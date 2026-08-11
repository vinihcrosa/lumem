import fs from 'node:fs'
import path from 'node:path'
import type { Command } from 'commander'
import { BODY_TEMPLATE, adrFilename, serializeAdr, slugify } from '../core/adr/format'
import { atomicWrite } from '../core/shared/fsx'
import type { CliContext } from './context'

export interface AdrNewOptions {
  area: string
  summary?: string
  /** The `docs/features/` directory that produced this decision. */
  feature?: string
  supersedes?: string
  /** YYYY-MM-DD; defaults to today. */
  date?: string
  dryRun?: boolean
}

export interface AdrNewResult {
  ok: boolean
  /** Absolute path of the file created, or of the one --dry-run would create. */
  path?: string
  message: string
}

interface Outcome {
  result: AdrNewResult
  exitCode: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Seeded when `--summary` is absent; `adr lint`'s `todo-summary` then flags it. */
const TODO_SUMMARY = 'TODO: one sentence on what this decides'

/** Collision suffixes: `-2` through `-99`, then the command gives up. */
const MAX_COLLISION_SUFFIX = 99

/** A `supersedes` value containing `/` is a `<module>/<rule>` id, not a filename. */
const MODULE_RULE_SEPARATOR = '/'

function ok(message: string, filePath: string): Outcome {
  return { result: { ok: true, path: filePath, message }, exitCode: 0 }
}

/** No `path` on a failure: nothing was written, so there is nothing to point at. */
function fail(message: string): Outcome {
  return { result: { ok: false, message }, exitCode: 1 }
}

function localToday(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * The first free filename for this date and slug: the bare one, else `-2`, `-3`
 * and so on. Returns undefined once every suffix in range is taken, which means
 * the slug is far too generic to keep reusing.
 */
function freeFilename(adrDir: string, date: string, slug: string): string | undefined {
  for (let suffix = 1; suffix <= MAX_COLLISION_SUFFIX; suffix += 1) {
    const id = adrFilename(date, suffix === 1 ? slug : `${slug}-${suffix}`)
    if (!fs.existsSync(path.join(adrDir, id))) return id
  }
  return undefined
}

/**
 * Create `docs/adr/<date>-<slug>.md` with seeded frontmatter and body.
 *
 * Deliberately independent of `.lumem/`: an ADR is a repository document that a
 * reader meets through git, not through lumem, so the command has to work in a
 * project that never ran `lumem init` (TDD 001 §2.1).
 *
 * Every validation runs before anything touches disk, so a rejected invocation
 * leaves `docs/adr/` exactly as it found it — including not creating it.
 */
export function runAdrNew(ctx: CliContext, title: string, opts: AdrNewOptions): Outcome {
  const cleanTitle = title.trim()
  if (cleanTitle === '') return fail('empty title: an ADR needs a title stating the decision')

  const date = opts.date ?? localToday()
  if (!DATE_RE.test(date)) return fail(`invalid --date '${date}': expected YYYY-MM-DD`)

  const adrDir = path.join(ctx.projectDir, 'docs', 'adr')

  const supersedes = opts.supersedes?.trim()
  if (supersedes !== undefined && supersedes !== '') {
    // A module rule id is unresolvable in this slice: accepted and written through.
    const isModuleRule = supersedes.includes(MODULE_RULE_SEPARATOR)
    if (!isModuleRule && !fs.existsSync(path.join(adrDir, supersedes))) {
      return fail(
        `unknown --supersedes target '${supersedes}': no such file under docs/adr/; nothing was written`,
      )
    }
  }

  const slug = slugify(cleanTitle)
  const id = freeFilename(adrDir, date, slug)
  if (id === undefined) {
    return fail(
      `too many ADRs named '${adrFilename(date, slug)}': suffixes up to -${MAX_COLLISION_SUFFIX} are taken; nothing was written`,
    )
  }

  const summary = opts.summary?.trim()
  // Written through unvalidated: `adr lint` reports a name that matches no
  // directory, and it is informational there because a feature folder can be
  // renamed or archived without invalidating a decision it produced.
  const feature = opts.feature?.trim()
  const content = serializeAdr({
    title: cleanTitle,
    date,
    area: opts.area.trim(),
    summary: summary === undefined || summary === '' ? TODO_SUMMARY : summary,
    ...(feature === undefined || feature === '' ? {} : { feature }),
    ...(supersedes === undefined || supersedes === '' ? {} : { supersedes }),
    body: BODY_TEMPLATE,
  })

  const filePath = path.join(adrDir, id)
  if (opts.dryRun === true) {
    return ok(`dry-run: would create ${filePath}\n\n${content}`, filePath)
  }

  try {
    // atomicWrite creates docs/adr/ and its parents on the way.
    atomicWrite(filePath, content)
  } catch (err) {
    return fail(`could not write ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return ok(`created ${filePath}`, filePath)
}

/**
 * One status line. A dry-run message carries the whole file after that line, so
 * the newlines are kept: printing the intended content is the point of the flag.
 */
export function renderAdrNew(result: AdrNewResult): string {
  return `${result.ok ? '✔' : '✖'} ${result.message}`
}

type Emit = (json: boolean, report: unknown, rendered: string) => void

interface AdrNewFlags {
  area: string
  summary?: string
  feature?: string
  supersedes?: string
  date?: string
  dryRun?: boolean
}

/**
 * The `adr` parent command, created once and reused afterwards. Sibling
 * registrars (`adr lint`) call this too, so the order they run in does not
 * matter and neither has to own the parent.
 */
export function adrParentCommand(program: Command): Command {
  const existing = program.commands.find((cmd) => cmd.name() === 'adr')
  if (existing !== undefined) return existing
  return program.command('adr').description('Create and check architecture decision records')
}

/**
 * Attach `new` to the `adr` parent. The caller owns context building and output,
 * so `--json` stays a global flag.
 */
export function registerAdrCommands(
  program: Command,
  buildContext: () => CliContext,
  emit: Emit,
): void {
  adrParentCommand(program)
    .command('new <title>')
    .description('Create an architecture decision record under docs/adr/')
    .requiredOption('--area <area>', 'area the decision belongs to, e.g. auth')
    .option('--summary <text>', 'one sentence on what this decides (seeds a TODO when absent)')
    .option('--feature <slug>', 'docs/features directory that produced this decision')
    .option('--supersedes <file>', 'ADR filename this replaces, or a <module>/<rule> id')
    .option('--date <date>', 'decision date as YYYY-MM-DD (default today)')
    .option('--dry-run', 'print the file that would be written, without writing it')
    .action((title: string, options: AdrNewFlags) => {
      const ctx = buildContext()
      const { result, exitCode } = runAdrNew(ctx, title, {
        area: options.area,
        ...(options.summary === undefined ? {} : { summary: options.summary }),
        ...(options.feature === undefined ? {} : { feature: options.feature }),
        ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
        ...(options.date === undefined ? {} : { date: options.date }),
        dryRun: options.dryRun === true,
      })
      emit(ctx.json, result, renderAdrNew(result))
      process.exitCode = exitCode
    })
}
