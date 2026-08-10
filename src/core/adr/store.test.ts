import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { serializeAdr } from './format'
import { currentOf, isSuperseded, readAdrs } from './store'

/** A cycle that regressed would hang forever; fail the test instead of the suite. */
const CYCLE_TIMEOUT_MS = 1000

const A = '2026-01-01-a.md'
const B = '2026-02-02-b.md'
const C = '2026-03-03-c.md'

function tmpDocs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-adr-store-'))
}

interface AdrFields {
  title?: string
  date?: string
  area?: string
  summary?: string
  supersedes?: string
  body?: string
}

/** Write `<docsDir>/adr/<id>` through the real serializer, so the fixture is a real ADR. */
function writeAdr(docsDir: string, id: string, fields: AdrFields = {}): void {
  const adrDir = path.join(docsDir, 'adr')
  fs.mkdirSync(adrDir, { recursive: true })
  fs.writeFileSync(
    path.join(adrDir, id),
    serializeAdr({
      title: fields.title ?? id,
      date: fields.date ?? id.slice(0, 10),
      area: fields.area ?? 'auth',
      summary: fields.summary ?? 'Because it had to be decided.',
      supersedes: fields.supersedes,
      body: fields.body ?? '## Context\nWhy.\n',
    }),
  )
}

/** A, B and C where B supersedes A. C stands alone. */
function threeAdrs(docsDir: string): void {
  writeAdr(docsDir, A)
  writeAdr(docsDir, B, { supersedes: A })
  writeAdr(docsDir, C)
}

describe('readAdrs', () => {
  it('returns an empty set when docs/adr does not exist', () => {
    const set = readAdrs(path.join(tmpDocs(), 'nowhere'))
    expect(set.adrs).toEqual([])
    expect(set.byId.size).toBe(0)
    expect(set.supersededBy.size).toBe(0)
  })

  it('returns an empty set for a docs folder without an adr subfolder', () => {
    const set = readAdrs(tmpDocs())
    expect(set.adrs).toEqual([])
    expect(set.byId.size).toBe(0)
  })

  it('returns an empty set for an empty adr folder', () => {
    const dir = tmpDocs()
    fs.mkdirSync(path.join(dir, 'adr'), { recursive: true })
    const set = readAdrs(dir)
    expect(set.adrs).toEqual([])
    expect(set.byId.size).toBe(0)
    expect(set.supersededBy.size).toBe(0)
  })

  it('parses every ADR and keys it by filename', () => {
    const dir = tmpDocs()
    threeAdrs(dir)
    const set = readAdrs(dir)
    expect(set.adrs).toHaveLength(3)
    expect([...set.byId.keys()].sort()).toEqual([A, B, C])
    expect(set.byId.get(B)?.area).toBe('auth')
    expect(set.byId.get(B)?.supersedes).toBe(A)
    expect(set.byId.get(A)?.warnings).toEqual([])
  })

  it('orders by id, which orders by date', () => {
    const dir = tmpDocs()
    writeAdr(dir, C)
    writeAdr(dir, A)
    writeAdr(dir, B)
    expect(readAdrs(dir).adrs.map((adr) => adr.id)).toEqual([A, B, C])
  })

  it('ignores files that are not .md', () => {
    const dir = tmpDocs()
    writeAdr(dir, A)
    fs.writeFileSync(path.join(dir, 'adr', 'notes.txt'), 'not an ADR\n')
    fs.writeFileSync(path.join(dir, 'adr', 'README'), 'not an ADR\n')
    fs.writeFileSync(path.join(dir, 'adr', '.hidden.md.bak'), 'not an ADR\n')
    expect(readAdrs(dir).adrs.map((adr) => adr.id)).toEqual([A])
  })

  it('ignores subdirectories, including one named like an ADR', () => {
    const dir = tmpDocs()
    writeAdr(dir, A)
    fs.mkdirSync(path.join(dir, 'adr', 'archive'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'adr', 'archive', B), 'nested\n')
    fs.mkdirSync(path.join(dir, 'adr', '2026-04-04-a-directory.md'), { recursive: true })
    expect(readAdrs(dir).adrs.map((adr) => adr.id)).toEqual([A])
  })

  it('surfaces an unreadable file as an ADR carrying a warning instead of throwing', () => {
    const dir = tmpDocs()
    writeAdr(dir, A)
    const broken = '2026-05-05-broken.md'
    fs.symlinkSync(path.join(dir, 'adr', 'does-not-exist.md'), path.join(dir, 'adr', broken))

    const set = readAdrs(dir)
    expect(set.adrs.map((adr) => adr.id)).toEqual([A, broken])
    const adr = set.byId.get(broken)
    expect(adr?.warnings).toHaveLength(1)
    expect(adr?.warnings[0]).toContain('unreadable')
    expect(adr?.title).toBe('')
    expect(adr?.body).toBe('')
  })

  it('keeps parse warnings from a malformed ADR without dropping it', () => {
    const dir = tmpDocs()
    fs.mkdirSync(path.join(dir, 'adr'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'adr', A), 'no frontmatter here\n')
    const set = readAdrs(dir)
    expect(set.adrs).toHaveLength(1)
    expect(set.byId.get(A)?.warnings.length).toBeGreaterThan(0)
  })
})

