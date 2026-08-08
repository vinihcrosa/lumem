import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Command } from 'commander'
import { type LumemConfig, readConfig } from '../core/config'
import type { ConsolidationResult, RunLlm } from '../core/consolidate/run'
import { runConsolidation } from '../core/consolidate/run'
import { detect } from '../core/harness/detect'
import { loadDescriptors } from '../core/harness/load'
import type { CliContext } from './context'
import { resolveAssetsDir } from './install'

export interface MemoryConsolidateOptions {
  /** Waive the gate thresholds — never the lock. */
  force?: boolean
  /** Run the model and print the patch without touching a single memory file. */
  dryRun?: boolean
  /** Harness whose headless CLI runs the consolidation; defaults to the detected one. */
  harness?: string
  /** Journal to consolidate; defaults to the most recently modified one. */
  sessionFile?: string
  /** Injected by tests. Left unset, the runner spawns the harness's real CLI. */
  runLlm?: RunLlm
}

/**
 * The runner's own result plus the journal it was pointed at — the one thing the
 * caller cannot reconstruct, since this command resolves it.
 */
export type MemoryConsolidateReport = ConsolidationResult & { sessionFile?: string }

const LUMEM_DIR = '.lumem'

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function failure(
  message: string,
  sessionFile?: string,
): {
  report: MemoryConsolidateReport
  exitCode: number
} {
  return {
    report: {
      ran: false,
      gateReasons: [],
      error: message,
      ...(sessionFile === undefined ? {} : { sessionFile }),
    },
    exitCode: 1,
  }
}

/**
 * The most recently modified `*.jsonl` under `sessionsDir`, or undefined when
 * there is none. Ties break on the file name so the choice never depends on a
 * filesystem's timestamp granularity.
 */
function newestSessionFile(sessionsDir: string): string | undefined {
  let entries: string[]
  try {
    entries = fs.readdirSync(sessionsDir)
  } catch {
    return undefined
  }

  let newest: { file: string; mtimeMs: number } | undefined
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const file = path.join(sessionsDir, name)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      const better =
        newest === undefined ||
        stat.mtimeMs > newest.mtimeMs ||
        (stat.mtimeMs === newest.mtimeMs && file > newest.file)
      if (better) newest = { file, mtimeMs: stat.mtimeMs }
    } catch {
      // unreadable entry: it is not a candidate
    }
  }
  return newest?.file
}

/**
 * Which harness's headless CLI runs the consolidation: the flag, then a config
 * `consolidation.runtime` that names one, then the first harness that is both
 * configured and detected — the same rule `lumem install` applies by default.
 */
function resolveHarnessId(
  ctx: CliContext,
  config: LumemConfig | undefined,
  explicit: string | undefined,
): { harnessId?: string; error?: string } {
  if (explicit !== undefined && explicit !== '') return { harnessId: explicit }

  const runtime = config?.consolidation.runtime
  if (runtime !== undefined && runtime !== 'auto') return { harnessId: runtime }

  const { descriptors } = loadDescriptors(ctx.adaptersDir)
  const configured = new Set(Object.keys(config?.harnesses ?? {}))
  const first = descriptors.find((d) => configured.has(d.id) && detect(d, ctx.env).detected)
  if (first !== undefined) return { harnessId: first.id }

  return {
    error:
      'no harness is both configured and detected in this project — pass `--harness <id>`, or run `lumem init --harness <id>` first',
  }
}

/**
 * Consolidate one session by hand, without waiting for a SessionEnd hook.
 *
 * Everything that decides whether the run happens (gate, lock, config) lives in
 * `runConsolidation`; this command only resolves what the hook would otherwise
 * have supplied — which journal, which harness — and maps the outcome onto an
 * exit code. A refusal is NOT a failure: only a broken project (exit 1 before
 * the runner) or a failed run (exit 1 from the runner) is.
 */
