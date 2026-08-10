// T44 — hook chaos suite: the NFR-1 proof.
//
// The claim under test is absolute: NO failure mode of the lumem hook can break
// the user's agent session. Unit tests cover the logic of each piece; this file
// covers the promise, and it can only do that by spawning the REAL bundle
// (`dist/lumem-hook.mjs`) as a real process, the way a harness invokes it.
//
// Every case asserts the same two things — exit code 0 and a silent stderr —
// under a filesystem, a stdin and an argv that have all been made hostile. A
// third assertion runs at the end over every invocation in the file: none of
// them may exceed the `inject` deadline in wall clock, because a hook that
// HANGS is the failure mode the user feels most.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const bundlePath = path.join(repoRoot, 'dist', 'lumem-hook.mjs')

/** A hung hook must fail the suite, not the run: well above any honest case. */
const SPAWN_TIMEOUT_MS = 20_000
/** `EVENT_DEADLINES_MS.inject` — the largest budget any event may spend. */
const LATENCY_CEILING_MS = 2_000

// Every event the hook actually answers. `capture-tool-failure` belongs here
// for the same reason it exists: it runs on the path where something already
// went wrong, which is exactly when a hook must not make things worse.
const EVENTS = ['inject', 'capture-prompt', 'capture-tool', 'capture-tool-failure', 'end'] as const

/** A durable fact, so `inject` has something real to lose when things break. */
const FACT = '- [2026-08-01] usa pnpm, nunca npm\n  <!-- src:sess_chaos conf:high -->\n'
const FACT_LINE = '- [2026-08-01] usa pnpm, nunca npm'

/** chmod cases are meaningless as root: root writes into 0o555 anyway. */
const IS_ROOT = process.getuid?.() === 0

// ---------------------------------------------------------------------------
// the bundle, built once by test/global-setup.ts
// ---------------------------------------------------------------------------

// Nothing here builds: `test/global-setup.ts` produces the bundles once, before
// any suite starts. This only confirms the one this file spawns is there, so a
// misconfigured run says so plainly instead of surfacing as a puzzling
// module-not-found from every spawn below.
beforeAll(() => {
  expect(fs.existsSync(bundlePath), `bundle not built: ${bundlePath}`).toBe(true)
  expect(fs.statSync(bundlePath).size, `bundle is empty: ${bundlePath}`).toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// running the real bundle
// ---------------------------------------------------------------------------

interface HookRun {
  status: number | null
  stdout: string
  stderr: string
  /** Wall clock as the harness would feel it, spawn included. */
  ms: number
  /** The PARENT's spawn failure (e.g. EPIPE writing a payload the hook bounded). */
  spawnErrorCode?: string
}

/** Every invocation in this file, for the latency guard at the end. */
const latencies: { label: string; ms: number }[] = []

function record(label: string, ms: number): void {
  latencies.push({ label, ms })
}

/**
 * An empty home for every spawn.
 *
 * The hook reads global memory from `$HOME/.lumem`, so inheriting the real home
 * makes these assertions depend on whether the person running the suite happens
 * to use lumem themselves — the maintainers, exactly. Injecting an empty home
 * keeps the chaos cases measuring the hook instead of the machine.
 */
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-chaos-home-'))

function spawnEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, HOME: isolatedHome, ...env }
}

function runHook(args: string[], input: string, env?: NodeJS.ProcessEnv): HookRun {
  const started = Date.now()
  const result = spawnSync(process.execPath, [bundlePath, ...args], {
    input,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: spawnEnv(env),
  })
  const ms = Date.now() - started
  record(args.join(' ') || '(no args)', ms)

  const code = (result.error as NodeJS.ErrnoException | undefined)?.code
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ms,
    ...(code === undefined ? {} : { spawnErrorCode: code }),
  }
}

/** Same contract, but the hook is handed no stdin pipe at all. */
function runHookWithoutStdin(args: string[], env?: NodeJS.ProcessEnv): HookRun {
  const started = Date.now()
  const result = spawnSync(process.execPath, [bundlePath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: spawnEnv(env),
  })
  const ms = Date.now() - started
  record(`${args.join(' ')} (no stdin)`, ms)
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ms }
}

