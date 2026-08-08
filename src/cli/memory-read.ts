import os from 'node:os'
import path from 'node:path'
import type { Command } from 'commander'
import {
  type Fact,
  type MemoryFile,
  memoryLayout,
  readMemoryFile,
  searchFacts,
} from '../core/memory/store'
import type { CliContext } from './context'

export interface MemoryPaths {
  /** `<projectDir>/.lumem` — project scope root. */
  projectLumemDir: string
  /** `<HOME>/.lumem` — global scope root. */
  globalLumemDir: string
}

/** A fact plus the memory file it was read from, so merged scopes stay traceable. */
export interface MemoryFactView extends Fact {
  file: string
}

export interface MemoryListReport {
  facts: MemoryFactView[]
  /** Parser diagnostics from every file read, each prefixed with its path. */
  warnings: string[]
}

export interface MemoryShowReport {
  /** The id that was asked for, echoed so the renderer can name it when absent. */
  id: string
  fact?: MemoryFactView
  found: boolean
}

export interface MemoryListOptions {
  type?: string
  scope?: string
}

/** Roots of the two memory scopes. HOME comes from the context — never read directly. */
export function resolveMemoryPaths(ctx: CliContext): MemoryPaths {
  return {
    projectLumemDir: path.join(ctx.projectDir, '.lumem'),
    globalLumemDir: path.join(ctx.env.HOME ?? os.homedir(), '.lumem'),
  }
}

/** Read the four layout files. Missing files come back empty — that is not an error. */
export function loadAllMemory(ctx: CliContext): MemoryFile[] {
  const { projectLumemDir, globalLumemDir } = resolveMemoryPaths(ctx)
  return memoryLayout(projectLumemDir, globalLumemDir).map((entry) =>
    readMemoryFile(entry.path, { type: entry.type, scope: entry.scope }),
  )
}

function viewsOf(file: MemoryFile): MemoryFactView[] {
  return file.facts.map((fact) => ({ ...fact, file: file.path }))
}

function collectWarnings(files: MemoryFile[]): string[] {
  return files.flatMap((file) => file.warnings.map((warning) => `${file.path}: ${warning}`))
}

export function runMemoryList(
  ctx: CliContext,
  opts?: MemoryListOptions,
): { report: MemoryListReport; exitCode: number } {
  const files = loadAllMemory(ctx)
  const facts = files
    .flatMap(viewsOf)
    .filter((fact) => opts?.type === undefined || fact.type === opts.type)
    .filter((fact) => opts?.scope === undefined || fact.scope === opts.scope)

  // Warnings are diagnostics about the store itself: never filtered away.
  return { report: { facts, warnings: collectWarnings(files) }, exitCode: 0 }
}

export function runMemoryShow(
  ctx: CliContext,
  id: string,
): { report: MemoryShowReport; exitCode: number } {
  const fact = loadAllMemory(ctx)
    .flatMap(viewsOf)
    .find((candidate) => candidate.id === id)

  if (fact === undefined) return { report: { id, found: false }, exitCode: 1 }
  return { report: { id, fact, found: true }, exitCode: 0 }
}

export function runMemorySearch(
  ctx: CliContext,
  query: string,
): { report: MemoryListReport; exitCode: number } {
  const files = loadAllMemory(ctx)
  // One file at a time so each hit keeps the path it came from.
  const facts = files.flatMap((file) =>
    searchFacts([file], query).map((fact) => ({ ...fact, file: file.path })),
  )

  return { report: { facts, warnings: collectWarnings(files) }, exitCode: 0 }
}

export function renderMemoryList(report: MemoryListReport): string {
  const lines =
    report.facts.length === 0
      ? ['no facts recorded']
      : report.facts.map((fact) => {
          const [first] = fact.body.split('\n')
          return `${fact.id}  [${fact.date}]  (${fact.type}/${fact.scope})  ${first ?? ''}`
        })

  for (const warning of report.warnings) lines.push(`warning: ${warning}`)
  return lines.join('\n')
}

export function renderMemoryShow(report: MemoryShowReport): string {
  const fact = report.fact
  if (!report.found || fact === undefined) return `fact ${report.id} not found`

  return [
    `${fact.id}  [${fact.date}]  (${fact.type}/${fact.scope})`,
    fact.body,
    `src:${fact.src} conf:${fact.conf}`,
    `file: ${fact.file}`,
  ].join('\n')
}

/**
 * Attach `list`, `show <id>` and `search <query>` to the given `memory` command.
 * The caller owns context building and output (so `--json` stays a global flag).
 */
export function registerMemoryReadCommands(
  memoryCmd: Command,
  buildContext: () => CliContext,
  emit: (json: boolean, report: unknown, rendered: string) => void,
): void {
  memoryCmd
    .command('list')
    .description('List memory facts (project + global)')
    .option('--type <type>', 'filter by type: project | preference | correction')
    .option('--scope <scope>', 'filter by scope: project | global')
    .action((opts: MemoryListOptions) => {
      const ctx = buildContext()
      const { report, exitCode } = runMemoryList(ctx, opts)
      emit(ctx.json, report, renderMemoryList(report))
      process.exitCode = exitCode
    })

  memoryCmd
    .command('show')
    .argument('<id>', 'fact id as shown by `lumem memory list`')
    .description('Show a full fact with its provenance')
    .action((id: string) => {
      const ctx = buildContext()
      const { report, exitCode } = runMemoryShow(ctx, id)
      emit(ctx.json, report, renderMemoryShow(report))
      process.exitCode = exitCode
    })

  memoryCmd
    .command('search')
    .argument('<query>', 'substring searched in fact bodies (case-insensitive)')
    .description('Search facts by body substring')
    .action((query: string) => {
      const ctx = buildContext()
      const { report, exitCode } = runMemorySearch(ctx, query)
      emit(ctx.json, report, renderMemoryList(report))
      process.exitCode = exitCode
    })
}
