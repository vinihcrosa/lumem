/**
 * Static checks over a feature's artifacts: the ones a reader cannot reliably
 * make, plus a few worth saying out loud that never block.
 *
 * Reads the artifact text it needs from the feature directory — `readFeature`
 * keeps structure, not prose, and these checks are about prose. Never throws: a
 * missing or unreadable artifact is a finding, not an exception.
 *
 * The finding shape mirrors `core/adr`'s `AdrFinding` rather than importing
 * `core/memory`'s `LintFinding`: kinds are domain-specific, so a shared union
 * would force memory to know about spec kinds. What is shared is the *shape* —
 * kind, `gate | info` severity, ids, message — and the sorting rule, so every
 * lint in lumem renders identically.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { SpecFeature } from './feature'

/** The three artifacts that have gates. Smaller than `SpecPhase`, which covers the whole pipeline. */
export type SpecLintPhase = 'prd' | 'tdd' | 'tasks'

export type SpecLintKind =
  /** A question is still open while a later artifact already exists. */
  | 'unanswered-question'
  /** An assumption row with no chosen default, or no rationale for it. */
  | 'unclosed-ambiguity'
  /** A failure, state-transition or concurrency requirement written so it cannot be falsified. */
  | 'vague-risky-criterion'
  /** An answered question with no recorded effect. */
  | 'unscored-question'
  /** A field table row with no type. */
  | 'field-without-type'
  /** No fenced block anywhere declares anything. */
  | 'no-signature-block'
  /** An Invariants section written as prose or bullets rather than a numbered list. */
  | 'invariants-not-ordered'
  /** A deferred item with no trigger to bring it back. */
  | 'no-deferred-triggers'
  /** A declared case owned by no task. */
  | 'orphan-test-id'
  /** A declared case owned by more than one task. */
  | 'duplicate-test-id'
  /** Following `dependsOn` returns to a task already seen. */
  | 'dependency-cycle'
  /** `dependsOn` names a task that is not in the graph. */
  | 'unknown-dependency'
  /** A task that verifies nothing. */
  | 'task-without-tests'
  /** The artifact this phase checks is missing or unreadable. */
  | 'artifact-unreadable'

export interface SpecFinding {
  kind: SpecLintKind
  /**
   * `gate` for anything that makes the artifact unsafe to build against: an open
   * fork, an unfalsifiable requirement, a design a reader can interpret two ways,
   * a graph that cannot be walked. Everything else is information.
   */
  severity: 'gate' | 'info'
  /** The artifact, relative to the feature directory. */
  file: string
  /** Question, task or case ids involved. Empty for a whole-file finding. */
  ids: string[]
  /** One line: what is wrong, and where. */
  message: string
}

const SEVERITY_RANK: Record<SpecFinding['severity'], number> = { gate: 0, info: 1 }

const FILES: Record<SpecLintPhase, string> = {
  prd: 'prd.md',
  tdd: 'tdd.md',
  tasks: 'tasks.md',
}

/**
 * The three dimensions where prose reliably hides the requirement (D15). Notation
 * is required here and nowhere else — a criterion outside them is never flagged.
 */
const RISKY =
  /\b(fail|fails|failed|failure|error|errors|timeout|timed out|retry|retries|invalid|unreadable|malformed|corrupt\w*|concurren\w*|race|races|parallel|lock|locks|deadlock|transition|transitions)\b/i

/** Words that describe an outcome without naming one. */
const VAGUE =
  /\b(gracefully|quickly|properly|appropriately|correctly|reasonabl\w*|robustly|safely|efficiently|sensibly|as needed|if necessary)\b/i

/** The pattern keywords, uppercase by convention so prose cannot match by accident. */
const PATTERN = /\b(IF|WHEN|WHILE|WHERE)\b/

/**
 * A condition stated in prose instead of in the notation. Lowercase and
 * deliberately narrow — its job is to separate *"WHEN X fails, do Y"* written
 * badly from a requirement that merely mentions failure.
 *
 * Without it the check fires on any requirement *about* the risky dimensions —
 * "an acceptance criterion covering a failure path SHALL name a concrete
 * outcome" is always-on and correctly carries no keyword. Found by running this
 * gate against lumem's own PRD, which it flagged on exactly that line.
 */
const PROSE_CONDITION =
  /\b(?:if|when|whenever|while|unless|once|upon|after|during)\b|\bon (?:a |an |the )?(?:timeout|failure|failing|error|retry|invalid|malformed|corrupt)/

/** A requirement line: a table row or list item stating an obligation. */
const REQUIREMENT = /\bSHALL\b/

