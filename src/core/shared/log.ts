import fs from 'node:fs'
import path from 'node:path'

export interface LogEntry {
  ts: string
  level: 'info' | 'warn' | 'error'
  event: string
  data?: Record<string, unknown>
}

const DEFAULT_MAX_BYTES = 1_048_576
const DEFAULT_MAX_FILES = 3

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** Size of `file` in bytes, or 0 when it is missing / unreadable. */
function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** Rename, tolerating a source that vanished (concurrent rotation). */
function shift(from: string, to: string): void {
  try {
    fs.renameSync(from, to)
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
}

/** Delete every `<log>.<n>` with n greater than `keep`. */
function pruneBeyond(logFile: string, keep: number): void {
  const dir = path.dirname(logFile)
  const base = path.basename(logFile)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(`${base}.`)) continue
    const suffix = name.slice(base.length + 1)
    if (!/^\d+$/.test(suffix) || Number(suffix) <= keep) continue
    fs.rmSync(path.join(dir, name), { force: true })
  }
}

/**
 * Classic numbered rotation of `logFile`: drop rotated files beyond `maxFiles`,
 * shift `<log>.n` to `<log>.n+1` down to `<log>.1` -> `<log>.2`, then move
 * `<log>` to `<log>.1`, leaving no live log behind. `maxFiles` counts the
 * rotated copies kept, so 0 keeps none and merely discards the live log.
 *
 * Sources that vanished mid-shift are skipped silently; any other failure is
 * thrown so the caller can decide what to do (`appendLog` swallows it).
 */
export function rotateLogs(logFile: string, maxFiles: number): void {
  const keep = Math.max(0, Math.trunc(maxFiles))
  pruneBeyond(logFile, keep)
  if (keep === 0) {
    fs.rmSync(logFile, { force: true })
    return
  }
  fs.rmSync(`${logFile}.${keep}`, { force: true })
  for (let i = keep - 1; i >= 1; i--) shift(`${logFile}.${i}`, `${logFile}.${i + 1}`)
  shift(logFile, `${logFile}.1`)
}

/**
 * Append one JSON line to `logFile` (ts auto-filled as ISO string), creating
 * parent directories as needed and rotating the log once it would grow past
 * `maxBytes`. Never throws: this runs in fail-open hook paths, so all errors
 * are swallowed silently — including rotation failures, after which the line is
 * still appended to the current file.
 */
export function appendLog(
  logFile: string,
  entry: Omit<LogEntry, 'ts'>,
  opts?: { maxBytes?: number; maxFiles?: number },
): void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    const line: LogEntry = { ts: new Date().toISOString(), ...entry }
    const payload = `${JSON.stringify(line)}\n`

    const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
    const size = sizeOf(logFile)
    // Rotate at most once, and never an empty log: an entry bigger than
    // maxBytes still lands whole in a fresh file instead of looping.
    if (size > 0 && size + Buffer.byteLength(payload) > maxBytes) {
      try {
        rotateLogs(logFile, opts?.maxFiles ?? DEFAULT_MAX_FILES)
      } catch {
        // rotation is best effort: fall through and append to the current file
      }
    }

    fs.appendFileSync(logFile, payload)
  } catch {
    // never throw: fail-open logging
  }
}
