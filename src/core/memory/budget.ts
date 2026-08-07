import type { Fact, MemoryFile, MemoryType } from './store'

export interface InjectionResult {
  /** The rendered injection block. Empty when nothing was included. */
  text: string
  /** Ids of the included facts, in the order they appear in `text`. */
  includedFactIds: string[]
  /** True when at least one fact was left out because of the budget. */
  truncated: boolean
}

/** Emitted once, before the first section, and only when something is included. */
const DOC_HEADER = '# lumem memory\n'

/** Types in fill priority order, each with the header that opens its section. */
const SECTIONS: readonly { type: MemoryType; header: string }[] = [
  { type: 'correction', header: '## corrections\n' },
  { type: 'project', header: '## project\n' },
  { type: 'preference', header: '## preferences\n' },
]

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
 */
export function buildInjection(files: MemoryFile[], budgetBytes: number): InjectionResult {
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

  return { text, includedFactIds, truncated }
}
