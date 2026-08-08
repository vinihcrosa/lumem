import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { afterEach, describe, expect, it } from 'vitest'
import type { Signal } from '../core/capture/journal'
import { defaultConfig, writeConfig } from '../core/config'
import { acquireLock } from '../core/consolidate/lock'
import type { RunLlm } from '../core/consolidate/run'
import { readLocalState } from '../core/memory/limits'
import { memoryLayout } from '../core/memory/store'
import type { CliContext } from './context'
import {
  type MemoryConsolidateReport,
  registerMemoryConsolidateCommand,
  renderMemoryConsolidate,
  runMemoryConsolidate,
} from './memory-consolidate'

const HARNESS_ID = 'test-harness'
/** Sorts before {@link HARNESS_ID} and is never detected: proves the selection. */
const UNDETECTED_ID = 'aaa-harness'

const BASE_MS = Date.parse('2026-08-07T14:00:00.000Z')

const NEW_BODY = '`npm run test:e2e` needs `docker compose up -d` first.'
const SEED_BODY = 'Auth is undecided: JWT and session cookies are both on the table.'

const PATCH = {
  version: 1,
  add: [{ type: 'project', scope: 'project', body: NEW_BODY, conf: 'high' }],
  replace: [],
  remove: [],
}
const PATCH_JSON = JSON.stringify(PATCH)

const createdRoots: string[] = []

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

interface Fixture {
  root: string
  projectDir: string
  homeDir: string
  lumemDir: string
  localDir: string
  sessionsDir: string
  ctx: CliContext
}

function at(minutes: number): string {
  return new Date(BASE_MS + minutes * 60_000).toISOString()
}

/** Six work signals over 12 minutes: comfortably past the default gate. */
function journalSignals(sessionId: string): Signal[] {
  return [
    { t: 'session', ts: at(0), ev: 'start', harness: HARNESS_ID, sessionId, cwd: '/repo' },
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
    { t: 'session', ts: at(12), ev: 'end', harness: HARNESS_ID, sessionId, cwd: '/repo' },
  ]
}

interface Headless {
  command: string[]
  promptVia: 'stdin'
  modelFlag?: string
  defaultModel?: string
}

/**
 * A headless "model" that is just node printing a fixed patch: hermetic, offline
 * and dependency-free. Used only where the CLI owns the invocation and no
 * `runLlm` can be injected.
 */
const NODE_HEADLESS: Headless = {
  command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(PATCH_JSON)})`],
  promptVia: 'stdin',
}

function descriptor(id: string, detectDir: string, headless?: Headless): string {
  return JSON.stringify({
    id,
    minVersion: '1.0.0',
    detect: [{ type: 'dir', path: detectDir }],
    paths: {
      home: `~/.${id}`,
      skills: { project: `.${id}/skills`, global: `~/.${id}/skills` },
      hooksConfig: [
        { scope: 'project', path: `.${id}/hooks.json`, format: 'json', strategy: 'own-file' },
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
    headless: headless ?? {
      command: [`${id}-cli`, '--headless'],
      promptVia: 'stdin',
      modelFlag: '--model',
      defaultModel: 'tiny',
    },
  })
}

/** A complete, gate-passing project: config, adapters, journal, seeded memory. */
function setup(
  options: { journal?: boolean; harnesses?: string[]; headless?: Headless } = {},
): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-consolidate-'))
  createdRoots.push(root)

  const projectDir = path.join(root, 'repo')
  const homeDir = path.join(root, 'home')
  const adaptersDir = path.join(root, 'adapters')
  const lumemDir = path.join(projectDir, '.lumem')
  const fx: Fixture = {
    root,
    projectDir,
    homeDir,
    lumemDir,
    localDir: path.join(lumemDir, 'local'),
    sessionsDir: path.join(lumemDir, 'local', 'sessions'),
    ctx: {
      projectDir,
      adaptersDir,
      env: { HOME: homeDir, PATH: '' },
      json: false,
    },
  }

  fs.mkdirSync(fx.sessionsDir, { recursive: true })
  // Only `test-harness` has its detect directory on disk.
  fs.mkdirSync(path.join(homeDir, `.${HARNESS_ID}`), { recursive: true })
  fs.mkdirSync(adaptersDir, { recursive: true })
  fs.writeFileSync(
    path.join(adaptersDir, `${HARNESS_ID}.json`),
    descriptor(HARNESS_ID, '~/.test-harness', options.headless),
  )
  fs.writeFileSync(
    path.join(adaptersDir, `${UNDETECTED_ID}.json`),
    descriptor(UNDETECTED_ID, '~/.aaa-harness'),
  )

  const ids = options.harnesses ?? [HARNESS_ID]
  writeConfig(lumemDir, defaultConfig(ids.map((id) => ({ id, minVersion: '1.0.0' }))))

  const projectMemory = path.join(lumemDir, 'memory', 'project.md')
  fs.mkdirSync(path.dirname(projectMemory), { recursive: true })
  fs.writeFileSync(projectMemory, `- [2026-06-02] ${SEED_BODY}\n  <!-- src:sess_old conf:low -->\n`)

  if (options.journal !== false) writeJournal(fx, 'a1b2c3')
  return fx
}

function writeJournal(fx: Fixture, sessionId: string, mtimeSec?: number): string {
  const file = path.join(fx.sessionsDir, `${sessionId}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `${journalSignals(sessionId)
      .map((signal) => JSON.stringify(signal))
      .join('\n')}\n`,
  )
  if (mtimeSec !== undefined) fs.utimesSync(file, mtimeSec, mtimeSec)
  return file
}

