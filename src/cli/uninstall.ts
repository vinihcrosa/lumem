import fs from 'node:fs'
import path from 'node:path'
import type { Command } from 'commander'
import { loadDescriptors } from '../core/harness/load'
import { applyPlan } from '../core/install/apply'
import { type LockEntry, readLock } from '../core/install/lockfile'
import { planUninstall } from '../core/install/plan'
import type { CliContext } from './context'
import { hookConfigStrategies } from './install'

export interface UninstallReport {
  /** Artifacts taken off disk; `backupPath` is the user file put back in its place. */
  removed: { artifactId: string; destPath: string; backupPath?: string }[]
  /** Tracked artifacts left alone — filtered out by `--harness`, or still shared. */
  skipped: { artifactId: string; reason: string }[]
  errors: { artifactId: string; message: string }[]
  /** True only when `.lumem` was actually deleted; always false on a dry run. */
  purged: boolean
  dryRun: boolean
  notes: string[]
}

export interface UninstallOptions {
  /** Harness ids to uninstall; defaults to every harness the lockfile tracks. */
  harnesses?: string[]
  /** Also delete `.lumem` — memory included. Honored only when exactly `true`. */
  purge?: boolean
  dryRun?: boolean
}

const LUMEM_DIR = '.lumem'

/** artifactId for failures that abort the whole command rather than one artifact. */
const COMMAND_SCOPE = '*'

/**
 * planUninstall's purge request: a pseudo-action whose destPath is the literal
 * '.lumem' token for this module to resolve. It never reaches the filesystem
 * through applyPlan, so it is filtered out of the report and handled here.
 */
const PURGE_MARKER = '.lumem'

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The harness an artifact id belongs to, or undefined when it is shared by all.
 *
 * Ids come in two shapes: `skill:<name>@<harness>` (suffix) and
 * `<kind>:<harness>` (hook-config). `hook-bundle:*` is the harness-agnostic
 * pair installed once under `.lumem/bin`, so it belongs to no harness.
 *
 * SPEC_DEVIATION: a T17 leitura de harness é "sufixo `@<harness>`"; sem tratar
 * `hook-config:<harness>` o `--harness <id>` deixaria o hooks config órfão,
 * apontando para bundles já removidos.
 */
function harnessOf(artifactId: string): string | undefined {
  const at = artifactId.lastIndexOf('@')
  if (at !== -1) return artifactId.slice(at + 1)
  const colon = artifactId.indexOf(':')
  if (colon === -1) return undefined
  return artifactId.slice(0, colon) === 'hook-bundle' ? undefined : artifactId.slice(colon + 1)
}

/** True when `target` sits strictly below `root` (never the root itself). */
function isStrictlyInside(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Delete the directories a removal just emptied, walking up from `startDir`
 * while the directory is empty and stays strictly inside one of `boundaries` —
 * the project root and the injected home. Boundaries themselves always survive,
 * as does any directory that still holds a user file. Failures are ignored: a
 * directory that will not go simply stays.
 */
function pruneEmptyDirs(startDir: string, boundaries: string[]): void {
  let dir = path.resolve(startDir)
  while (boundaries.some((boundary) => isStrictlyInside(dir, boundary))) {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return
    }
    if (entries.length > 0) return
    try {
      fs.rmdirSync(dir)
    } catch {
      return
    }
    dir = path.dirname(dir)
  }
}

interface Selection {
  targets: LockEntry[]
  skipped: { artifactId: string; reason: string }[]
  notes: string[]
}

/**
 * Split the lockfile into what this run removes and what it leaves.
 *
 * Without `--harness` everything goes. With it, an artifact goes when it
 * belongs to a named harness; the shared bundles go only when no other harness
 * still has entries — otherwise removing them would break the harnesses that
 * remain installed.
 */
