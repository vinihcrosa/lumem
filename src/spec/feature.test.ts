import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SpecFeature } from './feature'
import { expandCaseIds, readFeature } from './feature'

const SLUG = '002-spec-driven'

const DECISIONS = `---
slug: ${SLUG}
tier: full
created: 2026-08-11
---
# Decisions

## D1 — something
`

/** A feature directory whose basename is the slug, holding exactly `files`. */
function build(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-spec-'))
  const dir = path.join(root, SLUG)
  fs.mkdirSync(dir)
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

function read(files: Record<string, string>): SpecFeature {
  return readFeature(build(files))
}

/** Frontmatter from flat fields, in the given order. */
function decisions(fields: Record<string, string>, body = '# Decisions\n'): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`)
  return `---\n${lines.join('\n')}\n---\n${body}`
}

function question(id: string, answer: string | undefined, effect?: string): string {
  let out = `### ${id} — does it matter?\n\nSome framing.\n\n**Answer:**${answer ?? ''}\n`
  if (effect !== undefined) out += `**Effect:** ${effect}\n`
  return out
}

describe('readFeature — frontmatter', () => {
  it('UT-01 carries slug, tier and created, with no warnings', () => {
    const feature = read({ 'decisions.md': DECISIONS })
    expect(feature.slug).toBe(SLUG)
    expect(feature.tier).toBe('full')
    expect(feature.created).toBe('2026-08-11')
    expect(feature.warnings).toEqual([])
  })

  it('UT-02 leaves tier absent and warns when it is missing', () => {
    const feature = read({
      'decisions.md': decisions({ slug: SLUG, created: '2026-08-11' }),
    })
    expect(feature.tier).toBeUndefined()
    expect(feature.warnings.some((w) => w.includes('no tier recorded'))).toBe(true)
  })

  it('UT-03 does not coerce an unknown tier', () => {
    const feature = read({
      'decisions.md': decisions({ slug: SLUG, tier: 'huge', created: '2026-08-11' }),
    })
    expect(feature.tier).toBeUndefined()
    expect(feature.warnings.some((w) => w.includes("unknown tier 'huge'"))).toBe(true)
  })

  it('UT-04 lets the directory name win over a disagreeing slug', () => {
    const feature = read({
      'decisions.md': decisions({ slug: '003-other', tier: 'full', created: '2026-08-11' }),
    })
    expect(feature.slug).toBe(SLUG)
    expect(feature.warnings.some((w) => w.includes('disagrees with the directory name'))).toBe(true)
  })

  it('UT-05 survives an unterminated fence and still reads the prune record', () => {
    const feature = read({
      'decisions.md': `---\nslug: ${SLUG}\ntier: full\n\n# Decisions\n\n## Cut, and why\n`,
    })
    expect(feature.warnings.some((w) => w.includes('never closed'))).toBe(true)
    expect(feature.has.cutSection).toBe(true)
    expect(feature.tier).toBeUndefined()
  })

  it('UT-05 warns on a malformed frontmatter line and on an unknown key', () => {
    const feature = read({
      'decisions.md': `---\nslug: ${SLUG}\ntier: full\ncreated: 2026-08-11\nnonsense\nphase: execute\n---\n`,
    })
    expect(feature.tier).toBe('full')
    expect(feature.warnings.some((w) => w.includes('skipped malformed frontmatter line'))).toBe(
      true,
    )
    expect(feature.warnings.some((w) => w.includes("unknown frontmatter key 'phase'"))).toBe(true)
  })
})

