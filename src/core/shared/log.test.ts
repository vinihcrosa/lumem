import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendLog, rotateLogs } from './log'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-'))
}

function readLines(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
}

describe('appendLog', () => {
  it('appends valid JSONL lines with an ISO ts, creating parent dirs', () => {
    const dir = tmpDir()
    const logFile = path.join(dir, 'nested', 'logs', 'lumem.log')

    appendLog(logFile, { level: 'info', event: 'start' })
    appendLog(logFile, { level: 'warn', event: 'slow', data: { ms: 1200 } })

    const lines = fs
      .readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)

    const first = JSON.parse(lines[0] as string)
    expect(first.level).toBe('info')
    expect(first.event).toBe('start')
    expect(typeof first.ts).toBe('string')
    expect(Number.isNaN(Date.parse(first.ts))).toBe(false)
    expect(first.ts).toBe(new Date(first.ts).toISOString())

    const second = JSON.parse(lines[1] as string)
    expect(second.level).toBe('warn')
    expect(second.event).toBe('slow')
    expect(second.data).toEqual({ ms: 1200 })
  })

  it('does not throw when the path is unwritable (parent is an existing file)', () => {
    const dir = tmpDir()
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'i am a file')
    const logFile = path.join(blocker, 'sub', 'lumem.log')

    expect(() => appendLog(logFile, { level: 'error', event: 'boom' })).not.toThrow()
  })

  it('accepts rotation opts without throwing', () => {
    const dir = tmpDir()
    const logFile = path.join(dir, 'lumem.log')
    expect(() =>
      appendLog(logFile, { level: 'info', event: 'opts' }, { maxBytes: 1024, maxFiles: 3 }),
    ).not.toThrow()
    expect(fs.existsSync(logFile)).toBe(true)
  })
})

describe('appendLog rotation', () => {
  it('rotates to <log>.1 when the next line would exceed maxBytes', () => {
    const dir = tmpDir()
    const logFile = path.join(dir, 'lumem.log')

    appendLog(logFile, { level: 'info', event: 'first' })
    const firstBytes = fs.readFileSync(logFile)

    appendLog(logFile, { level: 'info', event: 'second' }, { maxBytes: firstBytes.length + 1 })

    // rotated content is preserved byte for byte
    expect(Buffer.compare(fs.readFileSync(`${logFile}.1`), firstBytes)).toBe(0)

    const lines = readLines(logFile)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string).event).toBe('second')
    expect(fs.existsSync(`${logFile}.2`)).toBe(false)
  })

  it('keeps at most maxFiles rotated files alongside the live log', () => {
    const dir = tmpDir()
    const logFile = path.join(dir, 'lumem.log')

    for (const event of ['a', 'b', 'c', 'd', 'e']) {
      appendLog(logFile, { level: 'info', event }, { maxBytes: 1, maxFiles: 2 })
    }

    const eventOf = (file: string): string => JSON.parse(readLines(file)[0] as string).event
    expect(eventOf(logFile)).toBe('e')
    expect(eventOf(`${logFile}.1`)).toBe('d')
    expect(eventOf(`${logFile}.2`)).toBe('c')
    expect(fs.existsSync(`${logFile}.3`)).toBe(false)
  })

  it('truncates without keeping any rotated copy when maxFiles is 0', () => {
    const dir = tmpDir()
    const logFile = path.join(dir, 'lumem.log')

    appendLog(logFile, { level: 'info', event: 'old' })
    appendLog(logFile, { level: 'info', event: 'new' }, { maxBytes: 1, maxFiles: 0 })

    const lines = readLines(logFile)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string).event).toBe('new')
    expect(fs.existsSync(`${logFile}.1`)).toBe(false)
  })

  it('still writes a single entry larger than maxBytes to a fresh log', () => {
    const dir = tmpDir()
    const logFile = path.join(dir, 'lumem.log')

    appendLog(logFile, { level: 'info', event: 'small' })
    const smallBytes = fs.readFileSync(logFile)

    const blob = 'x'.repeat(4096)
    appendLog(logFile, { level: 'info', event: 'big', data: { blob } }, { maxBytes: 128 })

    expect(Buffer.compare(fs.readFileSync(`${logFile}.1`), smallBytes)).toBe(0)
    const lines = readLines(logFile)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string).data.blob).toBe(blob)
    expect(fs.statSync(logFile).size).toBeGreaterThan(128)
  })

  it('does not rotate while the log stays under the limit', () => {
    const dir = tmpDir()
    const logFile = path.join(dir, 'lumem.log')

    for (const event of ['a', 'b', 'c']) {
      appendLog(logFile, { level: 'info', event }, { maxBytes: 1_000_000, maxFiles: 3 })
    }
    appendLog(logFile, { level: 'info', event: 'd' })

    expect(readLines(logFile)).toHaveLength(4)
    expect(fs.existsSync(`${logFile}.1`)).toBe(false)
  })

  it('appends anyway, without throwing, when rotation fails', () => {
    const dir = tmpDir()
    const logFile = path.join(dir, 'lumem.log')
    appendLog(logFile, { level: 'info', event: 'first' })

    // <log>.1 is an unwritable (non-empty) directory: the rotation cannot proceed
    const blocked = `${logFile}.1`
    fs.mkdirSync(blocked)
    fs.writeFileSync(path.join(blocked, 'keep'), 'x')

    expect(() =>
      appendLog(logFile, { level: 'info', event: 'second' }, { maxBytes: 1, maxFiles: 1 }),
    ).not.toThrow()

    const lines = readLines(logFile)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1] as string).event).toBe('second')
    expect(fs.readFileSync(path.join(blocked, 'keep'), 'utf8')).toBe('x')
  })
})

