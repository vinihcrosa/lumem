import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Signal } from '../capture/journal'
import { defaultConfig, writeConfig } from '../config'
import {
  DEFAULT_FILE_BUDGETS,
  checkSoftLimits,
  readLocalState,
  updateCompactionFlags,
  writeLocalState,
} from '../memory/limits'
import type { MemoryFile } from '../memory/store'
import { addFact, factId, memoryLayout, readMemoryFile, writeMemoryFile } from '../memory/store'
import { acquireLock } from './lock'
import { DEFAULT_LLM_TIMEOUT_MS, runConsolidation } from './run'

const HARNESS_ID = 'test-harness'
const NOW = new Date('2026-08-07T18:00:00.000Z')
const BASE_MS = Date.parse('2026-08-07T14:00:00.000Z')

const SEED_BODY = 'Auth is undecided: JWT and session cookies are both on the table.'
const SEED_DATE = '2026-06-02'
const NEW_BODY =
  '`npm run test:e2e` needs `docker compose up -d` first; the suite starts no containers.'

const PATCH = {
  version: 1,
  add: [{ type: 'project', scope: 'project', body: NEW_BODY, conf: 'high' }],
  replace: [],
  remove: [],
}
const PATCH_JSON = JSON.stringify(PATCH)

const SKILL_MARKER = '# lumem-consolidate (fixture body)'
const SKILL_FIXTURE = `---\nname: lumem-consolidate\ndescription: fixture front matter\n---\n\n${SKILL_MARKER}\n\nEmit the patch object and nothing else.\n`

const createdRoots: string[] = []

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

interface Headless {
  command: string[]
  promptVia: 'stdin' | 'arg'
  modelFlag?: string
  defaultModel?: string
}

const DEFAULT_HEADLESS: Headless = {
  command: ['test-llm', '--headless'],
  promptVia: 'stdin',
  modelFlag: '--model',
  defaultModel: 'tiny',
}

interface Fixture {
  root: string
  projectDir: string
  homeDir: string
  adaptersDir: string
  assetsDir: string
  lumemDir: string
  localDir: string
  sessionFile: string
}

/** ISO timestamp `minutes` after the fixed journal base instant. */
function at(minutes: number): string {
  return new Date(BASE_MS + minutes * 60_000).toISOString()
}

/** Six work signals spread over 12 minutes: comfortably past the default gate. */
function journalSignals(): Signal[] {
  return [
    {
      t: 'session',
      ts: at(0),
      ev: 'start',
      harness: HARNESS_ID,
      sessionId: 'a1b2c3',
      cwd: '/repo',
    },
    { t: 'file', ts: at(1), path: 'src/api/auth.ts', tool: 'Edit' },
    { t: 'cmd', ts: at(4), cmd: 'npm run test:e2e', exit: 1 },
    {
      t: 'recovery',
      ts: at(5),
      failed: 'npm run test:e2e',
      passed: 'docker compose up -d && npm run test:e2e',
    },
    { t: 'correction', ts: at(7), marker: 'actually', prompt: 'actually no, use a session cookie' },
    { t: 'file', ts: at(9), path: 'src/api/session.ts', tool: 'Write' },
    { t: 'cmd', ts: at(12), cmd: 'npm run test:e2e', exit: 0 },
    { t: 'session', ts: at(12), ev: 'end', harness: HARNESS_ID, sessionId: 'a1b2c3', cwd: '/repo' },
  ]
}

