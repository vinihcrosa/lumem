import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Signal } from '../capture/journal'
import { DEFAULT_GATE_CONFIG, checkGate } from './gate'

const createdRoots: string[] = []

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** A fresh temp dir, removed after each test. Doubles as `localDir`. */
function tmpDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-gate-'))
  createdRoots.push(root)
  return root
}

const BASE_MS = Date.parse('2026-08-07T12:00:00.000Z')

/** ISO timestamp `minutes` after the fixed base instant. */
function at(minutes: number): string {
  return new Date(BASE_MS + minutes * 60_000).toISOString()
}

/** `now` for the tests: 10 minutes after the base, i.e. after every journal entry. */
const NOW = new Date(BASE_MS + 10 * 60_000)

function hoursBefore(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString()
}

function fileSignal(minutes: number): Signal {
  return { t: 'file', ts: at(minutes), path: 'src/a.ts', tool: 'Edit' }
}

function sessionSignal(minutes: number, ev: 'start' | 'end'): Signal {
  return {
    t: 'session',
    ts: at(minutes),
    ev,
    harness: 'claude-code',
    sessionId: 's1',
    cwd: '/repo',
  }
}

function writeJournal(dir: string, signals: Signal[]): string {
  return writeRawJournal(dir, signals.map((s) => `${JSON.stringify(s)}\n`).join(''))
}

function writeRawJournal(dir: string, text: string): string {
  const file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(file, text)
  return file
}

/** Journal that satisfies both the signal count (5) and the duration (5 min). */
function passingJournal(dir: string): string {
  return writeJournal(dir, [
    sessionSignal(0, 'start'),
    fileSignal(1),
    fileSignal(2),
    fileSignal(3),
    fileSignal(4),
    fileSignal(5),
    sessionSignal(5, 'end'),
  ])
}

function writeState(dir: string, state: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
}

function writeLock(dir: string, startedAt: string): void {
  fs.writeFileSync(
    path.join(dir, 'consolidate.lock'),
    `${JSON.stringify({ pid: 4242, startedAt })}\n`,
  )
}

function minutesAgoReal(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

describe('DEFAULT_GATE_CONFIG', () => {
  it('matches the PRD §6 thresholds', () => {
    expect(DEFAULT_GATE_CONFIG).toEqual({
      minSignals: 5,
      minDurationMin: 3,
      minHoursBetween: 6,
      lockTtlMin: 30,
    })
  })
})

describe('checkGate — all conditions satisfied', () => {
  it('passes with no reasons when all four conditions hold', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 10), compactionFlags: [] })

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.pass).toBe(true)
    expect(result.reasons).toEqual([])
    expect(result.signals).toBe(5)
    expect(result.durationMin).toBe(5)
    expect(result.hoursSinceLast).toBe(10)
  })

  it('passes on the exact boundaries of every threshold', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [fileSignal(0), fileSignal(1), fileSignal(3)])
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 6), compactionFlags: [] })

    const result = checkGate({
      sessionFile,
      localDir: dir,
      now: NOW,
      config: { minSignals: 3 },
    })

    expect(result).toEqual({
      pass: true,
      reasons: [],
      signals: 3,
      durationMin: 3,
      hoursSinceLast: 6,
    })
  })
})

describe('checkGate — condition 1: signals', () => {
  it('does not count session start/end markers toward the threshold', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [
      sessionSignal(0, 'start'),
      fileSignal(1),
      fileSignal(2),
      fileSignal(5),
      sessionSignal(5, 'end'),
    ])

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.signals).toBe(3)
  })

  it('fails with a reason naming the count and the threshold', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [fileSignal(0), fileSignal(5)])
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 10), compactionFlags: [] })

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.pass).toBe(false)
    expect(result.signals).toBe(2)
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toMatch(/^signals:/)
    expect(result.reasons[0]).toContain('2')
    expect(result.reasons[0]).toContain('5')
  })

  it('skips corrupt journal lines when counting', () => {
    const dir = tmpDir()
    const sessionFile = writeRawJournal(
      dir,
      [
        JSON.stringify(fileSignal(0)),
        'not json at all',
        '',
        JSON.stringify({ t: 'unknown-kind', ts: at(1) }),
        JSON.stringify(fileSignal(5)),
      ].join('\n'),
    )

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.signals).toBe(2)
  })
})

