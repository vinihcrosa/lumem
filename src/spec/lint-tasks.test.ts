import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readFeature } from './feature'
import type { SpecFinding, SpecLintKind } from './lint'
import { lintSpec } from './lint'

const SLUG = '002-spec-driven'

const DECISIONS = `---
slug: ${SLUG}
tier: full
created: 2026-08-11
---
# Decisions
`

const HEADER = [
  '| # | Title | Domain | Complexity | Depends on | Cases |',
  '|---|---|---|---|---|---|',
]

/** A tests.md declaring exactly `ids` as case rows. */
function tests(ids: string[]): string {
  return [
    '| ID | Input | Expected |',
    '|---|---|---|',
    ...ids.map((id) => `| ${id} | x | y |`),
  ].join('\n')
}

function graph(rows: string[]): string {
  return [...HEADER, ...rows].join('\n')
}

function build(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-lint-'))
  const dir = path.join(root, SLUG)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'decisions.md'), DECISIONS)
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

function lint(files: Record<string, string>): SpecFinding[] {
  return lintSpec(readFeature(build(files)), 'tasks')
}

function kinds(findings: SpecFinding[]): SpecLintKind[] {
  return findings.map((finding) => finding.kind)
}

describe('lintSpec tasks — case ownership', () => {
  it('UT-49 gates a declared case that no task owns', () => {
    const findings = lint({
      'tests.md': tests(['UT-01', 'UT-07']),
      'tasks.md': graph(['| T1 | Parse | source | low | — | UT-01 |']),
    })
    const finding = findings.find((f) => f.kind === 'orphan-test-id')
    expect(finding?.severity).toBe('gate')
    expect(finding?.ids).toEqual(['UT-07'])
    expect(finding?.message).toContain('missing a slice')
  })

  it('UT-50 gates a case owned by two tasks and names both', () => {
    const findings = lint({
      'tests.md': tests(['IT-03']),
      'tasks.md': graph([
        '| T2 | Derive | source | low | — | IT-03 |',
        '| T5 | Install | source | low | — | IT-03 |',
      ]),
    })
    const finding = findings.find((f) => f.kind === 'duplicate-test-id')
    expect(finding?.severity).toBe('gate')
    expect(finding?.message).toContain('T2 and T5')
  })

  it('UT-53 reports a task owning no case as information', () => {
    const findings = lint({
      'tests.md': tests(['UT-01']),
      'tasks.md': graph([
        '| T1 | Parse | source | low | — | UT-01 |',
        '| T8 | Skills | prompt assets | high | T1 | — |',
      ]),
    })
    const finding = findings.find((f) => f.kind === 'task-without-tests')
    expect(finding?.severity).toBe('info')
    expect(finding?.ids).toEqual(['T8'])
  })
})

describe('lintSpec tasks — the graph', () => {
  it('UT-51 gates a cycle, names every member, and terminates', () => {
    const findings = lint({
      'tests.md': tests(['UT-01', 'UT-02']),
      'tasks.md': graph([
        '| T1 | One | source | low | T2 | UT-01 |',
        '| T2 | Two | source | low | T1 | UT-02 |',
      ]),
    })
    const finding = findings.find((f) => f.kind === 'dependency-cycle')
    expect(finding?.severity).toBe('gate')
    expect(finding?.ids).toEqual(['T1', 'T2'])
  })

  it('UT-51 gates a longer cycle without looping', () => {
    const findings = lint({
      'tests.md': tests(['UT-01']),
      'tasks.md': graph([
        '| T1 | One | source | low | T3 | UT-01 |',
        '| T2 | Two | source | low | T1 | — |',
        '| T3 | Three | source | low | T2 | — |',
      ]),
    })
    expect(findings.find((f) => f.kind === 'dependency-cycle')?.ids).toEqual(['T1', 'T2', 'T3'])
  })

  it('UT-51 leaves a diamond alone: shared dependencies are not a cycle', () => {
    const findings = lint({
      'tests.md': tests(['UT-01']),
      'tasks.md': graph([
        '| T1 | One | source | low | — | UT-01 |',
        '| T2 | Two | source | low | T1 | — |',
        '| T3 | Three | source | low | T1 | — |',
        '| T4 | Four | source | low | T2, T3 | — |',
      ]),
    })
    expect(kinds(findings)).not.toContain('dependency-cycle')
  })

  it('UT-52 gates a dependency that is not in the graph', () => {
    const findings = lint({
      'tests.md': tests(['UT-01']),
      'tasks.md': graph(['| T3 | Three | source | low | T9 | UT-01 |']),
    })
    const finding = findings.find((f) => f.kind === 'unknown-dependency')
    expect(finding?.severity).toBe('gate')
    expect(finding?.ids).toEqual(['T3', 'T9'])
  })
})

describe('lintSpec tasks — clean and missing', () => {
  it('UT-54 finds nothing in a graph where every case is owned once and deps resolve', () => {
    const findings = lint({
      'tests.md': tests(['UT-01', 'UT-02', 'IT-01']),
      'tasks.md': graph([
        '| T1 | Parse | source | low | — | UT-01, UT-02 |',
        '| T2 | Install | source | low | T1 | IT-01 |',
      ]),
    })
    expect(findings).toEqual([])
  })

  it('UT-54 gates a missing task graph rather than reporting it clean', () => {
    const findings = lint({ 'tests.md': tests(['UT-01']) })
    expect(kinds(findings)).toEqual(['artifact-unreadable'])
  })

  it('UT-54 sorts gates ahead of information', () => {
    const findings = lint({
      'tests.md': tests(['UT-01', 'UT-09']),
      'tasks.md': graph([
        '| T1 | Parse | source | low | — | UT-01 |',
        '| T8 | Skills | prompt assets | high | — | — |',
      ]),
    })
    expect(findings.map((f) => f.severity)).toEqual(['gate', 'info'])
  })
})