function runHookAsync(args: string[], input: string): Promise<HookRun> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [bundlePath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (status) => {
      const ms = Date.now() - started
      record(`${args.join(' ')} (concurrent)`, ms)
      resolve({ status, stdout, stderr, ms })
    })
    // the hook may stop reading at its 1 MiB bound: a broken pipe is its right
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

/**
 * Node's own warnings (`(node:123) ExperimentalWarning: …` plus their stack)
 * are the runtime talking, not the hook. Anything else on stderr is noise the
 * user would see in their session, and is a failure.
 */
function noise(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .filter((line) => !/^\(node:\d+\)/.test(line) && !/^\s+at /.test(line))
    .join('\n')
}

/** The whole contract of this file, in one assertion pair. */
function expectSurvived(run: HookRun, what: string): void {
  expect(run.status, `${what}: expected exit 0; stderr was: ${run.stderr.slice(0, 400)}`).toBe(0)
  expect(noise(run.stderr), `${what}: expected silent stderr`).toBe('')
}

// ---------------------------------------------------------------------------
// hostile fixtures
// ---------------------------------------------------------------------------

const tempDirs: string[] = []

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-chaos-'))
  tempDirs.push(dir)
  return dir
}

interface ProjectOptions {
  /** Skip `.lumem` entirely — the "hook installed globally" case. */
  withoutLumem?: boolean
  memory?: string | Buffer
  config?: string
  journal?: { sessionId: string; content: string | Buffer }
}

