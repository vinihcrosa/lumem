import type { ConsolidationPatch } from '../src/core/consolidate/patch'
import type { ConsolidationResult } from '../src/core/consolidate/run'
import { scanSecrets } from '../src/core/shared/secrets'
import type { AssertionOutcome, Expectations, FixtureScore, RunOutcome } from './types'

/** Everything the model wrote that a human would read in `project.md`. */
function bodiesOf(patch: ConsolidationPatch): string[] {
  return [...patch.add.map((entry) => entry.body), ...patch.replace.map((entry) => entry.body)]
}

/** Bodies plus the throwaway `remove` reasons — a credential in either one is a leak. */
function textsOf(patch: ConsolidationPatch): string[] {
  return [...bodiesOf(patch), ...patch.remove.map((entry) => entry.reason)]
}

function isEmpty(patch: ConsolidationPatch): boolean {
  return patch.add.length === 0 && patch.replace.length === 0 && patch.remove.length === 0
}

/**
 * Secret scan over everything the run emitted, using the SAME scanner the write
 * path uses. Anything it flags would have been refused on disk anyway; here it
 * is a hard gate, because a prompt that produces credentials is broken even when
 * the scanner catches them.
 */
function scanRun(patch: ConsolidationPatch): string[] {
  const kinds = new Set<string>()
  for (const text of textsOf(patch)) {
    for (const hit of scanSecrets(text)) kinds.add(hit.kind)
  }
  return [...kinds].sort()
}

function includesAny(haystack: string[], needles: string[]): string[] {
  const lowered = haystack.map((text) => text.toLowerCase())
  return needles.filter((needle) => lowered.some((text) => text.includes(needle.toLowerCase())))
}

/**
 * Evaluate every declared expectation against one patch, in a fixed order so two
 * reports of the same fixture always list the same assertions in the same place.
 */
function assess(expect: Expectations, patch: ConsolidationPatch): AssertionOutcome[] {
  const out: AssertionOutcome[] = []
  const bodies = bodiesOf(patch)

  if (expect.emptyPatch !== undefined) {
    const empty = isEmpty(patch)
    out.push({
      name: 'emptyPatch',
      passed: empty === expect.emptyPatch,
      detail: `expected ${expect.emptyPatch ? 'empty' : 'non-empty'}, got ${
        empty ? 'empty' : `${patch.add.length}a/${patch.replace.length}r/${patch.remove.length}d`
      }`,
    })
  }

  if (expect.minAdds !== undefined) {
    out.push({
      name: 'minAdds',
      passed: patch.add.length >= expect.minAdds,
      detail: `${patch.add.length} adds, need >= ${expect.minAdds}`,
    })
  }

  if (expect.maxAdds !== undefined) {
    out.push({
      name: 'maxAdds',
      passed: patch.add.length <= expect.maxAdds,
      detail: `${patch.add.length} adds, need <= ${expect.maxAdds}`,
    })
  }

  if (expect.mustReplaceId !== undefined) {
    const ids = patch.replace.map((entry) => entry.targetId)
    out.push({
      name: 'mustReplaceId',
      passed: ids.includes(expect.mustReplaceId),
      detail: `replaced [${ids.join(', ')}], need ${expect.mustReplaceId}`,
    })
  }

  if (expect.mustNotContain !== undefined) {
    const found = includesAny(bodies, expect.mustNotContain)
    out.push({
      name: 'mustNotContain',
      passed: found.length === 0,
      detail: found.length === 0 ? 'clean' : `found ${found.join(', ')}`,
    })
  }

  if (expect.shouldMentionAny !== undefined) {
    const found = includesAny(bodies, expect.shouldMentionAny)
    out.push({
      name: 'shouldMentionAny',
      passed: found.length > 0,
      detail: found.length > 0 ? `mentions ${found.join(', ')}` : 'mentions none of them',
    })
  }

  if (expect.mustAddTypeScope !== undefined) {
    const present = new Set(patch.add.map((entry) => `${entry.type}/${entry.scope}`))
    const missing = expect.mustAddTypeScope.filter((pair) => !present.has(pair))
    out.push({
      name: 'mustAddTypeScope',
      passed: missing.length === 0,
      detail: missing.length === 0 ? 'all present' : `missing ${missing.join(', ')}`,
    })
  }

  if (expect.noSecrets === true) {
    const kinds = scanRun(patch)
    out.push({
      name: 'noSecrets',
      passed: kinds.length === 0,
      detail: kinds.length === 0 ? 'clean' : `leaked ${kinds.join(', ')}`,
    })
  }

  return out
}

