import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main, parseArgs } from './cli-main'
import {
  buildBaseline,
  compareToBaseline,
  readBaseline,
  renderComparison,
  renderReport,
  writeBaseline,
  writeResults,
} from './report'
import { DEFAULT_RUNS } from './run-eval'
import type { EvalReport, FixtureResult, FixtureScore } from './types'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-eval-report-'))
  tempDirs.push(dir)
  return dir
}

function score(overrides?: Partial<FixtureScore>): FixtureScore {
  return {
    runs: 3,
    schemaValid: 1,
    secretLeak: 0,
    emptyPatchRate: 0,
    addCount: 1,
    expectationsMet: 1,
    variance: { verdictAgreement: 1, addSpread: 0 },
    hardGateFailures: [],
    passed: true,
    ...overrides,
  }
}

function fixture(name: string, overrides?: Partial<FixtureScore>): FixtureResult {
  return { fixture: name, description: `${name} description`, runs: [], score: score(overrides) }
}

function report(fixtures: FixtureResult[]): EvalReport {
  const passed = fixtures.every((entry) => entry.score.passed)
  return {
    startedAt: '2026-08-07T10:00:00.000Z',
    finishedAt: '2026-08-07T10:01:00.000Z',
    mode: 'mock',
    harnessId: 'claude-code',
    runsPerFixture: 3,
    fixtures,
    overall: {
      fixtures: fixtures.length,
      totalRuns: fixtures.length * 3,
      schemaValid: Math.min(...fixtures.map((entry) => entry.score.schemaValid)),
      secretLeak: Math.max(...fixtures.map((entry) => entry.score.secretLeak)),
      expectationsMet: Math.min(...fixtures.map((entry) => entry.score.expectationsMet)),
      hardGateFailures: fixtures.flatMap((entry) =>
        entry.score.hardGateFailures.map((failure) => `${entry.fixture}: ${failure}`),
      ),
      passed,
    },
  }
}

describe('baseline round trip', () => {
  it('writes and reads back the scored summary without the per-run detail', () => {
    const file = path.join(tempDir(), 'baseline.json')
    const original = report([fixture('learned-trap'), fixture('trivial-session')])

    writeBaseline(file, buildBaseline(original))
    const loaded = readBaseline(file)

    expect(loaded?.mode).toBe('mock')
    expect(loaded?.runsPerFixture).toBe(3)
    expect(Object.keys(loaded?.fixtures ?? {})).toEqual(['learned-trap', 'trivial-session'])
    expect(loaded?.fixtures['learned-trap']?.expectationsMet).toBe(1)
    expect(loaded?.overall.schemaValid).toBe(1)
  })

  it('returns undefined when there is no baseline yet', () => {
    expect(readBaseline(path.join(tempDir(), 'absent.json'))).toBeUndefined()
  })

  it('throws on a baseline that is not one', () => {
    const file = path.join(tempDir(), 'baseline.json')
    fs.writeFileSync(file, JSON.stringify({ createdAt: 'now' }))
    expect(() => readBaseline(file)).toThrow(/not a valid baseline/)
  })
})

describe('compareToBaseline', () => {
  const baseline = buildBaseline(report([fixture('learned-trap'), fixture('trivial-session')]))

  it('reports nothing when nothing moved', () => {
    const comparison = compareToBaseline(
      report([fixture('learned-trap'), fixture('trivial-session')]),
      baseline,
    )
    expect(comparison.regressions).toEqual([])
    expect(comparison.warnings).toEqual([])
    expect(renderComparison(comparison, baseline)).toContain('no change')
  })

  it('calls a drop in schema validity a regression', () => {
    const comparison = compareToBaseline(
      report([
        fixture('learned-trap', { schemaValid: 0.6667, passed: false }),
        fixture('trivial-session'),
      ]),
      baseline,
    )
    expect(comparison.regressions).toEqual([
      'learned-trap: schemaValid 67% < baseline 100%',
      'overall: schemaValid 67% < baseline 100%',
    ])
  })

  it('calls a new secret leak a regression', () => {
    const comparison = compareToBaseline(
      report([fixture('learned-trap', { secretLeak: 0.3333 }), fixture('trivial-session')]),
      baseline,
    )
    expect(comparison.regressions).toContain('learned-trap: secretLeak 33% > baseline 0%')
  })

  it('calls a drop in expectations a warning, not a regression', () => {
    const comparison = compareToBaseline(
      report([
        fixture('learned-trap', { expectationsMet: 0.5, passed: false }),
        fixture('trivial-session'),
      ]),
      baseline,
    )
    expect(comparison.regressions).toEqual([])
    expect(comparison.warnings).toContain('learned-trap: expectationsMet 50% < baseline 100%')
    expect(renderComparison(comparison, baseline)).toContain('warning')
  })

  it('tolerates noise below the soft thresholds', () => {
    const comparison = compareToBaseline(
      report([
        fixture('learned-trap', { expectationsMet: 0.97, addCount: 1.3 }),
        fixture('trivial-session'),
      ]),
      baseline,
    )
    expect(comparison.regressions).toEqual([])
    expect(comparison.warnings).toEqual([])
  })

  it('warns about a fixture that is new and about one that was skipped', () => {
    const comparison = compareToBaseline(
      report([fixture('learned-trap'), fixture('brand-new')]),
      baseline,
    )
    expect(comparison.warnings).toContain('brand-new: no baseline entry (new fixture?)')
    expect(comparison.warnings).toContain('trivial-session: in the baseline but not run')
  })
})

