import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const bundlePath = path.join(repoRoot, 'dist', 'lumem-spec.mjs')

const SLUG = '002-spec-driven'

const DECISIONS = `---
slug: ${SLUG}
tier: full
created: 2026-08-11
---
# Decisions

## Cut, and why
`

const QUESTIONS = '## Round 1\n\n### Q1 — settled?\n\n**Answer:** yes\n**Effect:** accepted\n'

const CLEAN_TDD = [
  '# TDD',
  '',
  '| Field | Required | Type | Rule |',
  '|---|---|---|---|',
  '| slug | yes | string | The identifier |',
  '',
  '```ts',
  'export interface NextAction { phase: string }',
  '```',
  '',
  '## Invariants',
  '',
  '1. Phase is always derived.',
].join('\n')

/** A TDD missing every gate but the field table: one finding, and it is a gate. */
const PROSE_TDD = [
  '# TDD',
  '',
  '| Field | Required | Type | Rule |',
  '|---|---|---|---|',
  '| slug | yes | string | The identifier |',
  '',
  'The service will accept the config and return the result.',
].join('\n')

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function runSpec(args: string[], env?: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(process.execPath, [bundlePath, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: env === undefined ? process.env : { ...process.env, ...env },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function build(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-spec-bin-'))
  const dir = path.join(root, SLUG)
  fs.mkdirSync(dir)
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

/** A feature sitting at `execute`, with one task ready. */
function readyFeature(): string {
  return build({
    'decisions.md': DECISIONS,
    'context.md': '# Context\n',
    'questions.md': QUESTIONS,
    'prd.md': '# PRD\n',
    'tdd.md': CLEAN_TDD,
    'tests.md': '| ID | Input | Expected |\n|---|---|---|\n| UT-01 | x | y |\n',
    'tasks.md': [
      '| # | Title | Domain | Complexity | Depends on | Cases |',
      '|---|---|---|---|---|---|',
      '| T1 | Parse | source | low | — | UT-01 |',
      '',
      '## T1',
      '',
      '- [ ] T1 — Parse',
    ].join('\n'),
  })
}

beforeAll(() => {
  expect(fs.existsSync(bundlePath), `bundle not built: ${bundlePath}`).toBe(true)
})

describe('lumem-spec next', () => {
  it('IT-11 exists after the build and runs under bare node', () => {
    const result = runSpec(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('lumem-spec')
  })

  it('IT-01 prints exactly one line in the documented shape', () => {
    const result = runSpec(['next', readyFeature()])
    const lines = result.stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^phase=\S+ action=\S+( target=\S+)?$/)
    expect(lines[0]).toBe('phase=execute action=execute-task target=T1')
  })

  it('IT-02 exits 0 on a well-formed feature', () => {
    expect(runSpec(['next', readyFeature()]).status).toBe(0)
  })

  it('IT-02 exits 0 for a feature directory that does not exist yet', () => {
    const absent = path.join(os.tmpdir(), 'lumem-spec-absent', '404-nope')
    const result = runSpec(['next', absent])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('phase=context action=create-context')
  })

  it('IT-03 exits 1 on a path it cannot read, naming the path', () => {
    const dir = readyFeature()
    const asFile = path.join(dir, 'decisions.md')
    const result = runSpec(['next', asFile])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(asFile)
    expect(result.stderr).toContain('not a directory')
  })

  it('IT-04 emits the same action as JSON', () => {
    const dir = readyFeature()
    const text = runSpec(['next', dir]).stdout.trim()
    const json = JSON.parse(runSpec(['next', dir, '--json']).stdout) as Record<string, string>
    expect(json).toEqual({ phase: 'execute', action: 'execute-task', target: 'T1' })
    expect(text).toContain(`phase=${json.phase}`)
    expect(text).toContain(`action=${json.action}`)
    expect(text).toContain(`target=${json.target}`)
  })

  it('IT-03 rejects --phase on next', () => {
    const result = runSpec(['next', readyFeature(), '--phase', 'tdd'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no --phase')
  })
})

describe('lumem-spec lint', () => {
  it('IT-05 exits 3 when a gate fires', () => {
    const dir = build({ 'decisions.md': DECISIONS, 'tdd.md': PROSE_TDD })
    const result = runSpec(['lint', dir, '--phase', 'tdd'])
    expect(result.status).toBe(3)
    expect(result.stdout).toContain('gate: no-signature-block')
  })

  it('IT-06 exits 0 on a clean artifact and says nothing on stderr', () => {
    const dir = build({ 'decisions.md': DECISIONS, 'tdd.md': CLEAN_TDD })
    const result = runSpec(['lint', dir, '--phase', 'tdd'])
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('IT-07 exits 1 on an unknown phase', () => {
    const result = runSpec(['lint', readyFeature(), '--phase', 'nonsense'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("unknown phase 'nonsense'")
  })

  it('IT-07 exits 1 when --phase is missing entirely', () => {
    expect(runSpec(['lint', readyFeature()]).status).toBe(1)
  })

  it('IT-07 exits 1 on an unknown command and on a missing directory argument', () => {
    expect(runSpec(['frobnicate', readyFeature()]).status).toBe(1)
    expect(runSpec(['next']).status).toBe(1)
  })

  it('IT-08 emits findings as JSON in the shared finding shape', () => {
    const dir = build({ 'decisions.md': DECISIONS, 'tdd.md': PROSE_TDD })
    const result = runSpec(['lint', dir, '--phase', 'tdd', '--json'])
    expect(result.status).toBe(3)
    const findings = JSON.parse(result.stdout) as Record<string, unknown>[]
    expect(findings).toHaveLength(1)
    expect(Object.keys(findings[0] ?? {}).sort()).toEqual([
      'file',
      'ids',
      'kind',
      'message',
      'severity',
    ])
    expect(findings[0]?.severity).toBe('gate')
  })

  it('IT-09 runs with no lumem CLI reachable on PATH', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-empty-path-'))
    const result = runSpec(['next', readyFeature()], { PATH: emptyDir })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('phase=execute action=execute-task target=T1')
  })

  it('IT-10 checks the remaining artifacts when one is malformed', () => {
    const dir = build({
      // Unterminated fence: the frontmatter is lost, the prose is not.
      'decisions.md': `---\nslug: ${SLUG}\ntier: full\n\n## Cut, and why\n`,
      'tests.md':
        '| ID | Input | Expected |\n|---|---|---|\n| UT-01 | x | y |\n| UT-02 | x | y |\n',
      'tasks.md': [
        '| # | Title | Domain | Complexity | Depends on | Cases |',
        '|---|---|---|---|---|---|',
        '| T1 | Parse | source | low | — | UT-01 |',
      ].join('\n'),
    })
    const result = runSpec(['lint', dir, '--phase', 'tasks'])
    expect(result.status).toBe(3)
    expect(result.stdout).toContain('orphan-test-id')
    expect(result.stdout).toContain('UT-02')
  })

  it('IT-10 still advises a next action for a feature whose frontmatter is broken', () => {
    const dir = build({
      'context.md': '# Context\n',
      'decisions.md': `---\nslug: ${SLUG}\ntier: full\n\n# Decisions\n`,
    })
    const result = runSpec(['next', dir])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('phase=scope action=settle-size')
  })
})