describe('checkGate — condition 2: duration', () => {
  it('measures minutes between the first and the last signal timestamp', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [
      sessionSignal(0, 'start'),
      fileSignal(4),
      sessionSignal(10, 'end'),
    ])

    expect(checkGate({ sessionFile, localDir: dir, now: NOW }).durationMin).toBe(10)
  })

  it('reports fractional minutes', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [fileSignal(0), fileSignal(1.5)])

    expect(checkGate({ sessionFile, localDir: dir, now: NOW }).durationMin).toBe(1.5)
  })

  it('is 0 when there is a single signal', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [fileSignal(0)])

    expect(checkGate({ sessionFile, localDir: dir, now: NOW }).durationMin).toBe(0)
  })

  it('is 0 when the journal is empty', () => {
    const dir = tmpDir()
    const sessionFile = writeRawJournal(dir, '')

    expect(checkGate({ sessionFile, localDir: dir, now: NOW }).durationMin).toBe(0)
  })

  it('ignores signals whose ts is missing or unparseable', () => {
    const dir = tmpDir()
    const sessionFile = writeRawJournal(
      dir,
      [
        JSON.stringify({ t: 'file', path: 'src/a.ts', tool: 'Edit' }),
        JSON.stringify({ t: 'file', ts: 'not-a-date', path: 'src/b.ts', tool: 'Edit' }),
        JSON.stringify(fileSignal(2)),
        JSON.stringify(fileSignal(6)),
      ].join('\n'),
    )

    expect(checkGate({ sessionFile, localDir: dir, now: NOW }).durationMin).toBe(4)
  })

  it('is 0 when only one timestamp is parseable', () => {
    const dir = tmpDir()
    const sessionFile = writeRawJournal(
      dir,
      [
        JSON.stringify({ t: 'file', ts: 'not-a-date', path: 'src/b.ts', tool: 'Edit' }),
        JSON.stringify(fileSignal(2)),
      ].join('\n'),
    )

    expect(checkGate({ sessionFile, localDir: dir, now: NOW }).durationMin).toBe(0)
  })

  it('never reports a negative duration for an out-of-order journal', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [fileSignal(9), fileSignal(1)])

    expect(checkGate({ sessionFile, localDir: dir, now: NOW }).durationMin).toBe(0)
  })

  it('fails with a reason naming the duration and the threshold', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [
      fileSignal(0),
      fileSignal(0.5),
      fileSignal(1),
      fileSignal(1.5),
      fileSignal(2),
    ])
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 10), compactionFlags: [] })

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.pass).toBe(false)
    expect(result.durationMin).toBe(2)
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toMatch(/^duration:/)
    expect(result.reasons[0]).toContain('2')
    expect(result.reasons[0]).toContain('3')
  })
})

describe('checkGate — condition 3: hours since the last consolidation', () => {
  it('passes with hoursSinceLast null when the project was never consolidated', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.pass).toBe(true)
    expect(result.hoursSinceLast).toBeNull()
    expect(result.reasons).toEqual([])
  })

  it('passes when state.json exists but carries no lastConsolidationAt', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)
    writeState(dir, { compactionFlags: ['project'] })

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.pass).toBe(true)
    expect(result.hoursSinceLast).toBeNull()
  })

  it('treats a corrupt state.json as never consolidated', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)
    fs.writeFileSync(path.join(dir, 'state.json'), '{ this is not json')

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.pass).toBe(true)
    expect(result.hoursSinceLast).toBeNull()
    expect(result.reasons).toEqual([])
  })

  it('treats an unparseable lastConsolidationAt as never consolidated', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)
    writeState(dir, { lastConsolidationAt: 'yesterday-ish', compactionFlags: [] })

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.pass).toBe(true)
    expect(result.hoursSinceLast).toBeNull()
  })

  it('fails with a reason naming the elapsed hours and the threshold', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 2.5), compactionFlags: [] })

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.pass).toBe(false)
    expect(result.hoursSinceLast).toBe(2.5)
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toMatch(/^hours-since-last:/)
    expect(result.reasons[0]).toContain('2.5')
    expect(result.reasons[0]).toContain('6')
  })

  it('fails when lastConsolidationAt is in the future (clock skew)', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, -3), compactionFlags: [] })

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.pass).toBe(false)
    expect(result.hoursSinceLast).toBe(-3)
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toMatch(/^hours-since-last:/)
  })

  it('defaults now to the current time when not injected', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)
    writeState(dir, { lastConsolidationAt: minutesAgoReal(60), compactionFlags: [] })

    const result = checkGate({ sessionFile, localDir: dir })

    expect(result.pass).toBe(false)
    expect(result.hoursSinceLast).toBe(1)
  })
})

