import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Atomically write `content` to `filePath`: write to a temp file in the same
 * directory, then rename over the target. Creates parent directories.
 * On failure the temp file is removed and the error is rethrown.
 */
export function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmpPath, content)
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // best-effort cleanup
    }
    throw err
  }
}

/** Expand a leading `~` or `~/...` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** Hex-encoded SHA-256 digest of the input. */
export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

/** Read and parse a JSON file; returns undefined on missing file or invalid JSON. */
export function readJsonSafe<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return undefined
  }
}
