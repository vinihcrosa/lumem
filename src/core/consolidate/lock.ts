import fs from 'node:fs'
import path from 'node:path'

/** A held consolidation lock: the file that backs it plus the identity written into it. */
export interface Lock {
  path: string
  pid: number
  startedAt: string
}

const LOCK_FILENAME = 'consolidate.lock'
const DEFAULT_TTL_MIN = 30

/** The `{ pid, startedAt }` payload of a lock file, once validated. */
type LockRecord = Pick<Lock, 'pid' | 'startedAt'>

/**
 * Try to take the consolidation lock for `localDir`.
 *
 * The lock is the single file `<localDir>/consolidate.lock`, created with
 * `O_CREAT|O_EXCL` so exactly one process can win the race. `localDir` is
 * created when missing.
 *
 * A lock whose `startedAt` is older than `ttlMin` (default 30) — or whose
 * contents cannot be parsed — is considered abandoned by an orphaned runner:
 * it is unlinked and creation is retried once, still exclusively, so a
 * concurrent winner that slips into that window keeps the lock and we return
 * `null`. A fresh, valid lock is never disturbed.
 *
 * Returns the held `Lock`, or `null` when the lock is unavailable. Any
 * unexpected filesystem error is reported as `null`; this never throws.
 */
export function acquireLock(localDir: string, ttlMin = DEFAULT_TTL_MIN): Lock | null {
  const lockPath = path.join(localDir, LOCK_FILENAME)

  try {
    fs.mkdirSync(localDir, { recursive: true })
  } catch {
    return null
  }

  const created = createExclusive(lockPath)
  if (created !== null) return created

  const existing = readLockFile(lockPath)
  if (existing !== undefined && isFresh(existing, ttlMin)) return null

  try {
    fs.unlinkSync(lockPath)
  } catch {
    // Already gone, or not removable — the single retry below settles it.
  }
  return createExclusive(lockPath)
}

/**
 * Release a lock previously returned by {@link acquireLock}.
 *
 * The file is re-read first and unlinked only while it still carries our
 * `pid` + `startedAt`: after a stale takeover it belongs to another runner and
 * must be left in place. A missing file and any error are swallowed.
 */
export function releaseLock(lock: Lock): void {
  const current = readLockFile(lock.path)
  if (current === undefined) return
  if (current.pid !== lock.pid || current.startedAt !== lock.startedAt) return

  try {
    fs.unlinkSync(lock.path)
  } catch {
    // Best-effort: someone else already removed it.
  }
}

/**
 * Whether `localDir` currently holds a live lock: the file exists, parses, and
 * started within `ttlMin` (default 30). Stale and unparseable locks read as
 * unlocked, since {@link acquireLock} would reclaim them.
 */
export function isLocked(localDir: string, ttlMin = DEFAULT_TTL_MIN): boolean {
  const existing = readLockFile(path.join(localDir, LOCK_FILENAME))
  return existing !== undefined && isFresh(existing, ttlMin)
}

/** Create the lock file with `wx` (O_CREAT|O_EXCL); `null` if it exists or on any error. */
function createExclusive(lockPath: string): Lock | null {
  const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() }
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify(record)}\n`, { flag: 'wx' })
    return { path: lockPath, ...record }
  } catch {
    return null
  }
}

/** Read and validate a lock file; `undefined` when missing, unreadable, or malformed. */
function readLockFile(lockPath: string): LockRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined

  const { pid, startedAt } = parsed as { pid?: unknown; startedAt?: unknown }
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return undefined
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) return undefined
  return { pid, startedAt }
}

/** Whether `record` started less than `ttlMin` minutes ago. */
function isFresh(record: LockRecord, ttlMin: number): boolean {
  return Date.now() - Date.parse(record.startedAt) < ttlMin * 60_000
}