describe('checkGate — condition 4: lock', () => {
  it('fails with a lock reason while a fresh lock is held', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 10), compactionFlags: [] })
    writeLock(dir, new Date().toISOString())

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.pass).toBe(false)
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toMatch(/^lock:/)
  })

  it('ignores a stale lock (older than lockTtlMin)', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 10), compactionFlags: [] })
    writeLock(dir, minutesAgoReal(31))

    expect(checkGate({ sessionFile, localDir: dir, now: NOW }).pass).toBe(true)
  })

  it('honors a custom lockTtlMin', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 10), compactionFlags: [] })
    writeLock(dir, minutesAgoReal(5))

    expect(checkGate({ sessionFile, localDir: dir, now: NOW }).pass).toBe(false)
    expect(
      checkGate({ sessionFile, localDir: dir, now: NOW, config: { lockTtlMin: 1 } }).pass,
    ).toBe(true)
  })

  it('ignores an unparseable lock file', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 10), compactionFlags: [] })
    fs.writeFileSync(path.join(dir, 'consolidate.lock'), 'garbage')

    expect(checkGate({ sessionFile, localDir: dir, now: NOW }).pass).toBe(true)
  })
})

describe('checkGate — force', () => {
  it('passes with everything else failing when there is no lock', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [fileSignal(0)])
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 0.5), compactionFlags: [] })

    const result = checkGate({ sessionFile, localDir: dir, now: NOW, force: true })

    expect(result.pass).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('still reports the real metrics it bypassed', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [fileSignal(0)])
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 0.5), compactionFlags: [] })

    const result = checkGate({ sessionFile, localDir: dir, now: NOW, force: true })

    expect(result.signals).toBe(1)
    expect(result.durationMin).toBe(0)
    expect(result.hoursSinceLast).toBe(0.5)
  })

  it('NEVER bypasses the lock: force + active lock fails with only the lock reason', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [fileSignal(0)])
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 0.5), compactionFlags: [] })
    writeLock(dir, new Date().toISOString())

    const result = checkGate({ sessionFile, localDir: dir, now: NOW, force: true })

    expect(result.pass).toBe(false)
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toMatch(/^lock:/)
  })

  it('force: false behaves like the default', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [fileSignal(0)])

    const result = checkGate({ sessionFile, localDir: dir, now: NOW, force: false })

    expect(result.pass).toBe(false)
    expect(result.reasons).toHaveLength(2)
  })
})

describe('checkGate — missing journal', () => {
  it('reports zeroes and fails on signals + duration instead of throwing', () => {
    const dir = tmpDir()
    const sessionFile = path.join(dir, 'sessions', 'nope.jsonl')

    let result: ReturnType<typeof checkGate> | undefined
    expect(() => {
      result = checkGate({ sessionFile, localDir: dir, now: NOW })
    }).not.toThrow()

    expect(result?.pass).toBe(false)
    expect(result?.signals).toBe(0)
    expect(result?.durationMin).toBe(0)
    expect(result?.hoursSinceLast).toBeNull()
    expect(result?.reasons).toHaveLength(2)
    expect(result?.reasons[0]).toMatch(/^signals:/)
    expect(result?.reasons[1]).toMatch(/^duration:/)
  })
})

