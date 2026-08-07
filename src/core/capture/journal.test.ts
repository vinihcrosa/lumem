import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type Signal,
  appendSignal,
  countSignals,
  readSignals,
  sessionFileName,
  tailSignals,
} from './journal'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-journal-'))
}

const TS = '2026-08-07T12:00:00.000Z'

type CmdSignal = Extract<Signal, { t: 'cmd' }>

function cmdSignal(cmd: string, exit = 0): CmdSignal {
  return { t: 'cmd', ts: TS, cmd, exit }
}

function onlyCmds(signals: Signal[]): CmdSignal[] {
  return signals.filter((s): s is CmdSignal => s.t === 'cmd')
}

const SESSION_SIGNAL: Signal = {
  t: 'session',
  ts: TS,
  ev: 'start',
  harness: 'claude-code',
  sessionId: 'sess_a1b2',
  cwd: '/repo',
}
const FILE_SIGNAL: Signal = { t: 'file', ts: TS, path: 'src/index.ts', tool: 'Edit' }
const CMD_SIGNAL: Signal = { t: 'cmd', ts: TS, cmd: 'npm test', exit: 1 }
const RECOVERY_SIGNAL: Signal = { t: 'recovery', ts: TS, failed: 'npm test', passed: 'npm test' }
const CORRECTION_SIGNAL: Signal = {
  t: 'correction',
  ts: TS,
  marker: 'na verdade',
  prompt: 'na verdade use pnpm',
}
const MEMORY_OP_SIGNAL: Signal = { t: 'memory-op', ts: TS, op: 'add', factId: 'deadbeef' }

const ALL_VARIANTS: Signal[] = [
  SESSION_SIGNAL,
  FILE_SIGNAL,
  CMD_SIGNAL,
  RECOVERY_SIGNAL,
  CORRECTION_SIGNAL,
  MEMORY_OP_SIGNAL,
]

describe('sessionFileName', () => {
  it('keeps allowed characters as-is', () => {
    expect(sessionFileName('sess_a1b2-3.4')).toBe('sess_a1b2-3.4.jsonl')
  })

  it('neutralizes path traversal', () => {
    const name = sessionFileName('../x')
    expect(name).toBe('..-x.jsonl')
    expect(name).not.toContain('/')
    expect(path.basename(name)).toBe(name)
  })

  it('replaces slashes and spaces with dashes', () => {
    expect(sessionFileName('a b/c\\d')).toBe('a-b-c-d.jsonl')
  })

  it('replaces every other character with a dash', () => {
    expect(sessionFileName('a:b*c?d"e|f')).toBe('a-b-c-d-e-f.jsonl')
  })

  it('falls back to unknown for an empty id', () => {
    expect(sessionFileName('')).toBe('unknown.jsonl')
  })

  it('falls back to unknown for dot-only ids', () => {
    expect(sessionFileName('.')).toBe('unknown.jsonl')
    expect(sessionFileName('..')).toBe('unknown.jsonl')
    expect(sessionFileName('....')).toBe('unknown.jsonl')
  })

  it('never emits a path separator', () => {
    for (const id of ['/', '../../etc/passwd', 'a\\b', '/abs/path']) {
      const name = sessionFileName(id)
      expect(name).not.toContain('/')
      expect(name).not.toContain('\\')
      expect(path.basename(name)).toBe(name)
    }
  })
})

