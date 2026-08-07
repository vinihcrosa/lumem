import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite, sha256 } from '../shared/fsx'
import { backupOnce } from './backup'
import { type LockEntry, readLock, writeLock } from './lockfile'
import type { ManifestArtifact } from './manifest'
import type { InstallPlan } from './plan'

const HOOK_BUNDLE_TOKEN = '{{HOOK_BUNDLE}}'

export interface AppliedEntry {
  artifactId: string
  /** The plan action type, prefixed with 'would-' on a dry run. */
  action: string
  destPath: string
  /** Set when the write displaced an untracked file, or when a remove restored one. */
  backupPath?: string
  /** Extra context for the CLI; only set when the write was not a plain install. */
  reason?: string
}

export interface ApplyReport {
  applied: AppliedEntry[]
  skipped: { artifactId: string; reason: string }[]
  errors: { artifactId: string; message: string }[]
}

export interface ApplyOptions {
  plan: InstallPlan
  artifacts: ManifestArtifact[]
  /** `<projectDir>/.lumem` — lockfile and backups live here. */
  lumemDir: string
  /** Base dir for backup relative paths. */
  projectDir: string
  dryRun?: boolean
}

type DestKind = 'absent' | 'symlink' | 'file' | 'other'

interface WriteContext {
  artifact: ManifestArtifact
  destPath: string
  mode: 'symlink' | 'copy'
  /** True when the lockfile already tracks this artifact at this destination. */
  owned: boolean
  backupsDir: string
  baseDir: string
  hookBundlePath: string
}

interface WriteResult {
  backupPath?: string
  reason?: string
  /**
   * sha256 of the bytes that landed at the destination, when they differ from
   * the source artifact (rendered templates). Left unset when the destination
   * holds the source content verbatim, including symlinks.
   */
  contentHash?: string
}

function classifyDest(destPath: string): DestKind {
  const stat = fs.lstatSync(destPath, { throwIfNoEntry: false })
  if (stat === undefined) return 'absent'
  if (stat.isSymbolicLink()) return 'symlink'
  if (stat.isFile()) return 'file'
  return 'other'
}

function assertWritableDest(destPath: string, kind: DestKind): void {
  if (kind === 'other') {
    throw new Error(`destination is not a regular file or symlink: ${destPath}`)
  }
}

/** Delete a file or symlink; a missing destination is fine, a directory is refused. */
function removeDest(destPath: string): void {
  const kind = classifyDest(destPath)
  if (kind === 'absent') return
  assertWritableDest(destPath, kind)
  fs.unlinkSync(destPath)
}

function restoreBackup(backupPath: string, destPath: string): boolean {
  if (!fs.existsSync(backupPath)) return false
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.copyFileSync(backupPath, destPath)
  return true
}

/**
 * Install a skill / agent / hook-bundle: symlink the destination at srcPath or
 * copy its bytes. A regular file we do not already own is backed up first.
 */
function installFile(ctx: WriteContext): WriteResult {
  const kind = classifyDest(ctx.destPath)
  assertWritableDest(ctx.destPath, kind)

  // "pre-existing" means present before lumem installed here: a file the lockfile
  // already tracks at this destination is our own previous install, not the user's.
  const backupPath =
    kind === 'file' && !ctx.owned
      ? backupOnce(ctx.destPath, { backupsDir: ctx.backupsDir, baseDir: ctx.baseDir })
      : undefined

  if (ctx.mode === 'symlink') {
    if (kind !== 'absent') fs.unlinkSync(ctx.destPath)
    fs.mkdirSync(path.dirname(ctx.destPath), { recursive: true })
    fs.symlinkSync(ctx.artifact.srcPath, ctx.destPath)
    return { backupPath }
  }

  atomicWrite(ctx.destPath, fs.readFileSync(ctx.artifact.srcPath, 'utf8'))
  return { backupPath }
}

/**
 * Render the hook-config template — `{{HOOK_BUNDLE}}` becomes the absolute path
 * of the installed hook bundle — and write it to the destination.
 */
