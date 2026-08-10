import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Signal, readSignals, sessionFileName } from '../core/capture/journal'
import {
  type HandlerDeps,
  type SpawnFn,
  createHandlers,
  handlers,
  resolveSessionId,
} from './handlers'
import { type HookHandlers, type HookInput, type LumemEvent, runHook } from './runtime'

const TS = '2026-08-07T12:00:00.000Z'
const SESSION_ID = 'sess_a1b2'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-handlers-'))
}

// ASCII-only bodies keep the byte budget arithmetic below exact.
const PROJECT_BODY = 'use pnpm not npm'
const CORRECTION_BODY = 'never commit to main'
const PREFERENCE_BODY = 'short answers please'

function writeMemory(base: string, name: string, content: string): void {
  const file = path.join(base, '.lumem', 'memory', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function writeConfig(projectDir: string, content: string): void {
  const file = path.join(projectDir, '.lumem', 'lumem.config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/** A project with `.lumem` present but empty — the minimum for capture to write. */
function project(): string {
  const dir = tmpDir()
  fs.mkdirSync(path.join(dir, '.lumem'), { recursive: true })
  return dir
}

/** Project + home populated with one fact per memory file. */
function populated(): { projectDir: string; home: string } {
  const projectDir = project()
  const home = tmpDir()
  writeMemory(
    projectDir,
    'project.md',
    `- [2026-08-07] ${PROJECT_BODY}\n  <!-- src:s1 conf:high -->\n`,
  )
  writeMemory(
    projectDir,
    'correction.md',
    `- [2026-08-06] ${CORRECTION_BODY}\n  <!-- src:s2 conf:high -->\n`,
  )
  writeMemory(
    home,
    'preference.md',
    `- [2026-08-04] ${PREFERENCE_BODY}\n  <!-- src:manual conf:medium -->\n`,
  )
  return { projectDir, home }
}

/** Default spawn double: no test in this file may ever launch a real process. */
const noSpawn: SpawnFn = () => ({ unref: () => undefined })

// NEVER the real home, the real env or the real spawn: all three are injected.
function make(overrides?: Partial<HandlerDeps> & { home?: string }): HookHandlers {
  return createHandlers({
    env: overrides?.env ?? { HOME: overrides?.home ?? tmpDir() },
    now: overrides?.now ?? (() => new Date(TS)),
    spawn: overrides?.spawn ?? noSpawn,
  })
}

function input(event: LumemEvent, payload: Record<string, unknown>): HookInput {
  return { harnessId: 'claude-code', event, payload }
}

/** Fire an event; only `inject` produces text. */
function fire(h: HookHandlers, event: LumemEvent, payload: Record<string, unknown>): string {
  const out = h[event]?.(input(event, payload))
  return typeof out === 'string' ? out : ''
}

function journalFile(projectDir: string, sessionId = SESSION_ID): string {
  return path.join(projectDir, '.lumem', 'local', 'sessions', sessionFileName(sessionId))
}

function signals(projectDir: string, sessionId = SESSION_ID): Signal[] {
  return readSignals(journalFile(projectDir, sessionId)).signals
}

/** Every file under `dir`, relative — used to prove a discarded event wrote nothing. */
function tree(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel)
      else out.push(rel)
    }
  }
  walk(dir, '')
  return out.sort()
}

/** Where `lumem install` drops the runner bundle the SessionEnd hook spawns. */
function runnerPath(projectDir: string): string {
  return path.join(projectDir, '.lumem', 'bin', 'lumem-runner.mjs')
}

function writeRunner(projectDir: string): string {
  const file = runnerPath(projectDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '// stand-in for dist/lumem-runner.mjs\n')
  return file
}

/**
 * Five work signals spread from 10 to 6 minutes before {@link TS}: past the
 * default gate (≥5 signals, ≥3 min) once the handler appends its own end signal.
 */
function seedGatePassingJournal(projectDir: string): void {
  const file = journalFile(projectDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({
      t: 'file',
      ts: new Date(Date.parse(TS) - (10 - i) * 60_000).toISOString(),
      path: `src/f${i}.ts`,
      tool: 'Edit',
    }),
  )
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
}

interface SpawnCall {
  command: string
  args: string[]
  options: { detached: boolean; stdio: 'ignore' }
}

/** Records every launch and hands back a child that only knows how to `unref`. */
function spawnSpy(onSpawn?: () => void): {
  calls: SpawnCall[]
  unrefs: () => number
  fn: SpawnFn
} {
  const calls: SpawnCall[] = []
  let unrefs = 0
  const fn: SpawnFn = (command, args, options) => {
    calls.push({ command, args: [...args], options })
    onSpawn?.()
    return {
      unref: () => {
        unrefs += 1
      },
    }
  }
  return { calls, unrefs: () => unrefs, fn }
}

describe('createHandlers', () => {
  it('registers a handler for every lumem event', () => {
    const h = make()
    expect(Object.keys(h).sort()).toEqual([
      'capture-prompt',
      'capture-tool',
      'capture-tool-failure',
      'end',
      'inject',
    ])
  })

  it('exports a ready-made table bound to the real process env', () => {
    expect(Object.keys(handlers).sort()).toEqual([
      'capture-prompt',
      'capture-tool',
      'capture-tool-failure',
      'end',
      'inject',
    ])
  })
})

describe('resolveSessionId', () => {
  it('reads session_id, then sessionId, then falls back to unknown', () => {
    expect(resolveSessionId({ session_id: 'a', sessionId: 'b' })).toBe('a')
    expect(resolveSessionId({ sessionId: 'b' })).toBe('b')
    expect(resolveSessionId({})).toBe('unknown')
    expect(resolveSessionId({ session_id: 42, sessionId: null })).toBe('unknown')
  })
})

describe('inject', () => {
  it('returns the memory block built from the project and the global scope', () => {
    const { projectDir, home } = populated()
    const text = fire(make({ home }), 'inject', { cwd: projectDir, session_id: SESSION_ID })

    expect(text).toContain('# lumem memory')
    expect(text).toContain(`- [2026-08-06] ${CORRECTION_BODY}`)
    expect(text).toContain(`- [2026-08-07] ${PROJECT_BODY}`)
    expect(text).toContain(`- [2026-08-04] ${PREFERENCE_BODY}`)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(4096)
  })

  it('respects budgets.injectionBytes from lumem.config.json', () => {
    const { projectDir, home } = populated()
    // 15 (doc header) + 15 ('## corrections') + 36 (correction bullet) = 66 bytes;
    // the next section would need 43 more, so it must be dropped.
    writeConfig(projectDir, JSON.stringify({ budgets: { injectionBytes: 100 } }))
    const text = fire(make({ home }), 'inject', { cwd: projectDir })

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(100)
    expect(text).toContain(CORRECTION_BODY)
    expect(text).not.toContain(PROJECT_BODY)
    expect(text).not.toContain(PREFERENCE_BODY)
  })

  it('falls back to 4096 bytes when the config is absent, broken or implausible', () => {
    const { projectDir, home } = populated()
    const full = fire(make({ home }), 'inject', { cwd: projectDir })

    for (const raw of ['{ not json', '[]', '{"budgets":{"injectionBytes":0}}', '{"budgets":"x"}']) {
      writeConfig(projectDir, raw)
      expect(fire(make({ home }), 'inject', { cwd: projectDir })).toBe(full)
    }
  })

  it('appends a session start signal when a session id is present', () => {
    const { projectDir, home } = populated()
    fire(make({ home }), 'inject', { cwd: projectDir, session_id: SESSION_ID })

    expect(signals(projectDir)).toEqual([
      {
        t: 'session',
        ts: TS,
        ev: 'start',
        harness: 'claude-code',
        sessionId: SESSION_ID,
        cwd: projectDir,
      },
    ])
  })

  it('writes no session signal when the payload carries no session id', () => {
    const { projectDir, home } = populated()
    fire(make({ home }), 'inject', { cwd: projectDir })

    expect(fs.existsSync(path.join(projectDir, '.lumem', 'local'))).toBe(false)
  })

  it('returns an empty string and writes nothing when the project has no .lumem', () => {
    const projectDir = tmpDir()
    const text = fire(make(), 'inject', { cwd: projectDir, session_id: SESSION_ID })

    expect(text).toBe('')
    expect(tree(projectDir)).toEqual([])
  })

  it('returns an empty string when there is no project dir at all', () => {
    expect(fire(make(), 'inject', {})).toBe('')
  })

  it('prefers CLAUDE_PROJECT_DIR over the payload cwd', () => {
    const { projectDir, home } = populated()
    const decoy = project()
    const h = make({ env: { HOME: home, CLAUDE_PROJECT_DIR: projectDir } })

    const text = fire(h, 'inject', { cwd: decoy, session_id: SESSION_ID })
    expect(text).toContain(PROJECT_BODY)
    expect(signals(projectDir)).toHaveLength(1)
    expect(tree(decoy)).toEqual([])
  })

  it('returns an empty string when .lumem exists but holds no fact', () => {
    expect(fire(make(), 'inject', { cwd: project() })).toBe('')
  })

  it('never throws on a malformed memory file', () => {
    const projectDir = project()
    writeMemory(projectDir, 'project.md', 'lixo solto\n- [ontem] data quebrada\n')
    expect(fire(make(), 'inject', { cwd: projectDir })).toBe('')
  })
})

describe('capture-prompt', () => {
  it('appends exactly one correction signal, with the prompt redacted', () => {
    const projectDir = project()
    const token = `ghp_${'a'.repeat(36)}`
    fire(make(), 'capture-prompt', {
      cwd: projectDir,
      session_id: SESSION_ID,
      prompt: `na verdade use o token ${token}`,
    })

    const written = signals(projectDir)
    expect(written).toHaveLength(1)
    expect(written[0]).toEqual({
      t: 'correction',
      ts: TS,
      marker: 'na verdade',
      prompt: 'na verdade use o token [REDACTED:github-token]',
    })
  })

  it('appends nothing when the prompt trips no marker', () => {
    const projectDir = project()
    fire(make(), 'capture-prompt', {
      cwd: projectDir,
      session_id: SESSION_ID,
      prompt: 'adicione um teste para o parser',
    })

    expect(signals(projectDir)).toEqual([])
    expect(tree(projectDir)).toEqual([])
  })

  it('accepts both prompt field names', () => {
    for (const field of ['prompt', 'user_prompt']) {
      const projectDir = project()
      fire(make(), 'capture-prompt', {
        cwd: projectDir,
        session_id: SESSION_ID,
        [field]: 'na verdade prefiro vitest',
      })

      const written = signals(projectDir)
      expect(written).toHaveLength(1)
      expect(written[0]).toMatchObject({ t: 'correction', marker: 'na verdade' })
    }
  })

  it('never writes durable memory', () => {
    const projectDir = project()
    fire(make(), 'capture-prompt', {
      cwd: projectDir,
      session_id: SESSION_ID,
      prompt: 'na verdade prefiro vitest',
    })

    expect(fs.existsSync(path.join(projectDir, '.lumem', 'memory'))).toBe(false)
  })
})

describe('capture-tool', () => {
  it('appends a file signal for an Edit payload', () => {
    const projectDir = project()
    fire(make(), 'capture-tool', {
      cwd: projectDir,
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' },
    })

    expect(signals(projectDir)).toEqual([{ t: 'file', ts: TS, path: 'src/index.ts', tool: 'Edit' }])
  })

  it('appends a file signal for any tool whose input carries a file_path', () => {
    const projectDir = project()
    fire(make(), 'capture-tool', {
      cwd: projectDir,
      session_id: SESSION_ID,
      tool_name: 'CustomWriter',
      tool_input: { file_path: 'docs/readme.md' },
    })

    expect(signals(projectDir)).toEqual([
      { t: 'file', ts: TS, path: 'docs/readme.md', tool: 'CustomWriter' },
    ])
  })

  it('appends a cmd signal with the exit code from every accepted response shape', () => {
    const shapes: { payload: Record<string, unknown>; exit: number }[] = [
      { payload: { tool_response: { exit_code: 2 } }, exit: 2 },
      { payload: { tool_result: { exitCode: 3 } }, exit: 3 },
      { payload: { tool_response: { exitCode: 4 } }, exit: 4 },
      { payload: { tool_result: { exit_code: 5 } }, exit: 5 },
      { payload: {}, exit: 0 },
      { payload: { tool_response: 'saída em texto' }, exit: 0 },
    ]

    for (const shape of shapes) {
      const projectDir = project()
      fire(make(), 'capture-tool', {
        cwd: projectDir,
        session_id: SESSION_ID,
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        ...shape.payload,
      })

      expect(signals(projectDir)).toEqual([{ t: 'cmd', ts: TS, cmd: 'npm test', exit: shape.exit }])
    }
  })

  it('redacts secrets out of the captured command', () => {
    const projectDir = project()
    fire(make(), 'capture-tool', {
      cwd: projectDir,
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: `curl -H "token: ghp_${'b'.repeat(36)}" https://api.example.com` },
    })

    const written = signals(projectDir)
    expect(written).toHaveLength(1)
    const cmd = written[0] as Extract<Signal, { t: 'cmd' }>
    expect(cmd.cmd).toContain('[REDACTED:')
    expect(cmd.cmd).not.toContain('ghp_b')
  })

  it('emits a recovery signal, ahead of the passing cmd, for failed-then-passed', () => {
    const projectDir = project()
    const h = make()
    const base = { cwd: projectDir, session_id: SESSION_ID, tool_name: 'Bash' }

    fire(h, 'capture-tool', {
      ...base,
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 1 },
    })
    fire(h, 'capture-tool', {
      ...base,
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0 },
    })

    expect(signals(projectDir)).toEqual([
      { t: 'cmd', ts: TS, cmd: 'npm test', exit: 1 },
      { t: 'recovery', ts: TS, failed: 'npm test', passed: 'npm test' },
      { t: 'cmd', ts: TS, cmd: 'npm test', exit: 0 },
    ])
  })

  it('emits no recovery signal when the command simply passes', () => {
    const projectDir = project()
    const h = make()
    const base = { cwd: projectDir, session_id: SESSION_ID, tool_name: 'Bash' }

    fire(h, 'capture-tool', { ...base, tool_input: { command: 'npm test' } })
    fire(h, 'capture-tool', { ...base, tool_input: { command: 'npm test' } })

    expect(signals(projectDir).map((s) => s.t)).toEqual(['cmd', 'cmd'])
  })

  it('appends nothing for a tool that touches neither a file nor the shell', () => {
    const projectDir = project()
    fire(make(), 'capture-tool', {
      cwd: projectDir,
      session_id: SESSION_ID,
      tool_name: 'WebSearch',
      tool_input: { query: 'vitest matchers' },
    })

    expect(tree(projectDir)).toEqual([])
  })
})

