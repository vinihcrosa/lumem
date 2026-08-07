import { describe, expect, it } from 'vitest'
import { buildInjection } from './budget'
import type { Fact, MemoryFile, MemoryScope, MemoryType } from './store'

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

const DOC = '# lumem memory\n'
const CORRECTIONS = '## corrections\n'
const PROJECT = '## project\n'
const PREFERENCES = '## preferences\n'

function mk(
  id: string,
  date: string,
  body: string,
  type: MemoryType,
  scope: MemoryScope = 'project',
): Fact {
  return { id, date, body, src: 'sess_test', conf: 'high', type, scope }
}

function mkFile(facts: Fact[], name = 'a'): MemoryFile {
  return {
    path: `/tmp/lumem/${name}.md`,
    type: facts[0]?.type ?? 'project',
    scope: facts[0]?.scope ?? 'project',
    facts,
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
// Contract 1: output shape
// ---------------------------------------------------------------------------

describe('buildInjection — output shape', () => {
  it('renders the header then one section per type in priority order', () => {
    const files = [
      mkFile([mk('p1', '2026-01-01', 'proj one', 'project')], 'project'),
      mkFile([mk('c1', '2026-01-02', 'corr one', 'correction')], 'correction'),
      mkFile([mk('r1', '2026-01-03', 'pref one', 'preference', 'global')], 'preference'),
    ]

    const res = buildInjection(files, 4096)

    expect(res.text).toBe(
      `${DOC}${CORRECTIONS}- [2026-01-02] corr one\n${PROJECT}- [2026-01-01] proj one\n${PREFERENCES}- [2026-01-03] pref one\n`,
    )
    expect(res.includedFactIds).toEqual(['c1', 'p1', 'r1'])
    expect(res.truncated).toBe(false)
  })

  it('omits sections whose type has no included facts', () => {
    const files = [mkFile([mk('r1', '2026-01-03', 'only a preference', 'preference', 'global')])]

    const res = buildInjection(files, 4096)

    expect(res.text).toBe(`${DOC}${PREFERENCES}- [2026-01-03] only a preference\n`)
    expect(res.text).not.toContain('## corrections')
    expect(res.text).not.toContain('## project')
  })

  it("collapses a body's internal newlines into single spaces", () => {
    const body = 'first line\nsecond line\n\nfourth line'
    const res = buildInjection([mkFile([mk('p1', '2026-01-01', body, 'project')])], 4096)

    expect(res.text).toBe(`${DOC}${PROJECT}- [2026-01-01] first line second line fourth line\n`)
    expect(res.text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1)
  })

  it('ends with a single trailing newline', () => {
    const res = buildInjection([mkFile([mk('p1', '2026-01-01', 'body', 'project')])], 4096)

    expect(res.text.endsWith('\n')).toBe(true)
    expect(res.text.endsWith('\n\n')).toBe(false)
  })

  it('returns an empty result — with no header — when there are no files', () => {
    expect(buildInjection([], 4096)).toEqual({
      text: '',
      includedFactIds: [],
      truncated: false,
    })
  })

  it('returns an empty result — with no header — when every file is factless', () => {
    const res = buildInjection([mkFile([], 'x'), mkFile([], 'y')], 4096)

    expect(res).toEqual({ text: '', includedFactIds: [], truncated: false })
    expect(res.text).not.toContain('# lumem memory')
  })
})

// ---------------------------------------------------------------------------
// Contract 2: fill priority and ordering
// ---------------------------------------------------------------------------

describe('buildInjection — fill priority', () => {
  it('orders corrections newest date first', () => {
    const files = [
      mkFile([
        mk('c-old', '2026-01-01', 'old', 'correction'),
        mk('c-new', '2026-03-09', 'new', 'correction'),
        mk('c-mid', '2026-02-05', 'mid', 'correction'),
      ]),
    ]

    expect(buildInjection(files, 4096).includedFactIds).toEqual(['c-new', 'c-mid', 'c-old'])
  })

  it('breaks a correction date tie with project scope before global scope', () => {
    const files = [
      mkFile([mk('c-global', '2026-01-01', 'global one', 'correction', 'global')], 'global'),
      mkFile([mk('c-project', '2026-01-01', 'project one', 'correction', 'project')], 'project'),
    ]

    expect(buildInjection(files, 4096).includedFactIds).toEqual(['c-project', 'c-global'])
  })

  it('breaks a correction date+scope tie with input order', () => {
    const files = [
      mkFile(
        [mk('c1', '2026-01-01', 'one', 'correction'), mk('c2', '2026-01-01', 'two', 'correction')],
        'first',
      ),
      mkFile([mk('c3', '2026-01-01', 'three', 'correction')], 'second'),
    ]

    expect(buildInjection(files, 4096).includedFactIds).toEqual(['c1', 'c2', 'c3'])
  })

  it('orders project facts newest first', () => {
    const files = [
      mkFile([
        mk('p-old', '2025-12-31', 'old', 'project'),
        mk('p-new', '2026-06-30', 'new', 'project'),
      ]),
    ]

    expect(buildInjection(files, 4096).includedFactIds).toEqual(['p-new', 'p-old'])
  })

  it('orders preferences newest first', () => {
    const files = [
      mkFile([
        mk('r-old', '2025-01-02', 'old', 'preference', 'global'),
        mk('r-new', '2025-11-11', 'new', 'preference', 'global'),
      ]),
    ]

    expect(buildInjection(files, 4096).includedFactIds).toEqual(['r-new', 'r-old'])
  })

  it('fills corrections before project before preferences regardless of date', () => {
    const facts = [
      mk('r1', '2030-01-01', 'newest overall but a preference', 'preference', 'global'),
      mk('p1', '2029-01-01', 'a project fact', 'project'),
      mk('c1', '2000-01-01', 'oldest overall but a correction', 'correction'),
    ]
    const full = buildInjection([mkFile(facts)], 4096)
    expect(full.includedFactIds).toEqual(['c1', 'p1', 'r1'])

    // A budget that only affords the first slot goes to the correction.
    const oneSlot = bytes(`${DOC}${CORRECTIONS}- [2000-01-01] oldest overall but a correction\n`)
    const tight = buildInjection([mkFile(facts)], oneSlot)
    expect(tight.includedFactIds).toEqual(['c1'])
    expect(tight.truncated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Contract 3: hard budget
// ---------------------------------------------------------------------------

describe('buildInjection — hard budget', () => {
  it('includes a fact at exactly its byte cost and drops it one byte below', () => {
    const files = [mkFile([mk('p1', '2026-01-01', 'abc', 'project')])]
    const expected = `${DOC}${PROJECT}- [2026-01-01] abc\n`

    expect(buildInjection(files, bytes(expected))).toEqual({
      text: expected,
      includedFactIds: ['p1'],
      truncated: false,
    })
    expect(buildInjection(files, bytes(expected) - 1)).toEqual({
      text: '',
      includedFactIds: [],
      truncated: true,
    })
  })

  it('counts section headers toward the budget', () => {
    const files = [
      mkFile([mk('c1', '2026-01-02', 'c1', 'correction')], 'corr'),
      mkFile([mk('p1', '2026-01-01', 'p1', 'project')], 'proj'),
    ]
    const corrOnly = `${DOC}${CORRECTIONS}- [2026-01-02] c1\n`
    const projLine = '- [2026-01-01] p1\n'

    // Enough room for the project fact's own line but not for its section header.
    const res = buildInjection(files, bytes(corrOnly) + bytes(projLine))
    expect(res.text).toBe(corrOnly)
    expect(res.includedFactIds).toEqual(['c1'])
    expect(res.truncated).toBe(true)

    // One more byte than that is still short; the exact total does fit.
    const total = bytes(`${corrOnly}${PROJECT}${projLine}`)
    expect(buildInjection(files, total).includedFactIds).toEqual(['c1', 'p1'])
    expect(buildInjection(files, total - 1).includedFactIds).toEqual(['c1'])
  })

  it('counts the document header toward the budget', () => {
    const files = [mkFile([mk('p1', '2026-01-01', 'abc', 'project')])]
    const withoutDoc = `${PROJECT}- [2026-01-01] abc\n`

    expect(buildInjection(files, bytes(withoutDoc)).text).toBe('')
    expect(buildInjection(files, bytes(withoutDoc)).truncated).toBe(true)
  })

  it('never splits a fact: output lines are always whole', () => {
    const long = 'x'.repeat(300)
    const files = [mkFile([mk('p1', '2026-01-01', long, 'project')])]

    for (const budget of [0, 1, 64, 256, 4096]) {
      const res = buildInjection(files, budget)
      expect(res.text === '' || res.text === `${DOC}${PROJECT}- [2026-01-01] ${long}\n`).toBe(true)
      expect(bytes(res.text)).toBeLessThanOrEqual(budget)
    }
  })

  it('stops a type at the first non-fitting fact and does not backfill smaller ones', () => {
    const facts = [
      mk('p-big', '2026-02-02', 'B'.repeat(200), 'project'),
      mk('p-small', '2026-01-01', 'small', 'project'),
      mk('r1', '2026-01-01', 'pref', 'preference', 'global'),
    ]
    // Room for everything except the 200-byte project fact.
    const budget = bytes(
      `${DOC}${PROJECT}- [2026-01-01] small\n${PREFERENCES}- [2026-01-01] pref\n`,
    )

    const res = buildInjection([mkFile(facts)], budget)

    expect(res.includedFactIds).toEqual(['r1'])
    expect(res.text).toBe(`${DOC}${PREFERENCES}- [2026-01-01] pref\n`)
    expect(res.text).not.toContain('small')
    expect(res.truncated).toBe(true)
  })

  it('marks truncated only when a fact was actually left out', () => {
    const facts = [
      mk('c1', '2026-01-01', 'c', 'correction'),
      mk('p1', '2026-01-01', 'p', 'project'),
    ]
    const total = bytes(`${DOC}${CORRECTIONS}- [2026-01-01] c\n${PROJECT}- [2026-01-01] p\n`)

    expect(buildInjection([mkFile(facts)], total).truncated).toBe(false)
    expect(buildInjection([mkFile(facts)], total - 1).truncated).toBe(true)
  })

  it('holds the byte invariant over random fact sets and budgets (property)', () => {
    const budgets = [0, 1, 64, 256, 4096]

    for (let seed = 0; seed < 40; seed++) {
      const rand = mulberry32(seed)
      const files = randomFiles(rand)
      const all = files.flatMap((f) => f.facts)

      for (const budget of budgets) {
        const res = buildInjection(files, budget)
        const label = `seed=${seed} budget=${budget}`

        // (a) HARD budget, measured in bytes.
        expect(bytes(res.text), label).toBeLessThanOrEqual(budget)

        // (b) Whole facts only: every bullet line is a full rendered fact.
        const lines = res.text.split('\n').slice(0, -1)
        const bullets = lines.filter((l) => l.startsWith('- '))
        expect(bullets.length, label).toBe(res.includedFactIds.length)
        expect(res.text === '' || res.text.endsWith('\n'), label).toBe(true)

        // (c) Header present exactly when something was included.
        expect(lines[0], label).toBe(res.includedFactIds.length > 0 ? '# lumem memory' : undefined)

        // (d) Included ids render, in order, to the bullet lines.
        const byId = new Map(all.map((f) => [f.id, f]))
        expect(
          res.includedFactIds.map((id) => {
            const f = byId.get(id)
            return f === undefined ? '?' : `- [${f.date}] ${f.body.replace(/[\r\n]+/g, ' ')}`
          }),
          label,
        ).toEqual(bullets)

        // (e) truncated iff some fact was left out.
        expect(res.truncated, label).toBe(res.includedFactIds.length < all.length)

        // (f) Per type, the included facts are a prefix of that type's ranked order.
        for (const type of ['correction', 'project', 'preference'] as const) {
          const ranked = rankedIds(all, type)
          const got = res.includedFactIds.filter((id) => byId.get(id)?.type === type)
          expect(got, `${label} type=${type}`).toEqual(ranked.slice(0, got.length))
        }

        // (g) Sections appear in priority order.
        const headers = lines.filter((l) => l.startsWith('## '))
        const order = ['## corrections', '## project', '## preferences']
        expect(headers, label).toEqual(order.filter((h) => headers.includes(h)))
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Contract 4: non-positive budgets
// ---------------------------------------------------------------------------

describe('buildInjection — non-positive budgets', () => {
  it('yields an empty truncated result when facts exist and the budget is 0', () => {
    const files = [mkFile([mk('p1', '2026-01-01', 'x', 'project')])]

    expect(buildInjection(files, 0)).toEqual({ text: '', includedFactIds: [], truncated: true })
    expect(buildInjection(files, -100)).toEqual({ text: '', includedFactIds: [], truncated: true })
  })

  it('is not truncated when there are no facts to leave out', () => {
    expect(buildInjection([], 0)).toEqual({ text: '', includedFactIds: [], truncated: false })
    expect(buildInjection([mkFile([])], -1)).toEqual({
      text: '',
      includedFactIds: [],
      truncated: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Contract 5: multi-byte bodies are measured in bytes
// ---------------------------------------------------------------------------

describe('buildInjection — multi-byte bodies', () => {
  it('measures emoji bodies in bytes, not characters', () => {
    const body = '🚀🚀🚀'
    const files = [mkFile([mk('p1', '2026-01-01', body, 'project')])]
    const expected = `${DOC}${PROJECT}- [2026-01-01] ${body}\n`

    // The emoji costs 4 bytes but 2 UTF-16 units each: byte cost > string length.
    expect(bytes(body)).toBe(12)
    expect(body.length).toBe(6)
    expect(bytes(expected)).toBeGreaterThan(expected.length)

    // Exactly at the byte cost it fits.
    expect(buildInjection(files, bytes(expected)).includedFactIds).toEqual(['p1'])
    // One byte below the boundary it does not.
    expect(buildInjection(files, bytes(expected) - 1).text).toBe('')
    // A budget equal to the UTF-16 length would fit only if chars were counted.
    expect(buildInjection(files, expected.length).text).toBe('')
    expect(buildInjection(files, expected.length).truncated).toBe(true)
  })

  it('keeps the byte invariant with mixed multi-byte scripts', () => {
    const facts = [
      mk('c1', '2026-01-03', 'proibição de força bruta — não repetir', 'correction'),
      mk('p1', '2026-01-02', '日本語のテキストもバイト単位で数える', 'project'),
      mk('r1', '2026-01-01', 'emoji ✅ tail 🚀🚀', 'preference', 'global'),
    ]

    for (let budget = 0; budget <= 220; budget++) {
      const res = buildInjection([mkFile(facts)], budget)
      expect(bytes(res.text), `budget=${budget}`).toBeLessThanOrEqual(budget)
    }
  })
})

// ---------------------------------------------------------------------------
// Contract 6: purity
// ---------------------------------------------------------------------------

describe('buildInjection — purity', () => {
  it('does not mutate its inputs and is deterministic', () => {
    const files = [
      mkFile([
        mk('p1', '2026-01-01', 'one', 'project'),
        mk('c1', '2026-02-01', 'two', 'correction'),
        mk('r1', '2026-03-01', 'three', 'preference', 'global'),
      ]),
    ]
    const before = structuredClone(files)

    const first = buildInjection(files, 64)
    const second = buildInjection(files, 64)

    expect(files).toEqual(before)
    expect(second).toEqual(first)
  })

  it('never throws on degenerate facts', () => {
    const facts = [
      mk('e1', '', '', 'project'),
      mk('e2', 'not-a-date', '\n\n\n', 'correction'),
      mk('e3', '2026-01-01', '   ', 'preference', 'global'),
    ]

    for (const budget of [Number.NaN, Number.POSITIVE_INFINITY, -0, 0, 7, 4096]) {
      expect(() => buildInjection([mkFile(facts)], budget)).not.toThrow()
    }
    expect(bytes(buildInjection([mkFile(facts)], Number.NaN).text)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// helpers for the property test
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TYPES: readonly MemoryType[] = ['correction', 'project', 'preference']
const SCOPES: readonly MemoryScope[] = ['project', 'global']
const BODIES: readonly string[] = [
  'short',
  'a'.repeat(30),
  '🚀 rocket 🚀 emoji body',
  'line one\nline two\nline three',
  'acentuação e ção — não',
  'x'.repeat(150),
  '',
]

function pick<T>(rand: () => number, xs: readonly T[]): T {
  const value = xs[Math.floor(rand() * xs.length)]
  if (value === undefined) throw new Error('empty pool')
  return value
}

function randomFiles(rand: () => number): MemoryFile[] {
  const count = Math.floor(rand() * 14)
  const facts: Fact[] = []
  for (let i = 0; i < count; i++) {
    const day = String(1 + Math.floor(rand() * 28)).padStart(2, '0')
    facts.push(
      mk(`f${i}`, `2026-01-${day}`, pick(rand, BODIES), pick(rand, TYPES), pick(rand, SCOPES)),
    )
  }
  const fileCount = 1 + Math.floor(rand() * 3)
  const files: MemoryFile[] = []
  for (let i = 0; i < fileCount; i++) {
    files.push(
      mkFile(
        facts.filter((_, idx) => idx % fileCount === i),
        `f${i}`,
      ),
    )
  }
  return files
}

/** Independent re-implementation of the ranking rule, for cross-checking. */
function rankedIds(all: Fact[], type: MemoryType): string[] {
  return all
    .map((fact, index) => ({ fact, index }))
    .filter((r) => r.fact.type === type)
    .sort((a, b) => {
      if (a.fact.date !== b.fact.date) return a.fact.date < b.fact.date ? 1 : -1
      if (a.fact.scope !== b.fact.scope) return a.fact.scope === 'project' ? -1 : 1
      return a.index - b.index
    })
    .map((r) => r.fact.id)
}