function writeDescriptor(fx: Fixture, headless: Headless = DEFAULT_HEADLESS): void {
  fs.mkdirSync(fx.adaptersDir, { recursive: true })
  fs.writeFileSync(
    path.join(fx.adaptersDir, `${HARNESS_ID}.json`),
    JSON.stringify({
      id: HARNESS_ID,
      minVersion: '1.0.0',
      detect: [{ type: 'bin', name: 'test-llm' }],
      paths: {
        home: '~/.test-harness',
        skills: { project: '.test-harness/skills', global: '~/.test-harness/skills' },
        hooksConfig: [
          {
            scope: 'project',
            path: '.test-harness/hooks.json',
            format: 'json',
            strategy: 'own-file',
          },
        ],
      },
      capabilities: {
        'hooks.sessionStart': true,
        'hooks.sessionEnd': true,
        'hooks.userPromptSubmit': true,
        'hooks.postToolUse': true,
        'hooks.envProjectDir': true,
        'hooks.requiresTrust': false,
        'hooks.stdoutInjection': true,
        'platform.windows': true,
      },
      eventMap: { end: 'SessionEnd' },
      injection: ['hook-stdout'],
      headless,
    }),
  )
}

/** A complete, gate-passing project: config, adapter, skill asset, journal, seeded memory. */
function setup(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-run-'))
  createdRoots.push(root)

  const projectDir = path.join(root, 'repo')
  const homeDir = path.join(root, 'home')
  const fx: Fixture = {
    root,
    projectDir,
    homeDir,
    adaptersDir: path.join(root, 'adapters'),
    assetsDir: path.join(root, 'assets'),
    lumemDir: path.join(projectDir, '.lumem'),
    localDir: path.join(projectDir, '.lumem', 'local'),
    sessionFile: path.join(projectDir, '.lumem', 'local', 'sessions', 'a1b2c3.jsonl'),
  }

  fs.mkdirSync(fx.homeDir, { recursive: true })
  fs.mkdirSync(path.dirname(fx.sessionFile), { recursive: true })
  fs.writeFileSync(
    fx.sessionFile,
    `${journalSignals()
      .map((s) => JSON.stringify(s))
      .join('\n')}\n`,
  )

  writeDescriptor(fx)
  writeConfig(fx.lumemDir, defaultConfig([{ id: HARNESS_ID, minVersion: '1.0.0' }]))

  const skillDir = path.join(fx.assetsDir, 'skills', 'lumem-consolidate')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL_FIXTURE)

  const projectMemory = path.join(fx.lumemDir, 'memory', 'project.md')
  fs.mkdirSync(path.dirname(projectMemory), { recursive: true })
  fs.writeFileSync(
    projectMemory,
    `- [${SEED_DATE}] ${SEED_BODY}\n  <!-- src:sess_old conf:low -->\n`,
  )

  return fx
}

/** Rewrite the project config through a mutator, keeping it schema-valid. */
function patchConfig(fx: Fixture, mutate: (c: ReturnType<typeof defaultConfig>) => void): void {
  const config = defaultConfig([{ id: HARNESS_ID, minVersion: '1.0.0' }])
  mutate(config)
  writeConfig(fx.lumemDir, config)
}

interface LlmCall {
  cmd: string[]
  prompt: string
  timeoutMs: number
}

type LlmReply = { ok: boolean; stdout: string; stderr: string }

/** Injected LLM double: records every call, never spawns anything. */
function llmSpy(handler?: (call: LlmCall) => LlmReply): {
  calls: LlmCall[]
  fn: (cmd: string[], prompt: string, timeoutMs: number) => LlmReply
} {
  const calls: LlmCall[] = []
  return {
    calls,
    fn: (cmd, prompt, timeoutMs) => {
      const call = { cmd, prompt, timeoutMs }
      calls.push(call)
      return handler?.(call) ?? { ok: true, stdout: PATCH_JSON, stderr: '' }
    },
  }
}

function memoryPaths(fx: Fixture): string[] {
  return memoryLayout(fx.lumemDir, path.join(fx.homeDir, '.lumem')).map((entry) => entry.path)
}

/** Byte snapshot of the four memory files; a missing file is recorded as null. */
function snapshotMemory(fx: Fixture): Record<string, string | null> {
  const snapshot: Record<string, string | null> = {}
  for (const file of memoryPaths(fx)) {
    snapshot[file] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  }
  return snapshot
}

function lockFile(fx: Fixture): string {
  return path.join(fx.localDir, 'consolidate.lock')
}

