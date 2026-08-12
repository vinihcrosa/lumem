import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultVerification } from '../core/verification'
import { readFeature } from './feature'
import { computeFingerprint } from './fingerprint'
import type { SpecFinding, SpecLintKind } from './lint'
import { lintSpec } from './lint'

const SLUG = '003-closing-the-test-loop'

const DECISIONS = `---
slug: ${SLUG}
tier: full
created: 2026-08-11
---
# Decisions
`

const GRAPH = [
  '| # | Title | Domain | Complexity | Depends on | Cases |',
  '|---|---|---|---|---|---|',
  '| T1 | Parse | source | low | — | UT-01 |',
  '',
  '## T1',
  '',
  '- [x] T1 — Parse',
].join('\n')

interface Built {
  dir: string
  root: string
  /** The fingerprint of the tree as it stands, so a case can record a real one. */
  hash: string
}

/** A lumem project holding one feature, one source file and one test. */
function build(verdict?: string, gateLine?: string): Built {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-verdict-'))
  fs.mkdirSync(path.join(root, '.lumem'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(root, 'src', 'a.test.ts'), "it('UT-01 works', () => {})\n")

  const dir = path.join(root, SLUG)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'decisions.md'), DECISIONS)

  const body = gateLine === undefined ? GRAPH : `${GRAPH}\n- **Gate:** ${gateLine}`
  const tail = verdict === undefined ? '' : `\n\n## Verdict\n\n${verdict}\n`
  fs.writeFileSync(path.join(dir, 'tasks.md'), `${body}${tail}`)

  return { dir, root, hash: computeFingerprint(root, defaultVerification()).hash }
}

const withCommand = {
  readVerificationConfig: () => ({ ...defaultVerification(), command: 'npm run verify' }),
}

function lint(dir: string, opts = withCommand): SpecFinding[] {
  return lintSpec(readFeature(dir), 'verdict', opts)
}

function kinds(findings: SpecFinding[]): SpecLintKind[] {
  return findings.map((finding) => finding.kind)
}

describe('lintSpec verdict', () => {
  it('UT-49 gates a feature with no verdict recorded', () => {
    const finding = lint(build().dir).find((f) => f.kind === 'verdict-absent')
    expect(finding?.severity).toBe('gate')
    expect(finding?.message).toContain('nothing here has been claimed')
  })

  it('UT-50 gates a verdict when no command is known anywhere', () => {
    // The fingerprint is irrelevant here: the missing command is judged first.
    const { dir } = build(`- **Result:** PASS\n- **Fingerprint:** ${'0'.repeat(64)}`)
    const findings = lint(dir, { readVerificationConfig: () => defaultVerification() })

    const finding = findings.find((f) => f.kind === 'verdict-unverifiable')
    expect(finding?.severity).toBe('gate')
    expect(finding?.message).toContain('lumem.config.json')
  })

  it('UT-51 gates a fingerprint that does not match this tree', () => {
    const zeroes = '0'.repeat(64)
    const { dir } = build(
      `- **Result:** PASS\n- **Command:** npm run verify\n- **Fingerprint:** ${zeroes}`,
    )

    const finding = lint(dir).find((f) => f.kind === 'verdict-stale')
    expect(finding?.severity).toBe('gate')
    expect(finding?.message).toContain('describes something else')
  })

  it('UT-51 gates a verdict that carries no fingerprint at all', () => {
    const { dir } = build('- **Result:** PASS\n- **Command:** npm run verify')
    expect(kinds(lint(dir))).toContain('verdict-stale')
  })

  it('UT-52 gates a recorded failure on a matching tree', () => {
    const { dir, hash } = build('- **Result:** FAIL\n- **Command:** npm run verify')
    // Rewrite with the real fingerprint so the failure is judged, not the staleness.
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      `${GRAPH}\n\n## Verdict\n\n- **Result:** FAIL\n- **Command:** npm run verify\n- **Fingerprint:** ${hash}\n`,
    )

    const finding = lint(dir).find((f) => f.kind === 'verdict-failing')
    expect(finding?.severity).toBe('gate')
  })

  it('UT-53 finds nothing for a passing verdict that matches this tree', () => {
    const { dir, hash } = build()
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      `${GRAPH}\n\n## Verdict\n\n- **Result:** PASS\n- **Command:** npm run verify\n- **Fingerprint:** ${hash}\n`,
    )

    expect(lint(dir)).toEqual([])
  })

  it('UT-53 goes stale as soon as a covered file changes under it', () => {
    const { dir, root, hash } = build()
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      `${GRAPH}\n\n## Verdict\n\n- **Result:** PASS\n- **Command:** npm run verify\n- **Fingerprint:** ${hash}\n`,
    )
    expect(lint(dir)).toEqual([])

    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2\n')
    expect(kinds(lint(dir))).toEqual(['verdict-stale'])
  })

  it('UT-53 is not invalidated by editing the document that records it', () => {
    const { dir, hash } = build()
    const verdictBlock = `\n\n## Verdict\n\n- **Result:** PASS\n- **Command:** npm run verify\n- **Fingerprint:** ${hash}\n`
    fs.writeFileSync(path.join(dir, 'tasks.md'), `${GRAPH}${verdictBlock}`)

    // The whole reason docs/ is excluded: writing the verdict must not void it.
    expect(lint(dir)).toEqual([])
    fs.appendFileSync(path.join(dir, 'tasks.md'), '\nA later note.\n')
    expect(lint(dir)).toEqual([])
  })

  it('UT-50 does not let a task gate stand in for the project command', () => {
    const { dir, hash } = build(undefined, 'vitest run src')
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      `${GRAPH}\n- **Gate:** vitest run src\n\n## Verdict\n\n- **Result:** PASS\n- **Fingerprint:** ${hash}\n`,
    )

    // The verdict is the feature's closing claim, which is broad by definition.
    // A task's gate exists for that task's narrow claim — accepting it here would
    // let "one suite passed" close a whole feature.
    expect(kinds(lint(dir, { readVerificationConfig: () => defaultVerification() }))).toEqual([
      'verdict-unverifiable',
    ])
  })

  it('UT-54 gates a feature outside any lumem project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-verdict-'))
    const dir = path.join(root, SLUG)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'decisions.md'), DECISIONS)
    fs.writeFileSync(path.join(dir, 'tasks.md'), GRAPH)

    const findings = lint(dir)
    expect(kinds(findings)).toEqual(['no-lumem-project'])
    expect(findings[0]?.severity).toBe('gate')
  })

  it('UT-54 gates a feature with no tasks.md to hold a verdict', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-verdict-'))
    fs.mkdirSync(path.join(root, '.lumem'))
    const dir = path.join(root, SLUG)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'decisions.md'), DECISIONS)

    expect(kinds(lint(dir))).toEqual(['artifact-unreadable'])
  })
})
