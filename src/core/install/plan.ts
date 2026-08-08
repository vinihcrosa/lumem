import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from '../shared/fsx'
import type { HookConfigStrategy } from './apply'
import type { LockEntry, Lockfile } from './lockfile'
import type { ManifestArtifact } from './manifest'

export type PlanActionType = 'create' | 'update' | 'skip' | 'conflict' | 'remove'

export interface PlanAction {
  type: PlanActionType
  artifactId: string
  /** Omitted for 'remove' actions — the lockfile does not record artifact kinds. */
  kind?: ManifestArtifact['kind']
  /** Absolute, resolved destination path. */
  destPath: string
  mode: 'symlink' | 'copy'
  /** Human-readable one-liner explaining the action. */
  reason: string
}

export interface InstallPlan {
  actions: PlanAction[]
}

type DestState = { state: 'absent' } | { state: 'unreadable' } | { state: 'present'; hash: string }

/**
 * Inspect what currently sits at destPath without ever writing.
 * Symlinks are followed, so a symlink dest is hashed via its target content;
 * a broken symlink counts as absent. An entry that exists but cannot be read
 * (e.g. a directory or permission-denied file) is 'unreadable'.
 */
function inspectDest(destPath: string): DestState {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(destPath)
  } catch {
    return { state: 'absent' }
  }
  try {
    return { state: 'present', hash: sha256(fs.readFileSync(destPath)) }
  } catch {
    return stat.isSymbolicLink() ? { state: 'absent' } : { state: 'unreadable' }
  }
}

function resolveDestPath(
  artifact: ManifestArtifact,
  projectDir: string,
  globalDirs: Record<string, string>,
): string {
  if (artifact.dest.scope === 'project') return path.join(projectDir, artifact.dest.relPath)
  const base = globalDirs[artifact.dest.harness] ?? globalDirs['*']
  if (base === undefined) {
    throw new Error(
      `planInstall: no global dir for harness '${artifact.dest.harness}' (artifact ${artifact.id})`,
    )
  }
  return path.join(base, artifact.dest.relPath)
}

/**
 * Whether this artifact is written by merging into whatever is already at the
 * destination. Same lookup convention as applyPlan — artifact id first, harness
 * second — and only `hook-config` artifacts have a strategy at all.
 */
function mergesIntoDest(
  artifact: ManifestArtifact,
  strategies: Record<string, HookConfigStrategy>,
): boolean {
  if (artifact.kind !== 'hook-config') return false
  const strategy = strategies[artifact.id] ?? strategies[artifact.dest.harness]
  return strategy === 'merge-json'
}

function byArtifactId(a: PlanAction, b: PlanAction): number {
  if (a.artifactId !== b.artifactId) return a.artifactId < b.artifactId ? -1 : 1
  return a.destPath < b.destPath ? -1 : a.destPath > b.destPath ? 1 : 0
}

/**
 * Pure install planner: decides, per artifact, whether the destination must be
 * created, updated, skipped, or flagged as a conflict. Reads the filesystem
 * only to hash existing destinations — it never writes.
 */
export function planInstall(opts: {
  artifacts: ManifestArtifact[]
  lock: Lockfile
  projectDir: string
  globalDirs: Record<string, string>
  mode: 'symlink' | 'copy'
  force?: boolean
  /**
   * Write strategy per `hook-config` artifact, keyed by artifact id or harness,
   * exactly as applyPlan takes it. A `merge-json` destination is a file the user
   * also owns, so finding their content there is expected rather than a
   * conflict — see the pre-existing-file rule below. Anything not listed is
   * planned as `own-file`.
   */
  hookConfigStrategy?: Record<string, HookConfigStrategy>
}): InstallPlan {
  const {
    artifacts,
    lock,
    projectDir,
    globalDirs,
    mode,
    force = false,
    hookConfigStrategy = {},
  } = opts

  const lockById = new Map<string, LockEntry>()
  for (const entry of lock.entries) {
    if (!lockById.has(entry.artifactId)) lockById.set(entry.artifactId, entry)
  }

  const actions = artifacts.map((artifact): PlanAction => {
    const destPath = resolveDestPath(artifact, projectDir, globalDirs)
    const base = { artifactId: artifact.id, kind: artifact.kind, destPath, mode }
    const entry = lockById.get(artifact.id)
    const dest = inspectDest(destPath)

    if (dest.state === 'unreadable') {
      return { ...base, type: 'conflict', reason: 'unreadable' }
    }

    if (dest.state === 'absent') {
      return entry === undefined
        ? { ...base, type: 'create', reason: 'new artifact' }
        : { ...base, type: 'create', reason: 'reinstall missing' }
    }

    if (entry !== undefined) {
      // Compare the destination against what install actually wrote, which is
      // the rendered content for templated artifacts — not the source hash.
      const installed = entry.contentHash ?? entry.hash
      if (dest.hash === installed) {
        return entry.hash === artifact.hash
          ? { ...base, type: 'skip', reason: 'up-to-date' }
          : { ...base, type: 'update', reason: 'new version; existing install unmodified' }
      }
      if (dest.hash === artifact.hash) {
        return { ...base, type: 'update', reason: 'already at new version; refreshing stale lock' }
      }
      return force
        ? { ...base, type: 'update', reason: 'overwriting local edits (force)' }
        : { ...base, type: 'conflict', reason: 'destination modified since install' }
    }

    if (dest.hash === artifact.hash) {
      return { ...base, type: 'update', reason: 'identical file already present; adopting' }
    }
    // A merge-json destination is shared with the user by design: their content
    // is preserved by merging into it, so flagging it as a conflict would only
    // block the very write that protects it.
    if (mergesIntoDest(artifact, hookConfigStrategy)) {
      return { ...base, type: 'update', reason: 'merging into existing file' }
    }
    return force
      ? { ...base, type: 'update', reason: 'overwriting pre-existing file (force)' }
      : { ...base, type: 'conflict', reason: 'pre-existing file differs from artifact' }
  })

  actions.sort(byArtifactId)
  return { actions }
}

/**
 * Plan removal of everything the lockfile tracks: one 'remove' per entry,
 * sorted by artifactId (kind is unknown from the lock and therefore omitted).
 * With purge, a final 'remove' for artifactId '.lumem' asks the caller to also
 * drop the .lumem state directory — its destPath is the literal marker
 * '.lumem' for the caller to resolve.
 */
export function planUninstall(opts: { lock: Lockfile; purge?: boolean }): InstallPlan {
  const actions: PlanAction[] = opts.lock.entries.map((entry) => ({
    type: 'remove',
    artifactId: entry.artifactId,
    destPath: entry.destPath,
    mode: entry.mode,
    reason: 'installed by lumem',
  }))
  actions.sort(byArtifactId)
  if (opts.purge === true) {
    actions.push({
      type: 'remove',
      artifactId: '.lumem',
      destPath: '.lumem',
      mode: 'copy',
      reason: 'purge requested: remove the .lumem state directory',
    })
  }
  return { actions }
}