function baseOptions(fx: Fixture): {
  projectDir: string
  sessionFile: string
  harnessId: string
  adaptersDir: string
  assetsDir: string
  homeDir: string
  now: () => Date
} {
  return {
    projectDir: fx.projectDir,
    sessionFile: fx.sessionFile,
    harnessId: HARNESS_ID,
    adaptersDir: fx.adaptersDir,
    assetsDir: fx.assetsDir,
    homeDir: fx.homeDir,
    now: () => NOW,
  }
}

describe('runConsolidation — refusals', () => {
  it('refuses when the gate fails: no lock is taken and the LLM is never called', () => {
    const fx = setup()
    // One lone signal: below the 5-signal and 3-minute thresholds.
    fs.writeFileSync(
      fx.sessionFile,
      `${JSON.stringify({ t: 'file', ts: at(0), path: 'a.ts', tool: 'Edit' })}\n`,
    )
    const llm = llmSpy()

    const result = runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    expect(result.ran).toBe(false)
    expect(result.gateReasons.some((r) => r.startsWith('signals:'))).toBe(true)
    expect(llm.calls).toHaveLength(0)
    expect(fs.existsSync(lockFile(fx))).toBe(false)
    expect(result.patch).toBeUndefined()
  })

  it('refuses when another runner holds the lock, even with --force', () => {
    const fx = setup()
    expect(acquireLock(fx.localDir)).not.toBeNull()
    const llm = llmSpy()

    const result = runConsolidation({ ...baseOptions(fx), force: true, runLlm: llm.fn })

    expect(result.ran).toBe(false)
    expect(result.gateReasons.some((r) => r.startsWith('lock:'))).toBe(true)
    expect(llm.calls).toHaveLength(0)
    expect(snapshotMemory(fx)[memoryPaths(fx)[0] ?? '']).toContain(SEED_BODY)
  })

  it('refuses when consolidation is disabled in config, without taking the lock', () => {
    const fx = setup()
    patchConfig(fx, (config) => {
      config.consolidation.enabled = false
    })
    const llm = llmSpy()

    const result = runConsolidation({ ...baseOptions(fx), force: true, runLlm: llm.fn })

    expect(result).toEqual({ ran: false, gateReasons: ['consolidation disabled in config'] })
    expect(llm.calls).toHaveLength(0)
    expect(fs.existsSync(lockFile(fx))).toBe(false)
  })

  it('--force waives the gate thresholds and runs anyway', () => {
    const fx = setup()
    fs.writeFileSync(
      fx.sessionFile,
      `${JSON.stringify({ t: 'file', ts: at(0), path: 'a.ts', tool: 'Edit' })}\n`,
    )
    const llm = llmSpy()

    const result = runConsolidation({ ...baseOptions(fx), force: true, runLlm: llm.fn })

    expect(result.ran).toBe(true)
    expect(llm.calls).toHaveLength(1)
  })
})

