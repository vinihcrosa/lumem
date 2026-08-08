import fs from 'node:fs'
import path from 'node:path'
import type { FileBudgets } from './limits'
import { DEFAULT_FILE_BUDGETS, checkSoftLimits } from './limits'
import type { Fact, MemoryFile } from './store'

export type LintKind =
  | 'contradiction'
  | 'near-duplicate'
  | 'stale'
  | 'dead-reference'
  | 'low-confidence'
  | 'over-budget'
  | 'malformed'

export interface LintFinding {
  kind: LintKind
  severity: 'warn' | 'info'
  /** One fact, two for pairwise findings, none for whole-file findings. */
  factIds: string[]
  file: string
  /** One line: what is suspected, and why. */
  message: string
  /** The fact bodies, or the offending token — material for the renderer. */
  detail?: string
}

export interface LintOptions {
  now?: Date
  /** Age beyond which a fact is flagged for review. */
  staleDays?: number
  /** Enables dead-reference checks; omit to skip them (nothing is read from disk). */
  projectDir?: string
  budgets?: FileBudgets
}

/** PRD §5.5 review cadence: a fact untouched for a full quarter deserves a look. */
export const DEFAULT_STALE_DAYS = 120

/** Jaccard overlap of content words at or above which two facts are "the same subject". */
/**
 * One threshold decides whether a pair is worth a human's attention; polarity
 * only decides the label.
 *
 * 0.6 was measured too strict against real memory. Consolidation paraphrases,
 * so a genuine pair — "auth uses session cookies, not JWT" against "auth does
 * not use session cookies, JWT instead" — scores 0.57 and was dropped in
 * silence. The score distribution is bimodal: facts about different subjects
 * share almost nothing once stopwords go and land near 0.0, while facts about
 * the same subject land at 0.5+. Nothing real occupies the middle, so 0.4 buys
 * the misses back without costing precision.
 *
 * Polarity is a weaker label than it looks: a real contradiction often negates
 * on BOTH sides ("uses X, not Y" against "does not use X"), which reads as no
 * flip at all. When that happens the pair still surfaces, as `near-duplicate`,
 * and its message still says one may supersede the other — which is the part a
 * reviewer acts on. Telling contradiction from redundancy needs meaning, and
 * that is the consolidation model's job, not a word-overlap heuristic's.
 */
const SIMILARITY_THRESHOLD = 0.4

const DAY_MS = 86_400_000
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Deliberately small: only words that carry no subject matter. Anything
 * domain-ish stays in, because dropping it would make unrelated facts look
 * alike — a lint that cries wolf gets ignored.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'our',
  'so',
  'than',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'when',
  'which',
  'while',
  'will',
  'with',
  'you',
  'your',
])

/**
 * Polarity carriers are excluded from the content-word set: the whole point of
 * the contradiction check is that "X uses cookies" and "X does not use cookies"
 * are about the same subject, so the negation must not push them apart.
 */
const POLARITY_WORDS = new Set([
  'aren',
  'didn',
  'doesn',
  'don',
  'dropped',
  'instead',
  'isn',
  'longer',
  'never',
  'no',
  'not',
  'stopped',
  't',
  'wasn',
])

/** Markers whose presence on exactly one side of a similar pair flips polarity. */
const NEGATION_MARKERS = [
  'not',
  'never',
  'no longer',
  "isn't",
  "doesn't",
  'stopped',
  'dropped',
  'instead of',
]

/** A token starting with one of these is treated as a path even without an extension. */
const SOURCE_DIR_PREFIXES = ['src/', 'test/', 'scripts/', 'assets/', '.github/']

/**
 * Re-examine the accumulated memory set and flag what looks wrong. Offline and
 * deterministic (NFR-3): no LLM, no network. It flags, it never fixes — every
 * finding is a candidate for a human, and nothing is written anywhere.
 *
 * Pure apart from the `dead-reference` existence checks, which only run when
 * `projectDir` is given. Never throws, for any input.
 */
