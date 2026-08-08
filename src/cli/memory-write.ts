import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Command } from 'commander'
import {
  type Fact,
  type MemoryFile,
  type MemoryScope,
  type MemoryType,
  SecretRefusalError,
  addFact,
  factId,
  memoryLayout,
  readMemoryFile,
  removeFact,
  writeMemoryFile,
} from '../core/memory/store'
import { scanSecrets } from '../core/shared/secrets'
import type { CliContext } from './context'

export interface MemoryWriteResult {
  ok: boolean
  factId?: string
  message: string
  filePath?: string
}

interface Outcome {
  result: MemoryWriteResult
  exitCode: number
}

export interface MemoryAddOptions {
  body: string
  type: MemoryType
  /** Defaults per type: project→project, preference→global, correction→project. */
  scope?: MemoryScope
  /** Defaults to 'medium'. */
  conf?: Fact['conf']
  /** YYYY-MM-DD; defaults to today. */
  date?: string
  dryRun?: boolean
}

export interface MemoryEditOptions {
  body: string
  dryRun?: boolean
}

export interface MemoryForgetOptions {
  dryRun?: boolean
}

/** Provenance token stamped on every fact written by these commands. */
const MANUAL_SRC = 'manual'

const DEFAULT_SCOPE: Record<MemoryType, MemoryScope> = {
  project: 'project',
  preference: 'global',
  correction: 'project',
}

const MEMORY_TYPES: readonly MemoryType[] = ['project', 'preference', 'correction']
const MEMORY_SCOPES: readonly MemoryScope[] = ['project', 'global']
const CONF_LEVELS: readonly Fact['conf'][] = ['low', 'medium', 'high']

interface MemoryTarget {
  path: string
  type: MemoryType
  scope: MemoryScope
}

/**
 * The four durable memory files for this context. Kept local on purpose: the
 * two path lines below are cheaper than a cross-module dependency.
 */
function memoryTargets(ctx: CliContext): MemoryTarget[] {
  const projectLumemDir = path.join(ctx.projectDir, '.lumem')
  const globalLumemDir = path.join(ctx.env.HOME ?? os.homedir(), '.lumem')
  return memoryLayout(projectLumemDir, globalLumemDir)
}

function ok(message: string, id: string, filePath: string): Outcome {
  return { result: { ok: true, factId: id, message, filePath }, exitCode: 0 }
}

function fail(message: string, filePath?: string): Outcome {
  return {
    result: { ok: false, message, ...(filePath === undefined ? {} : { filePath }) },
    exitCode: 1,
  }
}

function secretMessage(kinds: string[]): string {
  const unique = [...new Set(kinds)].join(', ')
  return `refused to write: apparent secret detected (${unique}); nothing was written`
}

function errorMessage(err: unknown): string {
  if (err instanceof SecretRefusalError) return secretMessage(err.hits.map((hit) => hit.kind))
  return err instanceof Error ? err.message : String(err)
}

/** Same scan the write choke point performs, used to make --dry-run truthful. */
function dryRunRefusal(facts: Fact[]): string | undefined {
  const kinds = facts.flatMap((fact) =>
    scanSecrets(`${fact.body}\n${fact.src}`).map((hit) => hit.kind),
  )
  return kinds.length > 0 ? secretMessage(kinds) : undefined
}

/** Write through the choke point, mapping any refusal onto a failed outcome. */
function commit(file: MemoryFile, message: string, id: string): Outcome {
  try {
    writeMemoryFile(file)
  } catch (err) {
    return fail(errorMessage(err), file.path)
  }
  return ok(message, id, file.path)
}

/** Locate the fact with `id` across the four memory files. */
function findFact(ctx: CliContext, id: string): { file: MemoryFile; index: number } | undefined {
  for (const target of memoryTargets(ctx)) {
    const file = readMemoryFile(target.path, { type: target.type, scope: target.scope })
    const index = file.facts.findIndex((fact) => fact.id === id)
    if (index !== -1) return { file, index }
  }
  return undefined
}

export function runMemoryAdd(ctx: CliContext, opts: MemoryAddOptions): Outcome {
  const scope = opts.scope ?? DEFAULT_SCOPE[opts.type]
  const targets = memoryTargets(ctx)
  const target = targets.find((t) => t.type === opts.type && t.scope === scope)
  if (target === undefined) {
    const allowed = targets
      .filter((t) => t.type === opts.type)
      .map((t) => `'${t.scope}'`)
      .join(', ')
    return fail(
      `type '${opts.type}' cannot be written with scope '${scope}': allowed scope(s): ${allowed}`,
    )
  }

  const body = opts.body.trim()
  if (body === '') return fail('empty body: nothing to add', target.path)

  const file = readMemoryFile(target.path, { type: target.type, scope: target.scope })
  let fact: Fact
  try {
    fact = addFact(file, { body, src: MANUAL_SRC, conf: opts.conf ?? 'medium', date: opts.date })
  } catch (err) {
    return fail(errorMessage(err), target.path)
  }

  if (opts.dryRun === true) {
    const refusal = dryRunRefusal([fact])
    if (refusal !== undefined) return fail(refusal, target.path)
    return ok(`dry-run: would add fact ${fact.id} to ${target.path}`, fact.id, target.path)
  }

  return commit(file, `added fact ${fact.id} to ${target.path}`, fact.id)
}

