// lumem spec entrypoint — bundled to `dist/lumem-spec.mjs`, copied into a repo
// as `.lumem/bin/lumem-spec.mjs`.
//
// Contract:
//   node lumem-spec.mjs next <feature-dir> [--json]
//   node lumem-spec.mjs lint <feature-dir> --phase <prd|tdd|tasks> [--json]
//
// Two rules govern this file, the same two that govern the hook bundle:
//   1. ZERO external dependencies — `node:` builtins and dependency-free core
//      modules only. `commander` belongs to the CLI; argv is parsed by hand here.
//   2. Nothing is written. Both commands read.
//
// Exit codes follow `memory lint` and `adr lint`: 0 clean, 3 findings, 1 the
// command itself failed. `next` is advice, so it only fails on a path it cannot
// read — a directory that does not exist yet is not a failure, it is a feature
// waiting for its first artifact.

import fs from 'node:fs'
import { readFeature } from './feature'
import type { SpecFinding, SpecLintPhase } from './lint'
import { lintSpec } from './lint'
import { nextAction } from './next'

const LINT_PHASES: readonly string[] = ['prd', 'tdd', 'tasks']

const USAGE = `lumem-spec — read-only checks over a feature directory

  next <feature-dir> [--json]
  lint <feature-dir> --phase <prd|tdd|tasks> [--json]

Exit: 0 clean, 3 findings, 1 usage or read failure.`

export interface RunResult {
  out: string
  err: string
  code: number
}

interface Args {
  command: string
  dir?: string
  phase?: string
  json: boolean
  unknown?: string
}

/** Hand-rolled argv: one command, one positional, two flags. */
function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: argv[0] ?? '', json: false }
  for (const token of argv.slice(1)) {
    if (token === '--json') {
      args.json = true
      continue
    }
    if (token.startsWith('--phase=')) {
      args.phase = token.slice('--phase='.length)
      continue
    }
    if (token === '--phase') {
      args.phase = ''
      continue
    }
    if (token.startsWith('-')) {
      args.unknown = token
      continue
    }
    // A bare token after `--phase` is its value; otherwise it is the directory.
    if (args.phase === '') args.phase = token
    else if (args.dir === undefined) args.dir = token
    else args.unknown = token
  }
  return args
}

function fail(message: string): RunResult {
  return { out: '', err: `${message}\n\n${USAGE}`, code: 1 }
}

/**
 * `undefined` when the path is usable — either a directory, or absent, which is
 * the state of a feature nobody has started. A path that exists and is not a
 * readable directory is the one thing neither command can work with.
 */
function pathProblem(dir: string): string | undefined {
  try {
    if (fs.statSync(dir).isDirectory()) return undefined
    return `${dir} exists but is not a directory`
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') return undefined
    return `${dir} could not be read (${code ?? 'unknown error'})`
  }
}

function renderFindings(findings: SpecFinding[]): string {
  return findings
    .map((finding) => `${finding.severity}: ${finding.kind}: ${finding.message}`)
    .join('\n')
}

export function run(argv: readonly string[]): RunResult {
  const args = parseArgs(argv)

  if (args.command === '' || args.command === '--help' || args.command === '-h') {
    return { out: USAGE, err: '', code: args.command === '' ? 1 : 0 }
  }
  if (args.unknown !== undefined) return fail(`unknown argument '${args.unknown}'`)
  if (args.dir === undefined) return fail('missing <feature-dir>')

  const problem = pathProblem(args.dir)
  if (problem !== undefined) return fail(problem)

  if (args.command === 'next') {
    if (args.phase !== undefined) return fail('next takes no --phase')
    const action = nextAction(readFeature(args.dir))
    const target = action.target === undefined ? '' : ` target=${action.target}`
    const line = `phase=${action.phase} action=${action.action}${target}`
    return { out: args.json ? JSON.stringify(action) : line, err: '', code: 0 }
  }

  if (args.command === 'lint') {
    if (args.phase === undefined || args.phase === '') return fail('lint needs --phase')
    if (!LINT_PHASES.includes(args.phase)) {
      return fail(`unknown phase '${args.phase}'; expected ${LINT_PHASES.join(', ')}`)
    }
    const findings = lintSpec(readFeature(args.dir), args.phase as SpecLintPhase)
    return {
      out: args.json ? JSON.stringify(findings) : renderFindings(findings),
      err: '',
      code: findings.length === 0 ? 0 : 3,
    }
  }

  return fail(`unknown command '${args.command}'`)
}

/**
 * Only when executed directly, so a test can import `run` without the module
 * writing to stdout or setting an exit code as a side effect.
 */
function isEntrypoint(): boolean {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return fs.realpathSync(invoked) === fs.realpathSync(new URL(import.meta.url).pathname)
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  const result = run(process.argv.slice(2))
  if (result.out !== '') process.stdout.write(`${result.out}\n`)
  if (result.err !== '') process.stderr.write(`${result.err}\n`)
  process.exitCode = result.code
}