describe('capture-tool-failure', () => {
  /** Seed one `cmd` signal, so the recovery lookback has a tail to scan. */
  function seedCmd(projectDir: string, cmd: string, exit: number): void {
    const file = journalFile(projectDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify({ t: 'cmd', ts: TS, cmd, exit })}\n`)
  }

  // THE regression test. In production `PostToolUseFailure` carries no exit code
  // at all — its documented payload is `error: { type, message }` — so a handler
  // that defaults to 0 records every failure as a success, which is exactly how
  // 161 consecutive `exit=0` signals reached a real journal and left `recovery`
  // structurally dead. The event firing IS the failure; the code must be non-zero.
  it('records a non-zero exit for a failed command whose payload carries no exit code', () => {
    const projectDir = project()
    fire(make(), 'capture-tool-failure', {
      cwd: projectDir,
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: { type: 'timeout', message: 'Command timed out after 120 seconds' },
    })

    const written = signals(projectDir)
    expect(written).toHaveLength(1)
    const cmd = written[0] as Extract<Signal, { t: 'cmd' }>
    expect(cmd.exit).not.toBe(0)
    expect(written).toEqual([{ t: 'cmd', ts: TS, cmd: 'npm test', exit: 1 }])
  })

  it('prefers an explicit exit code from every accepted response shape over the default', () => {
    const shapes: { payload: Record<string, unknown>; exit: number }[] = [
      { payload: { tool_response: { exit_code: 2 } }, exit: 2 },
      { payload: { tool_result: { exitCode: 3 } }, exit: 3 },
      { payload: { tool_response: { exitCode: 4 } }, exit: 4 },
      { payload: { tool_result: { exit_code: 5 } }, exit: 5 },
      // no code anywhere, or one lumem cannot read: the event itself is the signal
      { payload: {}, exit: 1 },
      { payload: { tool_response: 'saída em texto' }, exit: 1 },
    ]

    for (const shape of shapes) {
      const projectDir = project()
      fire(make(), 'capture-tool-failure', {
        cwd: projectDir,
        session_id: SESSION_ID,
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        ...shape.payload,
      })

      expect(signals(projectDir)).toEqual([{ t: 'cmd', ts: TS, cmd: 'npm test', exit: shape.exit }])
    }
  })

  it('never emits a recovery signal, even when the tail holds a matching failure', () => {
    const projectDir = project()
    seedCmd(projectDir, 'npm test', 1)

    fire(make(), 'capture-tool-failure', {
      cwd: projectDir,
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    })

    // a failure can never be a recovery, whatever came before it
    expect(signals(projectDir).map((s) => s.t)).toEqual(['cmd', 'cmd'])
    expect(signals(projectDir)).toEqual([
      { t: 'cmd', ts: TS, cmd: 'npm test', exit: 1 },
      { t: 'cmd', ts: TS, cmd: 'npm test', exit: 1 },
    ])
  })

  // The sequence production could never produce: the failure only reaches the
  // journal through `PostToolUseFailure`, and the later success then finds it.
  it('lets a later success recover from a failure captured on the failure event', () => {
    const projectDir = project()
    const h = make()
    const base = { cwd: projectDir, session_id: SESSION_ID, tool_name: 'Bash' }

    fire(h, 'capture-tool-failure', { ...base, tool_input: { command: 'npm run check' } })
    fire(h, 'capture-tool', { ...base, tool_input: { command: 'npm run check' } })

    const written = signals(projectDir)
    expect(written.map((s) => s.t)).toEqual(['cmd', 'recovery', 'cmd'])
    const recovery = written[1] as Extract<Signal, { t: 'recovery' }>
    expect(recovery.failed).toBe('npm run check')
    expect(recovery.passed).toBe('npm run check')
    expect(written).toEqual([
      { t: 'cmd', ts: TS, cmd: 'npm run check', exit: 1 },
      { t: 'recovery', ts: TS, failed: 'npm run check', passed: 'npm run check' },
      { t: 'cmd', ts: TS, cmd: 'npm run check', exit: 0 },
    ])
  })

  // DELIBERATE: a failed Edit still says the session was working on that file,
  // and the `file` signal carries no outcome that the failure would contradict.
  // Dropping it would blind consolidation to precisely the files that fought back.
  it('still records the file signal for a file-touching tool that failed', () => {
    const projectDir = project()
    fire(make(), 'capture-tool-failure', {
      cwd: projectDir,
      session_id: SESSION_ID,
      tool_name: 'Edit',
      tool_input: { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' },
      error: { type: 'string_not_found', message: 'old_string not found' },
    })

    expect(signals(projectDir)).toEqual([{ t: 'file', ts: TS, path: 'src/index.ts', tool: 'Edit' }])
  })

  it('redacts secrets out of the failed command', () => {
    const projectDir = project()
    fire(make(), 'capture-tool-failure', {
      cwd: projectDir,
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: `curl -H "token: ghp_${'c'.repeat(36)}" https://api.example.com` },
    })

    const written = signals(projectDir)
    expect(written).toHaveLength(1)
    const cmd = written[0] as Extract<Signal, { t: 'cmd' }>
    expect(cmd.cmd).toContain('[REDACTED:')
    expect(cmd.cmd).not.toContain('ghp_c')
  })

  it('appends nothing for a failed tool that touches neither a file nor the shell', () => {
    const projectDir = project()
    fire(make(), 'capture-tool-failure', {
      cwd: projectDir,
      session_id: SESSION_ID,
      tool_name: 'WebSearch',
      tool_input: { query: 'vitest matchers' },
      error: { type: 'network', message: 'offline' },
    })

    expect(tree(projectDir)).toEqual([])
  })
})

