import fs from 'node:fs'
import path from 'node:path'
import type { Adr } from './format'
import { parseAdr } from './format'

/**
 * The ADR folder as a whole: every `docs/adr/*.md` parsed, plus the supersedence
 * relation derived from it.
 *
 * Dependency-free like its sibling `format` — `node:fs` and `node:path` only, no
 * zod. Part of `core/adr` reaches the bundled hook, where the purity assertions
 * in `src/hooks/main.test.ts` fail the moment an external import appears.
 *
 * Reading is tolerant end to end: a missing folder, a stray file, a file that
 * cannot be read — none of them throw. Whatever is wrong becomes a warning on an
 * ADR so `adr lint` can report it later with the file in hand.
 */
export interface AdrSet {
  /** Sorted by id, which sorts by date because the id starts with one. */
  adrs: Adr[]
  byId: Map<string, Adr>
  /** id → the ADR that supersedes it, when one does. */
  supersededBy: Map<string, string>
}

const ADR_DIRNAME = 'adr'
const MD_SUFFIX = '.md'
/** `<module>/<rule>` — a module rule id, which is not an ADR in this slice. */
const MODULE_RULE_SEPARATOR = '/'

/** An ADR that exists on disk but could not be read. Shaped like a parse failure. */
function unreadable(id: string): Adr {
  return {
    id,
    title: '',
    date: '',
    area: '',
    summary: '',
    body: '',
    warnings: ['unreadable file: it could not be read from disk'],
  }
}

/** Filenames of the `*.md` entries in `adrDir`, sorted. A missing folder yields none. */
function listAdrFiles(adrDir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(adrDir, { withFileTypes: true })
  } catch {
    // no docs/adr, or one this process may not read: an empty set, not an error
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) continue
    if (!entry.name.endsWith(MD_SUFFIX)) continue
    names.push(entry.name)
  }
  // Sorting here rather than trusting the filesystem: readdir order is not defined.
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return names
}

/**
 * Read every ADR under `<docsDir>/adr/` and derive the supersedence relation.
 *
 * Status is never stored (D14): an ADR is superseded exactly when another one
 * names it in `supersedes`, so the map is built by inverting those values. A
 * value that names no known ADR is left out entirely — a module rule, or a
 * dangling reference. T4's lint is what reports either; the store only records
 * what it can resolve.
 */
export function readAdrs(docsDir: string): AdrSet {
  const adrDir = path.join(docsDir, ADR_DIRNAME)
  const adrs: Adr[] = []
  const byId = new Map<string, Adr>()

  for (const name of listAdrFiles(adrDir)) {
    let content: string
    try {
      content = fs.readFileSync(path.join(adrDir, name), 'utf8')
    } catch {
      const adr = unreadable(name)
      adrs.push(adr)
      byId.set(name, adr)
      continue
    }
    const adr = parseAdr(name, content)
    adrs.push(adr)
    // Two files cannot share a name, so this only fires on a hostile filesystem.
    byId.set(name, adr)
  }

  const supersededBy = new Map<string, string>()
  for (const adr of adrs) {
    const target = adr.supersedes
    if (target === undefined) continue
    if (target.includes(MODULE_RULE_SEPARATOR)) continue
    if (!byId.has(target)) continue
    supersededBy.set(target, adr.id)
  }

  return { adrs, byId, supersededBy }
}

/** Is this ADR replaced by a later one? Derived, never read off the file (D14). */
export function isSuperseded(set: AdrSet, id: string): boolean {
  return set.supersededBy.has(id)
}

/**
 * The ADR that holds the current position on this decision: walk the chain
 * forward to its end (D11 — supersedence is a chain, followed by reading).
 *
 * A cycle would loop forever, so visited ids are tracked and the walk stops the
 * moment it would revisit one, returning the last id it reached. That answer is
 * arbitrary, because a cycle has no end; the store's only job here is to
 * terminate. Reporting the cycle belongs to lint.
 */
export function currentOf(set: AdrSet, id: string): string {
  const visited = new Set<string>([id])
  let current = id
  let next = set.supersededBy.get(current)
  while (next !== undefined && !visited.has(next)) {
    visited.add(next)
    current = next
    next = set.supersededBy.get(current)
  }
  return current
}
