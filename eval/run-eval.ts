import fs from 'node:fs'
import path from 'node:path'
import type { RunLlm } from '../src/core/consolidate/run'
import { runConsolidation } from '../src/core/consolidate/run'
import {
  ADAPTERS_DIR,
  ASSETS_DIR,
  DEFAULT_HARNESS_ID,
  FIXTURES_DIR,
  MOCK_DIR,
  listFixtures,
  loadFixture,
  materializeFixture,
} from './fixtures'
import { loadMockResponses, replayLlm } from './mock'
import { aggregate, round, scoreRun } from './score'
import type { EvalMode, EvalReport, FixtureResult, OverallScore, RunOutcome } from './types'

/** Three runs is the cheapest k that can disagree with itself. */
export const DEFAULT_RUNS = 3

export interface EvalOptions {
  /** Fixture names; defaults to every directory under `eval/fixtures/`. */
  fixtures?: string[]
  /** Runs per fixture. Defaults to {@link DEFAULT_RUNS}. */
  runs?: number
  /** Use this LLM for every fixture instead of spawning one. Wins over `mock`. */
  llm?: RunLlm
  /** Adapter descriptor whose `headless` block runs the consolidation. */
  harnessId?: string
  /** Replay `eval/mock-responses/<fixture>.json` instead of calling a model. */
  mock?: boolean
  fixturesDir?: string
  mockDir?: string
  adaptersDir?: string
  assetsDir?: string
  now?: () => Date
}

/**
 * Run the consolidation prompt against every fixture, k times each, and score
 * the patches it produced.
 *
 * Each run gets its own throwaway project — config, journal, seeded memory — and
 * goes through `runConsolidation` with `force: true, dryRun: true`. That is the
 * production code path: same prompt assembly, same shipped SKILL.md, same
 * `parsePatch`. `dryRun` means no memory file is ever written, and the project
 * and home directories are temp directories, so the real repo and the real home
 * are untouched no matter what the model returns.
 */
export async function runEval(opts?: EvalOptions): Promise<EvalReport> {
  const runs = Math.max(1, Math.trunc(opts?.runs ?? DEFAULT_RUNS))
  const harnessId = opts?.harnessId ?? DEFAULT_HARNESS_ID
  const fixturesDir = opts?.fixturesDir ?? FIXTURES_DIR
  const mockDir = opts?.mockDir ?? MOCK_DIR
  const now = opts?.now ?? ((): Date => new Date())
  const mode: EvalMode =
    opts?.llm !== undefined ? 'injected' : opts?.mock === true ? 'mock' : 'real'

  // Real mode spawns the headless CLI and spends the user's tokens. The unit
  // suite must never reach it, whatever a future refactor does to the defaults.
  if (mode === 'real' && process.env.VITEST !== undefined) {
    throw new Error('runEval: real mode is not allowed under vitest; pass `mock: true` or an `llm`')
  }

  const startedAt = now().toISOString()
  const names = opts?.fixtures ?? listFixtures(fixturesDir)
  const results: FixtureResult[] = []

  for (const name of names) {
    const spec = loadFixture(name, fixturesDir)
    const responses = mode === 'mock' ? loadMockResponses(name, mockDir) : []
    const outcomes: RunOutcome[] = []

    for (let index = 0; index < runs; index++) {
      const project = materializeFixture(spec, { harnessId })
      try {
        const result = runConsolidation({
          projectDir: project.projectDir,
          sessionFile: project.sessionFile,
          harnessId,
          adaptersDir: opts?.adaptersDir ?? ADAPTERS_DIR,
          assetsDir: opts?.assetsDir ?? ASSETS_DIR,
          homeDir: project.homeDir,
          force: true,
          dryRun: true,
          ...(mode === 'mock' ? { runLlm: replayLlm(responses, index) } : {}),
          ...(opts?.llm !== undefined ? { runLlm: opts.llm } : {}),
        })
        outcomes.push(
          scoreRun({
            run: index,
            expect: spec.expect,
            result,
            promptBytes: readPromptBytes(project.projectDir),
          }),
        )
      } finally {
        project.cleanup()
      }
    }

    results.push({
      fixture: name,
      description: spec.description,
      runs: outcomes,
      score: aggregate(outcomes),
    })
  }

  return {
    startedAt,
    finishedAt: now().toISOString(),
    mode,
    harnessId,
    runsPerFixture: runs,
    fixtures: results,
    overall: overallScore(results),
  }
}

/**
 * Size of the prompt the run actually sent, taken from the `consolidate.started`
 * line `runConsolidation` already logs. Reading it back beats re-deriving it:
 * this is the number production recorded, not a reconstruction of it.
 */
function readPromptBytes(projectDir: string): number {
  const logFile = path.join(projectDir, '.lumem', 'local', 'lumem.log')
  let text: string
  try {
    text = fs.readFileSync(logFile, 'utf8')
  } catch {
    return 0
  }
  for (const line of text.split('\n').reverse()) {
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const record = entry as { event?: unknown; data?: { promptBytes?: unknown } }
    if (record.event !== 'consolidate.started') continue
    const bytes = record.data?.promptBytes
    return typeof bytes === 'number' ? bytes : 0
  }
  return 0
}

function overallScore(results: FixtureResult[]): OverallScore {
  const outcomes = results.flatMap((result) => result.runs)
  const assertions = outcomes.flatMap((outcome) => outcome.assertions)

  const schemaValid = share(outcomes.map((outcome) => outcome.schemaValid))
  const secretLeak = share(outcomes.map((outcome) => outcome.secretLeak))
  const expectationsMet =
    assertions.length === 0 ? 1 : share(assertions.map((assertion) => assertion.passed))

  const hardGateFailures = results.flatMap((result) =>
    result.score.hardGateFailures.map((failure) => `${result.fixture}: ${failure}`),
  )

  return {
    fixtures: results.length,
    totalRuns: outcomes.length,
    schemaValid,
    secretLeak,
    expectationsMet,
    hardGateFailures,
    passed: hardGateFailures.length === 0 && results.every((result) => result.score.passed),
  }
}

function share(flags: boolean[]): number {
  if (flags.length === 0) return 0
  return round(flags.filter(Boolean).length / flags.length)
}
