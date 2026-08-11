import { describe, expect, it } from 'vitest'
import type { QuestionRecord, SpecFeature, SpecTier, TaskRecord } from './feature'
import { nextAction } from './next'

interface Overrides {
  /** `null` means no tier was recorded — the state `readFeature` returns for a missing or unknown one. */
  tier?: SpecTier | null
  has?: Partial<SpecFeature['has']>
  questions?: QuestionRecord[]
  tasks?: TaskRecord[]
  verdict?: 'pass' | 'fail'
}

/** A feature at an arbitrary point in the pipeline, built from what matters to the rule. */
function feature(overrides: Overrides = {}): SpecFeature {
  const base: SpecFeature = {
    slug: '002-spec-driven',
    dir: '/tmp/002-spec-driven',
    created: '2026-08-11',
    has: {
      context: true,
      prd: true,
      tdd: true,
      tests: true,
      tasks: true,
      cutSection: true,
      ...overrides.has,
    },
    questions: overrides.questions ?? [],
    tasks: overrides.tasks ?? [],
    testIds: [],
    warnings: [],
  }
  const tier = overrides.tier === undefined ? 'full' : overrides.tier
  if (tier !== null) base.tier = tier
  if (overrides.verdict !== undefined) base.verdict = overrides.verdict
  return base
}

function answered(id: string, effect: QuestionRecord['effect'] = 'accepted'): QuestionRecord {
  return { id, round: 1, answered: true, effect }
}

function task(id: string, done: boolean, dependsOn: string[] = []): TaskRecord {
  return { id, title: id, done, dependsOn, testIds: [] }
}

describe('nextAction — before the size is settled', () => {
  it('UT-16 asks for context when there is none, which is also the absent-directory case', () => {
    expect(nextAction(feature({ has: { context: false } }))).toEqual({
      phase: 'context',
      action: 'create-context',
    })
  })

  it('UT-17 asks for the size once context exists', () => {
    const f = feature({
      tier: null,
      has: { prd: false, tdd: false, tests: false, tasks: false },
    })
    expect(nextAction(f)).toEqual({ phase: 'scope', action: 'settle-size' })
  })

  it('UT-18 asks for the size when no tier is recorded, whatever else exists', () => {
    expect(nextAction(feature({ tier: null }))).toEqual({ phase: 'scope', action: 'settle-size' })
  })

  it('UT-25 assumes no size when the recorded one was unrecognised', () => {
    // readFeature leaves tier absent for an unknown value; the phase is scope, not an error.
    expect(nextAction(feature({ tier: null })).phase).toBe('scope')
  })
})

describe('nextAction — requirements', () => {
  it('UT-19 names the first unanswered question, not the last', () => {
    const questions: QuestionRecord[] = [
      answered('Q1'),
      { id: 'Q3', round: 1, answered: false },
      { id: 'Q7', round: 2, answered: false },
    ]
    expect(nextAction(feature({ questions }))).toEqual({
      phase: 'requirements',
      action: 'await-answers',
      target: 'Q3',
    })
  })

  it('UT-20 asks for the score when an answered question has no effect', () => {
    const questions: QuestionRecord[] = [
      answered('Q1'),
      { id: 'Q4', round: 1, answered: true },
      answered('Q5'),
    ]
    expect(nextAction(feature({ questions }))).toEqual({
      phase: 'requirements',
      action: 'score-round',
      target: 'Q4',
    })
  })

  it('UT-65 asks for the requirements artifact once the questions are settled', () => {
    const f = feature({ questions: [answered('Q1')], has: { prd: false } })
    expect(nextAction(f)).toEqual({ phase: 'requirements', action: 'write-prd' })
  })

  it('UT-29 puts an open question ahead of a missing design document', () => {
    const f = feature({
      questions: [{ id: 'Q1', round: 1, answered: false }],
      has: { tdd: false },
    })
    expect(nextAction(f).action).toBe('await-answers')
  })
})

describe('nextAction — prune and design', () => {
  it('UT-21 asks for a prune while no cut has been recorded', () => {
    expect(nextAction(feature({ has: { cutSection: false } }))).toEqual({
      phase: 'prune',
      action: 'prune',
    })
  })

  it('UT-23 asks for the design document at tier design', () => {
    expect(nextAction(feature({ tier: 'design', has: { tdd: false } }))).toEqual({
      phase: 'design',
      action: 'write-tdd',
    })
  })

  it('UT-24 asks for the test contract once the design exists', () => {
    expect(nextAction(feature({ tier: 'design', has: { tests: false } }))).toEqual({
      phase: 'design',
      action: 'write-tests',
    })
  })

  it('UT-22 never asks a light slice for a design document', () => {
    const f = feature({
      tier: 'light',
      has: { tdd: false, tests: false, tasks: false },
    })
    expect(nextAction(f)).toEqual({ phase: 'verify', action: 'verify' })
  })

  it('UT-25 asks a design slice for no task graph', () => {
    const f = feature({ tier: 'design', has: { tasks: false } })
    expect(nextAction(f)).toEqual({ phase: 'verify', action: 'verify' })
  })
})

describe('nextAction — tasks and execution', () => {
  it('UT-25 asks a full slice for its task graph', () => {
    expect(nextAction(feature({ tier: 'full', has: { tasks: false } }))).toEqual({
      phase: 'tasks',
      action: 'write-tasks',
    })
  })

  it('UT-26 picks the lowest ready task', () => {
    const tasks = [task('T1', true), task('T2', false, ['T1']), task('T3', false, ['T1'])]
    expect(nextAction(feature({ tasks }))).toEqual({
      phase: 'execute',
      action: 'execute-task',
      target: 'T2',
    })
  })

  it('UT-26 skips a task whose dependency is unfinished', () => {
    const tasks = [task('T1', false), task('T2', false, ['T1']), task('T3', false)]
    expect(nextAction(feature({ tasks })).target).toBe('T1')
  })

  it('UT-26 orders task ids numerically, not lexically', () => {
    const tasks = [task('T10', false), task('T2', false)]
    expect(nextAction(feature({ tasks })).target).toBe('T2')
  })

  it('UT-27 asks for verification once every task is done', () => {
    const tasks = [task('T1', true), task('T2', true, ['T1'])]
    expect(nextAction(feature({ tasks }))).toEqual({ phase: 'verify', action: 'verify' })
  })

  it('UT-27 treats a recorded failure as work still to do', () => {
    const tasks = [task('T1', true)]
    expect(nextAction(feature({ tasks, verdict: 'fail' }))).toEqual({
      phase: 'verify',
      action: 'verify',
    })
  })
})

describe('nextAction — done', () => {
  it('UT-28 reports done for a passing verdict on a finished graph', () => {
    const tasks = [task('T1', true), task('T2', true, ['T1'])]
    expect(nextAction(feature({ tasks, verdict: 'pass' }))).toEqual({
      phase: 'done',
      action: 'done',
    })
  })

  it('UT-30 reports done for a light slice with a passing verdict and no tasks', () => {
    const f = feature({
      tier: 'light',
      has: { tdd: false, tests: false, tasks: false },
      verdict: 'pass',
    })
    expect(nextAction(f)).toEqual({ phase: 'done', action: 'done' })
  })

  it('UT-28 always returns exactly one action, whatever the input', () => {
    const action = nextAction(feature({ tasks: [task('T1', true)], verdict: 'pass' }))
    expect(Object.keys(action).sort()).toEqual(['action', 'phase'])
  })
})
