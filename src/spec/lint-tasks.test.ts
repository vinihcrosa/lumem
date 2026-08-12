import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultVerification } from '../core/verification'
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
  // A real feature lives inside a lumem project, and since 003 the tasks phase
  // says so out loud: without a root there is nothing to check cases against.
  fs.mkdirSync(path.join(root, '.lumem'))
  const dir = path.join(root, SLUG)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'decisions.md'), DECISIONS)
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  // Ownership and implementation are different facts, and these cases are about
  // ownership. Every id the fixture declares gets a test naming it, so the
  // implementation check stays quiet unless a case sets out to trip it.
  const declared = [...(files['tests.md'] ?? '').matchAll(/\|\s*((?:UT|IT)-\d{2})\s*\|/g)].map(
    (m) => m[1] as string,
  )
  if (declared.length > 0) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'src', 'generated.test.ts'),
      declared.map((id) => `it('${id} is implemented', () => {})`).join('\n'),
    )
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

describe('lintSpec tasks — implementation (003 T6)', () => {
  /** A project whose test file names exactly `implementedIds`. */
  function projectWith(declared: string[], implementedIds: string[], patterns?: string[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-impl-lint-'))
    fs.mkdirSync(path.join(root, '.lumem'))
    const dir = path.join(root, SLUG)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'decisions.md'), DECISIONS)
    fs.writeFileSync(path.join(dir, 'tests.md'), tests(declared))
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      graph([`| T1 | Parse | source | low | — | ${declared.join(', ')} |`]),
    )
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(
      path.join(root, 'src', 'a.test.ts'),
      implementedIds.map((id) => `it('${id} works', () => {})`).join('\n'),
    )
    void patterns
    return dir
  }

  it('UT-43 gates a declared case that no test names', () => {
    const dir = projectWith(['UT-01', 'UT-02'], ['UT-01'])
    const findings = lintSpec(readFeature(dir), 'tasks')

    const finding = findings.find((f) => f.kind === 'unimplemented-case')
    expect(finding?.severity).toBe('gate')
    expect(finding?.ids).toEqual(['UT-02'])
    expect(finding?.message).toContain('owned, not written')
  })

  it('UT-44 says nothing when every declared case is named', () => {
    const dir = projectWith(['UT-01', 'UT-02'], ['UT-01', 'UT-02'])
    expect(kinds(lintSpec(readFeature(dir), 'tasks'))).not.toContain('unimplemented-case')
  })

  it('UT-43 does not count a case named only in a comment', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-impl-lint-'))
    fs.mkdirSync(path.join(root, '.lumem'))
    const dir = path.join(root, SLUG)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'decisions.md'), DECISIONS)
    fs.writeFileSync(path.join(dir, 'tests.md'), tests(['UT-01']))
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      graph(['| T1 | Parse | source | low | — | UT-01 |']),
    )
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(
      path.join(root, 'src', 'a.test.ts'),
      ["it('something else', () => {})", '// UT-01: covered over there somewhere'].join('\n'),
    )

    // Feature 002's IT-18 in miniature: the shape this whole slice exists for.
    expect(kinds(lintSpec(readFeature(dir), 'tasks'))).toContain('unimplemented-case')
  })

  it('UT-45 gates a pattern set that matches nothing, once', () => {
    const dir = projectWith(['UT-01', 'UT-02'], ['UT-01', 'UT-02'])
    const findings = lintSpec(readFeature(dir), 'tasks', {
      readVerificationConfig: () => ({ ...defaultVerification(), testPatterns: ['\\bnope\\('] }),
    })

    const finding = findings.find((f) => f.kind === 'no-tests-recognised')
    expect(finding?.severity).toBe('gate')
    expect(finding?.message).toContain('do not match this project')
  })

  it('UT-46 replaces every unimplemented finding with the one that names the cause', () => {
    const dir = projectWith(['UT-01', 'UT-02', 'UT-03'], [])
    const findings = lintSpec(readFeature(dir), 'tasks', {
      readVerificationConfig: () => ({ ...defaultVerification(), testPatterns: ['\\bnope\\('] }),
    })

    expect(kinds(findings)).toContain('no-tests-recognised')
    // Three cases would otherwise be three findings hiding their own cause.
    expect(kinds(findings)).not.toContain('unimplemented-case')
  })

  it('UT-45 reports cases as unimplemented, not as a pattern problem, when no test file exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-impl-lint-'))
    fs.mkdirSync(path.join(root, '.lumem'))
    const dir = path.join(root, SLUG)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'decisions.md'), DECISIONS)
    fs.writeFileSync(path.join(dir, 'tests.md'), tests(['UT-01']))
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      graph(['| T1 | Parse | source | low | — | UT-01 |']),
    )

    // No files searched is not evidence about the patterns.
    const findings = lintSpec(readFeature(dir), 'tasks')
    expect(kinds(findings)).toContain('unimplemented-case')
    expect(kinds(findings)).not.toContain('no-tests-recognised')
  })

  it('UT-47 returns an ownership finding and an implementation finding together', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-impl-lint-'))
    fs.mkdirSync(path.join(root, '.lumem'))
    const dir = path.join(root, SLUG)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'decisions.md'), DECISIONS)
    fs.writeFileSync(path.join(dir, 'tests.md'), tests(['UT-01', 'UT-02']))
    // UT-02 is declared, owned by nobody, and written by nobody.
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      graph(['| T1 | Parse | source | low | — | UT-01 |']),
    )
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src', 'a.test.ts'), "it('UT-01 works', () => {})")

    const found = kinds(lintSpec(readFeature(dir), 'tasks'))
    expect(found).toContain('orphan-test-id')
    expect(found).toContain('unimplemented-case')
  })

  it('UT-48 gates a feature outside any lumem project without searching for tests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-impl-lint-'))
    const dir = path.join(root, SLUG)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'decisions.md'), DECISIONS)
    fs.writeFileSync(path.join(dir, 'tests.md'), tests(['UT-01']))
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      graph(['| T1 | Parse | source | low | — | UT-01 |']),
    )

    const findings = lintSpec(readFeature(dir), 'tasks')
    const finding = findings.find((f) => f.kind === 'no-lumem-project')
    expect(finding?.severity).toBe('gate')
    // Skipping silently would make the implementation check pass vacuously,
    // which is the false PASS this feature exists to close.
    expect(kinds(findings)).not.toContain('unimplemented-case')
  })
})
