import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { serializeAdr } from './format'
import { lintAdrs } from './lint'
import type { AdrSet } from './store'
import { readAdrs } from './store'

const A = '2026-01-01-a.md'
const B = '2026-02-02-b.md'
const C = '2026-03-03-c.md'
const D = '2026-04-04-d.md'
const E = '2026-05-05-e.md'
const GHOST = '2026-09-09-ghost.md'

function tmpDocs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-adr-lint-'))
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

/** Write a file the serializer would never produce, for the tolerant-parse cases. */
function writeRaw(docsDir: string, id: string, content: string): void {
  const adrDir = path.join(docsDir, 'adr')
  fs.mkdirSync(adrDir, { recursive: true })
  fs.writeFileSync(path.join(adrDir, id), content)
}

/**
 * Build a set the way the CLI does: real files, read back through `readAdrs`, so
 * every id, warning and supersedence link in the fixture is the genuine article.
 */
function setOf(write: (docsDir: string) => void): AdrSet {
  const docsDir = tmpDocs()
  write(docsDir)
  return readAdrs(docsDir)
}

function kinds(set: AdrSet): string[] {
  return lintAdrs(set).map((finding) => finding.kind)
}

function rotate<T>(items: T[], by: number): T[] {
  return [...items.slice(by), ...items.slice(0, by)]
}

describe('lintAdrs — gates', () => {
  it('reports broken-supersedes when the target is not an ADR on disk', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A)
      writeAdr(docs, B, { supersedes: GHOST })
    })

    const findings = lintAdrs(set)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('broken-supersedes')
    expect(findings[0]?.severity).toBe('gate')
    expect(findings[0]?.ids).toEqual([B])
    expect(findings[0]?.message).toContain(GHOST)
  })

  it('stays silent when supersedes names an ADR that exists', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A)
      writeAdr(docs, B, { supersedes: A })
    })

    expect(lintAdrs(set)).toEqual([])
  })

  it('skips a module rule supersedes, which this slice cannot resolve', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A, { supersedes: 'backend-dotnet/x' })
    })

    expect(lintAdrs(set)).toEqual([])
  })

  it('reports a two-member cycle once, listing both members', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A, { supersedes: B })
      writeAdr(docs, B, { supersedes: A })
    })

    const findings = lintAdrs(set)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('supersedes-cycle')
    expect(findings[0]?.severity).toBe('gate')
    expect(findings[0]?.ids).toEqual([A, B])
  })

  it('reports a three-member cycle once, in the same order whatever the input order', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A, { supersedes: B })
      writeAdr(docs, B, { supersedes: C })
      writeAdr(docs, C, { supersedes: A })
    })

    const findings = lintAdrs(set)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('supersedes-cycle')
    expect(findings[0]?.ids).toEqual([A, B, C])

    // Same graph, a different member visited first: the finding must not move.
    for (const by of [1, 2]) {
      expect(lintAdrs({ ...set, adrs: rotate(set.adrs, by) })).toEqual(findings)
    }
  })

  it('reports a self-supersedence as a one-member cycle', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A, { supersedes: A })
    })

    const findings = lintAdrs(set)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('supersedes-cycle')
    expect(findings[0]?.ids).toEqual([A])
    expect(findings[0]?.message).toContain(A)
  })

  it('reports only the cycle when a healthy chain sits beside it', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A, { supersedes: B })
      writeAdr(docs, B, { supersedes: A })
      writeAdr(docs, C)
      writeAdr(docs, D, { supersedes: C })
      writeAdr(docs, E, { supersedes: D })
    })

    const findings = lintAdrs(set)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ids).toEqual([A, B])
  })

  it('leaves an ADR pointing into a cycle out of the cycle members', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A, { supersedes: B })
      writeAdr(docs, B, { supersedes: A })
      writeAdr(docs, C, { supersedes: A })
    })

    const findings = lintAdrs(set)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ids).toEqual([A, B])
  })

  it('reports both gates when a broken link and a cycle coexist', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A, { supersedes: B })
      writeAdr(docs, B, { supersedes: A })
      writeAdr(docs, C, { supersedes: GHOST })
    })

    expect(kinds(set)).toEqual(['broken-supersedes', 'supersedes-cycle'])
  })
})

