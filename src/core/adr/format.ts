/**
 * On-disk ADR format: `---` fenced frontmatter followed by a free-form body.
 *
 * Everything here is pure and dependency-free — no zod, no YAML library, not
 * even a `node:` builtin. Part of `core/adr` reaches the bundled hook, where the
 * purity assertions in `src/hooks/main.test.ts` fail the moment an external
 * import appears. The six frontmatter fields are flat, single-line strings, so
 * a hand-rolled key/value split is both sufficient and cheaper than a parser,
 * exactly as `core/capture` and `core/memory` do it.
 *
 * Parsing is tolerant: it never throws. Every complaint becomes a warning on the
 * returned ADR so `adr lint` can report it later with the file in hand.
 *
 * The frontmatter split itself lives in `core/shared/frontmatter`, shared with
 * `core/spec` — one parser, two consumers.
 */

import { FENCE, parseField, quoteIfNeeded, splitFrontmatter } from '../shared/frontmatter'

export interface Adr {
  /** Filename, e.g. `2026-08-08-cookie-sessions.md`. The identifier. */
  id: string
  title: string
  /** YYYY-MM-DD */
  date: string
  area: string
  summary: string
  /** The `docs/features/` directory that produced the decision. Absent when none did. */
  feature?: string
  /** An ADR id, or `<module>/<rule>`. Absent when this ADR replaces nothing. */
  supersedes?: string
  /** Everything after the closing fence, verbatim. */
  body: string
  /** Tolerant-parse complaints. Never thrown. */
  warnings: string[]
}

/** The four headings `adr new` seeds, from TDD 001 §1.3. All may be edited or removed. */
export const BODY_TEMPLATE = `## Context
What forced a decision. The constraint, not the history.

## Decision
What was decided, in the present tense.

## Alternatives considered
What else was on the table and why it lost. **This is the part that cannot be
reconstructed later** — the rest is recoverable from the code.

## Consequences
What this makes easy, and what it makes hard.
`

/** Emitted in this order by `serializeAdr`; the optional pair follows, `supersedes` last. */
const REQUIRED_FIELDS = ['title', 'date', 'area', 'summary'] as const
/** Optional, emitted after the required block in this order. */
const OPTIONAL_FIELDS = ['feature', 'supersedes'] as const
const KNOWN_KEYS: readonly string[] = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]

/** Combining marks left behind by NFD decomposition. */
const COMBINING_MARKS = /\p{M}/gu
const NON_SLUG_CHARS = /[^a-z0-9]+/g
const EDGE_DASHES = /^-+|-+$/g
const MAX_SLUG_LENGTH = 60
const MAX_WARNING_ECHO = 40

/**
 * Kebab-case slug for a title: accents folded to their base letters, everything
 * that is not `[a-z0-9]` collapsed to a single `-`, trimmed, capped at 60
 * characters on a word boundary where one exists inside the cap.
 *
 * ASCII-only on purpose — the slug becomes a filename, and folding is what keeps
 * "Sessão" a word (`sessao`) rather than two fragments (`sess-o`).
 */
export function slugify(title: string): string {
  const text = typeof title === 'string' ? title : ''
  const base = text
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NON_SLUG_CHARS, '-')
    .replace(EDGE_DASHES, '')

  if (base === '') return 'untitled'
  if (base.length <= MAX_SLUG_LENGTH) return base
  // The cap already lands on a boundary: the whole prefix is complete words.
  if (base.charAt(MAX_SLUG_LENGTH) === '-') return base.slice(0, MAX_SLUG_LENGTH)
  const cut = base.slice(0, MAX_SLUG_LENGTH)
  const lastDash = cut.lastIndexOf('-')
  // A single word longer than the cap has no boundary to cut on; cut it hard.
  return lastDash > 0 ? cut.slice(0, lastDash) : cut
}

/** The ADR identifier: `<date>-<slug>.md`. */
export function adrFilename(date: string, slug: string): string {
  return `${date}-${slug}.md`
}

/** Keep hostile input from producing a megabyte-long warning. */
function echo(text: string): string {
  return text.length <= MAX_WARNING_ECHO ? text : `${text.slice(0, MAX_WARNING_ECHO)}…`
}

/**
 * Parse an ADR file. Never throws: a missing fence, a malformed line, an unknown
 * key or an absent required field each becomes a warning, and the ADR is still
 * returned so lint can report the file rather than the reader losing it.
 */
export function parseAdr(id: string, content: string): Adr {
  const text = typeof content === 'string' ? content : ''
  const warnings: string[] = []
  const split = splitFrontmatter(text)

  if (split.kind !== 'ok') {
    warnings.push(
      split.kind === 'none'
        ? 'missing frontmatter: the file does not open with a --- fence'
        : 'missing frontmatter: the opening --- fence is never closed',
    )
    return { id, title: '', date: '', area: '', summary: '', body: text, warnings }
  }

  const fields = new Map<string, string>()
  for (const [index, line] of split.lines.entries()) {
    // Line 1 of the file is the opening fence, so frontmatter line 0 is line 2.
    const lineNo = index + 2
    if (line.trim() === '') continue

    const field = parseField(line)
    if (field === undefined) {
      warnings.push(`line ${lineNo}: skipped malformed frontmatter line (expected 'key: value')`)
      continue
    }
    if (!KNOWN_KEYS.includes(field.key)) {
      warnings.push(`line ${lineNo}: ignored unknown frontmatter key '${echo(field.key)}'`)
      continue
    }
    fields.set(field.key, field.value)
  }

  const adr: Adr = {
    id,
    title: fields.get('title') ?? '',
    date: fields.get('date') ?? '',
    area: fields.get('area') ?? '',
    summary: fields.get('summary') ?? '',
    body: split.body,
    warnings,
  }
  for (const field of OPTIONAL_FIELDS) {
    const value = fields.get(field)
    if (value !== undefined && value !== '') adr[field] = value
  }

  for (const field of REQUIRED_FIELDS) {
    if (adr[field] === '') warnings.push(`missing or empty required field '${field}'`)
  }
  return adr
}

/**
 * Render an ADR to its on-disk form. The inverse of `parseAdr` for any
 * single-line field value and any body: `parseAdr(id, serializeAdr(a))` returns
 * `a` unchanged, body included.
 *
 * The file always ends with a newline, and never gains a second one — a body
 * that already ends with blank lines keeps exactly the blank lines it had.
 */
export function serializeAdr(adr: Omit<Adr, 'id' | 'warnings'>): string {
  let out = `${FENCE}\n`
  for (const field of REQUIRED_FIELDS) out += `${field}: ${quoteIfNeeded(adr[field])}\n`
  for (const field of OPTIONAL_FIELDS) {
    const value = adr[field]
    if (value !== undefined && value !== '') out += `${field}: ${quoteIfNeeded(value)}\n`
  }
  out += `${FENCE}\n`

  if (adr.body === '' || adr.body.endsWith('\n')) return out + adr.body
  return `${out + adr.body}\n`
}