/** Which assertions a fixture declared, so a failed run can fail all of them. */
function declaredNames(expect: Expectations): string[] {
  const order = [
    'emptyPatch',
    'minAdds',
    'maxAdds',
    'mustReplaceId',
    'mustNotContain',
    'shouldMentionAny',
    'mustAddTypeScope',
    'noSecrets',
  ] as const
  return order.filter((name) => expect[name] !== undefined)
}

/**
 * Turn one `runConsolidation` result into a scored outcome. A run that produced
 * no patch fails the schema gate and every declared assertion — there is nothing
 * to be partially right about.
 */
export function scoreRun(input: {
  run: number
  expect: Expectations
  result: ConsolidationResult
  promptBytes: number
}): RunOutcome {
  const { patch } = input.result

  if (patch === undefined) {
    const error = input.result.error ?? input.result.gateReasons.join('; ') ?? 'no patch'
    return {
      run: input.run,
      schemaValid: false,
      secretLeak: false,
      secretKinds: [],
      emptyPatch: false,
      addCount: 0,
      replaceCount: 0,
      removeCount: 0,
      promptBytes: input.promptBytes,
      assertions: declaredNames(input.expect).map((name) => ({
        name,
        passed: false,
        detail: `no patch: ${error}`,
      })),
      error,
    }
  }

  const secretKinds = scanRun(patch)
  return {
    run: input.run,
    schemaValid: true,
    secretLeak: secretKinds.length > 0,
    secretKinds,
    emptyPatch: isEmpty(patch),
    addCount: patch.add.length,
    replaceCount: patch.replace.length,
    removeCount: patch.remove.length,
    promptBytes: input.promptBytes,
    assertions: assess(input.expect, patch),
    patch,
  }
}

/** Four decimals: enough to see a change, stable enough to diff two baselines. */
export function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function rate(flags: boolean[]): number {
  return mean(flags.map((flag) => (flag ? 1 : 0)))
}

/** Aggregate the k runs of one fixture, hard gates first. */
export function aggregate(outcomes: RunOutcome[]): FixtureScore {
  const runs = outcomes.length
  const schemaValid = rate(outcomes.map((o) => o.schemaValid))
  const secretLeak = rate(outcomes.map((o) => o.secretLeak))
  const adds = outcomes.map((o) => o.addCount)

  const assertions = outcomes.flatMap((o) => o.assertions)
  const expectationsMet =
    assertions.length === 0 ? 1 : rate(assertions.map((assertion) => assertion.passed))

  const empties = outcomes.filter((o) => o.emptyPatch).length
  const majority = Math.max(empties, runs - empties)

  const hardGateFailures: string[] = []
  if (schemaValid < 1) hardGateFailures.push(`schemaValid ${pct(schemaValid)} (must be 100%)`)
  if (secretLeak > 0) hardGateFailures.push(`secretLeak ${pct(secretLeak)} (must be 0%)`)

  return {
    runs,
    schemaValid,
    secretLeak,
    emptyPatchRate: runs === 0 ? 0 : round(empties / runs),
    addCount: mean(adds),
    expectationsMet,
    variance: {
      verdictAgreement: runs === 0 ? 1 : round(majority / runs),
      addSpread: adds.length === 0 ? 0 : Math.max(...adds) - Math.min(...adds),
    },
    hardGateFailures,
    passed: hardGateFailures.length === 0 && expectationsMet === 1,
  }
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}
