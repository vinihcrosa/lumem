import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunLlm } from '../src/core/consolidate/run'
import { FIXTURES_DIR, REPO_ROOT, listFixtures, loadFixture, materializeFixture } from './fixtures'
import { loadMockResponses, replayLlm } from './mock'
import { runEval } from './run-eval'
import type { EvalReport } from './types'

/**
 * The harness measures the prompt, so the harness itself has to be measured by
 * something. Every test here runs in mock mode or with an injected `runLlm`:
 * nothing in this file may ever spawn a CLI or open a socket.
 */

const EMPTY = '{"version":1,"add":[],"replace":[],"remove":[]}'

/** A patch with one add, built inline so a test can shape exactly what it needs. */
function patchWith(body: string, extra?: { type?: string; scope?: string }): string {
  return JSON.stringify({
    version: 1,
    add: [
      {
        type: extra?.type ?? 'project',
        scope: extra?.scope ?? 'project',
        body,
        conf: 'high',
      },
    ],
    replace: [],
    remove: [],
  })
}

function fixedLlm(stdout: string): RunLlm {
  return () => ({ ok: true, stdout, stderr: '' })
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-eval-test-'))
  tempDirs.push(dir)
  return dir
}

function scoreOf(report: EvalReport, fixture: string): EvalReport['fixtures'][number]['score'] {
  const result = report.fixtures.find((entry) => entry.fixture === fixture)
  if (result === undefined) throw new Error(`fixture '${fixture}' missing from report`)
  return result.score
}

describe('runEval — mock mode over the shipped fixtures', () => {
  it('runs every fixture, clears both hard gates and meets every expectation', async () => {
    const report = await runEval({ mock: true, runs: 1 })

    expect(report.mode).toBe('mock')
    expect(report.harnessId).toBe('claude-code')
    expect(report.fixtures.map((entry) => entry.fixture)).toEqual(listFixtures())
    expect(report.overall.totalRuns).toBe(listFixtures().length)
    expect(report.overall.schemaValid).toBe(1)
    expect(report.overall.secretLeak).toBe(0)
    expect(report.overall.expectationsMet).toBe(1)
    expect(report.overall.hardGateFailures).toEqual([])
    expect(report.overall.passed).toBe(true)
  })

  it('scores the calibration case as an empty patch and the trap case as a write', async () => {
    const report = await runEval({
      mock: true,
      runs: 3,
      fixtures: ['trivial-session', 'learned-trap'],
    })

    expect(scoreOf(report, 'trivial-session').emptyPatchRate).toBe(1)
    expect(scoreOf(report, 'trivial-session').addCount).toBe(0)
    expect(scoreOf(report, 'learned-trap').emptyPatchRate).toBe(0)
    expect(scoreOf(report, 'learned-trap').addCount).toBe(1)
  })

  it('replays a distinct canned response per run', async () => {
    const responses = loadMockResponses('noisy-long-session')
    expect(responses.length).toBeGreaterThan(1)

    const report = await runEval({
      mock: true,
      runs: responses.length,
      fixtures: ['noisy-long-session'],
    })
    const score = scoreOf(report, 'noisy-long-session')
    // The third variant writes one fact where the others write two.
    expect(score.variance.addSpread).toBe(1)
    expect(score.variance.verdictAgreement).toBe(1)
  })

  it('refuses to run a fixture that has no canned response', async () => {
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, 'lonely'), { recursive: true })
    fs.copyFileSync(
      path.join(FIXTURES_DIR, 'trivial-session', 'journal.jsonl'),
      path.join(dir, 'lonely', 'journal.jsonl'),
    )
    fs.writeFileSync(
      path.join(dir, 'lonely', 'expect.json'),
      JSON.stringify({
        description: 'a fixture with no mock file at all',
        expect: { noSecrets: true },
      }),
    )

    await expect(
      runEval({ mock: true, runs: 1, fixturesDir: dir, mockDir: path.join(dir, 'mocks') }),
    ).rejects.toThrow(/no mock response file/)
  })

  it('never runs in real mode under vitest', async () => {
    await expect(runEval({ runs: 1, fixtures: ['trivial-session'] })).rejects.toThrow(
      /real mode is not allowed under vitest/,
    )
  })
})

