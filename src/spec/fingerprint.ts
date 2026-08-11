/**
 * A fingerprint of the inputs a gate reads, so a recorded verdict can be told
 * apart from a stale one.
 *
 * It is a hash of a **sorted manifest** — one line pairing a path with the hash
 * of its own contents — not a hash of concatenated contents. The difference
 * matters twice: `readdirSync` order is undefined, so an unsorted manifest would
 * make the same tree hash differently on another machine; and pairing a path with
 * its content is what makes swapping two files' contents a change rather than a
 * no-op.
 *
 * `docs/` is excluded by default because the verdict lives in a document (003
 * D7): a fingerprint covering it would be invalidated by the act of recording the
 * verdict it certifies.
 *
 * Dependency-free but for `node:fs`, `node:path` and the shared `sha256` — this
 * module reaches the bundled spec entry, where the purity assertion fails the
 * moment an external import appears.
 */

import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from '../core/shared/fsx'
import type { VerificationConfig } from '../core/verification'

export interface Fingerprint {
  /** sha256 over the manifest. `''` when nothing was covered. */
  hash: string
  fileCount: number
  /**
   * A covered file existed and could not be read. An incomplete fingerprint is
   * never fresh — a file lumem could not hash might be exactly the changed one.
   */
  incomplete: boolean
}

/**
 * Does `relative` sit at or under one of `prefixes`?
 *
 * Boundary-aware: `src` matches `src` and `src/a.ts`, and never `srcfoo.ts`. A
 * bare `startsWith` would silently cover a sibling whose name begins the same way.
 */
function underPrefix(relative: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (relative === prefix) return true
    if (relative.startsWith(`${prefix}/`)) return true
  }
  return false
}

/**
 * Is `relative` excluded?
 *
 * Two forms, because one rule could not express what is needed. An entry
 * containing `/` is **anchored at the project root** — `src/spec` excludes exactly
 * that subtree. A bare name matches **any path segment at any depth**, so
 * `node_modules` excludes both `node_modules/` and `src/node_modules/`.
 *
 * The design called these prefixes and only the anchored form was implemented
 * first; `src/node_modules` then escaped, which UT-09 caught. A bare name is how
 * everyone reads "exclude node_modules", and requiring every nesting to be listed
 * would make the default list a guess about someone else's directory layout.
 */
function isExcluded(relative: string, excludes: readonly string[]): boolean {
  const segments = relative.split('/')
  for (const entry of excludes) {
    if (entry.includes('/')) {
      if (underPrefix(relative, [entry])) return true
      continue
    }
    if (segments.includes(entry)) return true
  }
  return false
}

/**
 * Could anything under `relative` still be included? Answers whether a directory
 * is worth walking: `src` is worth entering for the prefix `src/spec`, and `web`
 * is not.
 */
function couldContain(relative: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    // The directory is at or under an included prefix …
    if (underPrefix(relative, [prefix])) return true
    // … or an included prefix lies deeper inside it.
    if (prefix.startsWith(`${relative}/`)) return true
  }
  return false
}

/**
 * Walk `projectDir`, hashing every covered file into a sorted manifest.
 *
 * Exclusion is checked before inclusion, so an excluded prefix nested inside an
 * included one is skipped — `src` being covered never drags in `src/node_modules`.
 *
 * Never throws. An unreadable entry sets `incomplete` and the walk continues:
 * refusing to produce a fingerprint at all would turn one unreadable file into a
 * feature nobody can close.
 */
export function computeFingerprint(projectDir: string, cfg: VerificationConfig): Fingerprint {
  const lines: string[] = []
  let incomplete = false

  const walk = (dir: string, relativeDir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      incomplete = true
      return
    }

    for (const entry of entries) {
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (isExcluded(relative, cfg.fingerprintExclude)) continue

      if (entry.isDirectory()) {
        if (!couldContain(relative, cfg.fingerprintInclude)) continue
        walk(path.join(dir, entry.name), relative)
        continue
      }
      if (!entry.isFile()) continue
      if (!underPrefix(relative, cfg.fingerprintInclude)) continue

      try {
        lines.push(`${relative} ${sha256(fs.readFileSync(path.join(dir, entry.name)))}`)
      } catch {
        incomplete = true
      }
    }
  }

  walk(projectDir, '')

  if (lines.length === 0) {
    // Not the hash of an empty string: '' says "nothing was covered", which is a
    // different fact from "a tree that happens to hash to that value".
    return { hash: '', fileCount: 0, incomplete }
  }

  // Sorting here rather than trusting the filesystem: readdir order is not defined.
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { hash: sha256(`${lines.join('\n')}\n`), fileCount: lines.length, incomplete }
}
