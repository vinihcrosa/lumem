import fs from 'node:fs'
import path from 'node:path'
import type { Command } from 'commander'
import { backupOnce } from '../core/install/backup'
import { type DriftEntry, type Lockfile, detectDrift, readLock } from '../core/install/lockfile'
import { sha256 } from '../core/shared/fsx'
import type { CliContext } from './context'
import { runInstall } from './install'

export interface SyncReport {
  /** Lockfile entries whose destination no longer matches what lumem wrote. */
  drift: { artifactId: string; destPath: string; state: string; note?: string }[]
  /** Planned changes only — an already up-to-date artifact is not an action. */
  actions: { artifactId: string; type: string; destPath: string; reason: string }[]
  applied: { artifactId: string; action: string; destPath: string }[]
  skipped: { artifactId: string; reason: string }[]
  errors: { artifactId: string; message: string }[]
  dryRun: boolean
}

export interface SyncOptions {
  /** Explicit harness ids; defaults to every configured-and-detected harness. */
  harnesses?: string[]
  /** Overwrite destinations that drifted from what lumem installed. */
  force?: boolean
  dryRun?: boolean
}

const LUMEM_DIR = '.lumem'

/** artifactId for failures that abort the whole command rather than one artifact. */
const COMMAND_SCOPE = '*'

function hashOf(filePath: string): string | undefined {
  try {
    return sha256(fs.readFileSync(filePath))
  } catch {
    return undefined
  }
}

/**
 * The drift worth telling the user about, shared by `sync` and `doctor`.
 *
 * Two classes of `detectDrift` output are dropped:
 *
 * - `'ok'` entries, which are the healthy majority;
 * - `'modified'` entries whose destination still holds exactly the bytes install
 *   wrote. `detectDrift` compares against the entry's *source* hash, so every
 *   artifact install renders (hook-config templates, whose `{{HOOK_BUNDLE}}` is
 *   substituted) looks modified forever. The lockfile records those bytes as
 *   `contentHash`, which is what the install planner already compares against.
 *
 * The second filter belongs in `detectDrift` itself (`entry.contentHash ??
 * entry.hash`); it lives here so this task keeps core untouched.
 */
export function reportedDrift(lock: Lockfile): DriftEntry[] {
  const written = new Map<string, string>()
  for (const entry of lock.entries) {
    if (entry.contentHash !== undefined) written.set(entry.destPath, entry.contentHash)
  }

  return detectDrift(lock).filter((entry) => {
    if (entry.state === 'ok') return false
    if (entry.state !== 'modified') return true
    const contentHash = written.get(entry.destPath)
    return contentHash === undefined || hashOf(entry.destPath) !== contentHash
  })
}

/**
 * Reconcile the project against the manifest and the lockfile.
 *
 * Sync is install with a drift report in front of it: the reconciliation itself
 * is `runInstall`, so there is exactly one plan/apply implementation and sync
 * can never disagree with install about what belongs where.
 *
 * FR-15: a managed file the user edited plans as a conflict, which apply skips —
 * the file is left byte-for-byte alone and the command exits 3. `--force` turns
 * the conflict into an update, and the user's bytes are backed up first.
 */
export function runSync(
  ctx: CliContext,
  opts: SyncOptions = {},
): { report: SyncReport; exitCode: number } {
  const dryRun = opts.dryRun === true
  const lumemDir = path.join(ctx.projectDir, LUMEM_DIR)

  // Read drift before applying anything: apply rewrites both the destinations
  // and the lockfile, after which nothing could tell drift from a fresh install.
  const drift = reportedDrift(readLock(lumemDir))

  if (opts.force === true && !dryRun) preserveDrifted(drift, ctx.projectDir, lumemDir)

  const install = runInstall(ctx, {
    ...(opts.harnesses !== undefined ? { harnesses: opts.harnesses } : {}),
    ...(opts.force === true ? { force: true } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  })

  const report: SyncReport = {
    drift: drift.map((entry) => ({
      artifactId: entry.artifactId,
      destPath: entry.destPath,
      state: entry.state,
      ...(entry.note !== undefined ? { note: entry.note } : {}),
    })),
    actions: install.report.actions.filter((action) => action.type !== 'skip'),
    applied: install.report.applied.map((entry) => ({
      artifactId: entry.artifactId,
      action: entry.action,
      destPath: entry.destPath,
    })),
    skipped: install.report.skipped,
    errors: install.report.errors,
    dryRun,
  }

  return { report, exitCode: install.exitCode }
}

/**
 * Copy every drifted destination into `.lumem/local/backups` before a forced
 * overwrite. Apply keeps no backup for a file the lockfile already tracks — it
 * assumes those bytes are its own previous install — but drift means precisely
 * that they are not: they are the user's, and `--force` must never destroy them.
 */
function preserveDrifted(drift: DriftEntry[], projectDir: string, lumemDir: string): void {
  const backupsDir = path.join(lumemDir, 'local', 'backups')
  for (const entry of drift) {
    if (entry.state !== 'modified') continue
    backupOnce(entry.destPath, { backupsDir, baseDir: projectDir })
  }
}

export function renderSync(report: SyncReport): string {
  const lines: string[] = []

  if (report.dryRun) lines.push('dry-run: nada foi escrito')

  if (report.drift.length > 0) {
    lines.push('drift:')
    for (const entry of report.drift) {
      const note = entry.note !== undefined ? ` (${entry.note})` : ''
      lines.push(`  ${entry.state} ${entry.artifactId} → ${entry.destPath}${note}`)
    }
  }

  if (report.actions.length > 0) {
    lines.push('ações:')
    for (const action of report.actions) {
      lines.push(`  ${action.type} ${action.artifactId} → ${action.destPath} (${action.reason})`)
    }
  }

  for (const entry of report.applied) {
    lines.push(`+ ${entry.action} ${entry.artifactId} → ${entry.destPath}`)
  }
  for (const entry of report.skipped) {
    lines.push(`= ${entry.artifactId} (${entry.reason})`)
  }
  for (const entry of report.errors) {
    const scope = entry.artifactId === COMMAND_SCOPE ? '' : `${entry.artifactId}: `
    lines.push(`erro: ${scope}${entry.message}`)
  }

  if (report.actions.some((action) => action.type === 'conflict')) {
    lines.push(
      'conflito: arquivos editados localmente não foram tocados — rode `lumem sync --force` para sobrescrever (o conteúdo atual vai para .lumem/local/backups)',
    )
  }

  if (lines.length === 0) lines.push('tudo sincronizado')
  return lines.join('\n')
}

/**
 * Register `lumem sync` on `program`. The orchestrator owns wiring, so this
 * module never imports the program itself.
 */
export function registerSyncCommand(
  program: Command,
  buildContext: () => CliContext,
  emit: (json: boolean, report: unknown, rendered: string) => void,
): void {
  program
    .command('sync')
    .description('Reconcile installed artifacts with the manifest, reporting local drift')
    .option('--harness <id...>', 'harness to sync; defaults to all configured and detected')
    .option('--force', 'overwrite destinations that drifted from what lumem installed')
    .option('--dry-run', 'report drift and planned actions without writing anything')
    .action((options: { harness?: string[]; force?: boolean; dryRun?: boolean }) => {
      const ctx = buildContext()
      const { report, exitCode } = runSync(ctx, {
        ...(options.harness !== undefined ? { harnesses: options.harness } : {}),
        ...(options.force === true ? { force: true } : {}),
        ...(options.dryRun === true ? { dryRun: true } : {}),
      })
      emit(ctx.json, report, renderSync(report))
      process.exitCode = exitCode
    })
}
