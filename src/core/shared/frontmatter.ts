/**
 * `---` fenced frontmatter: peel it off, and read or write a flat single-line
 * `key: value` block.
 *
 * Extracted from `core/adr/format.ts`, which was the first consumer and is now
 * one of two — `core/spec` reads the same shape out of `decisions.md`. Two
 * copies of a parser is the drift this module exists to prevent.
 *
 * Dependency-free, and not even a `node:` builtin: both consumers reach the
 * bundled hook and the bundled spec entry, where the purity assertions fail the
 * moment an external import appears. A YAML library is deliberately absent — the
 * fields are flat, single-line strings, so a key/value split is sufficient and
 * cheaper than a parser.
 */

export const FENCE = '---'

/** The fence has to be the very first thing in the file. */
const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/

export type FrontmatterSplit =
  | { kind: 'ok'; lines: string[]; body: string }
  /** No opening fence at the very start of the file. */
  | { kind: 'none' }
  /** An opening fence that is never closed. */
  | { kind: 'unterminated' }

/**
 * Peel the frontmatter block off the top of the file. The body is whatever
 * follows the closing fence's newline, kept byte-for-byte — trailing blank lines
 * included, since round-tripping through this module must not rewrite prose.
 */
export function splitFrontmatter(content: string): FrontmatterSplit {
  const open = FRONTMATTER_OPEN.exec(content)
  if (open === null) return { kind: 'none' }

  const lines: string[] = []
  let cursor = open[0].length
  while (cursor <= content.length) {
    const newline = content.indexOf('\n', cursor)
    const end = newline === -1 ? content.length : newline
    const raw = content.slice(cursor, end)
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trimEnd() === FENCE) {
      return { kind: 'ok', lines, body: newline === -1 ? '' : content.slice(newline + 1) }
    }
    if (newline === -1) return { kind: 'unterminated' }
    lines.push(line)
    cursor = newline + 1
  }
  return { kind: 'unterminated' }
}

/** Strip exactly one matching pair of `'` or `"`, so a quoted value survives verbatim. */
export function unquote(value: string): string {
  const first = value.charAt(0)
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Quote a value only when reading it back would change it: leading or trailing
 * whitespace (the parser trims), or a value that is itself wrapped in a matching
 * quote pair (the parser would strip it). The wrapper is the other quote
 * character, so only one pair is ever removed.
 */
export function quoteIfNeeded(value: string): string {
  if (value === unquote(value) && value === value.trim()) return value
  return value.charAt(0) === "'" ? `"${value}"` : `'${value}'`
}

/**
 * Split one frontmatter line into a key and its value. `undefined` when the line
 * carries no `:` at all. Only the first colon separates, so a value containing
 * `:` survives intact, and the value is trimmed then unquoted.
 */
export function parseField(line: string): { key: string; value: string } | undefined {
  const colon = line.indexOf(':')
  if (colon === -1) return undefined
  const key = line.slice(0, colon).trim()
  if (key === '') return undefined
  return { key, value: unquote(line.slice(colon + 1).trim()) }
}
