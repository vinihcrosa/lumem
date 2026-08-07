import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256 } from '../shared/fsx'
import { detectDrift, readLock, writeLock } from './lockfile'
import type { LockEntry, Lockfile } from './lockfile'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-lock-'))
}

function makeEntry(overrides: Partial<LockEntry> = {}): LockEntry {
  return {
    artifactId: 'artifact-a',
    installedAt: '2026-08-07T12:00:00.000Z',
    destPath: '/abs/dest/a.md',
    hash: sha256('content-a'),
    mode: 'copy',
    ...overrides,
  }
}

describe('readLock', () => {
  it('returns an empty lock when the file is missing', () => {
    const dir = tmpDir()
    expect(readLock(dir)).toEqual({ version: 1, entries: [] })
  })

  it('returns an empty lock and does not throw on corrupt JSON', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'lumem-lock.json'), '{ definitely not json !!!')
    expect(() => readLock(dir)).not.toThrow()
    expect(readLock(dir)).toEqual({ version: 1, entries: [] })
  })

  it('returns an empty lock when JSON is valid but not a lockfile shape', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'lumem-lock.json'), JSON.stringify({ version: 2, foo: [] }))
    expect(readLock(dir)).toEqual({ version: 1, entries: [] })
  })
})

describe('writeLock', () => {
  it('round-trips entries exactly through writeLock/readLock', () => {
    const dir = tmpDir()
    const lock: Lockfile = {
      version: 1,
      entries: [
        makeEntry({ artifactId: 'one', backupPath: '/abs/backup/one.md' }),
        makeEntry({ artifactId: 'two', mode: 'symlink', destPath: '/abs/dest/two.md' }),
      ],
    }
    writeLock(dir, lock)
    expect(readLock(dir)).toEqual(lock)
  })

  it('writes to <lumemDir>/lumem-lock.json with a trailing newline', () => {
    const dir = tmpDir()
    writeLock(dir, { version: 1, entries: [makeEntry()] })
    const raw = fs.readFileSync(path.join(dir, 'lumem-lock.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('serializes entry keys in a stable order regardless of input key order', () => {
    const dir = tmpDir()
    // build an entry whose insertion order is deliberately scrambled
    const scrambled = {
      mode: 'copy',
      hash: sha256('x'),
      backupPath: '/abs/backup/x.md',
      artifactId: 'scrambled',
      destPath: '/abs/dest/x.md',
      installedAt: '2026-08-07T12:00:00.000Z',
    } as LockEntry
    writeLock(dir, { version: 1, entries: [scrambled] })
    const raw = fs.readFileSync(path.join(dir, 'lumem-lock.json'), 'utf8')
    const order = [
      '"artifactId"',
      '"installedAt"',
      '"destPath"',
      '"hash"',
      '"mode"',
      '"backupPath"',
    ]
    const positions = order.map((k) => raw.indexOf(k))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    // version comes before entries
    expect(raw.indexOf('"version"')).toBeLessThan(raw.indexOf('"entries"'))
  })

  it('produces byte-identical output for the same lock (deterministic)', () => {
    const dirA = tmpDir()
    const dirB = tmpDir()
    const lock: Lockfile = { version: 1, entries: [makeEntry(), makeEntry({ artifactId: 'b' })] }
    writeLock(dirA, lock)
    writeLock(dirB, lock)
    expect(fs.readFileSync(path.join(dirA, 'lumem-lock.json'), 'utf8')).toBe(
      fs.readFileSync(path.join(dirB, 'lumem-lock.json'), 'utf8'),
    )
  })

  it('omits backupPath from the file when it is undefined', () => {
    const dir = tmpDir()
    writeLock(dir, { version: 1, entries: [makeEntry()] })
    const raw = fs.readFileSync(path.join(dir, 'lumem-lock.json'), 'utf8')
    expect(raw).not.toContain('backupPath')
  })
})

describe('detectDrift', () => {
  it('reports ok for a copy whose content still matches the recorded hash', () => {
    const dir = tmpDir()
    const dest = path.join(dir, 'a.md')
    fs.writeFileSync(dest, 'installed content')
    const lock: Lockfile = {
      version: 1,
      entries: [makeEntry({ destPath: dest, hash: sha256('installed content') })],
    }
    expect(detectDrift(lock)).toEqual([{ artifactId: 'artifact-a', destPath: dest, state: 'ok' }])
  })

  it('reports modified for a copy whose content changed', () => {
    const dir = tmpDir()
    const dest = path.join(dir, 'a.md')
    fs.writeFileSync(dest, 'user edited this')
    const lock: Lockfile = {
      version: 1,
      entries: [makeEntry({ destPath: dest, hash: sha256('installed content') })],
    }
    expect(detectDrift(lock)).toEqual([
      { artifactId: 'artifact-a', destPath: dest, state: 'modified' },
    ])
  })

  it('reports missing when the destination does not exist', () => {
    const dir = tmpDir()
    const dest = path.join(dir, 'gone.md')
    const lock: Lockfile = { version: 1, entries: [makeEntry({ destPath: dest })] }
    expect(detectDrift(lock)).toEqual([
      { artifactId: 'artifact-a', destPath: dest, state: 'missing' },
    ])
  })

  it('reports ok for an intact symlink whose target content matches', () => {
    const dir = tmpDir()
    const target = path.join(dir, 'target.md')
    const dest = path.join(dir, 'link.md')
    fs.writeFileSync(target, 'linked content')
    fs.symlinkSync(target, dest)
    const lock: Lockfile = {
      version: 1,
      entries: [makeEntry({ mode: 'symlink', destPath: dest, hash: sha256('linked content') })],
    }
    expect(detectDrift(lock)).toEqual([{ artifactId: 'artifact-a', destPath: dest, state: 'ok' }])
  })

  it('reports modified when the symlink target content changed', () => {
    const dir = tmpDir()
    const target = path.join(dir, 'target.md')
    const dest = path.join(dir, 'link.md')
    fs.writeFileSync(target, 'new upstream content')
    fs.symlinkSync(target, dest)
    const lock: Lockfile = {
      version: 1,
      entries: [makeEntry({ mode: 'symlink', destPath: dest, hash: sha256('linked content') })],
    }
    expect(detectDrift(lock)).toEqual([
      { artifactId: 'artifact-a', destPath: dest, state: 'modified' },
    ])
  })

  it('reports missing for a broken symlink', () => {
    const dir = tmpDir()
    const dest = path.join(dir, 'link.md')
    fs.symlinkSync(path.join(dir, 'does-not-exist.md'), dest)
    const lock: Lockfile = {
      version: 1,
      entries: [makeEntry({ mode: 'symlink', destPath: dest, hash: sha256('x') })],
    }
    expect(detectDrift(lock)).toEqual([
      { artifactId: 'artifact-a', destPath: dest, state: 'missing' },
    ])
  })

  it('reports ok with note replaced-by-file when a symlink became a real file with identical content', () => {
    const dir = tmpDir()
    const dest = path.join(dir, 'was-a-link.md')
    fs.writeFileSync(dest, 'same content')
    const lock: Lockfile = {
      version: 1,
      entries: [makeEntry({ mode: 'symlink', destPath: dest, hash: sha256('same content') })],
    }
    expect(detectDrift(lock)).toEqual([
      { artifactId: 'artifact-a', destPath: dest, state: 'ok', note: 'replaced-by-file' },
    ])
  })

  it('reports modified with note replaced-by-file when a symlink became a real file with different content', () => {
    const dir = tmpDir()
    const dest = path.join(dir, 'was-a-link.md')
    fs.writeFileSync(dest, 'edited content')
    const lock: Lockfile = {
      version: 1,
      entries: [makeEntry({ mode: 'symlink', destPath: dest, hash: sha256('same content') })],
    }
    expect(detectDrift(lock)).toEqual([
      { artifactId: 'artifact-a', destPath: dest, state: 'modified', note: 'replaced-by-file' },
    ])
  })

  it('returns drift entries in lockfile order', () => {
    const dir = tmpDir()
    const okDest = path.join(dir, 'ok.md')
    const modDest = path.join(dir, 'mod.md')
    const missDest = path.join(dir, 'miss.md')
    fs.writeFileSync(okDest, 'ok content')
    fs.writeFileSync(modDest, 'changed')
    const lock: Lockfile = {
      version: 1,
      entries: [
        makeEntry({ artifactId: 'z-last', destPath: okDest, hash: sha256('ok content') }),
        makeEntry({ artifactId: 'a-first', destPath: modDest, hash: sha256('original') }),
        makeEntry({ artifactId: 'm-mid', destPath: missDest }),
      ],
    }
    expect(detectDrift(lock)).toEqual([
      { artifactId: 'z-last', destPath: okDest, state: 'ok' },
      { artifactId: 'a-first', destPath: modDest, state: 'modified' },
      { artifactId: 'm-mid', destPath: missDest, state: 'missing' },
    ])
  })

  it('returns an empty array for an empty lock', () => {
    expect(detectDrift({ version: 1, entries: [] })).toEqual([])
  })
})
