import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendLog } from './log'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-'))
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