describe('lintAdrs — informational', () => {
  it('reports missing-frontmatter from the warnings the parser already produced', () => {
    const set = setOf((docs) => {
      writeRaw(
        docs,
        A,
        [
          '---',
          'title: No area',
          `date: ${A.slice(0, 10)}`,
          'summary: It has none.',
          '---',
          '',
        ].join('\n'),
      )
    })

    const findings = lintAdrs(set)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('missing-frontmatter')
    expect(findings[0]?.severity).toBe('info')
    expect(findings[0]?.ids).toEqual([A])
    expect(findings[0]?.message).toContain('area')
    expect(findings[0]?.message).toBe(set.byId.get(A)?.warnings[0])
  })

  it('reports one missing-frontmatter per parser warning', () => {
    const set = setOf((docs) => {
      writeRaw(docs, A, ['---', 'title: Only a title', '---', ''].join('\n'))
    })

    const findings = lintAdrs(set)
    expect(findings.map((finding) => finding.kind)).toEqual([
      'missing-frontmatter',
      'missing-frontmatter',
      'missing-frontmatter',
    ])
    expect(findings.map((finding) => finding.message)).toEqual(set.byId.get(A)?.warnings)
  })

  it('reports date-mismatch when the date field disagrees with the filename prefix', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A, { date: '2020-07-07' })
    })

    const findings = lintAdrs(set)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('date-mismatch')
    expect(findings[0]?.severity).toBe('info')
    expect(findings[0]?.ids).toEqual([A])
    expect(findings[0]?.message).toContain('2020-07-07')
  })

  it('does not report date-mismatch when the date is merely absent', () => {
    const set = setOf((docs) => {
      writeRaw(docs, A, 'no frontmatter at all\n')
    })

    expect(kinds(set)).toEqual(['missing-frontmatter'])
  })

  it('reports todo-summary while the seeded placeholder is still there', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A, { summary: 'TODO: one sentence on what this decides' })
    })

    const findings = lintAdrs(set)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('todo-summary')
    expect(findings[0]?.severity).toBe('info')
    expect(findings[0]?.ids).toEqual([A])
  })

  it('does not report todo-summary for a summary merely mentioning a todo', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A, { summary: 'The TODO: marker belongs at the start to count.' })
    })

    expect(lintAdrs(set)).toEqual([])
  })

  it('reports nothing for a clean set', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A)
      writeAdr(docs, B, { supersedes: A })
      writeAdr(docs, C)
    })

    expect(lintAdrs(set)).toEqual([])
  })

  it('reports nothing for an empty set', () => {
    expect(lintAdrs(readAdrs(path.join(tmpDocs(), 'nowhere')))).toEqual([])
  })

  it('keeps checking the other ADRs when one has malformed frontmatter', () => {
    const set = setOf((docs) => {
      writeRaw(docs, A, 'this file never opens a fence\n')
      writeAdr(docs, B, { supersedes: GHOST })
      writeAdr(docs, C, { summary: 'TODO: still to write' })
    })

    const findings = lintAdrs(set)
    expect(findings.map((finding) => [finding.kind, finding.ids])).toEqual([
      ['broken-supersedes', [B]],
      ['missing-frontmatter', [A]],
      ['todo-summary', [C]],
    ])
  })
})

describe('lintAdrs — ordering', () => {
  it('puts gates before information', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A, { summary: 'TODO: write me' })
      writeAdr(docs, B, { supersedes: GHOST })
    })

    const findings = lintAdrs(set)
    expect(findings.map((finding) => finding.severity)).toEqual(['gate', 'info'])
    expect(findings.map((finding) => finding.kind)).toEqual(['broken-supersedes', 'todo-summary'])
  })

  it('sorts by kind, then by the first id, within a severity', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A, { date: '2020-01-01', summary: 'TODO: write me' })
      writeAdr(docs, B, { date: '2020-01-01' })
    })

    expect(lintAdrs(set).map((finding) => [finding.kind, finding.ids[0]])).toEqual([
      ['date-mismatch', A],
      ['date-mismatch', B],
      ['todo-summary', A],
    ])
  })

  it('is pure: the same set twice yields the same findings and no mutation', () => {
    const set = setOf((docs) => {
      writeAdr(docs, A, { supersedes: B })
      writeAdr(docs, B, { supersedes: A })
      writeAdr(docs, C, { summary: 'TODO: write me' })
    })
    const before = JSON.stringify([set.adrs, [...set.supersededBy]])

    const first = lintAdrs(set)
    expect(lintAdrs(set)).toEqual(first)
    expect(JSON.stringify([set.adrs, [...set.supersededBy]])).toBe(before)
  })
})