describe('runConsolidation — the prompt', () => {
  it('sends the SKILL.md body with its front matter stripped', () => {
    const fx = setup()
    const llm = llmSpy()

    runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    const prompt = llm.calls[0]?.prompt ?? ''
    expect(prompt.startsWith(SKILL_MARKER)).toBe(true)
    expect(prompt).not.toContain('description: fixture front matter')
    expect(prompt).not.toContain('---')
  })

  it('carries the journal lines and the rendered current-memory block', () => {
    const fx = setup()
    const llm = llmSpy()

    runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    const prompt = llm.calls[0]?.prompt ?? ''
    expect(prompt).toContain('## Session journal')
    for (const signal of journalSignals()) {
      expect(prompt).toContain(JSON.stringify(signal))
    }
    expect(prompt).toContain('## Current memory')
    expect(prompt).toContain(
      `${factId(SEED_BODY)}  [${SEED_DATE}]  (project/project)  conf:low  ${SEED_BODY}`,
    )
  })

  it('adds compaction instructions naming the flagged files when flags are set', () => {
    const fx = setup()
    writeLocalState(fx.localDir, { compactionFlags: ['preference'] })
    const llm = llmSpy()

    runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    const prompt = llm.calls[0]?.prompt ?? ''
    expect(prompt).toContain('compact: preference')
    expect(prompt).toContain(path.join(fx.homeDir, '.lumem', 'memory', 'preference.md'))
    expect(prompt).not.toContain(path.join(fx.lumemDir, 'memory', 'project.md'))
  })

  it('omits the compaction section when no file is flagged', () => {
    const fx = setup()
    const llm = llmSpy()

    runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    expect(llm.calls[0]?.prompt ?? '').not.toContain('compact:')
  })

  it('uses the shipped SKILL.md when pointed at the real assets directory', () => {
    const fx = setup()
    const llm = llmSpy()

    runConsolidation({
      ...baseOptions(fx),
      assetsDir: fileURLToPath(new URL('../../../assets', import.meta.url)),
      runLlm: llm.fn,
    })

    const prompt = llm.calls[0]?.prompt ?? ''
    expect(prompt.startsWith('# lumem-consolidate')).toBe(true)
    expect(prompt).toContain('The four anti-junk rules')
  })
})

describe('runConsolidation — the command', () => {
  it('appends the model flag with the configured model', () => {
    const fx = setup()
    patchConfig(fx, (config) => {
      config.consolidation.model = 'cheap-model-1'
    })
    const llm = llmSpy()

    runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    expect(llm.calls[0]?.cmd).toEqual(['test-llm', '--headless', '--model', 'cheap-model-1'])
    expect(llm.calls[0]?.timeoutMs).toBe(DEFAULT_LLM_TIMEOUT_MS)
  })

  it("falls back to the descriptor's defaultModel when config names none", () => {
    const fx = setup()
    const llm = llmSpy()

    runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    expect(llm.calls[0]?.cmd).toEqual(['test-llm', '--headless', '--model', 'tiny'])
  })

  it('omits the model entirely when the descriptor has no modelFlag', () => {
    const fx = setup()
    writeDescriptor(fx, { command: ['test-llm', 'exec'], promptVia: 'stdin' })
    patchConfig(fx, (config) => {
      config.consolidation.model = 'cheap-model-1'
    })
    const llm = llmSpy()

    runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    expect(llm.calls[0]?.cmd).toEqual(['test-llm', 'exec'])
  })
})

describe('runConsolidation — applying', () => {
  it('applies a valid patch, writes memory and stamps lastConsolidationAt', () => {
    const fx = setup()
    const llm = llmSpy()

    const result = runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    expect(result.ran).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.patch?.add[0]?.body).toBe(NEW_BODY)

    const projectMemory = path.join(fx.lumemDir, 'memory', 'project.md')
    expect(result.applied?.filesWritten).toEqual([projectMemory])
    expect(result.applied?.applied).toHaveLength(1)

    const written = fs.readFileSync(projectMemory, 'utf8')
    expect(written).toContain(SEED_BODY)
    expect(written).toContain(NEW_BODY)
    expect(written).toContain('src:sess_a1b2c3 conf:high')

    expect(readLocalState(fx.localDir).lastConsolidationAt).toBe(NOW.toISOString())
  })

  it('reconciles compaction flags against the memory written by the patch', () => {
    const fx = setup()
    writeLocalState(fx.localDir, { compactionFlags: ['preference'] })
    const llm = llmSpy()

    runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    // preference.md is empty, so its stale flag is cleared once the run re-reads it.
    expect(readLocalState(fx.localDir).compactionFlags).toEqual([])
  })

  it('releases the lock after a successful run', () => {
    const fx = setup()
    const seen: boolean[] = []
    const llm = llmSpy(() => {
      seen.push(fs.existsSync(lockFile(fx)))
      return { ok: true, stdout: PATCH_JSON, stderr: '' }
    })

    runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    expect(seen).toEqual([true])
    expect(fs.existsSync(lockFile(fx))).toBe(false)
    expect(acquireLock(fx.localDir)).not.toBeNull()
  })

  it('writes a log line into .lumem/local/lumem.log', () => {
    const fx = setup()
    const llm = llmSpy()

    runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    const log = fs.readFileSync(path.join(fx.localDir, 'lumem.log'), 'utf8')
    expect(log).toContain('consolidate.applied')
  })
})

