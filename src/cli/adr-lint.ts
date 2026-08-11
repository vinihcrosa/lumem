import fs from 'node:fs'
import path from 'node:path'
import type { Command } from 'commander'
import type { AdrFinding } from '../core/adr/lint'
import { lintAdrs } from '../core/adr/lint'
import { readAdrs } from '../core/adr/store'
import { adrParentCommand } from './adr-new'
import type { CliContext } from './context'

export interface AdrLintReport {
  findings: AdrFinding[]
  adrsChecked: number
}

/** Findings present: 3, matching `doctor` and `memory lint`, so a script can gate on it. */
const EXIT_FINDINGS = 3

/**
 * Check every ADR under `<projectDir>/docs/adr/`. Read-only and offline: `lint`
 * reports and writes nothing, ever.
 *
 * Like `adr new`, it does not require `.lumem/` — ADRs are repository documents
 * (TDD 001 §2.1). Exit 1 is reserved for the command itself failing, which the
 * CLI's top-level catch sets; nothing here throws, because reading and linting
 * are both tolerant by construction.
 */
/**
 * Directory names under `docs/features/`. A missing or unreadable folder yields
 * an empty list, which is the truth `unknown-feature` needs: no features exist,
 * so any `feature:` value names none of them.
 */
function featureDirs(docsDir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(docsDir, 'features'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export function runAdrLint(ctx: CliContext): { report: AdrLintReport; exitCode: number } {
  const docsDir = path.join(ctx.projectDir, 'docs')
  const set = readAdrs(docsDir)
  const findings = lintAdrs(set, { features: featureDirs(docsDir) })

  return {
    report: { findings, adrsChecked: set.adrs.length },
    exitCode: findings.length > 0 ? EXIT_FINDINGS : 0,
  }
}

/**
 * Findings grouped by kind, each header carrying its severity so a gate cannot
 * be mistaken for one more informational line — two broken chains among five
 * TODO summaries is exactly the case this output exists for.
 */
export function renderAdrLint(report: AdrLintReport): string {
  const scope = count(report.adrsChecked, 'ADR')
  if (report.findings.length === 0) return `no findings — ${scope} checked`

  const lines: string[] = []
  let kind = ''
  for (const finding of report.findings) {
    // Findings arrive sorted by severity then kind, so a header per change of
    // kind groups them and puts every gate above every note.
    if (finding.kind !== kind) {
      kind = finding.kind
      lines.push(`${finding.severity} ${kind}:`)
    }

    const ids = finding.ids.join(' ')
    lines.push(`  ${ids === '' ? '' : `${ids}: `}${finding.message}`)
  }

  const gates = report.findings.filter((finding) => finding.severity === 'gate').length
  const info = report.findings.length - gates
  lines.push(
    `${count(report.findings.length, 'finding')} (${gates} gate, ${info} info) — ${scope} checked`,
  )
  return lines.join('\n')
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

/**
 * Attach `lint` to the `adr` parent, creating it only if no sibling registrar
 * did already. The caller owns context building and output, so `--json` stays a
 * global flag.
 */
export function registerAdrLintCommand(
  program: Command,
  buildContext: () => CliContext,
  emit: (json: boolean, report: unknown, rendered: string) => void,
): void {
  adrParentCommand(program)
    .command('lint')
    .description('Check docs/adr/ for broken or circular supersedence (offline; never writes)')
    .action(() => {
      const ctx = buildContext()
      const { report, exitCode } = runAdrLint(ctx)
      emit(ctx.json, report, renderAdrLint(report))
      process.exitCode = exitCode
    })
}
