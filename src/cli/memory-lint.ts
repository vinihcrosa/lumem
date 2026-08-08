import type { Command } from 'commander'
import { DEFAULT_STALE_DAYS, type LintFinding, lintMemory } from '../core/memory/lint'
import type { CliContext } from './context'
import { loadAllMemory } from './memory-read'

export interface LintReport {
  findings: LintFinding[]
  factsChecked: number
  filesChecked: number
}

export interface MemoryLintOptions {
  staleDays?: number
}

/** Findings present: 3, matching `doctor`, so a script can gate on it. */
const EXIT_FINDINGS = 3

/**
 * Re-examine the accumulated memory set. Offline, deterministic, and read-only:
 * `lint` flags candidates for a human and writes nothing, ever.
 */
export function runMemoryLint(
  ctx: CliContext,
  opts?: MemoryLintOptions,
): { report: LintReport; exitCode: number } {
  const files = loadAllMemory(ctx)
  const findings = lintMemory(files, {
    // Enables dead-reference checks: project-scope facts are about this repo.
    projectDir: ctx.projectDir,
    ...(opts?.staleDays !== undefined ? { staleDays: opts.staleDays } : {}),
  })

  const factsChecked = files.reduce((total, file) => total + file.facts.length, 0)
  // The layout always names four files; only the ones that carry something were
  // really examined, and most projects have never written to all four.
  const filesChecked = files.filter(
    (file) => file.facts.length > 0 || file.warnings.length > 0,
  ).length

  return {
    report: { findings, factsChecked, filesChecked },
    exitCode: findings.length > 0 ? EXIT_FINDINGS : 0,
  }
}

export function renderMemoryLint(report: LintReport): string {
  const scope = `${count(report.factsChecked, 'fact')} across ${count(report.filesChecked, 'file')}`
  if (report.findings.length === 0) return `no findings — ${scope}`

  const lines: string[] = []
  let kind = ''
  for (const finding of report.findings) {
    // Findings arrive sorted by kind, so a header per change of kind groups them.
    if (finding.kind !== kind) {
      kind = finding.kind
      lines.push(`${kind}:`)
    }

    const ids = finding.factIds.join(' ')
    lines.push(`  ${ids === '' ? '' : `${ids}: `}${finding.message}`)
    lines.push(`    file: ${finding.file}`)
    if (finding.detail !== undefined) {
      for (const line of finding.detail.split('\n')) lines.push(`    ${line}`)
    }
  }

  const warn = report.findings.filter((finding) => finding.severity === 'warn').length
  const info = report.findings.length - warn
  lines.push(`${count(report.findings.length, 'finding')} (${warn} warn, ${info} info) — ${scope}`)
  return lines.join('\n')
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

/** Commander hands over a raw string; an unusable one falls back to the default. */
function parseStaleDays(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

/**
 * Attach `lint` to the given `memory` command. The caller owns context building
 * and output (so `--json` stays a global flag).
 */
export function registerMemoryLintCommand(
  memoryCmd: Command,
  buildContext: () => CliContext,
  emit: (json: boolean, report: unknown, rendered: string) => void,
): void {
  memoryCmd
    .command('lint')
    .description('Flag suspect facts in durable memory (offline; never writes)')
    .option(
      '--stale-days <n>',
      `age in days past which a fact is flagged (default ${DEFAULT_STALE_DAYS})`,
    )
    .action((opts: { staleDays?: string }) => {
      const ctx = buildContext()
      const staleDays = parseStaleDays(opts.staleDays)
      const { report, exitCode } = runMemoryLint(ctx, {
        ...(staleDays !== undefined ? { staleDays } : {}),
      })
      emit(ctx.json, report, renderMemoryLint(report))
      process.exitCode = exitCode
    })
}