describe('end', () => {
  it('appends the session end signal', () => {
    const projectDir = project()
    fire(make(), 'end', { cwd: projectDir, session_id: SESSION_ID })

    expect(signals(projectDir)).toEqual([
      {
        t: 'session',
        ts: TS,
        ev: 'end',
        harness: 'claude-code',
        sessionId: SESSION_ID,
        cwd: projectDir,
      },
    ])
  })

  it('uses the unknown journal when no session id is sent', () => {
    const projectDir = project()
    fire(make(), 'end', { cwd: projectDir })

    expect(fs.existsSync(journalFile(projectDir, 'unknown'))).toBe(true)
    expect(signals(projectDir, 'unknown')).toHaveLength(1)
  })
})

describe('end → detached consolidation runner', () => {
  it('spawns the installed runner detached, unreferenced, with the full argv', () => {
    const projectDir = project()
    seedGatePassingJournal(projectDir)
    const runner = writeRunner(projectDir)
    const spy = spawnSpy()

    fire(make({ spawn: spy.fn }), 'end', { cwd: projectDir, session_id: SESSION_ID })

    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]).toEqual({
      command: process.execPath,
      args: [
        runner,
        '--project-dir',
        projectDir,
        '--session-file',
        journalFile(projectDir),
        '--harness',
        'claude-code',
      ],
      options: { detached: true, stdio: 'ignore' },
    })
    expect(spy.unrefs()).toBe(1)
  })

  it('spawns nothing when the gate refuses the session', () => {
    const projectDir = project()
    writeRunner(projectDir)
    const spy = spawnSpy()

    // No seeded journal: the lone end signal is below both thresholds.
    fire(make({ spawn: spy.fn }), 'end', { cwd: projectDir, session_id: SESSION_ID })

    expect(spy.calls).toEqual([])
    expect(signals(projectDir)).toHaveLength(1)
  })

  it('spawns nothing when the runner bundle is not installed', () => {
    const projectDir = project()
    seedGatePassingJournal(projectDir)
    const spy = spawnSpy()

    fire(make({ spawn: spy.fn }), 'end', { cwd: projectDir, session_id: SESSION_ID })

    expect(spy.calls).toEqual([])
    expect(fs.existsSync(runnerPath(projectDir))).toBe(false)
  })

  it('honours the gate thresholds configured in lumem.config.json', () => {
    const projectDir = project()
    seedGatePassingJournal(projectDir)
    writeRunner(projectDir)
    writeConfig(projectDir, JSON.stringify({ gate: { minSignals: 99 } }))
    const spy = spawnSpy()

    fire(make({ spawn: spy.fn }), 'end', { cwd: projectDir, session_id: SESSION_ID })

    expect(spy.calls).toEqual([])
  })

  it('spawns for a session the configured thresholds accept but the defaults reject', () => {
    const projectDir = project()
    writeRunner(projectDir)
    writeConfig(projectDir, JSON.stringify({ gate: { minSignals: 0, minDurationMin: 0 } }))
    const spy = spawnSpy()

    fire(make({ spawn: spy.fn }), 'end', { cwd: projectDir, session_id: SESSION_ID })

    expect(spy.calls).toHaveLength(1)
  })

  it('never throws when the launch itself fails', () => {
    const projectDir = project()
    seedGatePassingJournal(projectDir)
    writeRunner(projectDir)
    const exploding: SpawnFn = () => {
      throw new Error('EAGAIN')
    }

    expect(() =>
      fire(make({ spawn: exploding }), 'end', { cwd: projectDir, session_id: SESSION_ID }),
    ).not.toThrow()
  })

  it('returns inside the SessionEnd deadline, with the child still running', async () => {
    const projectDir = project()
    seedGatePassingJournal(projectDir)
    writeRunner(projectDir)
    let childRunning = false
    const spy = spawnSpy(() => {
      childRunning = true
    })
    const errors: unknown[] = []

    // The handler returns void, not a promise: there is nothing to await, so
    // the detached child cannot possibly have finished by the time we assert.
    const returned = make({ spawn: spy.fn }).end?.(
      input('end', { cwd: projectDir, session_id: SESSION_ID }),
    )
    expect(returned).toBeUndefined()
    expect(spy.calls).toHaveLength(1)
    expect(childRunning).toBe(true)

    const other = project()
    seedGatePassingJournal(other)
    writeRunner(other)
    const raced = await runHook(
      input('end', { cwd: other, session_id: SESSION_ID }),
      make({ spawn: spy.fn }),
      { deadlineMs: 50, onError: (err) => errors.push(err) },
    )
    expect(raced).toBe('')
    expect(errors).toEqual([])
    expect(spy.calls).toHaveLength(2)
  })
})