describe('renderReport', () => {
  const rendered = renderReport(
    report([
      fixture('learned-trap'),
      fixture('trivial-session', {
        emptyPatchRate: 0.3333,
        addCount: 0.6667,
        expectationsMet: 0.5,
        hardGateFailures: ['secretLeak 33% (must be 0%)'],
        secretLeak: 0.3333,
        passed: false,
      }),
    ]),
  )

  it('prints a header, one row per fixture and an overall line', () => {
    expect(rendered).toContain('mode=mock harness=claude-code k=3')
    expect(rendered).toContain('learned-trap')
    expect(rendered).toContain('trivial-session')
    expect(rendered).toContain('overall: 2 fixtures, 6 runs')
  })

  it('spells out the hard-gate failure under the table', () => {
    expect(rendered).toContain('HARD GATE  secretLeak 33% (must be 0%)')
    expect(rendered).toContain('FAIL')
  })
})

describe('writeResults', () => {
  it('writes <ISO>.json with a portable file name', () => {
    const dir = path.join(tempDir(), 'results')
    const file = writeResults(dir, report([fixture('learned-trap')]))

    expect(path.basename(file)).toBe('2026-08-07T10-01-00-000Z.json')
    expect(path.basename(file)).not.toContain(':')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as EvalReport
    expect(parsed.fixtures[0]?.fixture).toBe('learned-trap')
  })
})

describe('parseArgs', () => {
  it('defaults to a real run with the standard k and a results file', () => {
    const parsed = parseArgs([])
    expect('options' in parsed && parsed.options.mock).toBe(false)
    expect('options' in parsed && parsed.options.runs).toBe(DEFAULT_RUNS)
    expect('options' in parsed && parsed.options.resultsDir).toContain('results')
  })

  it('accepts --mock, --runs, repeated and comma-separated --fixture', () => {
    const parsed = parseArgs([
      '--mock',
      '--runs',
      '5',
      '--fixture',
      'trivial-session',
      '--fixture',
      'learned-trap,secret-in-prompt',
    ])
    expect('options' in parsed && parsed.options.mock).toBe(true)
    expect('options' in parsed && parsed.options.runs).toBe(5)
    expect('options' in parsed ? parsed.options.fixtures : []).toEqual([
      'trivial-session',
      'learned-trap',
      'secret-in-prompt',
    ])
  })

  it('drops the results file on --no-results', () => {
    const parsed = parseArgs(['--no-results'])
    expect('options' in parsed && parsed.options.resultsDir).toBeUndefined()
  })

  it('rejects a bad --runs and an unknown flag', () => {
    expect(parseArgs(['--runs', 'lots'])).toEqual({
      error: "--runs expects a positive integer, got 'lots'",
    })
    expect(parseArgs(['--runs', '0'])).toEqual({
      error: "--runs expects a positive integer, got '0'",
    })
    expect(parseArgs(['--turbo'])).toEqual({ error: "unknown argument '--turbo'" })
  })
})

describe('main', () => {
  it('prints usage and exits 0 on --help', async () => {
    const lines: string[] = []
    const code = await main(['--help'], (line: string) => lines.push(line))
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('npm run eval')
  })

  it('exits 2 and prints the usage on a bad flag', async () => {
    const errors: string[] = []
    const code = await main(
      ['--nope'],
      () => undefined,
      (line: string) => errors.push(line),
    )
    expect(code).toBe(2)
    expect(errors[0]).toContain("unknown argument '--nope'")
  })

  it('runs a mock eval end to end and exits 0', async () => {
    const dir = tempDir()
    const lines: string[] = []
    const code = await main(
      [
        '--mock',
        '--runs',
        '1',
        '--fixture',
        'trivial-session',
        '--results-dir',
        dir,
        '--baseline',
        path.join(dir, 'baseline.json'),
        '--update-baseline',
      ],
      (line: string) => lines.push(line),
    )

    expect(code).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain('trivial-session')
    expect(output).toContain('PASS')
    expect(fs.readdirSync(dir)).toContain('baseline.json')
    expect(fs.readdirSync(dir).some((name) => name.endsWith('.json'))).toBe(true)
  })

  it('exits 1 when the run does not meet its expectations', async () => {
    const mockDir = tempDir()
    // A model that writes nothing where the recovery signal demands a fact.
    fs.writeFileSync(
      path.join(mockDir, 'learned-trap.json'),
      JSON.stringify({
        description: 'an under-writing model',
        responses: [{ version: 1, add: [], replace: [], remove: [] }],
      }),
    )

    const lines: string[] = []
    const code = await main(
      ['--mock-dir', mockDir, '--runs', '1', '--fixture', 'learned-trap', '--no-results'],
      (line: string) => lines.push(line),
    )

    expect(code).toBe(1)
    const output = lines.join('\n')
    expect(output).toContain('FAIL')
    expect(output).toContain('emptyPatch: expected non-empty, got empty')
  })

  it('exits 1 when a hard gate regressed against the baseline', async () => {
    const dir = tempDir()
    const mockDir = path.join(dir, 'mocks')
    fs.mkdirSync(mockDir, { recursive: true })
    fs.writeFileSync(
      path.join(mockDir, 'trivial-session.json'),
      JSON.stringify({
        description: 'a model that answers in prose',
        responses: ['no notes today'],
      }),
    )
    writeBaseline(
      path.join(dir, 'baseline.json'),
      buildBaseline(report([fixture('trivial-session', { emptyPatchRate: 1, addCount: 0 })])),
    )

    const lines: string[] = []
    const code = await main(
      [
        '--mock-dir',
        mockDir,
        '--runs',
        '1',
        '--fixture',
        'trivial-session',
        '--no-results',
        '--baseline',
        path.join(dir, 'baseline.json'),
      ],
      (line: string) => lines.push(line),
    )

    expect(code).toBe(1)
    expect(lines.join('\n')).toContain(
      'REGRESSION  trivial-session: schemaValid 0% < baseline 100%',
    )
  })
})
