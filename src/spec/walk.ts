/**
 * Walking a project tree by path prefix, shared by the fingerprint and by the
 * search for implemented cases.
 *
 * Extracted rather than copied: the inclusion and exclusion rules here are three
 * subtle predicates — a boundary-aware prefix, a two-form exclusion, and "is this
 * directory worth entering" — and two implementations of those would drift on the
 * first change to either.
 *
 * Dependency-free but for `node:fs` and `node:path`: this reaches the bundled
 * spec entry, where the purity assertion fails on any external import.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Does `relative` sit at or under one of `prefixes`?
 *
 * Boundary-aware: `src` matches `src` and `src/a.ts`, and never `srcextra.ts`. A
 * bare `startsWith` would silently cover a sibling whose name begins the same way.
 */
export function underPrefix(relative: string, prefixes: readonly string[]): boolean {
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
 * Only the anchored form existed first, and `src/node_modules` walked straight
 * through it. A bare name is how everyone reads "exclude node_modules", and
 * requiring every nesting to be listed would make a default list a guess about
 * someone else's directory layout.
 */
export function isExcluded(relative: string, excludes: readonly string[]): boolean {
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
 * is worth entering: `src` is worth entering for the prefix `src/spec`, and `web`
 * is not.
 */
function couldContain(relative: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (underPrefix(relative, [prefix])) return true
    if (prefix.startsWith(`${relative}/`)) return true
  }
  return false
}

export interface WalkOptions {
  include: readonly string[]
  exclude: readonly string[]
  /** Called for each covered file, with its project-relative POSIX path. */
  onFile: (relative: string, absolute: string) => void
}

/**
 * Walk `projectDir`, calling `onFile` for every included, non-excluded file.
 *
 * Exclusion is checked **before** inclusion, so an excluded prefix nested inside
 * an included one is skipped — `src` being covered never drags in
 * `src/node_modules`.
 *
 * Never throws. Returns `true` when every directory was readable, `false` when at
 * least one was not, so a caller can decide whether a partial answer is usable.
 * Aborting on the first unreadable directory would turn one locked folder into a
 * feature nobody can close.
 */
export function walkFiles(projectDir: string, opts: WalkOptions): boolean {
  let complete = true

  const walk = (dir: string, relativeDir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      complete = false
      return
    }

    for (const entry of entries) {
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (isExcluded(relative, opts.exclude)) continue

      if (entry.isDirectory()) {
        if (!couldContain(relative, opts.include)) continue
        walk(path.join(dir, entry.name), relative)
        continue
      }
      if (!entry.isFile()) continue
      if (!underPrefix(relative, opts.include)) continue
      opts.onFile(relative, path.join(dir, entry.name))
    }
  }

  walk(projectDir, '')
  return complete
}