function writeHookConfig(ctx: WriteContext): WriteResult {
  const kind = classifyDest(ctx.destPath)
  assertWritableDest(ctx.destPath, kind)

  const template = fs.readFileSync(ctx.artifact.srcPath, 'utf8')
  const content = template.replaceAll(HOOK_BUNDLE_TOKEN, ctx.hookBundlePath)

  const contentHash = sha256(content)

  if (kind === 'absent' || ctx.owned) {
    atomicWrite(ctx.destPath, content)
    return { contentHash }
  }

  // SPEC_DEVIATION: merge JSON para .claude/settings.json chega na T33; T14 trata own-file genericamente.
  const backupPath = backupOnce(ctx.destPath, {
    backupsDir: ctx.backupsDir,
    baseDir: ctx.baseDir,
  })
  atomicWrite(ctx.destPath, content)
  return { backupPath, reason: 'replaced (backup kept)', contentHash }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Execute an install plan against the filesystem.
 *
 * Actions run sequentially and independently: one that throws lands in
 * `errors` and the rest keep going, so the lockfile written at the end always
 * describes exactly what made it to disk. `dryRun` performs no I/O at all and
 * reports every action it would have taken with a 'would-' prefix.
 */
export function applyPlan(opts: ApplyOptions): ApplyReport {
  const { plan, artifacts, lumemDir, projectDir, dryRun = false } = opts
  const report: ApplyReport = { applied: [], skipped: [], errors: [] }

  const artifactById = new Map<string, ManifestArtifact>()
  for (const artifact of artifacts) {
    if (!artifactById.has(artifact.id)) artifactById.set(artifact.id, artifact)
  }

  const entries = new Map<string, LockEntry>()
  for (const entry of readLock(lumemDir).entries) {
    if (!entries.has(entry.artifactId)) entries.set(entry.artifactId, entry)
  }

  const backupsDir = path.join(lumemDir, 'local', 'backups')
  const hookBundlePath = path.resolve(lumemDir, 'bin', 'lumem-hook.mjs')

  for (const action of plan.actions) {
    const { artifactId, destPath } = action
    try {
      if (action.type === 'skip' || action.type === 'conflict') {
        report.skipped.push({ artifactId, reason: action.reason })
        continue
      }

      if (action.type === 'remove') {
        // planUninstall's purge marker ('.lumem') is a relative token the caller resolves.
        if (!path.isAbsolute(destPath)) {
          report.skipped.push({ artifactId, reason: action.reason })
          continue
        }
        const backupPath = entries.get(artifactId)?.backupPath
        if (dryRun) {
          report.applied.push({
            artifactId,
            action: 'would-remove',
            destPath,
            ...(backupPath !== undefined ? { backupPath } : {}),
          })
          continue
        }
        removeDest(destPath)
        const restored = backupPath !== undefined && restoreBackup(backupPath, destPath)
        entries.delete(artifactId)
        report.applied.push({
          artifactId,
          action: 'remove',
          destPath,
          ...(restored && backupPath !== undefined ? { backupPath } : {}),
        })
        continue
      }

      const artifact = artifactById.get(artifactId)
      if (artifact === undefined) {
        throw new Error(`no artifact in the manifest for id '${artifactId}'`)
      }

      if (dryRun) {
        report.applied.push({ artifactId, action: `would-${action.type}`, destPath })
        continue
      }

      const previous = entries.get(artifactId)
      const ctx: WriteContext = {
        artifact,
        destPath,
        mode: action.mode,
        owned: previous !== undefined && previous.destPath === destPath,
        backupsDir,
        baseDir: projectDir,
        hookBundlePath,
      }
      const result = artifact.kind === 'hook-config' ? writeHookConfig(ctx) : installFile(ctx)
      const backupPath = result.backupPath ?? (ctx.owned ? previous?.backupPath : undefined)

      entries.set(artifactId, {
        artifactId,
        installedAt: new Date().toISOString(),
        destPath,
        hash: artifact.hash,
        ...(result.contentHash !== undefined ? { contentHash: result.contentHash } : {}),
        mode: action.mode,
        ...(backupPath !== undefined ? { backupPath } : {}),
      })
      report.applied.push({
        artifactId,
        action: action.type,
        destPath,
        ...(backupPath !== undefined ? { backupPath } : {}),
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      })
    } catch (err) {
      report.errors.push({ artifactId, message: errorMessage(err) })
    }
  }

  if (!dryRun) writeLock(lumemDir, { version: 1, entries: [...entries.values()] })
  return report
}
