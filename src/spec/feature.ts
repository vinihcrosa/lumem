/**
 * A feature directory under `docs/features/` read into one value.
 *
 * Reading is tolerant end to end (TDD 002 invariant 6): a missing directory, a
 * missing file, malformed frontmatter, an unknown tier, an unrecognised effect —
 * none of them throw. Every complaint becomes an entry in `warnings` so lint can
 * report it later with the file in hand, exactly as `core/adr` does.
 *
 * Dependency-free but for `node:fs` and `node:path`: this module reaches the
 * bundled spec entry, where the purity assertion fails the moment an external
 * import appears.
 *
 * **Phase is never stored** (invariant 1). Nothing here records, caches or infers
 * it; `nextAction` derives it from these fields every time it is asked.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseField, splitFrontmatter } from '../core/shared/frontmatter'

export type SpecTier = 'light' | 'design' | 'full'

export type SpecPhase =
  | 'context'
  | 'scope'
  | 'requirements'
  | 'prune'
  | 'design'
  | 'tasks'
  | 'execute'
  | 'verify'
  | 'done'

export type QuestionEffect = 'changed' | 'accepted' | 'rejected-framing' | 'not-understood'

export interface QuestionRecord {
  /** `Q6`. Unique within the feature. */
  id: string
  round: number
  answered: boolean
  /** Absent until the question is scored, or when the recorded value is unknown. */
  effect?: QuestionEffect
}

/**
 * A recorded verification verdict.
 *
 * `command` and `fingerprint` are optional because a verdict written before 003
 * has neither, and such a verdict has to keep parsing — it is simply never fresh,
 * which is the honest reading rather than an error.
 */
export interface VerdictRecord {
  result: 'pass' | 'fail'
  /** The command the author says produced this. */
  command?: string
  /**
   * The tree fingerprint as recorded, **verbatim**. A human's truncated display
   * form (`4f9c1a…`) is kept as written rather than normalised: it will not match
   * a computed hash, and reporting that is the point.
   */
  fingerprint?: string
}

export interface TaskRecord {
  /** `T3`. */
  id: string
  title: string
  done: boolean
  /** Task ids that must finish first. Empty, never undefined. */
  dependsOn: string[]
  /** Case ids this task owns, ranges already expanded. */
  testIds: string[]
  /**
   * The gate command this task declares, overriding the project default. Absent —
   * never an empty string — when the body declares none.
   */
  gate?: string
}

/** Which artifacts exist, plus whether the prune left a record. */
export type SpecArtifactFlags = Record<
  'context' | 'prd' | 'tdd' | 'tests' | 'tasks' | 'cutSection',
  boolean
>

export interface SpecFeature {
  /** The directory name. The identifier — frontmatter never overrides it. */
  slug: string
  dir: string
  /**
   * Absent when `decisions.md` carries no `tier`, or an unrecognised one. Absence
   * is a phase (`scope`), not an error: a tolerant parser cannot promise a value
   * the author never wrote, and defaulting one would silently skip the sizing
   * decision that D9 exists to make explicit.
   */
  tier?: SpecTier
  /** `YYYY-MM-DD`, or `''` when absent — the shape `core/adr` uses for a missing required field. */
  created: string
  has: SpecArtifactFlags
  questions: QuestionRecord[]
  tasks: TaskRecord[]
  /** Every case id declared in `tests.md`, deduplicated, in declaration order. */
  testIds: string[]
  /**
   * The verification verdict from `tasks.md`, absent until one is recorded.
   *
   * A verdict is a claim about the tree, so it lives beside the tasks it covers
   * rather than in a file of its own — the doubt about that is on the record in
   * 002 TDD §14.
   */
  verdict?: VerdictRecord
  /** Tolerant-parse complaints. Never thrown. */
  warnings: string[]
}

const FILES = {
  context: 'context.md',
  decisions: 'decisions.md',
  questions: 'questions.md',
  prd: 'prd.md',
  tdd: 'tdd.md',
  tests: 'tests.md',
  tasks: 'tasks.md',
} as const

const TIERS: readonly string[] = ['light', 'design', 'full']
const EFFECTS: readonly string[] = ['changed', 'accepted', 'rejected-framing', 'not-understood']
const DECISION_KEYS: readonly string[] = ['slug', 'tier', 'created']

