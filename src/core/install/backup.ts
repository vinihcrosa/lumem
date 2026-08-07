import fs from 'node:fs'
import path from 'node:path'

/**
 * Back up `filePath` once into `<backupsDir>/<timestamp>/<relPath>`.
 *
 * - `relPath` is `filePath` relative to `baseDir`; `..` segments are replaced
 *   with `__` so backups can never escape `backupsDir`.
 * - The timestamp is ISO basic (`2026-08-07T14-22-33-123Z`), which sorts
 *   lexicographically in time order.
 * - Idempotent per file: if any timestamp dir already holds a backup for the
 *   same relPath, nothing is copied and that first backup's path is returned.
 * - Returns the absolute path of the backup that now exists, or `undefined`
 *   when the source file is missing (no side effects in that case).
 */
export function backupOnce(
  filePath: string,
  opts: { backupsDir: string; baseDir: string },
): string | undefined {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false })
  if (!stat?.isFile()) return undefined

  const relPath = path
    .relative(opts.baseDir, filePath)
    .split(path.sep)
    .map((segment) => (segment === '..' ? '__' : segment))
    .join(path.sep)

  const existing = findExistingBackup(opts.backupsDir, relPath)
  if (existing !== undefined) return existing

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.resolve(opts.backupsDir, timestamp, relPath)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(filePath, dest)
  return dest
}

/** Absolute path of the oldest existing backup of `relPath` under any timestamp dir, if any. */
function findExistingBackup(backupsDir: string, relPath: string): string | undefined {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(backupsDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  const timestampDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  for (const dir of timestampDirs) {
    const candidate = path.resolve(backupsDir, dir, relPath)
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}