const FENCE_LINE = /^\s*```/
/** Something is being declared, in any of the languages a project might use. */
const DECLARATION =
  /\b(interface|type|class|struct|enum|func|function|def|record|protocol|trait|CREATE TABLE)\b/

const INVARIANTS_HEADING = /^#{1,4}[ \t]+.*\bInvariants?\b/i
const ORDERED_ITEM = /^\d+\.[ \t]/
const HEADING = /^#{1,6}[ \t]/

interface TableRow {
  cells: string[]
  /** 1-based line number in the artifact. */
  line: number
}

interface Table {
  header: string[]
  rows: TableRow[]
}

/** Cells of a pipe row, outer pipes dropped, each trimmed. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/** A separator row: `|---|---|`, optionally with alignment colons. */
function isSeparator(line: string): boolean {
  const parts = cells(line)
  return parts.length > 0 && parts.every((cell) => /^:?-{1,}:?$/.test(cell))
}

/** Every markdown table in `text`, header and data rows. Malformed tables are skipped. */
function tables(text: string): Table[] {
  const lines = text.split('\n')
  const out: Table[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!line.trim().startsWith('|')) continue
    const separator = lines[i + 1] ?? ''
    if (!separator.trim().startsWith('|') || !isSeparator(separator)) continue

    const table: Table = { header: cells(line), rows: [] }
    let cursor = i + 2
    while (cursor < lines.length && (lines[cursor] ?? '').trim().startsWith('|')) {
      table.rows.push({ cells: cells(lines[cursor] ?? ''), line: cursor + 1 })
      cursor++
    }
    out.push(table)
    i = cursor - 1
  }
  return out
}

/** Index of the first header cell matching `pattern`, or -1. */
function column(table: Table, pattern: RegExp): number {
  return table.header.findIndex((cell) => pattern.test(cell))
}

function artifact(dir: string, name: string): string | undefined {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8')
  } catch {
    return undefined
  }
}

function unreadable(file: string): SpecFinding {
  return {
    kind: 'artifact-unreadable',
    severity: 'gate',
    file,
    ids: [],
    message: `${file} is missing or could not be read, so this phase cannot be checked`,
  }
}

function lintPrd(f: SpecFeature, text: string): SpecFinding[] {
  const file = FILES.prd
  const findings: SpecFinding[] = []

  for (const question of f.questions) {
    if (!question.answered) {
      findings.push({
        kind: 'unanswered-question',
        severity: 'gate',
        file: 'questions.md',
        ids: [question.id],
        message: `${question.id} is unanswered while ${file} already exists: the artifact was written against an open fork`,
      })
    } else if (question.effect === undefined) {
      findings.push({
        kind: 'unscored-question',
        severity: 'info',
        file: 'questions.md',
        ids: [question.id],
        message: `${question.id} records no effect, so this round cannot be scored`,
      })
    }
  }

  for (const table of tables(text)) {
    const defaultAt = column(table, /default/i)
    const rationaleAt = column(table, /rationale/i)
    if (defaultAt === -1 || rationaleAt === -1) continue
    for (const row of table.rows) {
      const chosen = row.cells[defaultAt] ?? ''
      const why = row.cells[rationaleAt] ?? ''
      if (chosen !== '' && why !== '') continue
      findings.push({
        kind: 'unclosed-ambiguity',
        severity: 'gate',
        file,
        ids: [],
        message: `${file} line ${row.line}: an assumption with ${chosen === '' ? 'no chosen default' : 'no rationale'} — nothing proceeds unmarked`,
      })
    }
  }

  for (const [index, line] of text.split('\n').entries()) {
    if (!REQUIREMENT.test(line)) continue

    // Two separate rules, and the split matters. A vague outcome is unfalsifiable
    // in any dimension, so it is checked everywhere. A missing pattern keyword is
    // only a defect where prose hides the requirement, so that half stays scoped
    // to the three risky dimensions — an always-on invariant reads fine as prose.
    const vague = VAGUE.exec(line)
    if (vague !== null) {
      findings.push({
        kind: 'vague-risky-criterion',
        severity: 'gate',
        file,
        ids: [],
        message: `${file} line ${index + 1}: '${vague[0]}' describes an outcome without naming one`,
      })
      continue
    }
    if (RISKY.test(line) && PROSE_CONDITION.test(line) && !PATTERN.test(line)) {
      findings.push({
        kind: 'vague-risky-criterion',
        severity: 'gate',
        file,
        ids: [],
        message: `${file} line ${index + 1}: a failure, state or concurrency condition stated in prose — use IF / WHEN / WHILE / WHERE to pin when it applies`,
      })
    }
  }

  return findings
}

function lintTdd(text: string): SpecFinding[] {
  const file = FILES.tdd
  const findings: SpecFinding[] = []

  for (const table of tables(text)) {
    const typeAt = column(table, /^type$/i)
    if (typeAt === -1) continue
    for (const row of table.rows) {
      if ((row.cells[typeAt] ?? '') !== '') continue
      findings.push({
        kind: 'field-without-type',
        severity: 'gate',
        file,
        ids: [],
        message: `${file} line ${row.line}: a field with no type — the implementer has to invent one`,
      })
    }
  }

  let declares = false
  let inFence = false
  let fenced = ''
  for (const line of text.split('\n')) {
    if (FENCE_LINE.test(line)) {
      if (inFence && DECLARATION.test(fenced)) declares = true
      inFence = !inFence
      fenced = ''
      continue
    }
    if (inFence) fenced += `${line}\n`
  }
  if (!declares) {
    findings.push({
      kind: 'no-signature-block',
      severity: 'gate',
      file,
      ids: [],
      message: `${file} declares nothing in a fenced block: prose produces one implementation per reader`,
    })
  }

  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    if (!INVARIANTS_HEADING.test(line)) continue
    let cursor = index + 1
    while (cursor < lines.length && (lines[cursor] ?? '').trim() === '') cursor++
    const first = (lines[cursor] ?? '').trim()
    if (ORDERED_ITEM.test(first)) continue
    findings.push({
      kind: 'invariants-not-ordered',
      severity: 'gate',
      file,
      ids: [],
      message: `${file} line ${index + 1}: invariants are not a numbered list, so no one can cite one`,
    })
  }

  for (const table of tables(text)) {
    const deferredAt = column(table, /defer/i)
    const triggerAt = column(table, /revisit|trigger|when/i)
    if (deferredAt === -1 || triggerAt === -1) continue
    for (const row of table.rows) {
      if ((row.cells[triggerAt] ?? '') !== '') continue
      findings.push({
        kind: 'no-deferred-triggers',
        severity: 'info',
        file,
        ids: [],
        message: `${file} line ${row.line}: deferred with no trigger to bring it back`,
      })
    }
  }

  return findings
}

/** Every task id that sits on a `dependsOn` cycle. */
function cycleMembers(f: SpecFeature): string[] {
  const deps = new Map(f.tasks.map((t) => [t.id, t.dependsOn]))
  const state = new Map<string, 'open' | 'closed'>()
  const onCycle = new Set<string>()

  const walk = (id: string, trail: string[]): void => {
    if (state.get(id) === 'closed') return
    const at = trail.indexOf(id)
    if (at !== -1) {
      for (const member of trail.slice(at)) onCycle.add(member)
      return
    }
    for (const dep of deps.get(id) ?? []) {
      if (!deps.has(dep)) continue
      walk(dep, [...trail, id])
    }
    state.set(id, 'closed')
  }

  for (const task of f.tasks) walk(task.id, [])
  return [...onCycle].sort()
}

function lintTasks(f: SpecFeature): SpecFinding[] {
  const file = FILES.tasks
  const findings: SpecFinding[] = []
  const owners = new Map<string, string[]>()

  for (const task of f.tasks) {
    for (const id of task.testIds) {
      owners.set(id, [...(owners.get(id) ?? []), task.id])
    }
  }

  for (const id of f.testIds) {
    const holders = owners.get(id) ?? []
    if (holders.length === 0) {
      findings.push({
        kind: 'orphan-test-id',
        severity: 'gate',
        file,
        ids: [id],
        message: `${id} is declared in tests.md and owned by no task: the breakdown is missing a slice`,
      })
    } else if (holders.length > 1) {
      findings.push({
        kind: 'duplicate-test-id',
        severity: 'gate',
        file,
        ids: [id, ...holders],
        message: `${id} is owned by ${holders.join(' and ')}: a case belongs to exactly one task`,
      })
    }
  }

  const known = new Set(f.tasks.map((t) => t.id))
  for (const task of f.tasks) {
    for (const dep of task.dependsOn) {
      if (known.has(dep)) continue
      findings.push({
        kind: 'unknown-dependency',
        severity: 'gate',
        file,
        ids: [task.id, dep],
        message: `${task.id} depends on ${dep}, which is not in the graph`,
      })
    }
    if (task.testIds.length === 0) {
      findings.push({
        kind: 'task-without-tests',
        severity: 'info',
        file,
        ids: [task.id],
        message: `${task.id} verifies nothing: no case is assigned to it`,
      })
    }
  }

  const cycle = cycleMembers(f)
  if (cycle.length > 0) {
    findings.push({
      kind: 'dependency-cycle',
      severity: 'gate',
      file,
      ids: cycle,
      message: `${cycle.join(' → ')} form a dependency cycle, so no order satisfies the graph`,
    })
  }

  return findings
}

/**
 * Every check for one phase, sorted gates first, then by kind and by the ids
 * named — so two runs over the same feature render identically and a gate is
 * never buried under information.
 */
export function lintSpec(f: SpecFeature, phase: SpecLintPhase): SpecFinding[] {
  let findings: SpecFinding[]

  if (phase === 'tasks') {
    findings = f.has.tasks ? lintTasks(f) : [unreadable(FILES.tasks)]
  } else {
    const text = artifact(f.dir, FILES[phase])
    if (text === undefined) {
      findings = [unreadable(FILES[phase])]
    } else {
      findings = phase === 'prd' ? lintPrd(f, text) : lintTdd(text)
    }
  }

  return findings.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (bySeverity !== 0) return bySeverity
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
    const left = a.ids.join(',')
    const right = b.ids.join(',')
    if (left !== right) return left < right ? -1 : 1
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  })
}