/** `## Cut, and why` or `# Cut, and why`. The prune's record (D14). */
const CUT_HEADING = /^#{1,2}[ \t]+Cut, and why[ \t]*$/m
const ROUND_HEADING = /^##[ \t]+Round[ \t]+(\d+)/
const QUESTION_HEADING = /^###[ \t]+(Q\d+)\b/
const ANSWER_MARKER = '**Answer:**'
const EFFECT_MARKER = '**Effect:**'
/** A line that closes an answer rather than continuing it. */
const NOT_ANSWER_CONTINUATION = /^(?:\*\*|#|---|\||\s*$)/

/**
 * One id, or a range of them: `UT-04`, `UT-01…UT-15`, `IT-08...IT-10`.
 *
 * Both forms in one pattern so a single left-to-right scan yields ids in the
 * order they appear. Matching ranges separately and singles afterwards would
 * reorder them, which is the bug this shape prevents.
 */
const CASE_TOKEN = /\b(UT|IT)-(\d{2})(?:[ \t]*(?:…|\.\.\.)[ \t]*(UT|IT)-(\d{2}))?\b/g
/** A case-table row in `tests.md`: the id is the first cell. */
const CASE_ROW = /^\|[ \t]*((?:UT|IT)-\d{2})[ \t]*\|/
/** A task checkbox in a task body: `- [x] T1`, `- [ ] **T2** — …`. */
const TASK_CHECKBOX = /^-[ \t]*\[([ xX])\][ \t]*(?:\*\*)?(T\d+)\b/
/** A graph-table row: the id is the first cell. */
const TASK_ROW = /^\|[ \t]*(T\d+)[ \t]*\|/
/** `—`, `-`, or nothing: this task depends on nothing. */
const NO_DEPENDENCY = /^(?:—|–|-|)$/
/** The verification verdict line in `tasks.md`: `- **Result:** PASS`. */
const VERDICT_RESULT = /^-[ \t]*\*\*Result:\*\*[ \t]*(PASS|FAIL)\b/i
/** `- **Command:** npm run verify` */
const VERDICT_COMMAND = /^-[ \t]*\*\*Command:\*\*[ \t]*(.+)$/
/**
 * `- **Fingerprint:** 4f9c1a… (1284 files)`
 *
 * The first whitespace-delimited token only: the file count that may follow is
 * prose for a human and is deliberately not parsed (003 `Cut, and why`).
 */
const VERDICT_FINGERPRINT = /^-[ \t]*\*\*Fingerprint:\*\*[ \t]*(\S+)/
/** `- **Gate:** vitest run src/spec`, inside a task body. */
const TASK_GATE = /^-[ \t]*\*\*Gate:\*\*[ \t]*(.+)$/

/** Every flag false: a feature before its first artifact, and the parse's starting point. */
function noArtifacts(): SpecArtifactFlags {
  return { context: false, prd: false, tdd: false, tests: false, tasks: false, cutSection: false }
}

/** File contents, or `undefined` when it does not exist or cannot be read. */
function readText(dir: string, name: string): string | undefined {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8')
  } catch {
    return undefined
  }
}

/** Cells of a markdown table row, outer pipes dropped, each trimmed. */
function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map((cell) => cell.trim())
}

/**
 * Case ids in `text`, ranges expanded, deduplicated, in the order they appear.
 *
 * The range form is what makes a contract of eighty-odd cases writable by hand:
 * `UT-01…UT-15` in a task row means those fifteen ids belong to that task. A
 * descending or cross-prefix range yields nothing rather than guessing.
 */
export function expandCaseIds(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    out.push(id)
  }

  for (const [, prefix, from, toPrefix, to] of text.matchAll(CASE_TOKEN)) {
    if (prefix === undefined || from === undefined) continue
    if (to === undefined) {
      add(`${prefix}-${from}`)
      continue
    }
    // A cross-prefix (`UT-01…IT-05`) or descending range has no defined meaning:
    // drop it rather than guess, endpoints included.
    if (toPrefix !== prefix) continue
    const start = Number(from)
    const end = Number(to)
    if (end < start) continue
    for (let n = start; n <= end; n++) add(`${prefix}-${String(n).padStart(2, '0')}`)
  }
  return out
}