describe('wrong-project guard', () => {
  const events: { event: LumemEvent; payload: Record<string, unknown> }[] = [
    { event: 'inject', payload: {} },
    { event: 'capture-prompt', payload: { prompt: 'na verdade use vitest' } },
    {
      event: 'capture-tool',
      payload: { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } },
    },
    {
      event: 'capture-tool',
      payload: { tool_name: 'Bash', tool_input: { command: 'npm test' } },
    },
    {
      event: 'capture-tool-failure',
      payload: { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } },
    },
    {
      event: 'capture-tool-failure',
      payload: { tool_name: 'Bash', tool_input: { command: 'npm test' } },
    },
    { event: 'end', payload: {} },
  ]

  it('discards every event when the cwd has no .lumem directory', () => {
    for (const { event, payload } of events) {
      const projectDir = tmpDir()
      const text = fire(make(), event, { cwd: projectDir, session_id: SESSION_ID, ...payload })

      expect(text).toBe('')
      expect(tree(projectDir)).toEqual([])
    }
  })

  it('discards every event when .lumem is a file rather than a directory', () => {
    for (const { event, payload } of events) {
      const projectDir = tmpDir()
      fs.writeFileSync(path.join(projectDir, '.lumem'), 'i am a file')
      fire(make(), event, { cwd: projectDir, session_id: SESSION_ID, ...payload })

      expect(tree(projectDir)).toEqual(['.lumem'])
    }
  })

  it('discards every event when there is no project dir at all', () => {
    for (const { event, payload } of events) {
      expect(() => fire(make(), event, payload)).not.toThrow()
    }
  })
})

