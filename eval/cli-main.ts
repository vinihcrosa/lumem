import path from 'node:path'
import { REPO_ROOT } from './fixtures'
import {
  buildBaseline,
  compareToBaseline,
  readBaseline,
  renderComparison,
  renderReport,
  writeBaseline,
  writeResults,
} from './report'
import { DEFAULT_RUNS, runEval } from './run-eval'

const EVAL_DIR = path.join(REPO_ROOT, 'eval')
const DEFAULT_BASELINE = path.join(EVAL_DIR, 'baseline.json')
const DEFAULT_RESULTS_DIR = path.join(EVAL_DIR, 'results')

export interface CliOptions {
  mock: boolean
  runs: number
  fixtures?: string[]
  harnessId?: string
  updateBaseline: boolean
  baselineFile: string
  resultsDir?: string
  mockDir?: string
  json: boolean
  help: boolean
}

const USAGE = `lumem consolidation eval

  npm run eval -- [options]

Options
  --mock                 replay eval/mock-responses/<fixture>.json; no network, no tokens
  --mock-dir <dir>       replay from this directory instead (implies --mock)
  --runs <k>             runs per fixture (default ${DEFAULT_RUNS})
  --fixture <name>       run only this fixture; repeatable, or comma-separated
  --harness <id>         adapter descriptor to run headless (default claude-code)
  --baseline <file>      baseline to compare against (default eval/baseline.json)
  --update-baseline      overwrite the baseline with this run's scores
  --results-dir <dir>    where to write <ISO>.json (default eval/results)
  --no-results           do not write a results file
  --json                 print the full report as JSON instead of the table
  -h, --help             this text

Exit codes
  0  every hard gate held and every expectation was met
  1  a hard gate failed, an expectation failed, or a baseline hard gate regressed
  2  bad usage

Without --mock this spawns the harness's headless CLI once per fixture per run.
That costs tokens and needs the network. Read eval/README.md first.`

/** Hand-rolled on purpose: the whole surface is ten flags and it stays testable. */
export function parseArgs(argv: string[]): { options: CliOptions } | { error: string } {
  const options: CliOptions = {
    mock: false,
    runs: DEFAULT_RUNS,
    updateBaseline: false,
    baselineFile: DEFAULT_BASELINE,
    json: false,
    help: false,
  }
  const fixtures: string[] = []
  let noResults = false
  let resultsDir: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    const value = (): string | undefined => argv[++i]

    switch (arg) {
      case '--mock':
        options.mock = true
        break
      case '--update-baseline':
        options.updateBaseline = true
        break
      case '--json':
        options.json = true
        break
      case '--no-results':
        noResults = true
        break
      case '-h':
      case '--help':
        options.help = true
        break
      case '--runs':
      case '-k': {
        const raw = value()
        const runs = Number(raw)
        if (raw === undefined || !Number.isInteger(runs) || runs < 1) {
          return { error: `--runs expects a positive integer, got '${raw ?? ''}'` }
        }
        options.runs = runs
        break
      }
      case '--fixture': {
        const raw = value()
        if (raw === undefined || raw.length === 0) return { error: '--fixture expects a name' }
        for (const name of raw.split(',')) {
          if (name.trim().length > 0) fixtures.push(name.trim())
        }
        break
      }
      case '--harness': {
        const raw = value()
        if (raw === undefined || raw.length === 0) return { error: '--harness expects an id' }
        options.harnessId = raw
        break
      }
      case '--mock-dir': {
        const raw = value()
        if (raw === undefined || raw.length === 0) return { error: '--mock-dir expects a path' }
        options.mockDir = path.resolve(raw)
        options.mock = true
        break
      }
      case '--baseline': {
        const raw = value()
        if (raw === undefined || raw.length === 0) return { error: '--baseline expects a path' }
        options.baselineFile = path.resolve(raw)
        break
      }
      case '--results-dir': {
        const raw = value()
        if (raw === undefined || raw.length === 0) return { error: '--results-dir expects a path' }
        resultsDir = path.resolve(raw)
        break
      }
      default:
        return { error: `unknown argument '${arg}'` }
    }
  }

  if (fixtures.length > 0) options.fixtures = fixtures
  if (!noResults) options.resultsDir = resultsDir ?? DEFAULT_RESULTS_DIR
  return { options }
}

/** Runs the eval and prints it. Returns the process exit code; never throws for control flow. */
export async function main(
  argv: string[],
  out = console.log,
  err = console.error,
): Promise<number> {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    err(parsed.error)
    err('')
    err(USAGE)
    return 2
  }
  const options = parsed.options
  if (options.help) {
    out(USAGE)
    return 0
  }

  const report = await runEval({
    mock: options.mock,
    runs: options.runs,
    ...(options.fixtures !== undefined ? { fixtures: options.fixtures } : {}),
    ...(options.harnessId !== undefined ? { harnessId: options.harnessId } : {}),
    ...(options.mockDir !== undefined ? { mockDir: options.mockDir } : {}),
  })

  out(options.json ? JSON.stringify(report, null, 2) : renderReport(report))

  if (options.resultsDir !== undefined) {
    out(`\nresults: ${writeResults(options.resultsDir, report)}`)
  }

  let regressed = false
  const baseline = readBaseline(options.baselineFile)
  if (baseline !== undefined) {
    const comparison = compareToBaseline(report, baseline)
    out('')
    out(renderComparison(comparison, baseline))
    regressed = comparison.regressions.length > 0
  }

  if (options.updateBaseline) {
    writeBaseline(options.baselineFile, buildBaseline(report))
    out(`\nbaseline updated: ${options.baselineFile}`)
  }

  return report.overall.passed && !regressed ? 0 : 1
}