export function lintMemory(files: MemoryFile[], opts?: LintOptions): LintFinding[] {
  const now = opts?.now ?? new Date()
  const staleDays = opts?.staleDays ?? DEFAULT_STALE_DAYS
  const budgets = opts?.budgets ?? DEFAULT_FILE_BUDGETS
  const projectDir = opts?.projectDir

  const findings: LintFinding[] = []

  for (const file of files) {
    findings.push(...pairwiseFindings(file))

    for (const fact of file.facts) {
      const stale = staleFinding(fact, file, now, staleDays)
      if (stale !== undefined) findings.push(stale)

      if (fact.conf === 'low') {
        findings.push({
          kind: 'low-confidence',
          severity: 'info',
          factIds: [fact.id],
          file: file.path,
          message:
            "fact was written with conf 'low'; consolidation prefers writing nothing over writing low, so confirm or drop it",
          detail: oneLine(fact.body),
        })
      }

      // Global facts are not about this repository: a path in one proves nothing.
      if (projectDir !== undefined && fact.scope === 'project') {
        findings.push(...deadReferenceFindings(fact, file, projectDir))
      }
    }

    const limits = checkSoftLimits(file, budgets)
    if (limits.exceeded) {
      const budget = budgets[file.type]
      findings.push({
        kind: 'over-budget',
        severity: 'warn',
        factIds: [],
        file: file.path,
        message: `file is over its soft budget: ${limits.lines} lines / ${limits.bytes} bytes against ${budget.lines} lines / ${budget.bytes} bytes; the next consolidation will compact it`,
      })
    }

    for (const warning of file.warnings) {
      findings.push({
        kind: 'malformed',
        severity: 'info',
        factIds: [],
        file: file.path,
        message: `${warning}; a line the parser skipped is a fact that silently is not there`,
      })
    }
  }

  return findings.sort(compareFindings)
}

/** Deterministic order: kind, then file, then the fact ids, then the message. */
function compareFindings(a: LintFinding, b: LintFinding): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
  if (a.file !== b.file) return a.file < b.file ? -1 : 1

  const firstA = a.factIds[0] ?? ''
  const firstB = b.factIds[0] ?? ''
  if (firstA !== firstB) return firstA < firstB ? -1 : 1

  const idsA = a.factIds.join(',')
  const idsB = b.factIds.join(',')
  if (idsA !== idsB) return idsA < idsB ? -1 : 1

  if (a.message === b.message) return 0
  return a.message < b.message ? -1 : 1
}

/**
 * Same-file pairs whose content words overlap heavily. A polarity difference
 * makes the pair a contradiction candidate, otherwise it is a near-duplicate —
 * a pair is reported once, under exactly one of the two kinds.
 */
function pairwiseFindings(file: MemoryFile): LintFinding[] {
  const words = file.facts.map((fact) => contentWords(fact.body))
  const negated = file.facts.map((fact) => hasNegation(fact.body))
  const findings: LintFinding[] = []

  for (let i = 0; i < file.facts.length; i++) {
    for (let j = i + 1; j < file.facts.length; j++) {
      const left = file.facts[i]
      const right = file.facts[j]
      if (left === undefined || right === undefined) continue

      const overlap = jaccard(words[i] ?? new Set(), words[j] ?? new Set())
      if (overlap < SIMILARITY_THRESHOLD) continue

      const percent = Math.round(overlap * 100)
      const factIds = [left.id, right.id]
      const detail = pairDetail(left, right)

      if (negated[i] !== negated[j]) {
        const newer = left.date >= right.date ? left : right
        findings.push({
          kind: 'contradiction',
          severity: 'warn',
          factIds,
          file: file.path,
          message: `possible contradiction: ${percent}% word overlap with opposite polarity; the newer fact ${newer.id} dated ${newer.date} probably supersedes the other — a candidate to review, not a verdict`,
          detail,
        })
      } else {
        findings.push({
          kind: 'near-duplicate',
          severity: 'warn',
          factIds,
          file: file.path,
          message: `possible near-duplicate: ${percent}% word overlap, so these two may be redundant and one probably supersedes the other`,
          detail,
        })
      }
    }
  }

  return findings
}

function pairDetail(left: Fact, right: Fact): string {
  return [
    `${left.id} [${left.date}] ${oneLine(left.body)}`,
    `${right.id} [${right.date}] ${oneLine(right.body)}`,
  ].join('\n')
}