/** `decisions.md`: the only machine-read frontmatter in a feature, plus the prune record. */
function readDecisions(text: string, slug: string, feature: SpecFeature): void {
  const split = splitFrontmatter(text)
  if (split.kind !== 'ok') {
    feature.warnings.push(
      split.kind === 'none'
        ? `${FILES.decisions}: no frontmatter — the file does not open with a --- fence`
        : `${FILES.decisions}: the opening --- fence is never closed`,
    )
    // Broken frontmatter costs the frontmatter, not the file: the prune record is
    // in the prose, and losing it would report a prune that ran as one that did not.
    feature.has.cutSection = CUT_HEADING.test(text)
    return
  }

  const fields = new Map<string, string>()
  for (const [index, line] of split.lines.entries()) {
    if (line.trim() === '') continue
    const field = parseField(line)
    if (field === undefined) {
      feature.warnings.push(
        `${FILES.decisions} line ${index + 2}: skipped malformed frontmatter line`,
      )
      continue
    }
    if (!DECISION_KEYS.includes(field.key)) {
      feature.warnings.push(
        `${FILES.decisions} line ${index + 2}: ignored unknown frontmatter key '${field.key}'`,
      )
      continue
    }
    fields.set(field.key, field.value)
  }

  const declaredSlug = fields.get('slug')
  if (declaredSlug !== undefined && declaredSlug !== slug) {
    feature.warnings.push(
      `${FILES.decisions}: frontmatter slug '${declaredSlug}' disagrees with the directory name '${slug}'; the directory wins`,
    )
  }

  const tier = fields.get('tier')
  if (tier === undefined || tier === '') {
    feature.warnings.push(`${FILES.decisions}: no tier recorded; the size has not been settled`)
  } else if (TIERS.includes(tier)) {
    feature.tier = tier as SpecTier
  } else {
    feature.warnings.push(
      `${FILES.decisions}: unknown tier '${tier}'; expected light, design or full`,
    )
  }

  const created = fields.get('created')
  if (created === undefined || created === '') {
    feature.warnings.push(`${FILES.decisions}: missing or empty required field 'created'`)
  } else {
    feature.created = created
  }

  feature.has.cutSection = CUT_HEADING.test(split.body)
}

/** `questions.md`: one record per `### Qn`, with its round, answer state and effect. */
function readQuestions(text: string, feature: SpecFeature): QuestionRecord[] {
  const lines = text.split('\n')
  const records: QuestionRecord[] = []
  let round = 0
  let current: QuestionRecord | undefined

  for (const [index, line] of lines.entries()) {
    const roundMatch = ROUND_HEADING.exec(line)
    if (roundMatch?.[1] !== undefined) {
      round = Number(roundMatch[1])
      continue
    }

    const questionMatch = QUESTION_HEADING.exec(line)
    if (questionMatch?.[1] !== undefined) {
      current = { id: questionMatch[1], round, answered: false }
      records.push(current)
      continue
    }
    if (current === undefined) continue

    if (line.startsWith(ANSWER_MARKER)) {
      const sameLine = line.slice(ANSWER_MARKER.length).trim()
      const next = lines[index + 1] ?? ''
      // An answer may start on the next line, but `**Effect:**`, a heading, a
      // table row and a rule all close it rather than continuing it.
      current.answered = sameLine !== '' || !NOT_ANSWER_CONTINUATION.test(next)
      continue
    }

    if (line.startsWith(EFFECT_MARKER)) {
      const value = line.slice(EFFECT_MARKER.length).trim()
      if (EFFECTS.includes(value)) {
        current.effect = value as QuestionEffect
      } else {
        feature.warnings.push(
          `${FILES.questions}: ${current.id} records an unknown effect '${value}'`,
        )
      }
    }
  }

  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.id)) {
      feature.warnings.push(`${FILES.questions}: duplicate question id '${record.id}'`)
    }
    seen.add(record.id)
  }
  return records
}

/**
 * `tasks.md`: topology from the graph table, state from the task bodies.
 *
 * The split is deliberate. One table owns dependencies and case ownership, so
 * there is a single place to read the graph; each body owns its own checkbox, so
 * marking a task done touches only that task.
 */