describe('checkGate — config merging', () => {
  it('merges a partial config over the defaults', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [fileSignal(0), fileSignal(5)])

    expect(checkGate({ sessionFile, localDir: dir, now: NOW }).pass).toBe(false)
    expect(
      checkGate({ sessionFile, localDir: dir, now: NOW, config: { minSignals: 2 } }).pass,
    ).toBe(true)
  })

  it('keeps the defaults the partial config does not mention', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [fileSignal(0), fileSignal(1)])

    const result = checkGate({ sessionFile, localDir: dir, now: NOW, config: { minSignals: 2 } })

    expect(result.pass).toBe(false)
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toMatch(/^duration:/)
    expect(result.reasons[0]).toContain('3')
  })

  it('ignores explicitly undefined overrides', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)

    const result = checkGate({
      sessionFile,
      localDir: dir,
      now: NOW,
      config: { minSignals: undefined, minDurationMin: undefined },
    })

    expect(result.pass).toBe(true)
  })

  it('does not mutate DEFAULT_GATE_CONFIG', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)

    checkGate({ sessionFile, localDir: dir, now: NOW, config: { minSignals: 99, lockTtlMin: 1 } })

    expect(DEFAULT_GATE_CONFIG).toEqual({
      minSignals: 5,
      minDurationMin: 3,
      minHoursBetween: 6,
      lockTtlMin: 30,
    })
  })
})

describe('checkGate — multiple failures', () => {
  it('reports every failed condition in the order signals, duration, hours, lock', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [fileSignal(0)])
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 1), compactionFlags: [] })
    writeLock(dir, new Date().toISOString())

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.pass).toBe(false)
    expect(result.reasons).toHaveLength(4)
    expect(result.reasons[0]).toMatch(/^signals:/)
    expect(result.reasons[1]).toMatch(/^duration:/)
    expect(result.reasons[2]).toMatch(/^hours-since-last:/)
    expect(result.reasons[3]).toMatch(/^lock:/)
  })

  it('reports the surviving subset in the same relative order', () => {
    const dir = tmpDir()
    const sessionFile = writeJournal(dir, [fileSignal(0), fileSignal(5)])
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 1), compactionFlags: [] })

    const result = checkGate({ sessionFile, localDir: dir, now: NOW })

    expect(result.reasons).toHaveLength(2)
    expect(result.reasons[0]).toMatch(/^signals:/)
    expect(result.reasons[1]).toMatch(/^hours-since-last:/)
  })
})

describe('checkGate — robustness', () => {
  it('never throws for empty paths', () => {
    expect(() => checkGate({ sessionFile: '', localDir: '', now: NOW })).not.toThrow()
    expect(checkGate({ sessionFile: '', localDir: '', now: NOW }).pass).toBe(false)
  })

  it('never throws when sessionFile is a directory', () => {
    const dir = tmpDir()

    expect(() => checkGate({ sessionFile: dir, localDir: dir, now: NOW })).not.toThrow()
  })

  it('never throws when localDir is a regular file', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)
    const notADir = path.join(dir, 'not-a-dir')
    fs.writeFileSync(notADir, 'i am a file')

    expect(() => checkGate({ sessionFile, localDir: notADir, now: NOW })).not.toThrow()
    expect(checkGate({ sessionFile, localDir: notADir, now: NOW }).pass).toBe(true)
  })

  it('never throws for an invalid now', () => {
    const dir = tmpDir()
    const sessionFile = passingJournal(dir)
    writeState(dir, { lastConsolidationAt: hoursBefore(NOW, 10), compactionFlags: [] })

    expect(() =>
      checkGate({ sessionFile, localDir: dir, now: new Date('not-a-date') }),
    ).not.toThrow()
  })

  it('never throws for a huge journal of garbage', () => {
    const dir = tmpDir()
    const sessionFile = writeRawJournal(dir, 'x'.repeat(5000).split('').join('\n'))

    expect(() => checkGate({ sessionFile, localDir: dir, now: NOW })).not.toThrow()
    expect(checkGate({ sessionFile, localDir: dir, now: NOW }).signals).toBe(0)
  })
})
