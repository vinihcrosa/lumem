import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from '../shared/fsx'
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
}): InstallPlan {
  const { artifacts, lock, projectDir, globalDirs, mode, force = false } = opts

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
      if (dest.hash === artifact.hash) {
        return entry.hash === artifact.hash
          ? { ...base, type: 'skip', reason: 'up-to-date' }
          : { ...base, type: 'update', reason: 'already at new version; refreshing stale lock' }
      }
      if (dest.hash === entry.hash) {
        return { ...base, type: 'update', reason: 'new version; existing install unmodified' }
      }
      return force
        ? { ...base, type: 'update', reason: 'overwriting local edits (force)' }
        : { ...base, type: 'conflict', reason: 'destination modified since install' }
    }

    if (dest.hash === artifact.hash) {
      return { ...base, type: 'update', reason: 'identical file already present; adopting' }
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
