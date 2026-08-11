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

const SIGNATURE = ['```ts', 'export interface NextAction {', '  phase: string', '}', '```'].join(
  '\n',
)

const FIELDS = [
  '| Field | Required | Type | Rule |',
  '|---|---|---|---|',
  '| slug | yes | string | Matches the directory name |',
].join('\n')

const INVARIANTS = '## Invariants\n\n1. Phase is always derived.\n2. No skill edits an ADR.\n'

function build(tdd: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-lint-'))
  const dir = path.join(root, SLUG)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'decisions.md'), DECISIONS)
  fs.writeFileSync(path.join(dir, 'tdd.md'), tdd)
  return dir
}

function lint(tdd: string): SpecFinding[] {
  return lintSpec(readFeature(build(tdd)), 'tdd')
}

function kinds(findings: SpecFinding[]): SpecLintKind[] {
  return findings.map((finding) => finding.kind)
}

/** A TDD that passes every gate, so a case can add exactly one defect. */
const CLEAN = `# TDD\n\n${FIELDS}\n\n${SIGNATURE}\n\n${INVARIANTS}`

describe('lintSpec tdd — field types', () => {
  it('UT-41 gates a field row whose type cell is empty', () => {
    const table = [
      '| Field | Required | Type | Rule |',
      '|---|---|---|---|',
      '| slug | yes |  | Matches the directory name |',
    ].join('\n')
    const findings = lint(`${table}\n\n${SIGNATURE}\n\n${INVARIANTS}`)
    const finding = findings.find((f) => f.kind === 'field-without-type')
    expect(finding?.severity).toBe('gate')
    expect(finding?.message).toContain('no type')
  })

  it('UT-42 accepts a table where every field carries a type', () => {
    expect(kinds(lint(CLEAN))).not.toContain('field-without-type')
  })

  it('UT-42 ignores tables that are not field tables', () => {
    const other = ['| Option | Gain | Cost |', '|---|---|---|', '| A |  | expensive |'].join('\n')
    expect(kinds(lint(`${CLEAN}\n\n${other}`))).not.toContain('field-without-type')
  })
})

describe('lintSpec tdd — declarations', () => {
  it('UT-43 gates a design that declares nothing in a fenced block', () => {
    const findings = lint(
      `# TDD\n\n${FIELDS}\n\nThe service will accept the config.\n\n${INVARIANTS}`,
    )
    const finding = findings.find((f) => f.kind === 'no-signature-block')
    expect(finding?.severity).toBe('gate')
    expect(finding?.message).toContain('one implementation per reader')
  })

  it('UT-44 accepts a fenced block that declares an interface', () => {
    expect(kinds(lint(CLEAN))).not.toContain('no-signature-block')
  })

  it('UT-44 does not count a fenced block that declares nothing', () => {
    const shell = ['```', 'npm run verify', '```'].join('\n')
    const findings = lint(`# TDD\n\n${FIELDS}\n\n${shell}\n\n${INVARIANTS}`)
    expect(kinds(findings)).toContain('no-signature-block')
  })

  it('UT-44 accepts a declaration in a language that is not TypeScript', () => {
    const go = ['```go', 'type TaskClaimer interface {', '}', '```'].join('\n')
    const findings = lint(`# TDD\n\n${FIELDS}\n\n${go}\n\n${INVARIANTS}`)
    expect(kinds(findings)).not.toContain('no-signature-block')
  })
})

describe('lintSpec tdd — invariants', () => {
  it('UT-45 gates an invariants section written as bullets', () => {
    const bullets = '## Invariants\n\n- Phase is always derived.\n- No skill edits an ADR.\n'
    const findings = lint(`# TDD\n\n${FIELDS}\n\n${SIGNATURE}\n\n${bullets}`)
    const finding = findings.find((f) => f.kind === 'invariants-not-ordered')
    expect(finding?.severity).toBe('gate')
    expect(finding?.message).toContain('cite one')
  })

  it('UT-45 gates an invariants section written as prose', () => {
    const prose = '## Invariants\n\nThe phase is derived and ADRs are never edited.\n'
    expect(kinds(lint(`# TDD\n\n${FIELDS}\n\n${SIGNATURE}\n\n${prose}`))).toContain(
      'invariants-not-ordered',
    )
  })

  it('UT-46 accepts a numbered list, blank lines between heading and list included', () => {
    expect(kinds(lint(CLEAN))).not.toContain('invariants-not-ordered')
  })

  it('UT-46 says nothing when there is no invariants section at all', () => {
    const findings = lint(`# TDD\n\n${FIELDS}\n\n${SIGNATURE}\n`)
    expect(kinds(findings)).not.toContain('invariants-not-ordered')
  })
})

describe('lintSpec tdd — deferred and severity', () => {
  it('UT-47 reports a deferred row with no trigger as information', () => {
    const table = [
      '| Deferred | Revisit when |',
      '|---|---|',
      '| A driver | Contracts prove insufficient |',
      '| Mutation testing |  |',
    ].join('\n')
    const findings = lint(`${CLEAN}\n\n## Deferred\n\n${table}`)
    const finding = findings.find((f) => f.kind === 'no-deferred-triggers')
    expect(finding?.severity).toBe('info')
    expect(finding?.message).toContain('no trigger')
  })

  it('UT-48 returns a gate and an information finding together, gates first', () => {
    const table = ['| Deferred | Revisit when |', '|---|---|', '| Mutation testing |  |'].join('\n')
    const bullets = '## Invariants\n\n- Phase is always derived.\n'
    const findings = lint(`${FIELDS}\n\n${SIGNATURE}\n\n${bullets}\n\n${table}`)
    expect(findings.map((f) => f.severity)).toEqual(['gate', 'info'])
    expect(kinds(findings)).toEqual(['invariants-not-ordered', 'no-deferred-triggers'])
  })

  it('UT-48 gates a missing artifact rather than reporting a clean design', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-lint-'))
    const dir = path.join(root, SLUG)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'decisions.md'), DECISIONS)
    const findings = lintSpec(readFeature(dir), 'tdd')
    expect(kinds(findings)).toEqual(['artifact-unreadable'])
    expect(findings[0]?.severity).toBe('gate')
  })
})