describe('readFeature — questions', () => {
  const file = (body: string): Record<string, string> => ({
    'decisions.md': DECISIONS,
    'questions.md': body,
  })

  it('UT-06 records id, round and an answered question', () => {
    const feature = readFeature(
      build(
        file(
          `# Questions\n\n## Round 1\n\n${question('Q1', ' A')}\n## Round 2\n\n${question('Q6', ' B')}`,
        ),
      ),
    )
    expect(feature.questions.map((q) => [q.id, q.round, q.answered])).toEqual([
      ['Q1', 1, true],
      ['Q6', 2, true],
    ])
  })

  it('UT-07 marks an empty answer as unanswered', () => {
    const feature = readFeature(build(file(`## Round 1\n\n${question('Q1', undefined)}`)))
    expect(feature.questions[0]?.answered).toBe(false)
  })

  it('UT-07 treats an answer continuing on the next line as answered', () => {
    const feature = readFeature(
      build(file('## Round 1\n\n### Q1 — x?\n\n**Answer:**\nyes, option B\n')),
    )
    expect(feature.questions[0]?.answered).toBe(true)
  })

  it('UT-07 does not read the Effect line as the answer', () => {
    const feature = readFeature(
      build(file('## Round 1\n\n### Q1 — x?\n\n**Answer:**\n**Effect:** accepted\n')),
    )
    expect(feature.questions[0]?.answered).toBe(false)
    expect(feature.questions[0]?.effect).toBe('accepted')
  })

  it('UT-08 parses a known effect and warns on an unknown one', () => {
    const feature = readFeature(
      build(
        file(
          `## Round 1\n\n${question('Q1', ' A', 'rejected-framing')}\n${question('Q2', ' B', 'nonsense')}`,
        ),
      ),
    )
    expect(feature.questions[0]?.effect).toBe('rejected-framing')
    expect(feature.questions[1]?.effect).toBeUndefined()
    expect(feature.warnings.some((w) => w.includes("unknown effect 'nonsense'"))).toBe(true)
  })
})

describe('readFeature — tasks', () => {
  const GRAPH = [
    '| # | Title | Domain | Complexity | Depends on | Cases |',
    '|---|---|---|---|---|---|',
    '| T1 | Spec types | source | medium | — | UT-01…UT-03 |',
    '| T2 | Derivation | source | medium | T1 | UT-04, IT-02 |',
    '| T3 | Lints | source | high | T1, T2 | IT-05 |',
  ].join('\n')

  const bodies = '\n## T1\n\n- [x] T1 — Spec types\n\n## T2\n\n- [ ] **T2** — Derivation\n'

  const file = (body: string): Record<string, string> => ({
    'decisions.md': DECISIONS,
    'tasks.md': body,
  })

  it('UT-09 reads done state from the task body checkbox', () => {
    const feature = readFeature(build(file(GRAPH + bodies)))
    expect(feature.tasks.map((t) => [t.id, t.done])).toEqual([
      ['T1', true],
      ['T2', false],
      ['T3', false],
    ])
  })

  it('UT-09 keeps the graph order and reads titles', () => {
    const feature = readFeature(build(file(GRAPH + bodies)))
    expect(feature.tasks.map((t) => t.title)).toEqual(['Spec types', 'Derivation', 'Lints'])
  })

  it('UT-10 yields an empty dependency list, never undefined', () => {
    const feature = readFeature(build(file(GRAPH + bodies)))
    expect(feature.tasks[0]?.dependsOn).toEqual([])
    expect(feature.tasks[2]?.dependsOn).toEqual(['T1', 'T2'])
  })

  it('UT-11 expands a range and a comma list into ids in order', () => {
    const feature = readFeature(build(file(GRAPH + bodies)))
    expect(feature.tasks[0]?.testIds).toEqual(['UT-01', 'UT-02', 'UT-03'])
    expect(feature.tasks[1]?.testIds).toEqual(['UT-04', 'IT-02'])
  })

  it('UT-11 warns about a checkbox for a task with no graph row', () => {
    const feature = readFeature(build(file(`${GRAPH}\n\n## T9\n\n- [x] T9 — ghost\n`)))
    expect(feature.warnings.some((w) => w.includes("checkbox for 'T9'"))).toBe(true)
  })

  it('UT-11 falls back to the documented column order without a header', () => {
    const rows = '| T1 | Spec types | source | medium | — | UT-01, UT-02 |'
    const feature = readFeature(build(file(rows)))
    expect(feature.tasks[0]?.testIds).toEqual(['UT-01', 'UT-02'])
    expect(feature.tasks[0]?.dependsOn).toEqual([])
  })
})

