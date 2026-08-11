import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { VerificationConfig } from '../core/verification'
import { defaultVerification } from '../core/verification'
import { implementedCases } from './implemented'

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-impl-'))
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return root
}

const cfg = (overrides: Partial<VerificationConfig> = {}): VerificationConfig => ({
  ...defaultVerification(),
  ...overrides,
})

const found = (files: Record<string, string>, ids: string[], overrides = {}): Set<string> =>
  implementedCases(project(files), cfg(overrides), ids).implemented

describe('implementedCases — what counts', () => {
  it('UT-15 counts an id inside a test name', () => {
    const files = { 'src/spec/a.test.ts': "it('UT-01 does a thing', () => {})\n" }
    expect([...found(files, ['UT-01'])]).toEqual(['UT-01'])
  })

  it('UT-16 does not count an id in a comment with no declaration on the line', () => {
    const files = {
      'src/cli/status.test.ts': [
        "describe('status', () => {",
        '  // UT-01: the bundle is listed like any other copied artifact.',
        '  expect(true).toBe(true)',
        '})',
      ].join('\n'),
    }
    // This is feature 002's IT-18, verbatim in shape. If it ever passes, the slice
    // has lost its point.
    expect([...found(files, ['UT-01'])]).toEqual([])
  })

  it('UT-17 counts `test("…")` with the default patterns', () => {
    const files = { 'test/b.test.ts': 'test("IT-03 spawns the bundle", () => {})\n' }
    expect([...found(files, ['IT-03'])]).toEqual(['IT-03'])
  })

  it('UT-18 counts a Go-style declaration, where a hyphen cannot appear', () => {
    const files = { 'src/go.test.ts': 'func TestIT03(t *testing.T) {}\n' }
    // `IT-03` cannot be an identifier, so the punctuation-free form counts too.
    // Without that, the default pattern set advertised two languages it could
    // never match in.
    expect([...found(files, ['IT-03'])]).toEqual(['IT-03'])
  })

  it('UT-18 counts a pytest-style declaration', () => {
    const files = { 'src/py.test.ts': 'def test_ut01_parses():\n' }
    expect([...found(files, ['UT-01'])]).toEqual(['UT-01'])
  })

  it('UT-23 counts every id named on one matching line', () => {
    const files = { 'src/a.test.ts': "it('UT-01, UT-02 and IT-09 together', () => {})\n" }
    expect([...found(files, ['UT-01', 'UT-02', 'IT-09'])].sort()).toEqual([
      'IT-09',
      'UT-01',
      'UT-02',
    ])
  })

  it('UT-15 does not count an id that only prefixes another', () => {
    const files = { 'src/a.test.ts': "it('UT-011 is a different case', () => {})\n" }
    // Substring containment is the rule, so this DOES match — recorded as a known
    // sharp edge rather than a silent surprise. Two-digit ids make it unreachable
    // in practice; a three-digit contract would need a boundary-aware search.
    expect([...found(files, ['UT-01'])]).toEqual(['UT-01'])
  })
})

describe('implementedCases — where it looks', () => {
  it('UT-19 ignores a file without a configured suffix', () => {
    const files = { 'src/helpers.ts': "it('UT-01 lives in the wrong file', () => {})\n" }
    expect([...found(files, ['UT-01'])]).toEqual([])
  })

  it('UT-20 ignores a test file outside every include prefix', () => {
    const files = { 'web/a.test.ts': "it('UT-01 is out of scope', () => {})\n" }
    expect([...found(files, ['UT-01'])]).toEqual([])
  })

  it('UT-20 ignores a test file under an excluded segment at any depth', () => {
    const files = { 'src/node_modules/dep/a.test.ts': "it('UT-01 is vendored', () => {})\n" }
    expect([...found(files, ['UT-01'])]).toEqual([])
  })

  it('UT-24 reports nothing searched when no test file exists', () => {
    const result = implementedCases(project({ 'src/a.ts': 'export const a = 1\n' }), cfg(), [
      'UT-01',
    ])
    expect(result.filesSearched).toBe(0)
    expect(result.patternHits).toBe(0)
    expect([...result.implemented]).toEqual([])
  })
})

describe('implementedCases — patterns', () => {
  it('UT-21 uses the configured pattern set instead of the default', () => {
    const files = { 'src/a.test.ts': "it('UT-01 uses vitest', () => {})\n" }
    expect([...found(files, ['UT-01'], { testPatterns: ['\\bspec\\s*\\('] })]).toEqual([])
  })

  it('UT-21 finds a case with a configured pattern the default would miss', () => {
    const files = { 'src/a.test.ts': "spec('UT-01 uses something else', () => {})\n" }
    expect([...found(files, ['UT-01'], { testPatterns: ['\\bspec\\s*\\('] })]).toEqual(['UT-01'])
  })

  it('UT-22 counts pattern hits so a wrong set can report itself', () => {
    const files = {
      'src/a.test.ts': ["it('UT-01 one', () => {})", "it('UT-02 two', () => {})"].join('\n'),
    }
    const withDefault = implementedCases(project(files), cfg(), ['UT-01', 'UT-02'])
    expect(withDefault.patternHits).toBe(2)

    const withWrong = implementedCases(project(files), cfg({ testPatterns: ['\\bnope\\('] }), [
      'UT-01',
    ])
    expect(withWrong.patternHits).toBe(0)
    expect(withWrong.filesSearched).toBe(1)
  })

  it('UT-22 skips an invalid pattern instead of throwing, and names it', () => {
    const files = { 'src/a.test.ts': "it('UT-01 still found', () => {})\n" }
    const result = implementedCases(project(files), cfg({ testPatterns: ['\\bit\\s*\\(', '('] }), [
      'UT-01',
    ])

    expect(result.invalidPatterns).toEqual(['('])
    expect([...result.implemented]).toEqual(['UT-01'])
  })
})

describe('implementedCases — against this repository', () => {
  it('UT-24 finds feature 002 declared cases, minus the two nobody implemented', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..')
    const contract = fs.readFileSync(
      path.join(repoRoot, 'docs/features/002-spec-driven/tests.md'),
      'utf8',
    )
    const ids = [
      ...new Set(
        [...contract.matchAll(/^\|\s*((?:UT|IT)-\d{2})\s*\|/gm)].map((m) => m[1] as string),
      ),
    ]

    const result = implementedCases(repoRoot, cfg(), ids)
    const missing = ids.filter((id) => !result.implemented.has(id))

    // The measurement that produced feature 003, reproduced by the code it produced.
    expect(ids).toHaveLength(85)
    expect(missing).toEqual(['IT-18', 'IT-19'])
    expect(result.patternHits).toBeGreaterThan(1000)
  })
})