export function runMemoryConsolidate(
  ctx: CliContext,
  opts: MemoryConsolidateOptions = {},
): { report: MemoryConsolidateReport; exitCode: number } {
  const lumemDir = path.join(ctx.projectDir, LUMEM_DIR)
  if (!isDirectory(lumemDir)) {
    return failure(`${lumemDir}: not found — run \`lumem init\` in this project first`)
  }

  const sessionsDir = path.join(lumemDir, 'local', 'sessions')
  const sessionFile = opts.sessionFile ?? newestSessionFile(sessionsDir)
  if (sessionFile === undefined) {
    // Nothing was ever captured here: not an error, just nothing to do.
    return {
      report: { ran: false, gateReasons: [`no session journal in ${sessionsDir}`] },
      exitCode: 0,
    }
  }

  // A broken config is the runner's problem to survive (it falls back to the
  // defaults); here it only costs us the automatic harness choice.
  const { config, error: configError } = readConfig(lumemDir)
  const harness = resolveHarnessId(ctx, config, opts.harness)
  if (harness.harnessId === undefined) {
    const detail = configError === undefined ? '' : ` (${configError})`
    return failure(`${harness.error ?? 'no harness available'}${detail}`, sessionFile)
  }

  let assetsDir: string
  try {
    assetsDir = resolveAssetsDir()
  } catch (err) {
    return failure(errorMessage(err), sessionFile)
  }

  const result = runConsolidation({
    projectDir: ctx.projectDir,
    sessionFile,
    harnessId: harness.harnessId,
    adaptersDir: ctx.adaptersDir,
    assetsDir,
    homeDir: ctx.env.HOME ?? os.homedir(),
    ...(opts.force === true ? { force: true } : {}),
    ...(opts.dryRun === true ? { dryRun: true } : {}),
    ...(opts.runLlm !== undefined ? { runLlm: opts.runLlm } : {}),
  })

  return { report: { ...result, sessionFile }, exitCode: result.error === undefined ? 0 : 1 }
}

export function renderMemoryConsolidate(report: MemoryConsolidateReport): string {
  const lines: string[] = []
  if (report.sessionFile !== undefined) lines.push(`session: ${report.sessionFile}`)

  if (report.error !== undefined) {
    lines.push(`error: ${report.error}`)
    return lines.join('\n')
  }

  if (report.sessionFile === undefined) {
    lines.push('nothing to consolidate — this project has captured no session yet')
    for (const reason of report.gateReasons) lines.push(`  ${reason}`)
    return lines.join('\n')
  }

  if (!report.ran) {
    lines.push('skipped — nothing was consolidated:')
    for (const reason of report.gateReasons) lines.push(`  - ${reason}`)
    if (report.gateReasons.length === 0) lines.push('  - (no reason reported)')
    return lines.join('\n')
  }

  if (report.applied === undefined) {
    // Dry run. Say the expensive part out loud: the model already answered.
    lines.push('dry-run: no memory file was touched — but the LLM DID run, so this cost tokens')
    lines.push(report.patch === undefined ? '(no patch)' : JSON.stringify(report.patch, null, 2))
    return lines.join('\n')
  }

  const { applied, discarded, filesWritten } = report.applied
  lines.push(`applied ${applied.length} operation(s), discarded ${discarded.length}`)
  for (const file of filesWritten) lines.push(`  wrote ${file}`)
  if (filesWritten.length === 0) lines.push('  no file needed a change')
  return lines.join('\n')
}

/**
 * Register `lumem memory consolidate` on the `memory` command. The orchestrator
 * owns the wiring, so this module never imports the program itself.
 */
export function registerMemoryConsolidateCommand(
  memoryCmd: Command,
  buildContext: () => CliContext,
  emit: (json: boolean, report: unknown, rendered: string) => void,
): void {
  memoryCmd
    .command('consolidate')
    .description('Consolidate a finished session into durable memory')
    .option('--force', 'waive the gate thresholds (the lock is still honoured)')
    .option(
      '--dry-run',
      'print the patch without writing it — the LLM still runs, and costs tokens',
    )
    .option('--harness <id>', 'harness whose headless CLI runs the consolidation')
    .option('--session <file>', 'session journal to consolidate; defaults to the newest one')
    .action(
      (options: { force?: boolean; dryRun?: boolean; harness?: string; session?: string }) => {
        const ctx = buildContext()
        const { report, exitCode } = runMemoryConsolidate(ctx, {
          ...(options.force === true ? { force: true } : {}),
          ...(options.dryRun === true ? { dryRun: true } : {}),
          ...(options.harness !== undefined ? { harness: options.harness } : {}),
          ...(options.session !== undefined ? { sessionFile: options.session } : {}),
        })
        emit(ctx.json, report, renderMemoryConsolidate(report))
        process.exitCode = exitCode
      },
    )
}