describe('appendSignal', () => {
  it('creates the sessions directory and the file, one JSON object per line', () => {
    const dir = path.join(tmpDir(), 'nested', 'sessions')
    expect(appendSignal(dir, 'sess_a1b2', FILE_SIGNAL)).toBe(true)
    expect(appendSignal(dir, 'sess_a1b2', CMD_SIGNAL)).toBe(true)

    const raw = fs.readFileSync(path.join(dir, 'sess_a1b2.jsonl'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)

    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    expect(lines.map((l) => JSON.parse(l))).toEqual([FILE_SIGNAL, CMD_SIGNAL])
  })

  it('uses the sanitized session file name', () => {
    const dir = tmpDir()
    expect(appendSignal(dir, '../evil', CMD_SIGNAL)).toBe(true)
    expect(fs.readdirSync(dir)).toEqual(['..-evil.jsonl'])
  })

  it('returns false without throwing when sessionsDir is an existing file', () => {
    const dir = tmpDir()
    const asFile = path.join(dir, 'sessions')
    fs.writeFileSync(asFile, 'not a directory')

    let result: boolean | undefined
    expect(() => {
      result = appendSignal(asFile, 'sess_a1b2', CMD_SIGNAL)
    }).not.toThrow()
    expect(result).toBe(false)
    expect(fs.readFileSync(asFile, 'utf8')).toBe('not a directory')
  })
})

describe('readSignals', () => {
  it('round-trips all six signal variants', () => {
    const dir = tmpDir()
    for (const signal of ALL_VARIANTS) appendSignal(dir, 'sess_a1b2', signal)

    const { signals, badLines } = readSignals(path.join(dir, 'sess_a1b2.jsonl'))
    expect(badLines).toBe(0)
    expect(signals).toEqual(ALL_VARIANTS)
    expect(signals.map((s) => s.t)).toEqual([
      'session',
      'file',
      'cmd',
      'recovery',
      'correction',
      'memory-op',
    ])
  })

  it('returns an empty result for a missing file', () => {
    expect(readSignals(path.join(tmpDir(), 'nope.jsonl'))).toEqual({ signals: [], badLines: 0 })
  })

  it('counts a corrupted middle line and parses the rest', () => {
    const file = path.join(tmpDir(), 'sess.jsonl')
    const lines = [
      JSON.stringify(SESSION_SIGNAL),
      '{"t":"file","ts":"2026-08-07T12:00:00.000Z","pa',
      JSON.stringify(FILE_SIGNAL),
      JSON.stringify(CMD_SIGNAL),
    ]
    fs.writeFileSync(file, `${lines.join('\n')}\n`)

    const { signals, badLines } = readSignals(file)
    expect(badLines).toBe(1)
    expect(signals).toEqual([SESSION_SIGNAL, FILE_SIGNAL, CMD_SIGNAL])
  })

  it('counts valid JSON without a known discriminator as a bad line', () => {
    const file = path.join(tmpDir(), 'sess.jsonl')
    const lines = [
      JSON.stringify({ t: 'unknown-kind', ts: TS }),
      JSON.stringify({ ts: TS, path: 'a.ts' }),
      JSON.stringify({ t: 42, ts: TS }),
      JSON.stringify('a bare string'),
      JSON.stringify([CMD_SIGNAL]),
      JSON.stringify(null),
      JSON.stringify(CMD_SIGNAL),
    ]
    fs.writeFileSync(file, `${lines.join('\n')}\n`)

    const { signals, badLines } = readSignals(file)
    expect(badLines).toBe(6)
    expect(signals).toEqual([CMD_SIGNAL])
  })

  it('ignores blank lines without counting them as bad', () => {
    const file = path.join(tmpDir(), 'sess.jsonl')
    fs.writeFileSync(file, `\n${JSON.stringify(CMD_SIGNAL)}\n\n  \n`)

    const { signals, badLines } = readSignals(file)
    expect(badLines).toBe(0)
    expect(signals).toEqual([CMD_SIGNAL])
  })
})

describe('countSignals', () => {
  it('counts every parseable signal by default', () => {
    const dir = tmpDir()
    for (const signal of ALL_VARIANTS) appendSignal(dir, 'sess', signal)
    const file = path.join(dir, 'sess.jsonl')
    fs.appendFileSync(file, 'garbage\n')

    expect(countSignals(file)).toBe(6)
    expect(countSignals(file, {})).toBe(6)
    expect(countSignals(file, { excludeSession: false })).toBe(6)
  })

  it('drops session signals when excludeSession is set', () => {
    const dir = tmpDir()
    for (const signal of ALL_VARIANTS) appendSignal(dir, 'sess', signal)
    appendSignal(dir, 'sess', {
      t: 'session',
      ts: TS,
      ev: 'end',
      harness: 'claude-code',
      sessionId: 'sess',
      cwd: '/repo',
    })

    const file = path.join(dir, 'sess.jsonl')
    expect(countSignals(file)).toBe(7)
    expect(countSignals(file, { excludeSession: true })).toBe(5)
  })

  it('returns 0 for a missing file', () => {
    const missing = path.join(tmpDir(), 'nope.jsonl')
    expect(countSignals(missing)).toBe(0)
    expect(countSignals(missing, { excludeSession: true })).toBe(0)
  })
})

describe('tailSignals', () => {
  it('returns every signal when the file fits in the window', () => {
    const dir = tmpDir()
    for (const signal of ALL_VARIANTS) appendSignal(dir, 'sess', signal)

    expect(tailSignals(path.join(dir, 'sess.jsonl'))).toEqual(ALL_VARIANTS)
  })

  it('returns an empty array for a missing file', () => {
    expect(tailSignals(path.join(tmpDir(), 'nope.jsonl'))).toEqual([])
  })

  it('reads only the trailing window of a large file, dropping the leading partial line', () => {
    const file = path.join(tmpDir(), 'sess.jsonl')
    const total = 2000
    const lines: string[] = []
    for (let i = 0; i < total; i++) lines.push(JSON.stringify(cmdSignal(`cmd-${i}`)))
    fs.writeFileSync(file, `${lines.join('\n')}\n`)
    expect(fs.statSync(file).size).toBeGreaterThan(4096 * 10)

    const window = 4096
    const tail = tailSignals(file, window)

    // bounded by the window, and far smaller than the whole file
    expect(tail.length).toBeGreaterThan(0)
    expect(tail.length).toBeLessThan(total)
    const bytes = Buffer.byteLength(`${tail.map((s) => JSON.stringify(s)).join('\n')}\n`)
    expect(bytes).toBeLessThanOrEqual(window)

    // every returned entry is a complete, well-formed cmd signal
    const cmds = onlyCmds(tail)
    expect(cmds).toHaveLength(tail.length)

    // contiguous suffix ending at the last appended signal
    const indices = cmds.map((s) => Number(s.cmd.slice('cmd-'.length)))
    expect(indices[indices.length - 1]).toBe(total - 1)
    const first = indices[0] ?? -1
    expect(indices).toEqual(indices.map((_unused, i) => first + i))

    // reading the whole file confirms nothing on disk is malformed
    expect(readSignals(file).badLines).toBe(0)
  })

  it('drops everything when the window cannot hold a full line', () => {
    const dir = tmpDir()
    for (let i = 0; i < 50; i++) appendSignal(dir, 'sess', cmdSignal(`cmd-${i}`))

    expect(tailSignals(path.join(dir, 'sess.jsonl'), 4)).toEqual([])
  })
})

describe('concurrent appends', () => {
  it('keeps every line intact with 8 writers x 50 appends', async () => {
    const file = path.join(tmpDir(), 'sess.jsonl')
    const writers = 8
    const perWriter = 50

    await Promise.all(
      Array.from({ length: writers }, async (_unused, w) => {
        for (let i = 0; i < perWriter; i++) {
          await fs.promises.appendFile(file, `${JSON.stringify(cmdSignal(`w${w}-${i}`))}\n`)
        }
      }),
    )

    const { signals, badLines } = readSignals(file)
    expect(badLines).toBe(0)
    expect(signals).toHaveLength(writers * perWriter)

    const seen = new Set(onlyCmds(signals).map((s) => s.cmd))
    expect(seen.size).toBe(writers * perWriter)
    for (let w = 0; w < writers; w++) {
      for (let i = 0; i < perWriter; i++) expect(seen.has(`w${w}-${i}`)).toBe(true)
    }
  })
})
