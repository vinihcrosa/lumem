import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backupOnce } from './backup'

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

function setup(): { root: string; baseDir: string; backupsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-backup-'))
  const baseDir = path.join(root, 'base')
  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(baseDir, { recursive: true })
  return { root, baseDir, backupsDir }
}

function timestampDirs(backupsDir: string): string[] {
  return fs
    .readdirSync(backupsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('backupOnce', () => {
  it('copies the file to <backupsDir>/<timestamp>/<relPath>', () => {
    const { baseDir, backupsDir } = setup()
    const src = path.join(baseDir, 'sub', 'dir', 'file.txt')
    fs.mkdirSync(path.dirname(src), { recursive: true })
    fs.writeFileSync(src, 'content')

    const result = backupOnce(src, { backupsDir, baseDir })

    expect(result).toBeDefined()
    const dirs = timestampDirs(backupsDir)
    expect(dirs).toHaveLength(1)
    const ts = dirs[0] as string
    expect(ts).toMatch(TIMESTAMP_RE)
    expect(result).toBe(path.join(backupsDir, ts, 'sub', 'dir', 'file.txt'))
    expect(fs.readFileSync(result as string, 'utf8')).toBe('content')
  })

  it('formats the timestamp as ISO basic (colons and dots replaced by dashes)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T14:22:33.123Z'))
    const { baseDir, backupsDir } = setup()
    const src = path.join(baseDir, 'a.txt')
    fs.writeFileSync(src, 'x')

    const result = backupOnce(src, { backupsDir, baseDir })

    expect(result).toBe(path.join(backupsDir, '2026-08-07T14-22-33-123Z', 'a.txt'))
  })

  it('produces timestamps that sort lexicographically in time order', () => {
    const older = new Date('2026-08-07T09:59:59.999Z')
    const newer = new Date('2026-08-07T10:00:00.000Z')
    const stamps: string[] = []
    for (const date of [newer, older]) {
      vi.useFakeTimers()
      vi.setSystemTime(date)
      const { baseDir, backupsDir } = setup()
      const src = path.join(baseDir, 'a.txt')
      fs.writeFileSync(src, 'x')
      backupOnce(src, { backupsDir, baseDir })
      stamps.push(...timestampDirs(backupsDir))
      vi.useRealTimers()
    }
    const [newerStamp, olderStamp] = stamps as [string, string]
    expect(olderStamp < newerStamp).toBe(true)
  })

  it('is idempotent per file: a second call returns the first backup and copies nothing', () => {
    const { baseDir, backupsDir } = setup()
    const src = path.join(baseDir, 'file.txt')
    fs.writeFileSync(src, 'original')

    const first = backupOnce(src, { backupsDir, baseDir })
    fs.writeFileSync(src, 'mutated')
    const second = backupOnce(src, { backupsDir, baseDir })

    expect(second).toBe(first)
    expect(timestampDirs(backupsDir)).toHaveLength(1)
    expect(fs.readFileSync(first as string, 'utf8')).toBe('original')
  })

  it('honors a pre-existing backup in any timestamp dir (first backup wins)', () => {
    const { baseDir, backupsDir } = setup()
    const src = path.join(baseDir, 'file.txt')
    fs.writeFileSync(src, 'current')
    const existing = path.join(backupsDir, '2020-01-01T00-00-00-000Z', 'file.txt')
    fs.mkdirSync(path.dirname(existing), { recursive: true })
    fs.writeFileSync(existing, 'ancient')

    const result = backupOnce(src, { backupsDir, baseDir })

    expect(result).toBe(existing)
    expect(fs.readFileSync(existing, 'utf8')).toBe('ancient')
    expect(timestampDirs(backupsDir)).toEqual(['2020-01-01T00-00-00-000Z'])
  })

  it('returns undefined for a missing source file, with no side effects', () => {
    const { baseDir, backupsDir } = setup()
    const src = path.join(baseDir, 'nope.txt')

    const result = backupOnce(src, { backupsDir, baseDir })

    expect(result).toBeUndefined()
    expect(fs.existsSync(backupsDir)).toBe(false)
  })

  it('preserves content byte-for-byte, including multi-byte UTF-8', () => {
    const { baseDir, backupsDir } = setup()
    const src = path.join(baseDir, 'utf8.txt')
    const content = Buffer.from('olá, 世界 — αβγ 🚀\n', 'utf8')
    fs.writeFileSync(src, content)

    const result = backupOnce(src, { backupsDir, baseDir })

    expect(result).toBeDefined()
    expect(fs.readFileSync(result as string).equals(content)).toBe(true)
  })

  it('sanitizes paths outside baseDir so backups never escape backupsDir', () => {
    const { root, baseDir, backupsDir } = setup()
    const src = path.join(root, 'outside.txt')
    fs.writeFileSync(src, 'escapee')

    const result = backupOnce(src, { backupsDir, baseDir })

    expect(result).toBeDefined()
    const rel = path.relative(backupsDir, result as string)
    expect(rel.startsWith('..')).toBe(false)
    expect(path.isAbsolute(rel)).toBe(false)
    expect(rel.split(path.sep)).toContain('__')
    expect(fs.readFileSync(result as string, 'utf8')).toBe('escapee')
  })

  it('stays idempotent for sanitized out-of-base paths', () => {
    const { root, baseDir, backupsDir } = setup()
    const src = path.join(root, 'outside.txt')
    fs.writeFileSync(src, 'v1')

    const first = backupOnce(src, { backupsDir, baseDir })
    fs.writeFileSync(src, 'v2')
    const second = backupOnce(src, { backupsDir, baseDir })

    expect(second).toBe(first)
    expect(fs.readFileSync(first as string, 'utf8')).toBe('v1')
  })

  it('returns an absolute path to a backup file that exists', () => {
    const { baseDir, backupsDir } = setup()
    const src = path.join(baseDir, 'abs.txt')
    fs.writeFileSync(src, 'here')

    const result = backupOnce(src, { backupsDir, baseDir })

    expect(result).toBeDefined()
    expect(path.isAbsolute(result as string)).toBe(true)
    expect(fs.existsSync(result as string)).toBe(true)
  })
})