describe('runEval — the prompt it actually sends', () => {
  it('carries the shipped SKILL.md, the fixture journal and the seeded memory', async () => {
    const prompts: string[] = []
    const llm: RunLlm = (_cmd, prompt) => {
      prompts.push(prompt)
      return { ok: true, stdout: EMPTY, stderr: '' }
    }

    const report = await runEval({ runs: 1, fixtures: ['contradicts-existing'], llm })

    expect(report.mode).toBe('injected')
    expect(prompts).toHaveLength(1)
    const prompt = prompts[0] ?? ''
    // the product under test, verbatim
    expect(prompt.startsWith('# lumem-consolidate')).toBe(true)
    expect(prompt).toContain('The four anti-junk rules')
    // the fixture journal
    expect(prompt).toContain('## Session journal')
    expect(prompt).toContain('"marker":"we decided"')
    // the seeded memory, rendered with the id the fixture pins
    expect(prompt).toContain('## Current memory')
    expect(prompt).toContain('3808e284')
    expect(prompt).toContain('Auth is undecided')
    // promptBytes is read back from the log the run itself wrote
    expect(report.fixtures[0]?.runs[0]?.promptBytes).toBe(Buffer.byteLength(prompt, 'utf8'))
  })

  it('leaves the real repo and the real home untouched', async () => {
    const watched = [path.join(REPO_ROOT, '.lumem'), path.join(os.homedir(), '.lumem')]
    const before = watched.map(snapshot)

    await runEval({ mock: true, runs: 1 })

    expect(watched.map(snapshot)).toEqual(before)
  })
})

describe('runEval — hard gates', () => {
  it('fails the secret gate when a body carries an AWS-shaped key', async () => {
    const leak = patchWith('Deploys need AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE exported first.')
    const report = await runEval({ runs: 2, fixtures: ['secret-in-prompt'], llm: fixedLlm(leak) })

    const score = scoreOf(report, 'secret-in-prompt')
    expect(score.secretLeak).toBe(1)
    expect(score.schemaValid).toBe(1)
    expect(score.hardGateFailures).toEqual(['secretLeak 100% (must be 0%)'])
    expect(score.passed).toBe(false)
    expect(report.overall.passed).toBe(false)
    expect(report.overall.hardGateFailures[0]).toContain('secret-in-prompt')

    const run = report.fixtures[0]?.runs[0]
    expect(run?.secretKinds).toContain('aws-access-key')
    expect(run?.assertions.find((entry) => entry.name === 'noSecrets')?.passed).toBe(false)
  })

  it('fails the schema gate when the model answers with prose', async () => {
    const report = await runEval({
      runs: 2,
      fixtures: ['learned-trap'],
      llm: fixedLlm('Sure! I had a look and honestly nothing stood out this session.'),
    })

    const score = scoreOf(report, 'learned-trap')
    expect(score.schemaValid).toBe(0)
    expect(score.hardGateFailures).toEqual(['schemaValid 0% (must be 100%)'])
    expect(score.expectationsMet).toBe(0)
    expect(report.fixtures[0]?.runs[0]?.error).toContain('invalid JSON')
    // A run without a patch is not an empty patch: it is a failure.
    expect(score.emptyPatchRate).toBe(0)
    expect(report.overall.passed).toBe(false)
  })

  it('fails the schema gate on a patch the strict schema rejects', async () => {
    const report = await runEval({
      runs: 1,
      fixtures: ['trivial-session'],
      llm: fixedLlm('{"version":1,"add":[],"replace":[],"remove":[],"notes":"tidy session"}'),
    })

    expect(scoreOf(report, 'trivial-session').schemaValid).toBe(0)
    expect(report.fixtures[0]?.runs[0]?.error).toContain('invalid patch')
  })
})