/** A project with `.lumem`, memory and a sessions dir, ready to be broken. */
function project(opts: ProjectOptions = {}): string {
  const dir = tmpDir()
  if (opts.withoutLumem === true) return dir

  const lumemDir = path.join(dir, '.lumem')
  fs.mkdirSync(path.join(lumemDir, 'memory'), { recursive: true })
  fs.mkdirSync(path.join(lumemDir, 'local', 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(lumemDir, 'memory', 'project.md'), opts.memory ?? FACT)
  if (opts.config !== undefined) {
    fs.writeFileSync(path.join(lumemDir, 'lumem.config.json'), opts.config)
  }
  if (opts.journal !== undefined) {
    const file = path.join(lumemDir, 'local', 'sessions', `${opts.journal.sessionId}.jsonl`)
    fs.writeFileSync(file, opts.journal.content)
  }
  return dir
}

function sessionsDir(projectDir: string): string {
  return path.join(projectDir, '.lumem', 'local', 'sessions')
}

/** One payload that gives EVERY handler real work to do. */
function fullPayload(cwd: string, sessionId = 'chaos'): string {
  return JSON.stringify({
    cwd,
    session_id: sessionId,
    prompt: 'na verdade, não faz assim — sempre roda o lint antes de commitar',
    tool_name: 'Bash',
    tool_input: { command: 'npm run test', file_path: 'src/app.ts' },
    tool_response: { exit_code: 0 },
  })
}

afterAll(() => {
  for (const dir of tempDirs) {
    // a 0o000 or 0o555 fixture must not survive the run
    restorePermissions(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function restorePermissions(entry: string): void {
  try {
    fs.chmodSync(entry, 0o700)
    if (!fs.statSync(entry).isDirectory()) return
    for (const name of fs.readdirSync(entry)) restorePermissions(path.join(entry, name))
  } catch {
    // best-effort cleanup: an unreadable leftover must not fail the suite
  }
}

// ---------------------------------------------------------------------------
// 1. malformed JSON on stdin
// ---------------------------------------------------------------------------

const MALFORMED_STDIN: [string, string][] = [
  ['truncated object', '{"cwd":"/tmp","session_id":"s'],
  ['trailing garbage', '{"cwd":"/tmp"} and then some words'],
  ['bare brace', '{'],
  ['unterminated array', '[{"a":1},'],
  ['not json at all', 'session_id=abc cwd=/tmp'],
  ['NUL bytes inside the object', '{"cwd":"/tmp"\u0000\u0000}'],
]

describe('malformed JSON on stdin', () => {
  for (const event of EVENTS) {
    it(`${event} exits 0 for every malformed payload`, () => {
      for (const [name, payload] of MALFORMED_STDIN) {
        expectSurvived(runHook(['claude-code', event], payload), `${event} / ${name}`)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// 2. empty stdin; stdin closed immediately
// ---------------------------------------------------------------------------

describe('absent stdin', () => {
  for (const event of EVENTS) {
    it(`${event} exits 0 with an empty payload and with no stdin pipe at all`, () => {
      expectSurvived(runHook(['claude-code', event], ''), `${event} / empty stdin`)
      expectSurvived(runHook(['claude-code', event], '   \n  '), `${event} / whitespace stdin`)
      expectSurvived(runHookWithoutStdin(['claude-code', event]), `${event} / closed stdin`)
    })
  }
})

// ---------------------------------------------------------------------------
// 3. valid JSON, wrong shape
// ---------------------------------------------------------------------------

function deeplyNested(depth: number): string {
  let json = 'null'
  for (let i = 0; i < depth; i++) json = `{"a":${json}}`
  return `{"cwd":"/tmp","session_id":"s","deep":${json}}`
}

const WRONG_SHAPE: [string, string][] = [
  ['array', '[1,2,3]'],
  ['null', 'null'],
  ['string', '"a payload that is a string"'],
  ['number', '42'],
  ['boolean', 'true'],
  ['empty object', '{}'],
  ['array of objects', '[{"cwd":"/tmp"}]'],
  ['deeply nested object', deeplyNested(2000)],
  [
    'every field of the wrong type',
    JSON.stringify({
      cwd: 123,
      session_id: [],
      sessionId: {},
      prompt: 5,
      user_prompt: null,
      tool_name: {},
      tool_input: 'not an object',
      tool_response: [1, 2],
      tool_result: 'not an object',
    }),
  ],
  [
    'right field names, nested wrong types',
    JSON.stringify({
      cwd: { path: '/tmp' },
      session_id: { id: 's' },
      tool_input: { command: ['npm', 'test'], file_path: 42 },
      tool_response: { exit_code: 'zero' },
    }),
  ],
]

describe('valid JSON of the wrong shape', () => {
  for (const event of EVENTS) {
    it(`${event} exits 0 for every wrong-shaped payload`, () => {
      for (const [name, payload] of WRONG_SHAPE) {
        expectSurvived(runHook(['claude-code', event], payload), `${event} / ${name}`)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// 4. a payload larger than the 1 MiB stdin bound
// ---------------------------------------------------------------------------

describe('a gigantic payload', () => {
  for (const event of EVENTS) {
    it(`${event} exits 0 on a payload above the 1 MiB stdin bound`, () => {
      const dir = project()
      const payload = JSON.stringify({
        cwd: dir,
        session_id: 'chaos',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        pad: 'x'.repeat(2 * 1024 * 1024 + 4096),
      })
      expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(2 * 1024 * 1024)

      const run = runHook(['claude-code', event], payload)
      expectSurvived(run, `${event} / 2 MiB payload`)
      // The hook stops reading at 1 MiB; the WRITER then sees a broken pipe.
      // That is the bound working, not a hook failure — but nothing else may
      // have gone wrong on the parent side.
      if (run.spawnErrorCode !== undefined) expect(run.spawnErrorCode).toBe('EPIPE')
    })
  }
})

// ---------------------------------------------------------------------------
// 5. argv chaos
// ---------------------------------------------------------------------------

describe('argv chaos', () => {
  const cases: [string, string[]][] = [
    ['no args', []],
    ['only one arg', ['claude-code']],
    ['unknown event', ['claude-code', 'SessionStart']],
    ['empty harness and event', ['', '']],
    ['empty event', ['claude-code', '']],
    ['event in place of harness', ['inject', 'claude-code']],
    ['flag-looking args', ['--help', '--version']],
    ['path traversal as event', ['claude-code', '../../etc/passwd']],
    ['extra args', ['claude-code', 'inject', 'extra', 'args', '--and-a-flag']],
    ['many args', ['claude-code', 'end', ...Array.from({ length: 200 }, (_, i) => `arg${i}`)]],
  ]

  for (const [name, args] of cases) {
    it(`exits 0 with ${name}`, () => {
      const dir = project()
      expectSurvived(runHook(args, fullPayload(dir)), name)
    })
  }

  it('still runs the handler when extra args follow a valid event', () => {
    const dir = project()
    const run = runHook(['claude-code', 'inject', 'extra'], fullPayload(dir))
    expectSurvived(run, 'extra args after inject')
    expect(run.stdout).toContain(FACT_LINE)
  })
})

// ---------------------------------------------------------------------------
// 6. a hostile cwd
// ---------------------------------------------------------------------------

describe('a hostile cwd', () => {
  function hostileCwdCase(name: string, makeCwd: () => string): void {
    it(`exits 0 for every event when cwd is ${name}`, () => {
      const cwd = makeCwd()
      for (const event of EVENTS) {
        expectSurvived(runHook(['claude-code', event], fullPayload(cwd)), `${event} / cwd ${name}`)
        // the same path arriving through the env instead of the payload
        expectSurvived(
          runHook(['claude-code', event], '{}', { CLAUDE_PROJECT_DIR: cwd }),
          `${event} / CLAUDE_PROJECT_DIR ${name}`,
        )
      }
    })
  }

  hostileCwdCase('a nonexistent path', () => path.join(tmpDir(), 'no', 'such', 'dir'))

  hostileCwdCase('a file, not a directory', () => {
    const file = path.join(tmpDir(), 'a-file')
    fs.writeFileSync(file, 'i am a file, not a project')
    return file
  })

  hostileCwdCase('a directory with no .lumem', () => project({ withoutLumem: true }))

  hostileCwdCase('a path whose .lumem is a file', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, '.lumem'), 'not a directory either')
    return dir
  })

  it.skipIf(IS_ROOT)('exits 0 for every event when cwd has no read permission', () => {
    const dir = project()
    fs.chmodSync(dir, 0o000)
    try {
      for (const event of EVENTS) {
        expectSurvived(runHook(['claude-code', event], fullPayload(dir)), `${event} / cwd 0o000`)
      }
    } finally {
      fs.chmodSync(dir, 0o700)
    }
  })
})

// ---------------------------------------------------------------------------
// 7. an unwritable journal
// ---------------------------------------------------------------------------

describe('an unwritable journal', () => {
  it('exits 0 for every event when .lumem/local/sessions is a FILE', () => {
    const dir = project()
    fs.rmSync(sessionsDir(dir), { recursive: true, force: true })
    fs.writeFileSync(sessionsDir(dir), 'sessions is a file now')

    for (const event of EVENTS) {
      expectSurvived(runHook(['claude-code', event], fullPayload(dir)), `${event} / sessions=file`)
    }
    expect(fs.statSync(sessionsDir(dir)).isFile()).toBe(true)
  })

  it.skipIf(IS_ROOT)('exits 0 for every event when the sessions dir is read-only', () => {
    const dir = project()
    fs.chmodSync(sessionsDir(dir), 0o555)
    try {
      for (const event of EVENTS) {
        expectSurvived(runHook(['claude-code', event], fullPayload(dir)), `${event} / sessions=ro`)
      }
      expect(fs.readdirSync(sessionsDir(dir))).toEqual([])
    } finally {
      fs.chmodSync(sessionsDir(dir), 0o755)
    }
  })

  it('still injects memory when the journal cannot be appended', () => {
    const dir = project()
    fs.rmSync(sessionsDir(dir), { recursive: true, force: true })
    fs.writeFileSync(sessionsDir(dir), 'sessions is a file now')

    const run = runHook(['claude-code', 'inject'], fullPayload(dir))
    expectSurvived(run, 'inject with an unwritable journal')
    // losing the signal must not cost the user their memory
    expect(run.stdout).toContain(FACT_LINE)
  })
})

// ---------------------------------------------------------------------------
// 8. an unwritable log
// ---------------------------------------------------------------------------

describe('an unwritable log', () => {
  it('exits 0 when .lumem/local/lumem.log is a directory', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, '.lumem', 'local', 'lumem.log'), { recursive: true })

    // bad args are the reachable failure-logging path: this WILL try to log
    expectSurvived(
      runHook(['claude-code', 'not-an-event'], fullPayload(dir), { CLAUDE_PROJECT_DIR: dir }),
      'bad args with lumem.log as a directory',
    )
    for (const event of EVENTS) {
      expectSurvived(
        runHook(['claude-code', event], fullPayload(dir)),
        `${event} / lumem.log=directory`,
      )
    }
    expect(fs.statSync(path.join(dir, '.lumem', 'local', 'lumem.log')).isDirectory()).toBe(true)
  })

  it.skipIf(IS_ROOT)('exits 0 when .lumem/local is read-only', () => {
    const dir = project()
    const localDir = path.join(dir, '.lumem', 'local')
    fs.chmodSync(localDir, 0o555)
    try {
      expectSurvived(
        runHook(['claude-code', 'not-an-event'], '{}', { CLAUDE_PROJECT_DIR: dir }),
        'bad args with a read-only .lumem/local',
      )
    } finally {
      fs.chmodSync(localDir, 0o755)
    }
  })
})

// ---------------------------------------------------------------------------
// 9. corrupt memory files
// ---------------------------------------------------------------------------

describe('corrupt memory files', () => {
  /** A well-formed bullet whose body is not valid UTF-8. */
  const invalidUtf8 = Buffer.concat([
    Buffer.from('- [2026-01-01] ', 'utf8'),
    Buffer.from([0xff, 0xfe, 0xc3, 0x28]),
    Buffer.from('\n  <!-- src:x conf:high -->\n', 'utf8'),
  ])

  const corruptions: [string, string | Buffer][] = [
    ['binary bytes', Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x1b, 0x5b, 0x41, 0x0a])],
    ['invalid UTF-8 inside a fact', invalidUtf8],
    ['a 4 MB single line', `- [2026-01-01] ${'a'.repeat(4 * 1024 * 1024)}\n`],
    ['a fact with no provenance', '- [2026-08-01] orphan fact\n'],
    ['ansi escapes and lone CRs', '- [2026-08-01] \u001b[31mred\u001b[0m\r\r- [bad] x\r\n'],
    ['nothing but newlines', '\n'.repeat(100_000)],
  ]

  for (const [name, content] of corruptions) {
    it(`inject exits 0 when project.md holds ${name}`, () => {
      const dir = project({ memory: content })
      expectSurvived(runHook(['claude-code', 'inject'], fullPayload(dir)), `inject / ${name}`)
    })
  }

  it('exits 0 for every event when .lumem/memory is a file', () => {
    const dir = project()
    fs.rmSync(path.join(dir, '.lumem', 'memory'), { recursive: true, force: true })
    fs.writeFileSync(path.join(dir, '.lumem', 'memory'), 'memory is a file now')
    for (const event of EVENTS) {
      expectSurvived(runHook(['claude-code', event], fullPayload(dir)), `${event} / memory=file`)
    }
  })

  it.skipIf(IS_ROOT)('exits 0 when project.md cannot be read', () => {
    const dir = project()
    const file = path.join(dir, '.lumem', 'memory', 'project.md')
    fs.chmodSync(file, 0o000)
    try {
      const run = runHook(['claude-code', 'inject'], fullPayload(dir))
      expectSurvived(run, 'inject / project.md 0o000')
      expect(run.stdout).toBe('')
    } finally {
      fs.chmodSync(file, 0o600)
    }
  })
})

// ---------------------------------------------------------------------------
// 10. corrupt config
// ---------------------------------------------------------------------------

describe('corrupt lumem.config.json', () => {
  const configs: [string, string][] = [
    ['garbage', 'not json at all {{{'],
    ['an empty file', ''],
    ['a JSON array', '[1,2,3]'],
    ['injectionBytes as a string', '{"budgets":{"injectionBytes":"4096"}}'],
    ['injectionBytes negative', '{"budgets":{"injectionBytes":-4096}}'],
    ['injectionBytes zero', '{"budgets":{"injectionBytes":0}}'],
    ['injectionBytes as Infinity (1e999)', '{"budgets":{"injectionBytes":1e999}}'],
    ['injectionBytes as null', '{"budgets":{"injectionBytes":null}}'],
    ['budgets as a string', '{"budgets":"tiny"}'],
  ]

  for (const [name, config] of configs) {
    it(`inject exits 0 and falls back to the default budget with ${name}`, () => {
      const dir = project({ config })
      const run = runHook(['claude-code', 'inject'], fullPayload(dir))
      expectSurvived(run, `inject / config ${name}`)
      // the PRD default (4 KB) still applies, so the fact survives the bad config
      expect(run.stdout).toContain(FACT_LINE)
    })
  }

  it('exits 0 for every event when the config is a directory', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, '.lumem', 'lumem.config.json'))
    for (const event of EVENTS) {
      expectSurvived(runHook(['claude-code', event], fullPayload(dir)), `${event} / config=dir`)
    }
  })
})

// ---------------------------------------------------------------------------
// 11. a corrupt journal, then recovery detection
// ---------------------------------------------------------------------------

describe('a corrupt journal', () => {
  const sessionId = 'corrupt'

  function corruptJournal(): string {
    return [
      '{"garbage',
      'not json at all',
      '{"t":"unknown-signal-kind","ts":"nope"}',
      '[]',
      'null',
      '',
      'z'.repeat(10 * 1024 * 1024),
      JSON.stringify({ t: 'cmd', ts: '2026-08-07T10:00:00Z', cmd: 'npm run test', exit: 1 }),
      '',
    ].join('\n')
  }

  it('capture-tool exits 0 and still detects the recovery', () => {
    const dir = project({ journal: { sessionId, content: corruptJournal() } })
    const run = runHook(['claude-code', 'capture-tool'], fullPayload(dir, sessionId))
    expectSurvived(run, 'capture-tool over a corrupt journal')

    const lines = fs
      .readFileSync(path.join(sessionsDir(dir), `${sessionId}.jsonl`), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
    const appended = lines.slice(-3).map((line) => {
      try {
        return (JSON.parse(line) as { t?: unknown }).t
      } catch {
        return 'unparseable'
      }
    })
    // the 10 MB junk line is outside the tail window; the failed cmd is not
    expect(appended).toContain('recovery')
    expect(appended).toContain('cmd')
  })

  it('exits 0 for every event over a corrupt journal', () => {
    for (const event of EVENTS) {
      const dir = project({ journal: { sessionId, content: corruptJournal() } })
      expectSurvived(
        runHook(['claude-code', event], fullPayload(dir, sessionId)),
        `${event} / corrupt journal`,
      )
    }
  })

  it('exits 0 when the journal is a directory', () => {
    const dir = project()
    fs.mkdirSync(path.join(sessionsDir(dir), `${sessionId}.jsonl`))
    for (const event of EVENTS) {
      expectSurvived(
        runHook(['claude-code', event], fullPayload(dir, sessionId)),
        `${event} / journal=dir`,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 12. concurrency
// ---------------------------------------------------------------------------

describe('concurrent hooks on one journal', () => {
  const CONCURRENCY = 10

  it('runs 10 hooks at once with no torn lines', async () => {
    const dir = project()
    const sessionId = 'concurrent'
    // Long commands make a torn line likely if the append were not atomic.
    const payloads = Array.from({ length: CONCURRENCY }, (_, i) =>
      JSON.stringify({
        cwd: dir,
        session_id: sessionId,
        tool_name: 'Bash',
        tool_input: { command: `echo run-${i} ${'p'.repeat(4000)}` },
        tool_response: { exit_code: 0 },
      }),
    )

    const runs = await Promise.all(
      payloads.map((payload) => runHookAsync(['claude-code', 'capture-tool'], payload)),
    )
    for (const [i, run] of runs.entries()) expectSurvived(run, `concurrent hook ${i}`)

    const text = fs.readFileSync(path.join(sessionsDir(dir), `${sessionId}.jsonl`), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    const lines = text.split('\n').filter((line) => line.length > 0)
    expect(lines).toHaveLength(CONCURRENCY)

    const commands = new Set<string>()
    for (const line of lines) {
      const signal = JSON.parse(line) as { t?: string; cmd?: string }
      expect(signal.t).toBe('cmd')
      expect(typeof signal.cmd).toBe('string')
      commands.add(signal.cmd ?? '')
    }
    // every writer landed exactly once, whole
    expect(commands.size).toBe(CONCURRENCY)
  })
})

// ---------------------------------------------------------------------------
// the latency guard, over everything above
// ---------------------------------------------------------------------------

describe('the latency guard holds under chaos', () => {
  it(`no invocation in this file exceeded ${LATENCY_CEILING_MS} ms`, () => {
    // not vacuous: the matrix above is worth well over a hundred invocations
    expect(latencies.length).toBeGreaterThan(100)

    const worst = latencies.reduce((a, b) => (a.ms >= b.ms ? a : b))
    expect(
      worst.ms,
      `slowest invocation was '${worst.label}' at ${worst.ms} ms over ${latencies.length} runs`,
    ).toBeLessThan(LATENCY_CEILING_MS)
  })
})
