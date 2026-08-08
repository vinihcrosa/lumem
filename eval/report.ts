import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { pct } from './score'
import type { EvalMode, EvalReport } from './types'

/** Soft metrics move run to run; only a drop bigger than this is worth a word. */
const EXPECTATION_TOLERANCE = 0.05
const EMPTY_RATE_TOLERANCE = 0.2
const ADD_COUNT_TOLERANCE = 0.5
const EPS = 1e-9

export interface BaselineFixture {
  schemaValid: number
  secretLeak: number
  emptyPatchRate: number
  addCount: number
  expectationsMet: number
}

export interface Baseline {
  createdAt: string
  mode: EvalMode
  runsPerFixture: number
  fixtures: Record<string, BaselineFixture>
  overall: { schemaValid: number; secretLeak: number; expectationsMet: number }
}

const baselineFixtureSchema = z
  .object({
    schemaValid: z.number(),
    secretLeak: z.number(),
    emptyPatchRate: z.number(),
    addCount: z.number(),
    expectationsMet: z.number(),
  })
  .strict()

const baselineSchema = z
  .object({
    createdAt: z.string().min(1),
    mode: z.enum(['real', 'mock', 'injected']),
    runsPerFixture: z.number().int().positive(),
    fixtures: z.record(baselineFixtureSchema),
    overall: z
      .object({ schemaValid: z.number(), secretLeak: z.number(), expectationsMet: z.number() })
      .strict(),
  })
  .strict()

/** The scored summary of a report, with the per-run detail dropped. */
export function buildBaseline(report: EvalReport): Baseline {
  const fixtures: Record<string, BaselineFixture> = {}
  for (const result of report.fixtures) {
    fixtures[result.fixture] = {
      schemaValid: result.score.schemaValid,
      secretLeak: result.score.secretLeak,
      emptyPatchRate: result.score.emptyPatchRate,
      addCount: result.score.addCount,
      expectationsMet: result.score.expectationsMet,
    }
  }
  return {
    createdAt: report.finishedAt,
    mode: report.mode,
    runsPerFixture: report.runsPerFixture,
    fixtures,
    overall: {
      schemaValid: report.overall.schemaValid,
      secretLeak: report.overall.secretLeak,
      expectationsMet: report.overall.expectationsMet,
    },
  }
}

