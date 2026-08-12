/**
 * The next action for a feature, derived from the files that exist.
 *
 * Read-only and pure: a `SpecFeature` in, one `NextAction` out. Every filesystem
 * access happened in `readFeature`, so this module cannot be the reason a stale
 * value strands a run — and because phase is never stored (TDD 002 invariant 1),
 * there is no state here to go stale in the first place.
 *
 * The rules are an ordered list and **the order is part of the contract**: an
 * unanswered question outranks a missing design document, because answering is
 * cheap and designing against an open fork is not. `RULES` is walked top to
 * bottom and the first match wins.
 */

import type { SpecFeature, SpecPhase } from './feature'
import type { VerificationState } from './verify'

export interface NextAction {
  phase: SpecPhase
  /** `await-answers`, `execute-task`, … — what to do, not how. */
  action: string
  /** A question id, a task id, or absent. */
  target?: string
}

/** Numeric order for `T2` before `T10`, which a string sort would reverse. */
function idNumber(id: string): number {
  const digits = id.slice(1)
  const parsed = Number(digits)
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

function lowestId(ids: string[]): string | undefined {
  let best: string | undefined
  for (const id of ids) {
    if (best === undefined || idNumber(id) < idNumber(best)) best = id
  }
  return best
}

/** The first task with every dependency done, lowest id first. */
function readyTask(f: SpecFeature): string | undefined {
  const done = new Set(f.tasks.filter((t) => t.done).map((t) => t.id))
  const ready = f.tasks
    .filter((t) => !t.done && t.dependsOn.every((dep) => done.has(dep)))
    .map((t) => t.id)
  return lowestId(ready)
}

type Rule = (f: SpecFeature, v?: VerificationState) => NextAction | undefined

/**
 * The derivation table from TDD 002 §5.4, in order.
 *
 * There is deliberately no rule for a task whose dependency is unfinished. With
 * cycles and unknown dependencies both gated, the graph is a DAG over known
 * nodes, and in a DAG the first unfinished task in topological order always has
 * its dependencies done — so a "blocked" outcome describes a state the
 * invariants forbid. It was cut for that reason, not for brevity.
 */
const RULES: readonly Rule[] = [
  // An absent directory and an empty one are the same situation: nothing to read.
  (f) => (f.has.context ? undefined : { phase: 'context', action: 'create-context' }),

  (f) => (f.tier === undefined ? { phase: 'scope', action: 'settle-size' } : undefined),

  (f) => {
    const open = f.questions.find((q) => !q.answered)
    return open === undefined
      ? undefined
      : { phase: 'requirements', action: 'await-answers', target: open.id }
  },

  (f) => {
    const unscored = f.questions.find((q) => q.answered && q.effect === undefined)
    return unscored === undefined
      ? undefined
      : { phase: 'requirements', action: 'score-round', target: unscored.id }
  },

  (f) => (f.has.prd ? undefined : { phase: 'requirements', action: 'write-prd' }),

  (f) => (f.has.cutSection ? undefined : { phase: 'prune', action: 'prune' }),

  (f) => (f.tier !== 'light' && !f.has.tdd ? { phase: 'design', action: 'write-tdd' } : undefined),

  (f) =>
    f.tier !== 'light' && !f.has.tests ? { phase: 'design', action: 'write-tests' } : undefined,

  (f) =>
    f.tier === 'full' && !f.has.tasks ? { phase: 'tasks', action: 'write-tasks' } : undefined,

  (f) => {
    const target = readyTask(f)
    return target === undefined ? undefined : { phase: 'execute', action: 'execute-task', target }
  },

  // Vacuously true with no tasks at all, which is what a `light` slice looks like.
  (f) => (f.verdict === undefined ? { phase: 'verify', action: 'verify' } : undefined),

  // A recorded failure is not done: the tree has to be fixed and re-verified.
  (f) => (f.verdict?.result === 'fail' ? { phase: 'verify', action: 'verify' } : undefined),

  // Anything a caller could learn about freshness, but only when it looked. With
  // no `VerificationState` this rule is silent and the answer is 002's exactly —
  // `next` is advice and fails open; `lint --phase verdict` is what refuses.
  (_f, v) =>
    v !== undefined && v.state !== 'fresh' ? { phase: 'verify', action: 'verify' } : undefined,
]

/**
 * The single next action. Always returns one; `done` is the terminal answer.
 *
 * `v` is optional on purpose. Computing it costs a walk of the whole tree, and a
 * caller that only wants to know which task is next should not pay for it —
 * omitting it reproduces 002's behaviour exactly, case for case.
 */
export function nextAction(f: SpecFeature, v?: VerificationState): NextAction {
  for (const rule of RULES) {
    const action = rule(f, v)
    if (action !== undefined) return action
  }
  return { phase: 'done', action: 'done' }
}