describe('supersededBy', () => {
  it('inverts a supersedes that names a known ADR', () => {
    const dir = tmpDocs()
    threeAdrs(dir)
    const set = readAdrs(dir)
    expect(set.supersededBy.get(A)).toBe(B)
    expect(set.supersededBy.size).toBe(1)
  })

  it('reports the superseded ADR as superseded and the others as current', () => {
    const dir = tmpDocs()
    threeAdrs(dir)
    const set = readAdrs(dir)
    expect(isSuperseded(set, A)).toBe(true)
    expect(isSuperseded(set, B)).toBe(false)
    expect(isSuperseded(set, C)).toBe(false)
  })

  it('leaves nothing in supersededBy for a supersedes naming a module rule', () => {
    const dir = tmpDocs()
    writeAdr(dir, A)
    writeAdr(dir, B, { supersedes: 'backend-dotnet/x' })
    const set = readAdrs(dir)
    expect(set.supersededBy.size).toBe(0)
    expect(isSuperseded(set, A)).toBe(false)
    expect(isSuperseded(set, 'backend-dotnet/x')).toBe(false)
  })

  it('leaves nothing in supersededBy for a supersedes naming a missing file', () => {
    const dir = tmpDocs()
    writeAdr(dir, B, { supersedes: '2020-01-01-gone.md' })
    const set = readAdrs(dir)
    expect(set.supersededBy.size).toBe(0)
    expect(isSuperseded(set, '2020-01-01-gone.md')).toBe(false)
  })

  it('is empty when nothing supersedes anything', () => {
    const dir = tmpDocs()
    writeAdr(dir, A)
    writeAdr(dir, B)
    expect(readAdrs(dir).supersededBy.size).toBe(0)
  })
})

describe('isSuperseded', () => {
  it('is false for an id the set does not know', () => {
    const dir = tmpDocs()
    threeAdrs(dir)
    expect(isSuperseded(readAdrs(dir), '2019-01-01-unknown.md')).toBe(false)
  })
})

describe('currentOf', () => {
  it('returns the id itself when nothing supersedes it', () => {
    const dir = tmpDocs()
    threeAdrs(dir)
    const set = readAdrs(dir)
    expect(currentOf(set, C)).toBe(C)
    expect(currentOf(set, B)).toBe(B)
  })

  it('returns an unknown id unchanged', () => {
    const dir = tmpDocs()
    threeAdrs(dir)
    expect(currentOf(readAdrs(dir), '2019-01-01-unknown.md')).toBe('2019-01-01-unknown.md')
  })

  it('walks a chain of three to its end', () => {
    const dir = tmpDocs()
    writeAdr(dir, A)
    writeAdr(dir, B, { supersedes: A })
    writeAdr(dir, C, { supersedes: B })
    const set = readAdrs(dir)
    expect(currentOf(set, A)).toBe(C)
    expect(currentOf(set, B)).toBe(C)
    expect(currentOf(set, C)).toBe(C)
  })

  it(
    'terminates on a two-member cycle A -> B -> A',
    () => {
      const dir = tmpDocs()
      writeAdr(dir, A, { supersedes: B })
      writeAdr(dir, B, { supersedes: A })
      const set = readAdrs(dir)
      expect(set.supersededBy.get(A)).toBe(B)
      expect(set.supersededBy.get(B)).toBe(A)
      // The last id seen before the walk revisits one it has already been to.
      expect(currentOf(set, A)).toBe(B)
      expect(currentOf(set, B)).toBe(A)
    },
    CYCLE_TIMEOUT_MS,
  )

  it(
    'terminates on a three-member cycle A -> B -> C -> A',
    () => {
      const dir = tmpDocs()
      writeAdr(dir, A, { supersedes: C })
      writeAdr(dir, B, { supersedes: A })
      writeAdr(dir, C, { supersedes: B })
      const set = readAdrs(dir)
      expect(currentOf(set, A)).toBe(C)
      expect(currentOf(set, B)).toBe(A)
      expect(currentOf(set, C)).toBe(B)
    },
    CYCLE_TIMEOUT_MS,
  )

  it(
    'terminates on an ADR that supersedes itself',
    () => {
      const dir = tmpDocs()
      writeAdr(dir, A, { supersedes: A })
      const set = readAdrs(dir)
      expect(currentOf(set, A)).toBe(A)
    },
    CYCLE_TIMEOUT_MS,
  )

  it(
    'terminates on a cycle that sits beside an unrelated chain',
    () => {
      const dir = tmpDocs()
      const d = '2026-04-04-d.md'
      const e = '2026-05-05-e.md'
      // A <-> B is the cycle; D supersedes C is the chain that must still resolve.
      writeAdr(dir, A, { supersedes: B })
      writeAdr(dir, B, { supersedes: A })
      writeAdr(dir, C)
      writeAdr(dir, d, { supersedes: C })
      writeAdr(dir, e)
      const set = readAdrs(dir)
      expect(currentOf(set, A)).toBe(B)
      expect(currentOf(set, C)).toBe(d)
      expect(currentOf(set, e)).toBe(e)
    },
    CYCLE_TIMEOUT_MS,
  )
})