function selectEntries(entries: LockEntry[], harnesses: string[] | undefined): Selection {
  if (harnesses === undefined) return { targets: entries, skipped: [], notes: [] }

  const wanted = new Set(harnesses)
  const owners = entries.map((entry) => ({ entry, harness: harnessOf(entry.artifactId) }))
  const remaining = [
    ...new Set(
      owners.flatMap(({ harness }) =>
        harness !== undefined && !wanted.has(harness) ? [harness] : [],
      ),
    ),
  ].sort()

  const selection: Selection = { targets: [], skipped: [], notes: [] }
  for (const { entry, harness } of owners) {
    if (harness === undefined) {
      if (remaining.length === 0) {
        selection.targets.push(entry)
      } else {
        selection.skipped.push({
          artifactId: entry.artifactId,
          reason: `shared artifact still used by: ${remaining.join(', ')}`,
        })
      }
      continue
    }
    if (wanted.has(harness)) {
      selection.targets.push(entry)
    } else {
      selection.skipped.push({ artifactId: entry.artifactId, reason: 'not selected by --harness' })
    }
  }

  const tracked = new Set(owners.flatMap(({ harness }) => (harness === undefined ? [] : [harness])))
  for (const id of [...new Set(harnesses)].sort()) {
    if (!tracked.has(id)) selection.notes.push(`harness '${id}': nothing tracked in the lockfile`)
  }

  return selection
}

/**
 * Remove everything lumem installed in this project.
 *
 * Lockfile-driven from end to end: only artifacts the lock tracks are touched,
 * each one restored to whatever the user had there before install (applyPlan
 * puts backups back), and the entry is dropped only once the destination is
 * really gone — a failure keeps it tracked so a later run can retry.
 *
 * Memory is not an artifact: `.lumem/memory` and `lumem.config.json` survive
 * every run except an explicit `--purge`.
 */
export function runUninstall(
  ctx: CliContext,
  opts: UninstallOptions = {},
): { report: UninstallReport; exitCode: number } {
  const dryRun = opts.dryRun === true
  const report: UninstallReport = {
    removed: [],
    skipped: [],
    errors: [],
    purged: false,
    dryRun,
    notes: [],
  }

  // Deleting the memory store is irreversible, so it takes the exact boolean
  // `true` — a truthy value from an untyped caller is refused, never guessed.
  const requested: unknown = opts.purge
  const purge = requested === true
  if (requested !== undefined && requested !== false && !purge) {
    report.errors.push({
      artifactId: COMMAND_SCOPE,
      message: `refusing to purge: the purge option must be exactly true, got ${JSON.stringify(
        requested,
      )} — nothing was removed`,
    })
    return { report, exitCode: 1 }
  }

  const lumemDir = path.join(ctx.projectDir, LUMEM_DIR)
  const selection = selectEntries(readLock(lumemDir).entries, opts.harnesses)
  report.skipped.push(...selection.skipped)
  report.notes.push(...selection.notes)

  if (selection.targets.length === 0) {
    report.notes.push(
      opts.harnesses === undefined
        ? `nothing to remove — no artifact is tracked in ${path.join(lumemDir, 'lumem-lock.json')}`
        : 'nothing to remove for the selected harnesses',
    )
    // No plan means no write at all: an empty run must never create `.lumem`.
    return purge ? purgeLumemDir(report, lumemDir, dryRun) : { report, exitCode: 0 }
  }

  const plan = planUninstall({
    lock: { version: 1, entries: selection.targets },
    ...(purge ? { purge: true } : {}),
  })

  // A hook config lumem merged into (`.claude/settings.json`) must be unmerged,
  // not deleted, so removal needs the same strategies the install was written
  // with. Unreadable descriptors simply leave a harness on the own-file default.
  const applied = applyPlan({
    plan,
    artifacts: [],
    lumemDir,
    projectDir: ctx.projectDir,
    ...(dryRun ? { dryRun: true } : {}),
    hookConfigStrategy: hookConfigStrategies(loadDescriptors(ctx.adaptersDir).descriptors),
  })

  report.removed = applied.applied
    .filter((entry) => entry.artifactId !== PURGE_MARKER)
    .map((entry) => ({
      artifactId: entry.artifactId,
      destPath: entry.destPath,
      ...(entry.backupPath !== undefined ? { backupPath: entry.backupPath } : {}),
    }))
  report.skipped.push(...applied.skipped.filter((entry) => entry.artifactId !== PURGE_MARKER))
  report.errors.push(...applied.errors)

  if (!dryRun) {
    const home = ctx.env.HOME
    const boundaries = [ctx.projectDir, ...(home !== undefined && home !== '' ? [home] : [])]
    for (const entry of report.removed) {
      pruneEmptyDirs(path.dirname(entry.destPath), boundaries)
    }
  }

  if (purge) {
    if (opts.harnesses !== undefined) {
      report.notes.push(
        'purge removes the whole .lumem state, including lock entries of harnesses this run kept',
      )
    }
    const purged = purgeLumemDir(report, lumemDir, dryRun)
    return { report, exitCode: report.errors.length > 0 ? 1 : purged.exitCode }
  }

  return { report, exitCode: report.errors.length > 0 ? 1 : 0 }
}