function staleFinding(
  fact: Fact,
  file: MemoryFile,
  now: Date,
  staleDays: number,
): LintFinding | undefined {
  const age = ageInDays(fact.date, now)
  if (age === undefined || age <= staleDays) return undefined
  return {
    kind: 'stale',
    severity: 'info',
    factIds: [fact.id],
    file: file.path,
    message: `fact is ${age} days old, past the ${staleDays}-day threshold; confirm it is still true`,
    detail: oneLine(fact.body),
  }
}

/** Whole days between the fact's date (UTC midnight) and `now`; undefined when unusable. */
function ageInDays(date: string, now: Date): number | undefined {
  const match = DATE_RE.exec(date)
  if (match === null) return undefined

  const [, year = '', month = '', day = ''] = match
  const stamp = Date.UTC(Number(year), Number(month) - 1, Number(day))
  const nowStamp = now.getTime()
  if (Number.isNaN(stamp) || Number.isNaN(nowStamp)) return undefined

  return Math.floor((nowStamp - stamp) / DAY_MS)
}

/** One finding per path-looking token that is no longer on disk. */
function deadReferenceFindings(fact: Fact, file: MemoryFile, projectDir: string): LintFinding[] {
  return pathCandidates(fact.body)
    .filter((token) => !existsInProject(projectDir, token))
    .map((token) => ({
      kind: 'dead-reference' as const,
      severity: 'warn' as const,
      factIds: [fact.id],
      file: file.path,
      message: `fact references '${token}', which no longer exists in the project`,
      detail: `${token} — ${oneLine(fact.body)}`,
    }))
}

/**
 * Path-looking tokens, conservatively. Backticked spans are pulled out whole so
 * a backticked path (the common case) is checked while a backticked command,
 * which contains spaces, is skipped along with URLs.
 */
function pathCandidates(body: string): string[] {
  const spans: string[] = []
  const rest = body.replace(/`([^`]*)`/g, (_match: string, inner: string) => {
    spans.push(inner)
    return ' '
  })

  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of [...spans, ...rest.split(/\s+/)]) {
    const token = trimToken(raw)
    if (token === '' || seen.has(token)) continue
    seen.add(token)
    if (looksLikePath(token)) out.push(token)
  }
  return out
}

/** Strips the punctuation prose wraps paths in, without touching the path itself. */
function trimToken(raw: string): string {
  return raw.replace(/^[('"[<{]+/, '').replace(/[)'"\]>},;:.]+$/, '')
}

function looksLikePath(token: string): boolean {
  if (/\s/.test(token)) return false
  if (token.includes('://') || token.startsWith('http')) return false
  if (SOURCE_DIR_PREFIXES.some((prefix) => token.startsWith(prefix))) return true
  return token.includes('/') && /\.[A-Za-z0-9]+$/.test(token)
}

/** An fs error is never evidence of rot: on doubt, the reference counts as alive. */
function existsInProject(projectDir: string, token: string): boolean {
  try {
    return fs.existsSync(path.resolve(projectDir, token))
  } catch {
    return true
  }
}

/** Lowercased, punctuation-free, stopword- and polarity-free, crudely singularized. */
function contentWords(body: string): Set<string> {
  const words = new Set<string>()
  for (const raw of body
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')) {
    if (raw === '' || STOPWORDS.has(raw) || POLARITY_WORDS.has(raw)) continue
    const stem = singular(raw)
    if (stem.length < 2 || STOPWORDS.has(stem) || POLARITY_WORDS.has(stem)) continue
    words.add(stem)
  }
  return words
}

/** Enough to match "uses"/"use" and "cookies"/"cookie"; no real stemmer, on purpose. */
function singular(word: string): string {
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) {
    if (right.has(word)) shared++
  }
  return shared / (left.size + right.size - shared)
}

function hasNegation(body: string): boolean {
  const text = ` ${body
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `
  return NEGATION_MARKERS.some((marker) => text.includes(` ${marker} `))
}

/** Multi-line bodies collapse to one line so a finding stays one renderable block. */
function oneLine(body: string): string {
  return body.replace(/\s*\n\s*/g, ' ').trim()
}
