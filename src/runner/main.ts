// lumem consolidation runner — bundled to `dist/lumem-runner.mjs`.
//
// Contract:
//   node lumem-runner.mjs --project-dir <dir> --session-file <file> --harness <id>
//                         [--force] [--dry-run]
//
// The SessionEnd hook spawns this detached and immediately forgets about it.
// Two consequences govern this file:
//   1. ALWAYS exit 0. Nobody reads the status; a nonzero exit only shows up as
//      noise in the user's shell or harness log.
//   2. Everything worth knowing goes to `<projectDir>/.lumem/local/lumem.log`,
//      because stdout and stderr are going nowhere.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runConsolidation } from '../core/consolidate/run'
import { appendLog } from '../core/shared/log'

interface RunnerArgs {
  projectDir: string
  sessionFile: string
  harnessId: string
  force: boolean
  dryRun: boolean
}

/**
 * Parse the runner's flags. Both `--flag value` and `--flag=value` are accepted;
 * anything else is ignored. Returns undefined when a required flag is missing —
 * there is no usage text to print, since nothing is listening.
 */
function parseArgs(argv: string[]): RunnerArgs | undefined {
  const values = new Map<string, string>()
  let force = false
  let dryRun = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    const eq = arg.indexOf('=')
    if (arg.startsWith('--') && eq !== -1) {
      values.set(arg.slice(0, eq), arg.slice(eq + 1))
      continue
    }
    if (arg.startsWith('--')) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        values.set(arg, next)
        i++
      }
    }
  }

  const projectDir = values.get('--project-dir')
  const sessionFile = values.get('--session-file')
  const harnessId = values.get('--harness')
  if (!projectDir || !sessionFile || !harnessId) return undefined
  return { projectDir, sessionFile, harnessId, force, dryRun }
}

/** First candidate directory that satisfies `accept`, or undefined. */
function firstMatch(candidates: (string | undefined)[], accept: (dir: string) => boolean): string {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue
    try {
      if (accept(candidate)) return candidate
    } catch {
      // unreadable candidate: try the next one
    }
  }
  throw new Error(`no usable directory among: ${candidates.filter(Boolean).join(', ')}`)
}

/**
 * Adapter descriptors, resolved exactly like the CLI does: explicit override,
 * then the dev layout (src/runner → src/adapters), then the packaged layout
 * (dist/lumem-runner.mjs → <pkg>/src/adapters).
 */
function resolveAdaptersDir(): string {
  return firstMatch(
    [
      process.env.LUMEM_ADAPTERS_DIR,
      fileURLToPath(new URL('../adapters', import.meta.url)),
      fileURLToPath(new URL('../src/adapters', import.meta.url)),
    ],
    (dir) => fs.readdirSync(dir).some((name) => name.endsWith('.json')),
  )
}

/**
 * Shipped assets (the consolidation skill lives there): explicit override, then
 * the dev layout (src/runner → <repo>/assets), then the packaged layout
 * (dist/lumem-runner.mjs → <pkg>/assets).
 */
function resolveAssetsDir(): string {
  return firstMatch(
    [
      process.env.LUMEM_ASSETS_DIR,
      fileURLToPath(new URL('../../assets', import.meta.url)),
      fileURLToPath(new URL('../assets', import.meta.url)),
    ],
    (dir) => fs.statSync(path.join(dir, 'skills', 'lumem-consolidate', 'SKILL.md')).isFile(),
  )
}

/** Synchronous stdout write: `process.exit` would truncate a pending async one. */
function writeStdout(text: string): void {
  if (text.length === 0) return
  const buf = Buffer.from(text, 'utf8')
  let offset = 0
  try {
    while (offset < buf.length) offset += fs.writeSync(1, buf, offset, buf.length - offset)
  } catch {
    // stdout is closed (we are detached): the log already has everything.
  }
}

function logFailure(projectDir: string | undefined, event: string, error: unknown): void {
  if (projectDir === undefined) return
  try {
    appendLog(path.join(projectDir, '.lumem', 'local', 'lumem.log'), {
      level: 'error',
      event,
      data: { error: error instanceof Error ? error.message : String(error) },
    })
  } catch {
    // logging must never be the reason this process misbehaves
  }
}

function main(): void {
  let projectDir: string | undefined
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args === undefined) return
    projectDir = args.projectDir

    const result = runConsolidation({
      projectDir: args.projectDir,
      sessionFile: args.sessionFile,
      harnessId: args.harnessId,
      adaptersDir: resolveAdaptersDir(),
      assetsDir: resolveAssetsDir(),
      homeDir: os.homedir(),
      force: args.force,
      dryRun: args.dryRun,
    })
    if (args.dryRun && result.patch !== undefined) {
      writeStdout(`${JSON.stringify(result.patch, null, 2)}\n`)
    }
  } catch (err) {
    // runConsolidation swallows its own failures; this catches the wiring
    // around it (unresolvable adapters/assets directories, mostly).
    logFailure(projectDir, 'runner.fatal', err)
  }
}

main()
process.exit(0)