describe('runConsolidation — failure paths', () => {
  it('leaves memory untouched and releases the lock when the LLM fails', () => {
    const fx = setup()
    const before = snapshotMemory(fx)
    const llm = llmSpy(() => ({ ok: false, stdout: '', stderr: 'command not found: test-llm' }))

    const result = runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    expect(result.ran).toBe(false)
    expect(result.error).toContain('command not found: test-llm')
    expect(result.applied).toBeUndefined()
    expect(snapshotMemory(fx)).toEqual(before)
    expect(readLocalState(fx.localDir).lastConsolidationAt).toBeUndefined()
    expect(acquireLock(fx.localDir)).not.toBeNull()
  })

  it('leaves memory untouched and releases the lock when the output does not parse', () => {
    const fx = setup()
    const before = snapshotMemory(fx)
    const noise = `here is my answer, boss: ${'x'.repeat(900)}`
    const llm = llmSpy(() => ({ ok: true, stdout: noise, stderr: '' }))

    const result = runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    expect(result.ran).toBe(false)
    expect(result.error).toContain('invalid JSON')
    expect(snapshotMemory(fx)).toEqual(before)
    expect(acquireLock(fx.localDir)).not.toBeNull()

    // The raw output is logged, but only an excerpt of it.
    const log = fs.readFileSync(path.join(fx.localDir, 'lumem.log'), 'utf8')
    expect(log).toContain('consolidate.parse-failed')
    expect(log).not.toContain('x'.repeat(900))
  })

  it('rejects a patch whose entries violate the schema, without writing', () => {
    const fx = setup()
    const before = snapshotMemory(fx)
    const llm = llmSpy(() => ({
      ok: true,
      stdout: JSON.stringify({ version: 1, add: [{ type: 'project' }], replace: [], remove: [] }),
      stderr: '',
    }))

    const result = runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    expect(result.ran).toBe(false)
    expect(result.error).toContain('invalid patch')
    expect(snapshotMemory(fx)).toEqual(before)
  })

  it('releases the lock when the flow throws', () => {
    const fx = setup()
    const llm = llmSpy(() => {
      throw new Error('spawn exploded')
    })

    const result = runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    expect(result.ran).toBe(false)
    expect(result.error).toContain('spawn exploded')
    expect(fs.existsSync(lockFile(fx))).toBe(false)
    expect(acquireLock(fx.localDir)).not.toBeNull()
  })

  it('reports an unknown harness id instead of throwing', () => {
    const fx = setup()
    const llm = llmSpy()

    const result = runConsolidation({ ...baseOptions(fx), harnessId: 'nope', runLlm: llm.fn })

    expect(result.ran).toBe(false)
    expect(result.error).toContain('nope')
    expect(llm.calls).toHaveLength(0)
    expect(acquireLock(fx.localDir)).not.toBeNull()
  })
})

/** Distinct one-line bodies, cheap to serialize and unique by construction. */
function bulkBodies(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `legacy note ${i}: a detail recorded during an old session`,
  )
}

/** Overwrite project.md with `bodies`, through the store's own writer. */
function seedProjectMemory(fx: Fixture, bodies: string[]): MemoryFile {
  const file: MemoryFile = {
    path: path.join(fx.lumemDir, 'memory', 'project.md'),
    type: 'project',
    scope: 'project',
    facts: [],
    warnings: [],
  }
  for (const body of bodies) {
    addFact(file, { date: SEED_DATE, body, src: 'sess_old', conf: 'low' })
  }
  writeMemoryFile(file)
  return file
}