/** Delete `.lumem` itself. Reports rather than throws, so one failure is not fatal. */
function purgeLumemDir(
  report: UninstallReport,
  lumemDir: string,
  dryRun: boolean,
): { report: UninstallReport; exitCode: number } {
  if (dryRun) {
    report.notes.push(`dry-run: ${lumemDir} would be removed, memory included`)
    return { report, exitCode: report.errors.length > 0 ? 1 : 0 }
  }
  if (!fs.existsSync(lumemDir)) {
    report.notes.push(`${lumemDir}: nothing to purge`)
    return { report, exitCode: report.errors.length > 0 ? 1 : 0 }
  }
  try {
    fs.rmSync(lumemDir, { recursive: true, force: true })
    report.purged = true
    report.notes.push(`${lumemDir} removed — memory, config and lockfile are gone`)
  } catch (err) {
    report.errors.push({ artifactId: COMMAND_SCOPE, message: errorMessage(err) })
  }
  return { report, exitCode: report.errors.length > 0 ? 1 : 0 }
}

export function renderUninstall(report: UninstallReport): string {
  const lines: string[] = []

  if (report.dryRun) lines.push('dry-run: nothing was removed')

  for (const entry of report.removed) {
    const restored = entry.backupPath !== undefined ? ` (restored from: ${entry.backupPath})` : ''
    lines.push(`- ${entry.artifactId} → ${entry.destPath}${restored}`)
  }
  for (const entry of report.skipped) {
    lines.push(`= ${entry.artifactId} (${entry.reason})`)
  }
  if (report.purged) lines.push('purge: .lumem removed')
  for (const entry of report.errors) {
    const scope = entry.artifactId === COMMAND_SCOPE ? '' : `${entry.artifactId}: `
    lines.push(`error: ${scope}${entry.message}`)
  }
  for (const note of report.notes) {
    lines.push(`note: ${note}`)
  }

  if (lines.length === 0) lines.push('nothing to do')
  return lines.join('\n')
}

/**
 * Register `lumem uninstall` on `program`. The orchestrator owns wiring, so this
 * module never imports the program itself.
 */
export function registerUninstallCommand(
  program: Command,
  buildContext: () => CliContext,
  emit: (json: boolean, report: unknown, rendered: string) => void,
): void {
  program
    .command('uninstall')
    .description('Remove the artifacts lumem installed, keeping memory intact')
    .option('--harness <id...>', 'harness to uninstall from; defaults to every tracked harness')
    .option('--purge', 'also delete the .lumem directory, memory included')
    .option('--dry-run', 'report what would be removed without touching the filesystem')
    .action((options: { harness?: string[]; purge?: boolean; dryRun?: boolean }) => {
      const ctx = buildContext()
      const { report, exitCode } = runUninstall(ctx, {
        ...(options.harness !== undefined ? { harnesses: options.harness } : {}),
        ...(options.purge === true ? { purge: true } : {}),
        ...(options.dryRun === true ? { dryRun: true } : {}),
      })
      emit(ctx.json, report, renderUninstall(report))
      process.exitCode = exitCode
    })
}
