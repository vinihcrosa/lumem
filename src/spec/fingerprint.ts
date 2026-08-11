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
 * The walk itself lives in `./walk`, shared with the search for implemented cases.
 */

import fs from 'node:fs'
import { sha256 } from '../core/shared/fsx'
import type { VerificationConfig } from '../core/verification'
import { walkFiles } from './walk'

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
 * Walk `projectDir`, hashing every covered file into a sorted manifest.
 *
 * Never throws. An unreadable entry sets `incomplete` and the walk continues:
 * refusing to produce a fingerprint at all would turn one unreadable file into a
 * feature nobody can close.
 */
export function computeFingerprint(projectDir: string, cfg: VerificationConfig): Fingerprint {
  const lines: string[] = []
  let incomplete = false

  const complete = walkFiles(projectDir, {
    include: cfg.fingerprintInclude,
    exclude: cfg.fingerprintExclude,
    onFile: (relative, absolute) => {
      try {
        lines.push(`${relative} ${sha256(fs.readFileSync(absolute))}`)
      } catch {
        incomplete = true
      }
    },
  })
  if (!complete) incomplete = true

  if (lines.length === 0) {
    // Not the hash of an empty string: '' says "nothing was covered", which is a
    // different fact from "a tree that happens to hash to that value".
    return { hash: '', fileCount: 0, incomplete }
  }

  // Sorting here rather than trusting the filesystem: readdir order is not defined.
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { hash: sha256(`${lines.join('\n')}\n`), fileCount: lines.length, incomplete }
}
