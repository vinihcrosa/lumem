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

## Cut, and why
`

const QUESTIONS = `## Round 1

### Q1 — does it matter?

**Answer:** yes
**Effect:** accepted
`

const ASSUMPTIONS = `## Assumptions and open questions

| Assumption | Chosen default | Rationale | Confirmed? |
|---|---|---|---|
| One author at a time | No locking | It has never happened | y |
`

const CRITERIA = `## Requirements

| ID | Requirement |
|---|---|
| SPEC-01 | IF the artifact is malformed THEN reading it SHALL yield a warning naming the file and SHALL NOT throw. |
`

function build(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-lint-'))
  const dir = path.join(root, SLUG)
  fs.mkdirSync(dir)
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

/** Lint the prd phase over a feature built from `files`. */
function lint(files: Record<string, string>): SpecFinding[] {
  return lintSpec(readFeature(build(files)), 'prd')
}

function kinds(findings: SpecFinding[]): SpecLintKind[] {
  return findings.map((finding) => finding.kind)
}

/** A PRD with the given requirement lines appended to a clean base. */
function prd(...requirements: string[]): string {
  const rows = requirements.map((text, index) => `| SPEC-${index + 1} | ${text} |`).join('\n')
  return `# PRD\n\n${ASSUMPTIONS}\n## Requirements\n\n| ID | Requirement |\n|---|---|\n${rows}\n`
}

describe('lintSpec prd — questions', () => {
  it('UT-31 gates an unanswered question once the PRD exists', () => {
    const findings = lint({
      'decisions.md': DECISIONS,
      'questions.md': '## Round 1\n\n### Q3 — open?\n\n**Answer:**\n',
      'prd.md': `${ASSUMPTIONS}${CRITERIA}`,
    })
    const open = findings.find((finding) => finding.kind === 'unanswered-question')
    expect(open?.severity).toBe('gate')
    expect(open?.ids).toEqual(['Q3'])
  })

  it('UT-32 does not gate an open question before the PRD exists', () => {
    const findings = lint({
      'decisions.md': DECISIONS,
      'questions.md': '## Round 1\n\n### Q3 — open?\n\n**Answer:**\n',
    })
    expect(kinds(findings)).not.toContain('unanswered-question')
    // The artifact this phase checks is absent, which is what it reports instead.
    expect(kinds(findings)).toEqual(['artifact-unreadable'])
  })

  it('UT-39 reports an answered but unscored question as information', () => {
    const findings = lint({
      'decisions.md': DECISIONS,
      'questions.md': '## Round 1\n\n### Q4 — scored?\n\n**Answer:** yes\n',
      'prd.md': `${ASSUMPTIONS}${CRITERIA}`,
    })
    const unscored = findings.find((finding) => finding.kind === 'unscored-question')
    expect(unscored?.severity).toBe('info')
    expect(unscored?.ids).toEqual(['Q4'])
  })
})

describe('lintSpec prd — assumptions', () => {
  const base = { 'decisions.md': DECISIONS, 'questions.md': QUESTIONS }

  it('UT-33 gates an assumption with no chosen default', () => {
    const findings = lint({
      ...base,
      'prd.md': `| Assumption | Chosen default | Rationale |\n|---|---|---|\n| Ambiguous thing |  | Because |\n${CRITERIA}`,
    })
    const finding = findings.find((f) => f.kind === 'unclosed-ambiguity')
    expect(finding?.severity).toBe('gate')
    expect(finding?.message).toContain('no chosen default')
  })

  it('UT-34 gates an assumption with a default and no rationale', () => {
    const findings = lint({
      ...base,
      'prd.md': `| Assumption | Chosen default | Rationale |\n|---|---|---|\n| Ambiguous thing | We do X |  |\n${CRITERIA}`,
    })
    expect(findings.find((f) => f.kind === 'unclosed-ambiguity')?.message).toContain('no rationale')
  })

  it('UT-33 leaves a fully closed assumption table alone', () => {
    const findings = lint({ ...base, 'prd.md': `${ASSUMPTIONS}${CRITERIA}` })
    expect(kinds(findings)).not.toContain('unclosed-ambiguity')
  })
})

describe('lintSpec prd — risky criteria', () => {
  const base = { 'decisions.md': DECISIONS, 'questions.md': QUESTIONS }

  it('UT-35 gates a failure criterion that says how well rather than what', () => {
    const findings = lint({
      ...base,
      'prd.md': prd('IF the upload fails THEN the system SHALL handle the error gracefully.'),
    })
    const finding = findings.find((f) => f.kind === 'vague-risky-criterion')
    expect(finding?.severity).toBe('gate')
    expect(finding?.message).toContain("'gracefully'")
  })

  it('UT-36 accepts a failure criterion that names a concrete outcome', () => {
    const findings = lint({
      ...base,
      'prd.md': prd(
        'IF the row is already claimed THEN the system SHALL return 409 and leave the row unchanged.',
      ),
    })
    expect(kinds(findings)).not.toContain('vague-risky-criterion')
  })

  it('UT-37 gates a concurrency criterion with a vague adverb instead of a bound', () => {
    const findings = lint({
      ...base,
      'prd.md': prd('WHILE two runs are in flight the system SHALL serialize them appropriately.'),
    })
    expect(kinds(findings)).toContain('vague-risky-criterion')
  })

  it('UT-37 gates a risky condition stated in prose instead of the notation', () => {
    const findings = lint({
      ...base,
      'prd.md': prd('The system SHALL return 503 on a timeout of the upstream call.'),
    })
    expect(findings.find((f) => f.kind === 'vague-risky-criterion')?.message).toContain(
      'stated in prose',
    )
  })

  it('UT-38 leaves an ordinary criterion outside the three dimensions in prose', () => {
    const findings = lint({
      ...base,
      'prd.md': prd('The catalogue SHALL list every published article, newest first.'),
    })
    expect(kinds(findings)).not.toContain('vague-risky-criterion')
  })

  it('UT-38 leaves a requirement *about* the risky dimensions alone', () => {
    // Always-on, so it correctly carries no pattern keyword. The gate flagged this
    // exact line in lumem's own PRD before the prose-condition test was added.
    const findings = lint({
      ...base,
      'prd.md': prd(
        'An acceptance criterion covering a failure path, a state transition, or concurrency SHALL name a concrete outcome.',
      ),
    })
    expect(kinds(findings)).not.toContain('vague-risky-criterion')
  })

  it('UT-38 ignores prose that is not a requirement at all', () => {
    const findings = lint({
      ...base,
      'prd.md': `${ASSUMPTIONS}\nWhen the upload fails we want it handled gracefully, eventually.\n${CRITERIA}`,
    })
    expect(kinds(findings)).not.toContain('vague-risky-criterion')
  })
})

describe('lintSpec prd — clean and sorted', () => {
  it('UT-40 finds nothing in a closed, scored, concrete PRD', () => {
    const findings = lint({
      'decisions.md': DECISIONS,
      'questions.md': QUESTIONS,
      'prd.md': `# PRD\n\n${ASSUMPTIONS}${CRITERIA}`,
    })
    expect(findings).toEqual([])
  })

  it('UT-40 sorts gates ahead of information', () => {
    const findings = lint({
      'decisions.md': DECISIONS,
      'questions.md': '## Round 1\n\n### Q4 — scored?\n\n**Answer:** yes\n',
      'prd.md': prd('IF the upload fails THEN the system SHALL handle it gracefully.'),
    })
    expect(findings[0]?.severity).toBe('gate')
    expect(findings.at(-1)?.severity).toBe('info')
  })
})
