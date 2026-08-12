/**
 * Whether a recorded verdict still describes the tree it claims to.
 *
 * lumem never runs the gate (003 D3). The agent runs it and records what it ran
 * plus a fingerprint; this module recomputes the fingerprint and decides which of
 * five states the verdict is in. A gate that only reads cannot damage a tree, and
 * the failure this closes is forgetfulness — a stale or absent run — not deception.
 *
 * Dependency-free but for `node:fs` and `node:path`: reaches the bundled spec entry.
 */

import fs from 'node:fs'
import path from 'node:path'
import { type VerificationConfig, defaultVerification } from '../core/verification'
import type { TaskRecord, VerdictRecord } from './feature'
import { type Fingerprint, computeFingerprint } from './fingerprint'

/** Marks the root of a lumem project. */
const LUMEM_DIR = '.lumem'

export type VerdictState = 'absent' | 'unverifiable' | 'stale' | 'failing' | 'fresh'

export interface VerificationState {
  state: VerdictState
  /** The command that applies here, task first then project. Absent means unverifiable. */
  command?: string
  computed: Fingerprint
}

/**
 * The nearest ancestor of `featureDir` holding a `.lumem` directory, or
 * `undefined`.
 *
 * Deliberately not `process.cwd()`. The bundle is normally invoked from a project
 * root, and nothing enforces that; deriving the root from the argument makes the
 * answer independent of where the command was typed.
 */
export function findProjectDir(featureDir: string): string | undefined {
  let current = path.resolve(featureDir)

  // `path.dirname` of a root returns the root, which is the only termination
  // condition available — a fixed depth limit would be a guess about layouts.
  for (;;) {
    try {
      if (fs.statSync(path.join(current, LUMEM_DIR)).isDirectory()) return current
    } catch {
      // Not here; keep climbing.
    }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * The gate command that applies: the task's own, else the project's default.
 *
 * Never fabricates one. A project that has named no command has no way to verify
 * anything, and saying so is the whole point — assuming success is the failure
 * this feature exists to close.
 */
export function gateCommand(
  task: TaskRecord | undefined,
  cfg: VerificationConfig | undefined,
): string | undefined {
  const fromTask = task?.gate?.trim()
  if (fromTask !== undefined && fromTask !== '') return fromTask
  const fromConfig = cfg?.command?.trim()
  if (fromConfig !== undefined && fromConfig !== '') return fromConfig
  return undefined
}

/**
 * Which state a verdict is in. **The order is the contract**, and it is asserted:
 *
 * 1. `absent` — there is nothing to judge.
 * 2. `unverifiable` — no command is known, so no claim could have been earned.
 * 3. `stale` — the fingerprint is missing, differs, or was computed incompletely.
 * 4. `failing` — the recorded result is a failure.
 * 5. `fresh` — everything else.
 *
 * `stale` sits **before** `failing` on purpose: a recorded failure against a tree
 * that has since changed describes a tree that no longer exists, and reporting it
 * as a failure would send someone to fix something that may already be fixed.
 */
export function verdictState(
  verdict: VerdictRecord | undefined,
  command: string | undefined,
  computed: Fingerprint,
): VerdictState {
  if (verdict === undefined) return 'absent'
  if (command === undefined) return 'unverifiable'
  if (verdict.fingerprint === undefined) return 'stale'
  if (computed.incomplete) return 'stale'
  if (computed.hash === '') return 'stale'
  if (verdict.fingerprint !== computed.hash) return 'stale'
  if (verdict.result === 'fail') return 'failing'
  return 'fresh'
}

/**
 * Everything a caller needs to judge a verdict, computed from disk.
 *
 * Returns `undefined` when the feature is not inside a lumem project: there is no
 * config to read and no root to fingerprint, and inventing either would let a
 * verdict pass for lack of anything to check it against.
 */
export function readVerification(
  featureDir: string,
  verdict: VerdictRecord | undefined,
  task: TaskRecord | undefined,
  readConfigured: (projectDir: string) => VerificationConfig | undefined,
): VerificationState | undefined {
  const projectDir = findProjectDir(featureDir)
  if (projectDir === undefined) return undefined

  const cfg = readConfigured(projectDir) ?? defaultVerification()
  const computed = computeFingerprint(projectDir, cfg)
  const command = gateCommand(task, cfg)

  return {
    state: verdictState(verdict, command, computed),
    ...(command !== undefined ? { command } : {}),
    computed,
  }
}
