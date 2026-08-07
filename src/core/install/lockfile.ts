import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite, readJsonSafe, sha256 } from '../shared/fsx'

export interface LockEntry {
  artifactId: string
  installedAt: string
  /** Absolute path of the installed artifact. */
  destPath: string
  /** sha256 of the installed content at install time. */
  hash: string
  mode: 'symlink' | 'copy'
  backupPath?: string
}

export interface Lockfile {
  version: 1
  entries: LockEntry[]
}

export interface DriftEntry {
  artifactId: string
  destPath: string
  state: 'ok' | 'modified' | 'missing'
  /** Set when a symlink install was replaced by a regular file. */
  note?: 'replaced-by-file'
}

const LOCKFILE_NAME = 'lumem-lock.json'

function lockPath(lumemDir: string): string {
  return path.join(lumemDir, LOCKFILE_NAME)
}

function isLockEntry(value: unknown): value is LockEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.artifactId === 'string' &&
    typeof e.installedAt === 'string' &&
    typeof e.destPath === 'string' &&
    typeof e.hash === 'string' &&
    (e.mode === 'symlink' || e.mode === 'copy') &&
    (e.backupPath === undefined || typeof e.backupPath === 'string')
  )
}

function emptyLock(): Lockfile {
  return { version: 1, entries: [] }
}

/**
 * Read `<lumemDir>/lumem-lock.json`. A missing, corrupt, or malformed file
 * yields an empty lock — this function never throws.
 */
export function readLock(lumemDir: string): Lockfile {
  const raw = readJsonSafe<unknown>(lockPath(lumemDir))
  if (typeof raw !== 'object' || raw === null) return emptyLock()
  const candidate = raw as Record<string, unknown>
  if (candidate.version !== 1 || !Array.isArray(candidate.entries)) return emptyLock()
  if (!candidate.entries.every(isLockEntry)) return emptyLock()
  return { version: 1, entries: candidate.entries }
}

/**
 * Write the lockfile atomically with a stable key order and trailing newline,
 * so identical locks always produce byte-identical files.
 */
export function writeLock(lumemDir: string, lock: Lockfile): void {
  const normalized = {
    version: lock.version,
    entries: lock.entries.map((e) => ({
      artifactId: e.artifactId,
      installedAt: e.installedAt,
      destPath: e.destPath,
      hash: e.hash,
      mode: e.mode,
      ...(e.backupPath !== undefined ? { backupPath: e.backupPath } : {}),
    })),
  }
  atomicWrite(lockPath(lumemDir), `${JSON.stringify(normalized, null, 2)}\n`)
}

/**
 * Compare each lock entry against what is currently on disk, in lockfile order.
 *
 * - dest missing (or a broken symlink) → 'missing'
 * - content hash differs from the recorded hash → 'modified'
 * - a symlink install replaced by a regular file keeps content-based state
 *   ('ok' when the content still matches) but carries note 'replaced-by-file'
 */
export function detectDrift(lock: Lockfile): DriftEntry[] {
  return lock.entries.map((entry) => {
    const base = { artifactId: entry.artifactId, destPath: entry.destPath }

    let stat: fs.Stats
    try {
      stat = fs.lstatSync(entry.destPath)
    } catch {
      return { ...base, state: 'missing' as const }
    }

    let content: Buffer
    try {
      // follows symlinks, so a symlink entry hashes its target's content
      content = fs.readFileSync(entry.destPath)
    } catch {
      // exists per lstat but unreadable: a broken symlink target is gone
      return {
        ...base,
        state: stat.isSymbolicLink() ? ('missing' as const) : ('modified' as const),
      }
    }

    const state = sha256(content) === entry.hash ? ('ok' as const) : ('modified' as const)
    if (entry.mode === 'symlink' && !stat.isSymbolicLink()) {
      return { ...base, state, note: 'replaced-by-file' as const }
    }
    return { ...base, state }
  })
}
