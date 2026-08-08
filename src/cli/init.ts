import fs from 'node:fs'
import path from 'node:path'
import type { Command } from 'commander'
import type { AdapterDescriptor } from '../adapters/schema'
import { CONFIG_FILE_NAME, defaultConfig, writeConfig } from '../core/config'
import { detect } from '../core/harness/detect'
import { loadDescriptors } from '../core/harness/load'
import { type OperatingMode, resolveMode } from '../core/harness/mode'
import { writeLock } from '../core/install/lockfile'
import type { CliContext } from './context'

export interface InitReport {
  /** Relative paths created by this run — empty on a re-run and on --dry-run failures. */
  created: string[]
  /** Relative paths that already existed and were left byte-for-byte untouched. */
  skipped: string[]
  harnesses: { id: string; detected: boolean; selected: boolean; grade: string }[]
  /** Human-readable remarks: unknown ids, descriptor problems, "no harness detected". */
  notes: string[]
}

const LUMEM_DIR = '.lumem'
const LOCK_FILE_NAME = 'lumem-lock.json'

/**
 * `.lumem/local/` is machine-local state (journals, consolidation lock, flags):
 * never committed. Exactly one line, so the file is trivially recognizable as
 * ours and trivially replaceable by the user.
 */
const GITIGNORE_CONTENT = 'local/\n'

interface PlannedEntry {
  /** Path relative to `ctx.projectDir`, always with forward slashes. */
  relative: string
  absolute: string
  create: () => void
}

/**
 * Initialize `<projectDir>/.lumem`. Idempotent by construction: every entry is
 * created only when absent, so a re-run touches nothing and an interrupted run
 * can simply be repeated.
 *
 * Non-interactive on purpose — the harness selection arrives in `opts`, never
 * from a prompt, which keeps this callable from tests, scripts and hooks alike.
 */
export function runInit(
  ctx: CliContext,
  opts: { harnesses?: string[]; dryRun?: boolean } = {},
): { report: InitReport; exitCode: number } {
  const notes: string[] = []

  const { descriptors, errors } = loadDescriptors(ctx.adaptersDir)
  for (const error of errors) {
    notes.push(`descriptor ${error.file}: ${error.message}`)
  }

  const modes = descriptors.map((descriptor) => ({
    descriptor,
    mode: resolveMode(descriptor, detect(descriptor, ctx.env)),
  }))

  const selection = selectHarnesses(modes, opts.harnesses)
  if (selection.unknown.length > 0) {
    const known = descriptors.map((descriptor) => descriptor.id)
    notes.push(
      `unknown harness id: ${selection.unknown.join(', ')} — known ids: ${
        known.length > 0 ? known.join(', ') : '(none)'
      }`,
    )
    // Refuse before touching the filesystem: a typo must not leave a half-configured project.
    return {
      report: {
        created: [],
        skipped: [],
        harnesses: describeHarnesses(modes, selection.ids),
        notes,
      },
      exitCode: 1,
    }
  }

  if (selection.ids.size === 0) {
    notes.push(
      'no harness selected — memory still works without hooks; re-run `lumem init --harness <id>` once one is installed',
    )
  }

  const selected = modes
    .filter(({ descriptor }) => selection.ids.has(descriptor.id))
    .map(({ descriptor }) => ({ id: descriptor.id, minVersion: descriptor.minVersion }))

  const lumemDir = path.join(ctx.projectDir, LUMEM_DIR)
  const config = defaultConfig(selected)

  const planned: PlannedEntry[] = [
    dirEntry(lumemDir, 'memory'),
    dirEntry(lumemDir, 'local'),
    {
      relative: `${LUMEM_DIR}/${CONFIG_FILE_NAME}`,
      absolute: path.join(lumemDir, CONFIG_FILE_NAME),
      create: () => writeConfig(lumemDir, config),
    },
    {
      relative: `${LUMEM_DIR}/${LOCK_FILE_NAME}`,
      absolute: path.join(lumemDir, LOCK_FILE_NAME),
      create: () => writeLock(lumemDir, { version: 1, entries: [] }),
    },
    {
      relative: `${LUMEM_DIR}/.gitignore`,
      absolute: path.join(lumemDir, '.gitignore'),
      create: () => fs.writeFileSync(path.join(lumemDir, '.gitignore'), GITIGNORE_CONTENT),
    },
  ]

  const created: string[] = []
  const skipped: string[] = []
  for (const entry of planned) {
    if (fs.existsSync(entry.absolute)) {
      skipped.push(entry.relative)
      continue
    }
    if (opts.dryRun !== true) entry.create()
    created.push(entry.relative)
  }

  return {
    report: { created, skipped, harnesses: describeHarnesses(modes, selection.ids), notes },
    exitCode: 0,
  }
}