describe('runEval — scoring math', () => {
  it('counts each failed expectation, not just the fixture', async () => {
    // trivial-session declares four assertions; a lone harmless add breaks two.
    const report = await runEval({
      runs: 1,
      fixtures: ['trivial-session'],
      llm: fixedLlm(patchWith('The memory module is covered by unit tests that all pass.')),
    })

    const run = report.fixtures[0]?.runs[0]
    expect(run?.assertions).toHaveLength(4)
    expect(run?.assertions.filter((entry) => !entry.passed).map((entry) => entry.name)).toEqual([
      'emptyPatch',
      'maxAdds',
    ])
    expect(scoreOf(report, 'trivial-session').expectationsMet).toBe(0.5)
  })

  it('catches a body that duplicates the repo', async () => {
    const report = await runEval({
      runs: 1,
      fixtures: ['repo-duplication-bait'],
      llm: fixedLlm(patchWith('The project bundles with tsup and targets node20.')),
    })

    const failed = report.fixtures[0]?.runs[0]?.assertions.filter((entry) => !entry.passed) ?? []
    expect(failed.map((entry) => entry.name)).toContain('mustNotContain')
    expect(failed.find((entry) => entry.name === 'mustNotContain')?.detail).toContain('tsup')
  })

  it('catches a fact filed under the wrong type/scope', async () => {
    const report = await runEval({
      runs: 1,
      fixtures: ['preference-signal'],
      llm: fixedLlm(
        patchWith('Wants the diff before approving a change.', {
          type: 'project',
          scope: 'project',
        }),
      ),
    })

    const assertion = report.fixtures[0]?.runs[0]?.assertions.find(
      (entry) => entry.name === 'mustAddTypeScope',
    )
    expect(assertion?.passed).toBe(false)
    expect(assertion?.detail).toContain('preference/global')
  })

  it('catches a contradiction that was stacked instead of replaced', async () => {
    const report = await runEval({
      runs: 1,
      fixtures: ['contradicts-existing'],
      llm: fixedLlm(patchWith('Auth uses session cookies because revocation must be immediate.')),
    })

    const assertion = report.fixtures[0]?.runs[0]?.assertions.find(
      (entry) => entry.name === 'mustReplaceId',
    )
    expect(assertion?.passed).toBe(false)
    expect(assertion?.detail).toContain('3808e284')
  })

  it('reports disagreement between runs', async () => {
    let call = 0
    const flipflop: RunLlm = () => {
      const stdout =
        call++ % 2 === 0 ? EMPTY : patchWith('Docker compose must be up for the e2e suite.')
      return { ok: true, stdout, stderr: '' }
    }

    const report = await runEval({ runs: 4, fixtures: ['learned-trap'], llm: flipflop })
    const score = scoreOf(report, 'learned-trap')

    expect(score.variance.verdictAgreement).toBe(0.5)
    expect(score.variance.addSpread).toBe(1)
    expect(score.emptyPatchRate).toBe(0.5)
    expect(score.addCount).toBe(0.5)
  })
})

describe('materializeFixture', () => {
  it('lays out a complete throwaway project and cleans it up', () => {
    const spec = loadFixture('contradicts-existing')
    const project = materializeFixture(spec)

    expect(fs.existsSync(path.join(project.projectDir, '.lumem', 'lumem.config.json'))).toBe(true)
    expect(fs.existsSync(project.sessionFile)).toBe(true)
    expect(
      fs.readFileSync(path.join(project.projectDir, '.lumem', 'memory', 'project.md'), 'utf8'),
    ).toContain('Auth is undecided')
    expect(fs.existsSync(path.join(project.homeDir, '.lumem', 'memory'))).toBe(true)

    project.cleanup()
    expect(fs.existsSync(project.root)).toBe(false)
  })

  it('refuses a memory file it cannot place', () => {
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, 'odd', 'memory'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'odd', 'journal.jsonl'), '')
    fs.writeFileSync(path.join(dir, 'odd', 'memory', 'notes.md'), '')
    fs.writeFileSync(
      path.join(dir, 'odd', 'expect.json'),
      JSON.stringify({
        description: 'a fixture with a stray memory file',
        expect: { noSecrets: true },
      }),
    )

    expect(() => materializeFixture(loadFixture('odd', dir))).toThrow(/unknown memory file/)
  })
})

describe('replayLlm', () => {
  it('cycles through the canned responses and never spawns anything', () => {
    const responses = ['a', 'b']
    expect(replayLlm(responses, 0)([], '', 0).stdout).toBe('a')
    expect(replayLlm(responses, 1)([], '', 0).stdout).toBe('b')
    expect(replayLlm(responses, 2)([], '', 0).stdout).toBe('a')
  })
})

/** Recursive listing of `dir` as `relative path -> content`; missing dirs are empty. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        try {
          out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8')
        } catch {
          out[path.relative(dir, full)] = '<unreadable>'
        }
      }
    }
  }
  walk(dir)
  return out
}