function readProjectMemory(fx: Fixture): MemoryFile {
  return readMemoryFile(path.join(fx.lumemDir, 'memory', 'project.md'), {
    type: 'project',
    scope: 'project',
  })
}

const MERGED_BODY =
  'Auth: session cookies won over JWT; the old per-session notes are merged into this line.'

/** A compaction patch: drop `removed`, keep the rest, add one merged fact. */
function compactionPatch(removed: string[]): string {
  return JSON.stringify({
    version: 1,
    add: [{ type: 'project', scope: 'project', body: MERGED_BODY, conf: 'high' }],
    replace: [],
    remove: removed.map((body) => ({ targetId: factId(body), reason: 'compaction: merged' })),
  })
}

describe('runConsolidation — compaction driven by soft limits', () => {
  it('names the flagged file in the prompt and clears the flag once it fits again', () => {
    const fx = setup()
    const bodies = bulkBodies(200)
    const seeded = seedProjectMemory(fx, bodies)

    // The fixture is genuinely over budget, so the flag is earned, not planted.
    expect(checkSoftLimits(seeded).exceeded).toBe(true)
    expect(updateCompactionFlags(fx.localDir, [seeded]).compactionFlags).toEqual(['project'])

    const llm = llmSpy(() => ({ ok: true, stdout: compactionPatch(bodies.slice(5)), stderr: '' }))
    const result = runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    const prompt = llm.calls[0]?.prompt ?? ''
    expect(prompt).toContain('compact: project')
    expect(prompt).toContain(seeded.path)

    expect(result.ran).toBe(true)
    expect(result.error).toBeUndefined()

    const after = readProjectMemory(fx)
    const measured = checkSoftLimits(after)
    expect(measured.lines).toBeLessThanOrEqual(DEFAULT_FILE_BUDGETS.project.lines)
    expect(measured.bytes).toBeLessThanOrEqual(DEFAULT_FILE_BUDGETS.project.bytes)
    expect(measured.exceeded).toBe(false)

    // The compaction kept what it was told to keep and recorded the merge.
    expect(after.facts.map((fact) => fact.body)).toEqual([...bodies.slice(0, 5), MERGED_BODY])
    expect(readLocalState(fx.localDir).compactionFlags).toEqual([])
  })

  it('keeps the flag when the patch does not bring the file back under budget', () => {
    const fx = setup()
    const bodies = bulkBodies(200)
    const seeded = seedProjectMemory(fx, bodies)
    expect(updateCompactionFlags(fx.localDir, [seeded]).compactionFlags).toEqual(['project'])

    // Ten of two hundred: a real edit that is nowhere near enough.
    const llm = llmSpy(() => ({
      ok: true,
      stdout: compactionPatch(bodies.slice(0, 10)),
      stderr: '',
    }))
    const result = runConsolidation({ ...baseOptions(fx), runLlm: llm.fn })

    expect(result.ran).toBe(true)
    expect(result.applied?.filesWritten).toEqual([seeded.path])

    const after = readProjectMemory(fx)
    expect(after.facts).toHaveLength(191)
    expect(checkSoftLimits(after).exceeded).toBe(true)
    expect(readLocalState(fx.localDir).compactionFlags).toEqual(['project'])
  })
})

describe('runConsolidation — dry run', () => {
  it('returns the parsed patch and leaves every memory file byte-identical', () => {
    const fx = setup()
    const before = snapshotMemory(fx)
    const llm = llmSpy()

    const result = runConsolidation({ ...baseOptions(fx), dryRun: true, runLlm: llm.fn })

    expect(llm.calls).toHaveLength(1)
    expect(result.ran).toBe(true)
    expect(result.patch).toEqual(PATCH)
    expect(result.applied).toBeUndefined()
    expect(snapshotMemory(fx)).toEqual(before)
    expect(readLocalState(fx.localDir).lastConsolidationAt).toBeUndefined()
    expect(fs.existsSync(lockFile(fx))).toBe(false)
  })
})
