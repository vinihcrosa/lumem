import fs from 'node:fs'
import path from 'node:path'

/**
 * Raw signals captured by the hooks. One JSON object per line in the session
 * journal (JSONL). Kept dependency-free on purpose: this module runs inside the
 * bundled hook, so no zod — shape checks are hand-rolled.
 */
export type Signal =
  | {
      t: 'session'
      ts: string
      ev: 'start' | 'end'
      harness: string
      sessionId: string
      cwd: string
    }
  | { t: 'file'; ts: string; path: string; tool: string }
  | { t: 'cmd'; ts: string; cmd: string; exit: number }
  | { t: 'recovery'; ts: string; failed: string; passed: string }
  | { t: 'correction'; ts: string; marker: string; prompt: string }
  | { t: 'memory-op'; ts: string; op: 'add' | 'forget'; factId?: string }

/** Default tail window: 64 KiB is plenty for the recovery/gate lookbacks. */
const DEFAULT_TAIL_BYTES = 65536

const SIGNAL_TYPES: readonly string[] = [
  'session',
  'file',
  'cmd',
  'recovery',
  'correction',
  'memory-op',
]

const UNSAFE_CHARS = /[^A-Za-z0-9._-]/g
const DOT_ONLY = /^\.+$/

/**
 * Journal file name for a session id: `<sanitized>.jsonl`.
 * Everything outside `[A-Za-z0-9._-]` becomes `-`, so the result is always a
 * single path segment (no traversal). An empty or dot-only id becomes `unknown`.
 */
export function sessionFileName(sessionId: string): string {
  const sanitized = sessionId.replace(UNSAFE_CHARS, '-')
  if (sanitized.length === 0 || DOT_ONLY.test(sanitized)) return 'unknown.jsonl'
  return `${sanitized}.jsonl`
}

/**
 * Append one signal to the session journal, creating `sessionsDir` if needed.
 * `appendFileSync` opens with `O_APPEND`, so concurrent writers never interleave
 * within a line. Returns false on any failure and never throws: this runs on the
 * hook fail-open path.
 */
export function appendSignal(sessionsDir: string, sessionId: string, signal: Signal): boolean {
  try {
    fs.mkdirSync(sessionsDir, { recursive: true })
    const file = path.join(sessionsDir, sessionFileName(sessionId))
    fs.appendFileSync(file, `${JSON.stringify(signal)}\n`)
    return true
  } catch {
    return false
  }
}

/** Hand-rolled shape check: an object whose `t` is one of the known signal kinds. */
function isSignal(value: unknown): value is Signal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const t = (value as { t?: unknown }).t
  return typeof t === 'string' && SIGNAL_TYPES.includes(t)
}

/**
 * Parse JSONL text tolerantly. Blank lines are skipped silently; lines that fail
 * to parse or do not look like a signal are counted in `badLines`.
 */
function parseJournal(text: string): { signals: Signal[]; badLines: number } {
  const signals: Signal[] = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      badLines++
      continue
    }
    if (isSignal(parsed)) signals.push(parsed)
    else badLines++
  }
  return { signals, badLines }
}

/**
 * Read a whole session journal. A missing (or unreadable) file yields an empty
 * result; corrupted lines are skipped and reported in `badLines`.
 */
export function readSignals(sessionFile: string): { signals: Signal[]; badLines: number } {
  let text: string
  try {
    text = fs.readFileSync(sessionFile, 'utf8')
  } catch {
    return { signals: [], badLines: 0 }
  }
  return parseJournal(text)
}

/**
 * Number of parseable signals in a journal. With `excludeSession`, `session`
 * start/end entries are not counted — that is the flavour the consolidation gate
 * uses, since bookkeeping entries are not evidence of work.
 */
export function countSignals(sessionFile: string, opts?: { excludeSession?: boolean }): number {
  const { signals } = readSignals(sessionFile)
  if (!opts?.excludeSession) return signals.length
  return signals.reduce((n, s) => (s.t === 'session' ? n : n + 1), 0)
}

/**
 * Read at most the last `maxBytes` of a journal and parse the complete lines in
 * that window. When the file is larger than the window the first (necessarily
 * partial) line is dropped, which also discards any byte sequence cut mid-UTF-8.
 * Never throws: a missing or unreadable file yields an empty array.
 */
export function tailSignals(sessionFile: string, maxBytes = DEFAULT_TAIL_BYTES): Signal[] {
  let fd: number | undefined
  try {
    fd = fs.openSync(sessionFile, 'r')
    const size = fs.fstatSync(fd).size
    const windowSize = Math.max(0, Math.min(Math.floor(maxBytes), size))
    const start = size - windowSize
    const buf = Buffer.alloc(windowSize)
    let read = 0
    while (read < windowSize) {
      const n = fs.readSync(fd, buf, read, windowSize - read, start + read)
      if (n <= 0) break
      read += n
    }
    let text = buf.subarray(0, read).toString('utf8')
    if (start > 0) {
      const firstBreak = text.indexOf('\n')
      text = firstBreak === -1 ? '' : text.slice(firstBreak + 1)
    }
    return parseJournal(text).signals
  } catch {
    return []
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // best-effort close
      }
    }
  }
}