interface LlmCall {
  cmd: string[]
  prompt: string
}

/** Injected LLM double: records every call, never spawns anything. */
function llmSpy(reply?: () => { ok: boolean; stdout: string; stderr: string }): {
  calls: LlmCall[]
  fn: RunLlm
} {
  const calls: LlmCall[] = []
  return {
    calls,
    fn: (cmd, prompt) => {
      calls.push({ cmd, prompt })
      return reply?.() ?? { ok: true, stdout: PATCH_JSON, stderr: '' }
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

describe('runMemoryConsolidate — session selection', () => {
  it('consolidates the most recently modified journal when --session is absent', () => {
    const fx = setup({ journal: false })
    writeJournal(fx, 'older', 1_000_000)
    const newest = writeJournal(fx, 'newer', 2_000_000)
    const llm = llmSpy()

    const { report, exitCode } = runMemoryConsolidate(fx.ctx, { runLlm: llm.fn })

    expect(exitCode).toBe(0)
    expect(report.sessionFile).toBe(newest)
    expect(report.ran).toBe(true)
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]?.prompt).toContain('"sessionId":"newer"')
  })

  it('honours an explicit --session', () => {
    const fx = setup({ journal: false })
    const older = writeJournal(fx, 'older', 1_000_000)
    writeJournal(fx, 'newer', 2_000_000)
    const llm = llmSpy()

    const { report } = runMemoryConsolidate(fx.ctx, { sessionFile: older, runLlm: llm.fn })

    expect(report.sessionFile).toBe(older)
    expect(llm.calls[0]?.prompt).toContain('"sessionId":"older"')
  })

  it('ignores non-journal files in the sessions directory', () => {
    const fx = setup({ journal: false })
    const journal = writeJournal(fx, 'a1b2c3', 1_000_000)
    const decoy = path.join(fx.sessionsDir, 'notes.txt')
    fs.writeFileSync(decoy, 'not a journal')
    fs.utimesSync(decoy, 9_000_000, 9_000_000)

    const { report } = runMemoryConsolidate(fx.ctx, { runLlm: llmSpy().fn })

    expect(report.sessionFile).toBe(journal)
  })

  it('reports nothing to consolidate — exit 0, no LLM — when no journal exists', () => {
    const fx = setup({ journal: false })
    const llm = llmSpy()

    const { report, exitCode } = runMemoryConsolidate(fx.ctx, { runLlm: llm.fn })

    expect(exitCode).toBe(0)
    expect(report.ran).toBe(false)
    expect(report.sessionFile).toBeUndefined()
    expect(report.error).toBeUndefined()
    expect(llm.calls).toEqual([])
    expect(renderMemoryConsolidate(report)).toContain('nothing to consolidate')
  })

  it('reports nothing to consolidate when the sessions directory was never created', () => {
    const fx = setup({ journal: false })
    fs.rmSync(fx.sessionsDir, { recursive: true, force: true })

    const { report, exitCode } = runMemoryConsolidate(fx.ctx, { runLlm: llmSpy().fn })

    expect(exitCode).toBe(0)
    expect(report.sessionFile).toBeUndefined()
  })
})

describe('runMemoryConsolidate — harness selection', () => {
  it('defaults to the first configured-and-detected harness', () => {
    const fx = setup()
    const llm = llmSpy()

    const { exitCode } = runMemoryConsolidate(fx.ctx, { runLlm: llm.fn })

    expect(exitCode).toBe(0)
    expect(llm.calls[0]?.cmd).toEqual(['test-harness-cli', '--headless', '--model', 'tiny'])
  })

  it('accepts an explicit --harness, detected or not', () => {
    const fx = setup()
    const llm = llmSpy()

    const { exitCode } = runMemoryConsolidate(fx.ctx, { harness: UNDETECTED_ID, runLlm: llm.fn })

    expect(exitCode).toBe(0)
    expect(llm.calls[0]?.cmd).toEqual(['aaa-harness-cli', '--headless', '--model', 'tiny'])
  })

  it('exits 1 when no harness is configured and detected', () => {
    const fx = setup({ harnesses: [] })
    const llm = llmSpy()

    const { report, exitCode } = runMemoryConsolidate(fx.ctx, { runLlm: llm.fn })

    expect(exitCode).toBe(1)
    expect(report.error).toContain('--harness')
    expect(llm.calls).toEqual([])
  })
})

describe('runMemoryConsolidate — the gate', () => {
  it('exits 0 and lists the reasons when the gate refuses the session', () => {
    const fx = setup({ journal: false })
    const file = path.join(fx.sessionsDir, 'thin.jsonl')
    fs.writeFileSync(
      file,
      `${JSON.stringify({ t: 'file', ts: at(0), path: 'a.ts', tool: 'Edit' })}\n`,
    )
    const llm = llmSpy()

    const { report, exitCode } = runMemoryConsolidate(fx.ctx, { runLlm: llm.fn })

    expect(exitCode).toBe(0)
    expect(report.ran).toBe(false)
    expect(report.error).toBeUndefined()
    expect(report.gateReasons.some((reason) => reason.startsWith('signals:'))).toBe(true)
    expect(llm.calls).toEqual([])

    const rendered = renderMemoryConsolidate(report)
    expect(rendered).toContain('signals:')
    expect(rendered).not.toContain('error')
  })

  it('--force waives the thresholds and consolidates anyway', () => {
    const fx = setup({ journal: false })
    const file = path.join(fx.sessionsDir, 'thin.jsonl')
    fs.writeFileSync(
      file,
      `${JSON.stringify({ t: 'file', ts: at(0), path: 'a.ts', tool: 'Edit' })}\n`,
    )
    const llm = llmSpy()

    const { report, exitCode } = runMemoryConsolidate(fx.ctx, { force: true, runLlm: llm.fn })

    expect(exitCode).toBe(0)
    expect(report.ran).toBe(true)
    expect(llm.calls).toHaveLength(1)
    expect(report.applied?.filesWritten).toEqual([path.join(fx.lumemDir, 'memory', 'project.md')])
  })

  it('--force still honours the lock', () => {
    const fx = setup()
    expect(acquireLock(fx.localDir)).not.toBeNull()
    const llm = llmSpy()

    const { report, exitCode } = runMemoryConsolidate(fx.ctx, { force: true, runLlm: llm.fn })

    expect(exitCode).toBe(0)
    expect(report.ran).toBe(false)
    expect(report.gateReasons.some((reason) => reason.startsWith('lock:'))).toBe(true)
    expect(llm.calls).toEqual([])
  })
})

describe('runMemoryConsolidate — applying and dry running', () => {
  it('applies the patch and stamps the local state', () => {
    const fx = setup()
    const llm = llmSpy()

    const { report, exitCode } = runMemoryConsolidate(fx.ctx, { runLlm: llm.fn })

    expect(exitCode).toBe(0)
    expect(report.ran).toBe(true)
    expect(report.applied?.applied).toHaveLength(1)
    const projectMemory = fs.readFileSync(path.join(fx.lumemDir, 'memory', 'project.md'), 'utf8')
    expect(projectMemory).toContain(NEW_BODY)
    expect(projectMemory).toContain(SEED_BODY)
    expect(readLocalState(fx.localDir).lastConsolidationAt).toBeDefined()
  })

  it('--dry-run runs the LLM, returns the patch and leaves memory byte-identical', () => {
    const fx = setup()
    const before = snapshotMemory(fx)
    const llm = llmSpy()

    const { report, exitCode } = runMemoryConsolidate(fx.ctx, { dryRun: true, runLlm: llm.fn })

    expect(exitCode).toBe(0)
    expect(report.ran).toBe(true)
    expect(report.patch).toEqual(PATCH)
    expect(report.applied).toBeUndefined()
    expect(llm.calls).toHaveLength(1)
    expect(snapshotMemory(fx)).toEqual(before)
    expect(readLocalState(fx.localDir).lastConsolidationAt).toBeUndefined()

    const rendered = renderMemoryConsolidate(report)
    expect(rendered).toContain('the LLM DID run')
    expect(rendered).toContain(NEW_BODY)
  })

  it('exits 1 when the runner reports an error', () => {
    const fx = setup()
    const before = snapshotMemory(fx)
    const llm = llmSpy(() => ({ ok: false, stdout: '', stderr: 'command not found: test-llm' }))

    const { report, exitCode } = runMemoryConsolidate(fx.ctx, { runLlm: llm.fn })

    expect(exitCode).toBe(1)
    expect(report.ran).toBe(false)
    expect(report.error).toContain('command not found')
    expect(snapshotMemory(fx)).toEqual(before)
    expect(renderMemoryConsolidate(report)).toContain('error:')
  })

  it('exits 1 when the model output does not parse', () => {
    const fx = setup()
    const llm = llmSpy(() => ({ ok: true, stdout: 'sure thing, boss', stderr: '' }))

    const { report, exitCode } = runMemoryConsolidate(fx.ctx, { runLlm: llm.fn })

    expect(exitCode).toBe(1)
    expect(report.error).toContain('invalid JSON')
  })
})

describe('runMemoryConsolidate — an uninitialized project', () => {
  it('exits 1 pointing at `lumem init` when .lumem is missing', () => {
    const fx = setup()
    fs.rmSync(fx.lumemDir, { recursive: true, force: true })
    const llm = llmSpy()

    const { report, exitCode } = runMemoryConsolidate(fx.ctx, { runLlm: llm.fn })

    expect(exitCode).toBe(1)
    expect(report.error).toContain('lumem init')
    expect(llm.calls).toEqual([])
    expect(renderMemoryConsolidate(report)).toContain('lumem init')
  })

  it('exits 1 when .lumem is a file rather than a directory', () => {
    const fx = setup()
    fs.rmSync(fx.lumemDir, { recursive: true, force: true })
    fs.writeFileSync(fx.lumemDir, 'i am a file')

    const { exitCode } = runMemoryConsolidate(fx.ctx, { runLlm: llmSpy().fn })

    expect(exitCode).toBe(1)
  })
})

describe('renderMemoryConsolidate', () => {
  it('names the journal it worked on and summarizes what was written', () => {
    const fx = setup()
    const { report } = runMemoryConsolidate(fx.ctx, { runLlm: llmSpy().fn })

    const rendered = renderMemoryConsolidate(report)
    expect(rendered).toContain(report.sessionFile ?? '')
    expect(rendered).toContain('applied 1')
    expect(rendered).toContain(path.join(fx.lumemDir, 'memory', 'project.md'))
  })

  it('never renders an empty string', () => {
    const reports: MemoryConsolidateReport[] = [
      { ran: false, gateReasons: [] },
      { ran: false, gateReasons: ['signals: 1 captured, need 5'], sessionFile: '/a.jsonl' },
      { ran: false, gateReasons: [], error: 'boom', sessionFile: '/a.jsonl' },
      { ran: true, gateReasons: [], sessionFile: '/a.jsonl' },
    ]
    for (const report of reports) {
      expect(renderMemoryConsolidate(report).length).toBeGreaterThan(0)
    }
  })
})

describe('registerMemoryConsolidateCommand', () => {
  function parse(argv: string[], ctx: CliContext): MemoryConsolidateReport {
    const program = new Command()
    program.exitOverride()
    const memory = program.command('memory')
    let captured: MemoryConsolidateReport | undefined
    registerMemoryConsolidateCommand(
      memory,
      () => ctx,
      (_json, report) => {
        captured = report as MemoryConsolidateReport
      },
    )

    const previousExitCode = process.exitCode
    program.parse(['node', 'lumem', ...argv])
    process.exitCode = previousExitCode
    if (captured === undefined) throw new Error('emit was never called')
    return captured
  }

  it('registers `consolidate` with --force, --dry-run, --harness and --session', () => {
    const fx = setup()
    const program = new Command()
    const memory = program.command('memory')
    registerMemoryConsolidateCommand(
      memory,
      () => fx.ctx,
      () => undefined,
    )

    const command = memory.commands.find((entry) => entry.name() === 'consolidate')
    expect(command).toBeDefined()
    const flags = (command?.options ?? []).map((option) => option.long)
    expect(flags).toEqual(['--force', '--dry-run', '--harness', '--session'])
  })

  it('wires --dry-run and --session through, end to end', () => {
    // No runLlm seam on this path, so the "model" is node printing the patch.
    const fx = setup({ journal: false, headless: NODE_HEADLESS })
    const wanted = writeJournal(fx, 'older', 1_000_000)
    writeJournal(fx, 'newer', 2_000_000)
    const before = snapshotMemory(fx)

    const report = parse(['memory', 'consolidate', '--dry-run', '--session', wanted], fx.ctx)

    expect(report.error).toBeUndefined()
    expect(report.sessionFile).toBe(wanted)
    expect(report.ran).toBe(true)
    expect(report.patch).toEqual(PATCH)
    expect(report.applied).toBeUndefined()
    expect(snapshotMemory(fx)).toEqual(before)
  })
})