describe('expandCaseIds', () => {
  it('UT-11 expands an inclusive range', () => {
    expect(expandCaseIds('UT-01…UT-04')).toEqual(['UT-01', 'UT-02', 'UT-03', 'UT-04'])
  })

  it('UT-11 accepts three dots as well as an ellipsis', () => {
    expect(expandCaseIds('IT-08...IT-10')).toEqual(['IT-08', 'IT-09', 'IT-10'])
  })

  it('UT-11 deduplicates while keeping first-seen order', () => {
    expect(expandCaseIds('UT-02, UT-01…UT-02, UT-01')).toEqual(['UT-02', 'UT-01'])
  })

  it('UT-11 drops a cross-prefix or descending range instead of guessing', () => {
    expect(expandCaseIds('UT-01…IT-05')).toEqual([])
    expect(expandCaseIds('UT-09…UT-04')).toEqual([])
  })
})

describe('readFeature — artifacts and test ids', () => {
  it('UT-12 collects case ids from every case table, deduplicated', () => {
    const tests = [
      '| ID | Input | Expected |',
      '| UT-01 | x | y |',
      '| UT-02 | x | y |',
      '',
      '| ID | Input | Expected |',
      '| IT-01 | x | y |',
      '',
      'Coverage: UT-01 appears again here and must not double.',
      '| UT-01 | x | y |',
    ].join('\n')
    const feature = read({ 'decisions.md': DECISIONS, 'tests.md': tests })
    expect(feature.testIds).toEqual(['UT-01', 'UT-02', 'IT-01'])
  })

  it('UT-12 ignores ids mentioned in prose rather than declared as a row', () => {
    const feature = read({
      'decisions.md': DECISIONS,
      'tests.md': 'UT-99 is discussed but never declared.\n\n| UT-01 | x | y |\n',
    })
    expect(feature.testIds).toEqual(['UT-01'])
  })

  it('UT-13 reports the prune record only when the section exists', () => {
    const withCut = read({ 'decisions.md': `${DECISIONS}\n## Cut, and why\n\n| a | b | c |\n` })
    const without = read({ 'decisions.md': DECISIONS })
    expect(withCut.has.cutSection).toBe(true)
    expect(without.has.cutSection).toBe(false)
  })

  it('UT-14 treats absent optional artifacts as valid, with no warning', () => {
    const feature = read({ 'decisions.md': DECISIONS, 'context.md': '# Context\n' })
    expect(feature.has).toEqual({
      context: true,
      prd: false,
      tdd: false,
      tests: false,
      tasks: false,
      cutSection: false,
    })
    expect(feature.warnings).toEqual([])
    expect(feature.questions).toEqual([])
    expect(feature.tasks).toEqual([])
    expect(feature.testIds).toEqual([])
  })

  it('UT-15 returns an empty feature and one warning for a directory that is not there', () => {
    const feature = readFeature(path.join(os.tmpdir(), 'lumem-spec-absent', '404-nope'))
    expect(feature.slug).toBe('404-nope')
    expect(feature.has).toEqual({
      context: false,
      prd: false,
      tdd: false,
      tests: false,
      tasks: false,
      cutSection: false,
    })
    expect(feature.warnings).toHaveLength(1)
    expect(feature.warnings[0]).toContain('not a readable directory')
  })

  it('UT-15 never throws on a path that is a file rather than a directory', () => {
    const dir = build({ 'decisions.md': DECISIONS })
    const asFile = path.join(dir, 'decisions.md')
    expect(() => readFeature(asFile)).not.toThrow()
    expect(readFeature(asFile).warnings[0]).toContain('not a readable directory')
  })
})
