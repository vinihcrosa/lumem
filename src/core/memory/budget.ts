import fs from 'node:fs'
import path from 'node:path'
import type { Fact, MemoryFile, MemoryType } from './store'

export interface InjectionResult {
  /** The rendered injection block. Empty when nothing was included. */
  text: string
  /** Ids of the included facts, in the order they appear in `text`. */
  includedFactIds: string[]
  /**
   * True when at least one FACT was left out because of the budget. A dropped
   * docs section does not set it: the flag reports lost memory, and the docs
   * section is a pointer the reader can recover by listing the folder.
   */
  truncated: boolean
}

export interface InjectionOptions {
  /**
   * The repository's `docs/` directory, e.g. `<projectDir>/docs`. When it holds
   * at least one ADR under `adr/`, the block gains the docs section.
   */
  docsDir?: string
}

/** Emitted once, before the first section, and only when something is included. */
const DOC_HEADER = '# lumem memory\n'

/** Types in fill priority order, each with the header that opens its section. */
const SECTIONS: readonly { type: MemoryType; header: string }[] = [
  { type: 'correction', header: '## corrections\n' },
  { type: 'project', header: '## project\n' },
  { type: 'preference', header: '## preferences\n' },
]

/**
 * The docs pointer (TDD 001 §3). A signpost, not a summary: the agent is told
 * where the decisions live and is expected to go and read them.
 */
const DOCS_SECTION =
  '## docs\n' +
  'Architectural decisions live in docs/adr/, newest last. Before proposing or\n' +
  'changing architecture, list that folder and read the frontmatter of anything\n' +
  'that looks relevant.\n'

/**
 * Does `<docsDir>/adr/` hold at least one `*.md`?
 *
 * EXISTENCE ONLY — one `readdirSync` that returns on the first hit and never
 * opens a file. This runs on the session-start hook path, where the latency
 * budget is measured in milliseconds; parsing frontmatter here would spend it
 * to produce something the agent is being told to go and read anyway.
 *
 * Any failure (missing, not a directory, unreadable, invalid path) reads as
 * "no ADRs", which renders exactly what a project without `docs/` renders.
 */
function hasAdr(docsDir: string): boolean {
  try {
    for (const name of fs.readdirSync(path.join(docsDir, 'adr'))) {
      if (name.endsWith('.md')) return true
    }
  } catch {
    // no docs/adr, or one this process may not read: the pointer is just absent
  }
  return false
}

interface Ranked {
  fact: Fact
  /** Position in the flattened input, used as the last tie-breaker. */
  index: number
}

/** Newest date first; same date puts project scope before global; then input order. */
function byPriority(a: Ranked, b: Ranked): number {
  if (a.fact.date !== b.fact.date) return a.fact.date < b.fact.date ? 1 : -1
  if (a.fact.scope !== b.fact.scope) return a.fact.scope === 'project' ? -1 : 1
  return a.index - b.index
}

/** One rendered bullet; the body's internal newlines collapse to single spaces. */
function renderFact(fact: Fact): string {
  return `- [${fact.date}] ${fact.body.replace(/[\r\n]+/g, ' ')}\n`
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * Build the memory injection block under a HARD byte budget.
 *
 * Guarantees, for any input: `Buffer.byteLength(text, 'utf8') <= budgetBytes`,
 * whole facts only (never split), and no throw. Headers — both the document
 * header and each section header — count toward the budget, so a fact only
 * fits if it fits together with the headers it would have to open.
 *
 * Fill order is corrections, then project facts, then preferences; within a
 * type, newest first. The fill is greedy: the first fact of a type that does
 * not fit stops that type (no backfill of smaller, older facts) and the next
 * type is attempted.
 *
 * The docs section (TDD 001 §3) is appended LAST, under the same budget, so it
 * is the first thing dropped under pressure and no fact ever loses its place to
 * it. Without `opts.docsDir`, or with no ADR to point at, the output is
 * byte-identical to what it was before the section existed.
 */
export function buildInjection(
  files: MemoryFile[],
  budgetBytes: number,
  opts?: InjectionOptions,
): InjectionResult {
  // NaN would make every comparison false anyway; normalize it to "no room".
  const budget = Number.isNaN(budgetBytes) ? 0 : budgetBytes

  const ranked: Ranked[] = []
  for (const file of files) {
    for (const fact of file.facts) ranked.push({ fact, index: ranked.length })
  }

  let text = ''
  let used = 0
  let docOpen = false
  const includedFactIds: string[] = []
  let truncated = false

  for (const section of SECTIONS) {
    const candidates = ranked.filter((r) => r.fact.type === section.type).sort(byPriority)
    let sectionOpen = false

    for (const { fact } of candidates) {
      const line = renderFact(fact)
      const cost =
        utf8Bytes(line) +
        (docOpen ? 0 : utf8Bytes(DOC_HEADER)) +
        (sectionOpen ? 0 : utf8Bytes(section.header))

      if (used + cost > budget) {
        // Whole facts only: stop this type here rather than backfilling.
        truncated = true
        break
      }

      if (!docOpen) {
        text += DOC_HEADER
        docOpen = true
      }
      if (!sectionOpen) {
        text += section.header
        sectionOpen = true
      }
      text += line
      used += cost
      includedFactIds.push(fact.id)
    }
  }

  const docsDir = opts?.docsDir
  if (docsDir !== undefined) {
    const cost = utf8Bytes(DOCS_SECTION) + (docOpen ? 0 : utf8Bytes(DOC_HEADER))
    // Budget first, disk second: under pressure the section cannot fit anyway,
    // so the hook pays for no syscall it does not need.
    if (used + cost <= budget && hasAdr(docsDir)) {
      if (!docOpen) {
        text += DOC_HEADER
        docOpen = true
      }
      text += DOCS_SECTION
      used += cost
    }
  }

  return { text, includedFactIds, truncated }
}