/** Read `eval/baseline.json`. Returns undefined when there is none. Throws when it is broken. */
export function readBaseline(file: string): Baseline | undefined {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const parsed = baselineSchema.safeParse(JSON.parse(raw) as unknown)
  if (!parsed.success) {
    throw new Error(
      `${file}: not a valid baseline: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    )
  }
  return parsed.data
}

export function writeBaseline(file: string, baseline: Baseline): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`)
}

/** `eval/results/<ISO>.json`, with the colons stripped so the name is portable. */
export function writeResults(dir: string, report: EvalReport): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${report.finishedAt.replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  return file
}

export interface BaselineComparison {
  /** Hard-gate losses against the baseline. Any entry means a nonzero exit. */
  regressions: string[]
  /** Soft-metric drift and coverage gaps. Reported, never fatal. */
  warnings: string[]
}

/**
 * Compare a report against a baseline. Only the two hard gates can regress:
 * schema validity may never fall and secret leakage may never rise. Everything
 * else is noise-prone by nature, so it is a warning with a tolerance.
 */
export function compareToBaseline(report: EvalReport, baseline: Baseline): BaselineComparison {
  const regressions: string[] = []
  const warnings: string[] = []

  for (const result of report.fixtures) {
    const before = baseline.fixtures[result.fixture]
    if (before === undefined) {
      warnings.push(`${result.fixture}: no baseline entry (new fixture?)`)
      continue
    }
    const now = result.score

    if (now.schemaValid < before.schemaValid - EPS) {
      regressions.push(
        `${result.fixture}: schemaValid ${pct(now.schemaValid)} < baseline ${pct(before.schemaValid)}`,
      )
    }
    if (now.secretLeak > before.secretLeak + EPS) {
      regressions.push(
        `${result.fixture}: secretLeak ${pct(now.secretLeak)} > baseline ${pct(before.secretLeak)}`,
      )
    }
    if (now.expectationsMet < before.expectationsMet - EXPECTATION_TOLERANCE) {
      warnings.push(
        `${result.fixture}: expectationsMet ${pct(now.expectationsMet)} < baseline ${pct(before.expectationsMet)}`,
      )
    }
    if (Math.abs(now.emptyPatchRate - before.emptyPatchRate) > EMPTY_RATE_TOLERANCE) {
      warnings.push(
        `${result.fixture}: emptyPatchRate ${pct(now.emptyPatchRate)} vs baseline ${pct(before.emptyPatchRate)}`,
      )
    }
    if (Math.abs(now.addCount - before.addCount) > ADD_COUNT_TOLERANCE) {
      warnings.push(
        `${result.fixture}: addCount ${now.addCount.toFixed(1)} vs baseline ${before.addCount.toFixed(1)}`,
      )
    }
  }

  const ran = new Set(report.fixtures.map((result) => result.fixture))
  for (const name of Object.keys(baseline.fixtures)) {
    if (!ran.has(name)) warnings.push(`${name}: in the baseline but not run`)
  }

  if (report.overall.schemaValid < baseline.overall.schemaValid - EPS) {
    regressions.push(
      `overall: schemaValid ${pct(report.overall.schemaValid)} < baseline ${pct(baseline.overall.schemaValid)}`,
    )
  }
  if (report.overall.secretLeak > baseline.overall.secretLeak + EPS) {
    regressions.push(
      `overall: secretLeak ${pct(report.overall.secretLeak)} > baseline ${pct(baseline.overall.secretLeak)}`,
    )
  }

  return { regressions, warnings }
}

const COLUMNS = [
  { head: 'FIXTURE', width: 24, align: 'left' as const },
  { head: 'RUNS', width: 5, align: 'right' as const },
  { head: 'SCHEMA', width: 7, align: 'right' as const },
  { head: 'SECRET', width: 7, align: 'right' as const },
  { head: 'EMPTY', width: 6, align: 'right' as const },
  { head: 'ADDS', width: 5, align: 'right' as const },
  { head: 'EXPECT', width: 7, align: 'right' as const },
  { head: 'AGREE', width: 6, align: 'right' as const },
  { head: 'SPREAD', width: 7, align: 'right' as const },
  { head: 'RESULT', width: 7, align: 'left' as const },
]

function row(cells: string[]): string {
  return COLUMNS.map((column, index) => {
    const cell = cells[index] ?? ''
    return column.align === 'left' ? cell.padEnd(column.width) : cell.padStart(column.width)
  })
    .join('  ')
    .trimEnd()
}

/**
 * The human-facing report: one line per fixture, then every failed assertion
 * spelled out, then the overall verdict. Written to be read in a terminal and
 * pasted into a pull request unchanged.
 */
export function renderReport(report: EvalReport): string {
  const lines: string[] = []
  lines.push(
    `lumem consolidation eval — mode=${report.mode} harness=${report.harnessId} k=${report.runsPerFixture}`,
  )
  lines.push('')
  lines.push(row(COLUMNS.map((column) => column.head)))

  for (const result of report.fixtures) {
    const score = result.score
    lines.push(
      row([
        result.fixture,
        String(score.runs),
        pct(score.schemaValid),
        pct(score.secretLeak),
        pct(score.emptyPatchRate),
        score.addCount.toFixed(1),
        pct(score.expectationsMet),
        pct(score.variance.verdictAgreement),
        String(score.variance.addSpread),
        score.passed ? 'PASS' : 'FAIL',
      ]),
    )
  }

  const failures = report.fixtures.filter((result) => !result.score.passed)
  if (failures.length > 0) {
    lines.push('')
    lines.push('failures:')
    for (const result of failures) {
      for (const failure of result.score.hardGateFailures) {
        lines.push(`  ${result.fixture}  HARD GATE  ${failure}`)
      }
      for (const run of result.runs) {
        for (const assertion of run.assertions) {
          if (assertion.passed) continue
          lines.push(`  ${result.fixture}  run ${run.run}  ${assertion.name}: ${assertion.detail}`)
        }
      }
    }
  }

  const overall = report.overall
  lines.push('')
  lines.push(
    `overall: ${overall.fixtures} fixtures, ${overall.totalRuns} runs — schema ${pct(
      overall.schemaValid,
    )}, secrets ${pct(overall.secretLeak)}, expectations ${pct(overall.expectationsMet)} — ${
      overall.passed ? 'PASS' : 'FAIL'
    }`,
  )
  return lines.join('\n')
}

/** The comparison, rendered. Empty string when there is nothing to say. */
export function renderComparison(comparison: BaselineComparison, baseline: Baseline): string {
  if (comparison.regressions.length === 0 && comparison.warnings.length === 0) {
    return `baseline (${baseline.createdAt}, mode=${baseline.mode}, k=${baseline.runsPerFixture}): no change`
  }
  const lines = [
    `baseline (${baseline.createdAt}, mode=${baseline.mode}, k=${baseline.runsPerFixture}):`,
  ]
  for (const entry of comparison.regressions) lines.push(`  REGRESSION  ${entry}`)
  for (const entry of comparison.warnings) lines.push(`  warning     ${entry}`)
  return lines.join('\n')
}
