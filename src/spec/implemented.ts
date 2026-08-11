/**
 * Which declared cases are named by a test.
 *
 * The rule is deliberately narrow: **one line must both match a test-declaration
 * pattern and contain the case id.** Both conditions, on the same line.
 *
 * That is what separates this from a search for the id. A comment mentioning
 * `IT-18` inside a test file satisfies "the id appears somewhere" and satisfies
 * nothing worth gating on — it is the exact shape that let two declared cases ship
 * unimplemented in feature 002, and the reason this module exists (003 D4).
 *
 * The patterns are a guess about other people's languages. They are configurable,
 * and `patternHits` exists so a caller can tell "no tests here" from "no cases
 * here" — a wrong pattern set must report itself, not report every case as missing.
 */

import fs from 'node:fs'
import type { VerificationConfig } from '../core/verification'
import { walkFiles } from './walk'

export interface ImplementedCases {
  /** Ids named by at least one test. */
  implemented: Set<string>
  /** Lines that matched any pattern, anywhere in the searched files. */
  patternHits: number
  /** Files searched, so a caller can distinguish "none searched" from "none matched". */
  filesSearched: number
  /** Pattern sources that are not valid regular expressions, skipped rather than thrown. */
  invalidPatterns: string[]
}

/** Compile what compiles; collect what does not. A bad pattern must not be fatal. */
function compile(sources: readonly string[]): { patterns: RegExp[]; invalid: string[] } {
  const patterns: RegExp[] = []
  const invalid: string[] = []
  for (const source of sources) {
    try {
      patterns.push(new RegExp(source))
    } catch {
      invalid.push(source)
    }
  }
  return { patterns, invalid }
}

function isTestFile(relative: string, suffixes: readonly string[]): boolean {
  for (const suffix of suffixes) {
    if (relative.endsWith(suffix)) return true
  }
  return false
}

/**
 * The forms of an id a test name may legally carry: the id itself, and the id
 * with punctuation removed.
 *
 * `UT-01` appears verbatim in `it('UT-01 …')`, because a JavaScript test name is a
 * string. It cannot appear verbatim in `func TestUT01` or `def test_ut01` — a
 * hyphen is illegal in an identifier, and Python lowercases by convention — and
 * both runners are in the default pattern set. Requiring the exact id would have
 * shipped a check that silently never matches in half the languages it advertises.
 *
 * Matching is therefore case-insensitive and punctuation-tolerant. Both forms are
 * lowercased once here, and each line is lowercased once at the call site, so the
 * comparison costs one pass rather than one per id.
 *
 * Found by UT-18, written from the contract, which failed twice on the first two
 * runs — once for the hyphen and once for the case.
 */
function acceptedForms(id: string): string[] {
  const lower = id.toLowerCase()
  const bare = lower.replace(/[^a-z0-9]/g, '')
  return bare === lower ? [lower] : [lower, bare]
}

/**
 * Search the project's test files for lines that declare a test and name a case.
 *
 * Never throws: an unreadable file is skipped, and the count of files searched
 * tells the caller how much of the tree was actually looked at.
 */
export function implementedCases(
  projectDir: string,
  cfg: VerificationConfig,
  ids: readonly string[],
): ImplementedCases {
  const { patterns, invalid } = compile(cfg.testPatterns)
  const forms = new Map(ids.map((id) => [id, acceptedForms(id)]))
  const result: ImplementedCases = {
    implemented: new Set<string>(),
    patternHits: 0,
    filesSearched: 0,
    invalidPatterns: invalid,
  }
  if (ids.length === 0 && patterns.length === 0) return result

  walkFiles(projectDir, {
    include: cfg.testInclude,
    exclude: cfg.fingerprintExclude,
    onFile: (relative, absolute) => {
      if (!isTestFile(relative, cfg.testSuffixes)) return

      let text: string
      try {
        text = fs.readFileSync(absolute, 'utf8')
      } catch {
        return
      }
      result.filesSearched++

      for (const rawLine of text.split('\n')) {
        const line = rawLine.toLowerCase()
        let declares = false
        for (const pattern of patterns) {
          if (pattern.test(rawLine)) {
            declares = true
            break
          }
        }
        if (!declares) continue
        result.patternHits++
        // One line may name several ids; a test covering three cases names three.
        for (const id of ids) {
          for (const form of forms.get(id) ?? [id]) {
            if (line.includes(form)) {
              result.implemented.add(id)
              break
            }
          }
        }
      }
    },
  })

  return result
}
