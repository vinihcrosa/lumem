import fs from 'node:fs'
import path from 'node:path'

export interface LogEntry {
  ts: string
  level: 'info' | 'warn' | 'error'
  event: string
  data?: Record<string, unknown>
}

/**
 * Append one JSON line to `logFile` (ts auto-filled as ISO string), creating
 * parent directories as needed. Never throws: this runs in fail-open hook
 * paths, so all errors are swallowed silently.
 */
export function appendLog(
  logFile: string,
  entry: Omit<LogEntry, 'ts'>,
  opts?: { maxBytes?: number; maxFiles?: number },
): void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    const line: LogEntry = { ts: new Date().toISOString(), ...entry }
    fs.appendFileSync(logFile, `${JSON.stringify(line)}\n`)
    void opts // rotation implemented in T46
  } catch {
    // never throw: fail-open logging
  }
}
