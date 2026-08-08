import type { ConsolidationPatch } from '../src/core/consolidate/patch'

/**
 * What a GOOD answer looks like for one fixture. Never an exact patch: the model
 * is non-deterministic, so every field here is an assertion about the shape of
 * the answer, not about its bytes. Every field is optional except the ones the
 * fixture author chooses to pin.
 */
export interface Expectations {
  /** The right answer is to write nothing (or, when false, to write something). */
  emptyPatch?: boolean
  /** Upper bound on `add` entries. The main defence against session narration. */
  maxAdds?: number
  /** Lower bound on `add` entries. */
  minAdds?: number
  /** Substrings that must appear in NO emitted body (case-insensitive). */
  mustNotContain?: string[]
  /** A contradicted fact that must be replaced, not stacked. */
  mustReplaceId?: string
  /** Always assert it: a leaked credential is a hard fail, never a soft score. */
  noSecrets?: boolean
  /** At least one emitted body must contain one of these (case-insensitive). */
  shouldMentionAny?: string[]
  /** `type/scope` pairs that must each be claimed by at least one `add`. */
  mustAddTypeScope?: string[]
}

/** One fixture directory, loaded and validated. */
export interface FixtureSpec {
  name: string
  dir: string
  description: string
  expect: Expectations
}

/** One `expect` field, evaluated against one run. */
export interface AssertionOutcome {
  name: string
  passed: boolean
  detail: string
}

/** Everything one fixture × one run produced. */
export interface RunOutcome {
  run: number
  /** Did `parsePatch` return a patch? Hard gate. */
  schemaValid: boolean
  /** Did any emitted body trip `scanSecrets`? Hard gate. */
  secretLeak: boolean
  secretKinds: string[]
  emptyPatch: boolean
  addCount: number
  replaceCount: number
  removeCount: number
  /** Size of the prompt actually sent, so a broken fixture is visible in results. */
  promptBytes: number
  assertions: AssertionOutcome[]
  /** Present when the run never produced a patch. */
  error?: string
  patch?: ConsolidationPatch
}

/** How much the k runs of one fixture agreed with each other. */
export interface VarianceScore {
  /** Share of runs on the majority side of the empty/non-empty verdict; 1 = unanimous. */
  verdictAgreement: number
  /** max(addCount) - min(addCount) across the runs. */
  addSpread: number
}

export interface FixtureScore {
  runs: number
  /** Rate in 0..1. Hard gate: must be 1. */
  schemaValid: number
  /** Rate in 0..1. Hard gate: must be 0. */
  secretLeak: number
  emptyPatchRate: number
  /** Mean adds per run. */
  addCount: number
  /** Share of (run × assertion) pairs that held. */
  expectationsMet: number
  variance: VarianceScore
  /** Human-readable hard-gate violations; empty means both gates held. */
  hardGateFailures: string[]
  /** Hard gates held AND every assertion held on every run. */
  passed: boolean
}

export interface FixtureResult {
  fixture: string
  description: string
  runs: RunOutcome[]
  score: FixtureScore
}

export interface OverallScore {
  fixtures: number
  totalRuns: number
  schemaValid: number
  secretLeak: number
  expectationsMet: number
  hardGateFailures: string[]
  passed: boolean
}

/**
 * `mock` replays canned responses, `injected` uses an `llm` the caller supplied,
 * `real` spawns the descriptor's headless CLI and spends tokens.
 */
export type EvalMode = 'real' | 'mock' | 'injected'

export interface EvalReport {
  startedAt: string
  finishedAt: string
  mode: EvalMode
  harnessId: string
  runsPerFixture: number
  fixtures: FixtureResult[]
  overall: OverallScore
}