export function runMemoryEdit(ctx: CliContext, id: string, opts: MemoryEditOptions): Outcome {
  const found = findFact(ctx, id)
  if (found === undefined) return fail(`unknown fact id '${id}': nothing to edit`)

  const { file, index } = found
  const current = file.facts[index]
  if (current === undefined) return fail(`unknown fact id '${id}': nothing to edit`, file.path)

  const body = opts.body.trim()
  if (body === '') return fail('empty body: nothing to write', file.path)

  const newId = factId(body)
  if (file.facts.some((fact, i) => i !== index && fact.id === newId)) {
    return fail(
      `duplicate fact id '${newId}': an equivalent fact already exists in ${file.path}`,
      file.path,
    )
  }

  const updated: Fact = { ...current, id: newId, body }
  file.facts[index] = updated

  if (opts.dryRun === true) {
    const refusal = dryRunRefusal([updated])
    if (refusal !== undefined) return fail(refusal, file.path)
    return ok(`dry-run: would rewrite fact ${id} as ${newId} in ${file.path}`, newId, file.path)
  }

  return commit(file, `edited fact ${id} → ${newId} in ${file.path}`, newId)
}

export function runMemoryForget(
  ctx: CliContext,
  id: string,
  opts: MemoryForgetOptions = {},
): Outcome {
  const found = findFact(ctx, id)
  if (found === undefined) return fail(`unknown fact id '${id}': nothing to forget`)

  const { file } = found

  if (opts.dryRun === true) {
    return ok(`dry-run: would remove fact ${id} from ${file.path}`, id, file.path)
  }

  removeFact(file, id)
  return commit(file, `forgot fact ${id} from ${file.path}`, id)
}

export function renderMemoryWrite(result: MemoryWriteResult): string {
  return `${result.ok ? '✔' : '✖'} ${result.message.replace(/\s*\n\s*/g, ' ')}`
}

type Emit = (json: boolean, report: unknown, rendered: string) => void

function emitOutcome(ctx: CliContext, emit: Emit, outcome: Outcome): void {
  emit(ctx.json, outcome.result, renderMemoryWrite(outcome.result))
  process.exitCode = outcome.exitCode
}

/**
 * Interactive fallback for `memory edit` without --body. Deliberately kept out
 * of the pure run* functions and out of the test suite: it needs a real $EDITOR.
 */
function readBodyFromEditor(ctx: CliContext, id: string): string | undefined {
  const editor = process.env.EDITOR
  if (editor === undefined || editor.trim() === '') return undefined

  const found = findFact(ctx, id)
  const seed = found === undefined ? '' : (found.file.facts[found.index]?.body ?? '')
  const tmpPath = path.join(os.tmpdir(), `lumem-edit-${id}.md`)
  try {
    fs.writeFileSync(tmpPath, seed)
    const spawned = spawnSync(editor, [tmpPath], { stdio: 'inherit', shell: true })
    if (spawned.status !== 0) return undefined
    return fs.readFileSync(tmpPath, 'utf8')
  } finally {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // best-effort cleanup
    }
  }
}

export function registerMemoryWriteCommands(
  memoryCmd: Command,
  buildContext: () => CliContext,
  emit: Emit,
): void {
  memoryCmd
    .command('add <body>')
    .description('Record a durable memory fact')
    .requiredOption('--type <type>', `fact type: ${MEMORY_TYPES.join(' | ')}`)
    .option('--scope <scope>', `override the scope: ${MEMORY_SCOPES.join(' | ')}`)
    .option('--conf <conf>', `confidence: ${CONF_LEVELS.join(' | ')} (default medium)`)
    .option('--date <date>', 'fact date as YYYY-MM-DD (default today)')
    .option('--dry-run', 'report what would happen without writing')
    .action(
      (
        body: string,
        options: { type: string; scope?: string; conf?: string; date?: string; dryRun?: boolean },
      ) => {
        const ctx = buildContext()

        const type = MEMORY_TYPES.find((t) => t === options.type)
        if (type === undefined) {
          emitOutcome(
            ctx,
            emit,
            fail(`invalid --type '${options.type}': expected ${MEMORY_TYPES.join(' | ')}`),
          )
          return
        }

        let scope: MemoryScope | undefined
        if (options.scope !== undefined) {
          scope = MEMORY_SCOPES.find((s) => s === options.scope)
          if (scope === undefined) {
            emitOutcome(
              ctx,
              emit,
              fail(`invalid --scope '${options.scope}': expected ${MEMORY_SCOPES.join(' | ')}`),
            )
            return
          }
        }

        let conf: Fact['conf'] | undefined
        if (options.conf !== undefined) {
          conf = CONF_LEVELS.find((c) => c === options.conf)
          if (conf === undefined) {
            emitOutcome(
              ctx,
              emit,
              fail(`invalid --conf '${options.conf}': expected ${CONF_LEVELS.join(' | ')}`),
            )
            return
          }
        }

        emitOutcome(
          ctx,
          emit,
          runMemoryAdd(ctx, {
            body,
            type,
            scope,
            conf,
            date: options.date,
            dryRun: options.dryRun === true,
          }),
        )
      },
    )

  memoryCmd
    .command('edit <id>')
    .description('Rewrite the body of an existing fact')
    .option('--body <body>', 'new fact body (falls back to $EDITOR when omitted)')
    .option('--dry-run', 'report what would happen without writing')
    .action((id: string, options: { body?: string; dryRun?: boolean }) => {
      const ctx = buildContext()
      const body = options.body ?? readBodyFromEditor(ctx, id)
      if (body === undefined) {
        emitOutcome(ctx, emit, fail('--body is required (or set $EDITOR to edit interactively)'))
        return
      }
      emitOutcome(ctx, emit, runMemoryEdit(ctx, id, { body, dryRun: options.dryRun === true }))
    })

  memoryCmd
    .command('forget <id>')
    .description('Remove a fact by id')
    .option('--dry-run', 'report what would happen without writing')
    .action((id: string, options: { dryRun?: boolean }) => {
      const ctx = buildContext()
      emitOutcome(ctx, emit, runMemoryForget(ctx, id, { dryRun: options.dryRun === true }))
    })
}