describe('rotateLogs', () => {
  it('shifts numbered files down and drops the oldest beyond maxFiles', () => {
    const dir = tmpDir()
    const logFile = path.join(dir, 'lumem.log')
    fs.writeFileSync(logFile, 'live\n')
    fs.writeFileSync(`${logFile}.1`, 'one\n')
    fs.writeFileSync(`${logFile}.2`, 'two\n')
    fs.writeFileSync(`${logFile}.3`, 'three\n')

    rotateLogs(logFile, 3)

    expect(fs.existsSync(logFile)).toBe(false)
    expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toBe('live\n')
    expect(fs.readFileSync(`${logFile}.2`, 'utf8')).toBe('one\n')
    expect(fs.readFileSync(`${logFile}.3`, 'utf8')).toBe('two\n')
    expect(fs.existsSync(`${logFile}.4`)).toBe(false)
  })

  it('skips a source that was already rotated away', () => {
    const dir = tmpDir()
    const logFile = path.join(dir, 'lumem.log')
    fs.writeFileSync(logFile, 'live\n')
    fs.writeFileSync(`${logFile}.2`, 'two\n')

    expect(() => rotateLogs(logFile, 3)).not.toThrow()

    expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toBe('live\n')
    expect(fs.existsSync(`${logFile}.2`)).toBe(false)
    expect(fs.readFileSync(`${logFile}.3`, 'utf8')).toBe('two\n')
  })

  it('deletes rotated files beyond maxFiles', () => {
    const dir = tmpDir()
    const logFile = path.join(dir, 'lumem.log')
    fs.writeFileSync(logFile, 'live\n')
    for (const n of [1, 2, 3, 4, 5]) fs.writeFileSync(`${logFile}.${n}`, `old${n}\n`)

    rotateLogs(logFile, 3)

    expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toBe('live\n')
    expect(fs.readFileSync(`${logFile}.2`, 'utf8')).toBe('old1\n')
    expect(fs.readFileSync(`${logFile}.3`, 'utf8')).toBe('old2\n')
    expect(fs.existsSync(`${logFile}.4`)).toBe(false)
    expect(fs.existsSync(`${logFile}.5`)).toBe(false)
  })

  it('removes the live log and every rotated copy when maxFiles is 0', () => {
    const dir = tmpDir()
    const logFile = path.join(dir, 'lumem.log')
    fs.writeFileSync(logFile, 'live\n')
    fs.writeFileSync(`${logFile}.1`, 'one\n')

    rotateLogs(logFile, 0)

    expect(fs.existsSync(logFile)).toBe(false)
    expect(fs.existsSync(`${logFile}.1`)).toBe(false)
  })

  it('does not throw when the log does not exist', () => {
    const dir = tmpDir()
    const logFile = path.join(dir, 'lumem.log')
    expect(() => rotateLogs(logFile, 3)).not.toThrow()
    expect(fs.existsSync(`${logFile}.1`)).toBe(false)
  })
})
