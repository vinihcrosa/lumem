import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite, sha256 } from '../shared/fsx'
import { backupOnce } from './backup'
import { mergeHookConfig, unmergeHookConfig } from './hooks-config'
import { type LockEntry, readLock, writeLock } from './lockfile'
import type { ManifestArtifact } from './manifest'
import type { InstallPlan } from './plan'

const HOOK_BUNDLE_TOKEN = '{{HOOK_BUNDLE}}'

/**
 * How a hook-config destination is written, mirroring
 * `AdapterDescriptor.paths.hooksConfig[].strategy`:
 *
 * - `own-file` — the destination belongs to lumem alone (`.codex/hooks.json`):
 *   the rendered template replaces whatever is there.
 * - `merge-json` — the destination is shared with the user
 *   (`.claude/settings.json`): lumem's entries are merged into the existing JSON
 *   and everything else is preserved.
 */
export type HookConfigStrategy = 'merge-json' | 'own-file'

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
  /**
   * Write strategy for `hook-config` artifacts, looked up by artifact id first
   * and by `dest.harness` second. The manifest does not carry the strategy, so
   * the caller passes the descriptors' `paths.hooksConfig[].strategy` here.
   * Anything not listed is written as `own-file`.
   */
  hookConfigStrategy?: Record<string, HookConfigStrategy>
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
  /** Only meaningful for `hook-config` artifacts. */
  strategy: HookConfigStrategy
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

/**
 * Some artifacts are never symlinked, whatever the requested mode:
 *
 * - `hook-bundle` — the source lives wherever the package was resolved from,
 *   which for `npx lumem install` is an ephemeral cache. A symlink into it
 *   dangles as soon as the cache is pruned, and a dangling hook is exactly the
 *   broken session NFR-1 forbids.
 * - `hook-config` — the destination holds rendered content ({{HOOK_BUNDLE}}
 *   substituted), so it cannot be a link to the raw template.
 */
