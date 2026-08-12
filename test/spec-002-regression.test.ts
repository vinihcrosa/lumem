import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultVerification } from '../src/core/verification'
import { readFeature } from '../src/spec/feature'
import { lintSpec } from '../src/spec/lint'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const feature002 = path.join(repoRoot, 'docs/features/002-spec-driven')

/**
 * The acceptance test for feature 003.
 *
 * Feature 002 closed with a PASS verdict while two of its eighty-five declared
 * cases had no test — IT-18 named only in a comment, IT-19 only in a shell
 * script. Nothing noticed, and that measurement is what produced this slice.
 *
 * It reads 002's directory exactly as it is. Nothing here may edit those
 * artifacts to make this pass: the point is that history is caught unaltered.
 */
describe('the failure that produced 003, caught by 003', () => {
  // A case naming a foreign id in its own title would DECLARE that id implemented
  // — the search is repository-wide. So the two ids under test are built here
  // rather than spelled in a test name, which is a constraint worth knowing:
  // a test *about* an id must not be *named* with it unless it implements it.
  const MISSING = ['IT-1' + '8', 'IT-1' + '9']

  it('IT-08 reports exactly the two cases 002 never wrote', () => {
    const findings = lintSpec(readFeature(feature002), 'tasks', {
      readVerificationConfig: () => defaultVerification(),
    })

    const unimplemented = findings
      .filter((finding) => finding.kind === 'unimplemented-case')
      .flatMap((finding) => finding.ids)
      .sort()

    // Exactly, not "at least": a future over-eager check has to fail here.
    expect(unimplemented).toEqual(MISSING)
  })

  it('IT-09 recognises this repository own tests, so the patterns are not at fault', () => {
    const findings = lintSpec(readFeature(feature002), 'tasks', {
      readVerificationConfig: () => defaultVerification(),
    })

    expect(findings.map((finding) => finding.kind)).not.toContain('no-tests-recognised')
  })

  it('IT-09 leaves the historical contract untouched', () => {
    const contract = fs.readFileSync(path.join(feature002, 'tests.md'), 'utf8')
    const declared = [...contract.matchAll(/^\|\s*((?:UT|IT)-\d{2})\s*\|/gm)]

    // If this number moves, someone edited history to make the acceptance pass.
    expect(new Set(declared.map((m) => m[1])).size).toBe(85)
  })
})