describe('malformed payloads', () => {
  const broken: Record<string, unknown>[] = [
    {},
    { cwd: 42 },
    { cwd: null, session_id: [] },
    { cwd: '', prompt: 7 },
    { prompt: null, user_prompt: {} },
    { tool_name: 5, tool_input: 'not an object' },
    { tool_name: 'Bash', tool_input: null },
    { tool_name: 'Bash', tool_input: { command: 12 } },
    { tool_name: 'Edit', tool_input: { file_path: false } },
    { tool_input: { command: 'npm test' }, tool_response: { exit_code: 'boom' } },
    { tool_input: { command: 'npm test' }, tool_result: [1, 2, 3] },
    { session_id: {}, sessionId: 0 },
  ]

  it('never throws, whatever the payload looks like', () => {
    const projectDir = project()
    for (const payload of broken) {
      for (const event of [
        'inject',
        'capture-prompt',
        'capture-tool',
        'capture-tool-failure',
        'end',
      ] as LumemEvent[]) {
        expect(() => fire(make(), event, payload)).not.toThrow()
        expect(() => fire(make(), event, { ...payload, cwd: projectDir })).not.toThrow()
      }
    }
  })

  it('never throws when the injected clock itself is broken', () => {
    const h = createHandlers({
      env: { HOME: tmpDir() },
      now: () => new Date(Number.NaN),
    })
    expect(() => fire(h, 'end', { cwd: project(), session_id: SESSION_ID })).not.toThrow()
  })
})