function readTasks(text: string, feature: SpecFeature): TaskRecord[] {
  const lines = text.split('\n')
  const order: string[] = []
  const byId = new Map<string, TaskRecord>()
  let columns: { title: number; depends: number; cases: number } | undefined
  /** The task whose body is being read, so a `Gate:` line knows its owner. */
  let currentTask: string | undefined

  for (const line of lines) {
    const trimmed = line.trim()

    const verdictMatch = VERDICT_RESULT.exec(trimmed)
    if (verdictMatch?.[1] !== undefined) {
      const result = verdictMatch[1].toUpperCase() === 'PASS' ? 'pass' : 'fail'
      if (feature.verdict !== undefined && feature.verdict.result !== result) {
        feature.warnings.push(`${FILES.tasks}: two verdicts recorded and they disagree`)
      }
      // A second Result line starts a new record: the command and fingerprint
      // below it belong to that one, not to the verdict it replaced.
      feature.verdict = { result }
      continue
    }

    const commandMatch = VERDICT_COMMAND.exec(trimmed)
    if (commandMatch?.[1] !== undefined && feature.verdict !== undefined) {
      feature.verdict.command = commandMatch[1].trim()
      continue
    }

    const fingerprintMatch = VERDICT_FINGERPRINT.exec(trimmed)
    if (fingerprintMatch?.[1] !== undefined && feature.verdict !== undefined) {
      feature.verdict.fingerprint = fingerprintMatch[1]
      continue
    }

    const gateMatch = TASK_GATE.exec(trimmed)
    if (gateMatch?.[1] !== undefined) {
      // A Gate line belongs to the task whose checkbox opened the body it sits in.
      const record = currentTask === undefined ? undefined : byId.get(currentTask)
      if (record === undefined) {
        feature.warnings.push(`${FILES.tasks}: a Gate line outside any task body`)
      } else {
        record.gate = gateMatch[1].trim()
      }
      continue
    }

    if (columns === undefined && trimmed.startsWith('|')) {
      const header = cells(trimmed).map((cell) => cell.toLowerCase())
      const title = header.findIndex((cell) => cell === 'title')
      const depends = header.findIndex((cell) => cell.startsWith('depends'))
      const cases = header.findIndex((cell) => cell.startsWith('case'))
      if (title !== -1 && depends !== -1 && cases !== -1) columns = { title, depends, cases }
    }

    const rowMatch = TASK_ROW.exec(trimmed)
    if (rowMatch?.[1] !== undefined) {
      const id = rowMatch[1]
      const row = cells(trimmed)
      // Without a recognisable header, fall back to the documented column order.
      const map = columns ?? { title: 1, depends: 4, cases: 5 }
      const dependsCell = row[map.depends] ?? ''
      const record: TaskRecord = {
        id,
        title: row[map.title] ?? '',
        done: false,
        dependsOn: NO_DEPENDENCY.test(dependsCell)
          ? []
          : (dependsCell.match(/\bT\d+\b/g) ?? []).slice(),
        testIds: expandCaseIds(row[map.cases] ?? ''),
      }
      if (byId.has(id)) {
        feature.warnings.push(`${FILES.tasks}: duplicate graph row for '${id}'`)
        continue
      }
      byId.set(id, record)
      order.push(id)
      continue
    }

    const boxMatch = TASK_CHECKBOX.exec(trimmed)
    if (boxMatch?.[1] !== undefined && boxMatch[2] !== undefined) {
      const record = byId.get(boxMatch[2])
      if (record === undefined) {
        feature.warnings.push(
          `${FILES.tasks}: checkbox for '${boxMatch[2]}', which has no row in the graph table`,
        )
        continue
      }
      record.done = boxMatch[1] !== ' '
      currentTask = boxMatch[2]
    }
  }

  return order.map((id) => byId.get(id) as TaskRecord)
}

/** Case ids declared in `tests.md` — first cell of a case-table row, nothing else. */
function readTestIds(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const match = CASE_ROW.exec(line.trim())
    const id = match?.[1]
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Read a feature directory. Never throws.
 *
 * A directory that does not exist returns a feature with every flag false and one
 * warning — the same value a brand-new feature has before its first artifact,
 * which is what lets `nextAction` answer `create-context` without a special case.
 */
export function readFeature(dir: string): SpecFeature {
  const slug = path.basename(dir)
  const feature: SpecFeature = {
    slug,
    dir,
    created: '',
    has: noArtifacts(),
    questions: [],
    tasks: [],
    testIds: [],
    warnings: [],
  }

  let readable = false
  try {
    readable = fs.statSync(dir).isDirectory()
  } catch {
    readable = false
  }
  if (!readable) {
    feature.warnings.push(`${dir}: not a readable directory`)
    return feature
  }

  feature.has.context = readText(dir, FILES.context) !== undefined

  const decisions = readText(dir, FILES.decisions)
  if (decisions !== undefined) readDecisions(decisions, slug, feature)

  const questions = readText(dir, FILES.questions)
  if (questions !== undefined) feature.questions = readQuestions(questions, feature)

  feature.has.prd = readText(dir, FILES.prd) !== undefined
  feature.has.tdd = readText(dir, FILES.tdd) !== undefined

  const tests = readText(dir, FILES.tests)
  feature.has.tests = tests !== undefined
  if (tests !== undefined) feature.testIds = readTestIds(tests)

  const tasks = readText(dir, FILES.tasks)
  feature.has.tasks = tasks !== undefined
  if (tasks !== undefined) feature.tasks = readTasks(tasks, feature)

  return feature
}