function effectiveMode(
  kind: ManifestArtifact['kind'],
  requested: 'symlink' | 'copy',
): 'symlink' | 'copy' {
  return kind === 'hook-bundle' || kind === 'hook-config' ? 'copy' : requested
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

/** Content of a destination that may be absent, unreadable or a broken symlink. */
function readDestSafe(destPath: string): string | undefined {
  try {
    return fs.readFileSync(destPath, 'utf8')
  } catch {
    return undefined
  }
}

function backupDest(ctx: WriteContext): string | undefined {
  return backupOnce(ctx.destPath, { backupsDir: ctx.backupsDir, baseDir: ctx.baseDir })
}

/**
 * Render the hook-config template — `{{HOOK_BUNDLE}}` becomes the absolute path
 * of the installed hook bundle — and write it to the destination, own-file or
 * merged into the user's JSON depending on the harness's declared strategy.
 */
function writeHookConfig(ctx: WriteContext): WriteResult {
  const kind = classifyDest(ctx.destPath)
  assertWritableDest(ctx.destPath, kind)

  const template = fs.readFileSync(ctx.artifact.srcPath, 'utf8')
  const rendered = template.replaceAll(HOOK_BUNDLE_TOKEN, ctx.hookBundlePath)

  return ctx.strategy === 'merge-json'
    ? mergeHookConfigDest(ctx, kind, rendered)
    : replaceHookConfigDest(ctx, kind, rendered)
}

/** The destination is lumem's alone: the rendered content is the whole file. */
function replaceHookConfigDest(ctx: WriteContext, kind: DestKind, content: string): WriteResult {
  const contentHash = sha256(content)

  if (kind === 'absent' || ctx.owned) {
    atomicWrite(ctx.destPath, content)
    return { contentHash }
  }

  const backupPath = backupDest(ctx)
  atomicWrite(ctx.destPath, content)
  return { backupPath, reason: 'replaced (backup kept)', contentHash }
}

/**
 * The destination is shared with the user (`.claude/settings.json`): lumem's
 * hooks are merged in and everything else survives. A backup is kept only when
 * there was user content at risk — a pre-existing file we did not install, or
 * one we could not parse and are therefore about to replace.
 */
function mergeHookConfigDest(ctx: WriteContext, kind: DestKind, rendered: string): WriteResult {
  const existing = kind === 'absent' ? undefined : readDestSafe(ctx.destPath)
  const merged = mergeHookConfig(existing, rendered)
  const preexisting = kind !== 'absent' && !ctx.owned

  let reason: string | undefined
  if (merged.replacedInvalid === true) reason = 'replaced (invalid JSON; backup kept)'
  else if (preexisting) reason = 'merged into the existing config (backup kept)'

  const backupPath = merged.replacedInvalid === true || preexisting ? backupDest(ctx) : undefined

  atomicWrite(ctx.destPath, merged.content)
  return { backupPath, reason, contentHash: sha256(merged.content) }
}

interface RemoveResult {
  /** Set only when the user's pre-install file was actually put back. */
  backupPath?: string
  reason?: string
}

/**
 * Strategy for a removal, where the artifact id is all we have: the lockfile
 * records neither kind nor harness. Hook-config ids are `hook-config:<harness>`,
 * so the harness key is read off the id itself, mirroring the lookup writes use.
 */
function removalStrategy(
  artifactId: string,
  strategies: Record<string, HookConfigStrategy>,
): HookConfigStrategy {
  const byId = strategies[artifactId]
  if (byId !== undefined) return byId
  const prefix = 'hook-config:'
  if (!artifactId.startsWith(prefix)) return 'own-file'
  return strategies[artifactId.slice(prefix.length)] ?? 'own-file'
}

/** The destination is lumem's alone: delete it and put the user's file back. */
function removeOwnFile(destPath: string, backupPath: string | undefined): RemoveResult {
  removeDest(destPath)
  const restored = backupPath !== undefined && restoreBackup(backupPath, destPath)
  return restored && backupPath !== undefined ? { backupPath } : {}
}

/**
 * The destination is shared with the user (`.claude/settings.json`): take
 * lumem's marked entries out and leave the rest exactly as it now is.
 *
 * Restoring the backup here would throw away everything the user changed since
 * install, so it happens only when the unmerge emptied the file — nothing of
 * theirs was live in it, and their pre-install bytes are the truest thing left.
 * With no backup either, the file was lumem's own creation and simply goes.
 */
function unmergeDest(destPath: string, backupPath: string | undefined): RemoveResult {
  const kind = classifyDest(destPath)
  if (kind === 'absent') return {}
  assertWritableDest(destPath, kind)

  const existing = readDestSafe(destPath)
  // unreadable (a broken symlink, say): there is nothing to unmerge from
  if (existing === undefined) return removeOwnFile(destPath, backupPath)

  const remaining = unmergeHookConfig(existing)
  if (remaining === undefined) {
    const result = removeOwnFile(destPath, backupPath)
    return result.backupPath !== undefined
      ? { ...result, reason: 'nothing but lumem remained; restored the pre-install file' }
      : { reason: 'removed (lumem created it)' }
  }

  if (remaining !== existing) atomicWrite(destPath, remaining)
  return { reason: 'unmerged (the rest of the config was kept)' }
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
  const { plan, artifacts, lumemDir, projectDir, dryRun = false, hookConfigStrategy = {} } = opts
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
        // A merged config is the user's file with lumem's entries in it: the
        // only correct removal is taking those entries back out.
        const result =
          removalStrategy(artifactId, hookConfigStrategy) === 'merge-json'
            ? unmergeDest(destPath, backupPath)
            : removeOwnFile(destPath, backupPath)
        entries.delete(artifactId)
        report.applied.push({
          artifactId,
          action: 'remove',
          destPath,
          ...(result.backupPath !== undefined ? { backupPath: result.backupPath } : {}),
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
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
      const mode = effectiveMode(artifact.kind, action.mode)
      const ctx: WriteContext = {
        artifact,
        destPath,
        mode,
        owned: previous !== undefined && previous.destPath === destPath,
        backupsDir,
        baseDir: projectDir,
        hookBundlePath,
        strategy:
          hookConfigStrategy[artifact.id] ??
          hookConfigStrategy[artifact.dest.harness] ??
          'own-file',
      }
      const result = artifact.kind === 'hook-config' ? writeHookConfig(ctx) : installFile(ctx)
      const backupPath = result.backupPath ?? (ctx.owned ? previous?.backupPath : undefined)

      entries.set(artifactId, {
        artifactId,
        installedAt: new Date().toISOString(),
        destPath,
        hash: artifact.hash,
        ...(result.contentHash !== undefined ? { contentHash: result.contentHash } : {}),
        mode,
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