/**
 * Explicit ids win over detection — you may configure a harness before
 * installing it. Without the flag, every detected harness is selected.
 */
function selectHarnesses(
  modes: { descriptor: AdapterDescriptor; mode: OperatingMode }[],
  requested: string[] | undefined,
): { ids: Set<string>; unknown: string[] } {
  if (requested === undefined) {
    return {
      ids: new Set(
        modes.filter(({ mode }) => mode.detected).map(({ descriptor }) => descriptor.id),
      ),
      unknown: [],
    }
  }

  const known = new Set(modes.map(({ descriptor }) => descriptor.id))
  const wanted = [...new Set(requested)]
  return {
    ids: new Set(wanted.filter((id) => known.has(id))),
    unknown: wanted.filter((id) => !known.has(id)),
  }
}

function describeHarnesses(
  modes: { descriptor: AdapterDescriptor; mode: OperatingMode }[],
  selected: Set<string>,
): InitReport['harnesses'] {
  return modes.map(({ descriptor, mode }) => ({
    id: descriptor.id,
    detected: mode.detected,
    selected: selected.has(descriptor.id),
    grade: mode.grade,
  }))
}

function dirEntry(lumemDir: string, name: string): PlannedEntry {
  const absolute = path.join(lumemDir, name)
  return {
    relative: `${LUMEM_DIR}/${name}`,
    absolute,
    create: () => fs.mkdirSync(absolute, { recursive: true }),
  }
}

export function renderInit(report: InitReport): string {
  const lines: string[] = []

  for (const entry of report.created) {
    lines.push(`+ ${entry}`)
  }
  for (const entry of report.skipped) {
    lines.push(`= ${entry} (already exists)`)
  }

  for (const harness of report.harnesses) {
    if (!harness.detected) {
      lines.push(`✖ ${harness.id} — not detected`)
      continue
    }
    const mark = harness.selected ? 'configured' : 'skipped'
    lines.push(`✔ ${harness.id} (${harness.grade}) — ${mark}`)
  }

  for (const note of report.notes) {
    lines.push(`warning: ${note}`)
  }

  if (lines.length === 0) lines.push('nothing to do')
  return lines.join('\n')
}

/**
 * Register `lumem init` on `program`. The orchestrator owns wiring, so this
 * module never imports the program itself.
 */
export function registerInitCommand(
  program: Command,
  buildContext: () => CliContext,
  emit: (json: boolean, report: unknown, rendered: string) => void,
): void {
  program
    .command('init')
    .description('Create .lumem in this project (memory, config, lockfile)')
    .option('--harness <id...>', 'harness to configure; repeatable, defaults to all detected')
    .option('--dry-run', 'report what would be created without writing anything')
    .option('--yes', 'assume yes (init is non-interactive; accepted for symmetry)')
    .action((options: { harness?: string[]; dryRun?: boolean }) => {
      const ctx = buildContext()
      const { report, exitCode } = runInit(ctx, {
        ...(options.harness !== undefined ? { harnesses: options.harness } : {}),
        ...(options.dryRun === true ? { dryRun: true } : {}),
      })
      emit(ctx.json, report, renderInit(report))
      process.exitCode = exitCode
    })
}
