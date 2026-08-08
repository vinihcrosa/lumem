import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CliContext } from './context'
import { renderStatus, runStatus } from './status'

const realAdaptersDir = fileURLToPath(new URL('../adapters', import.meta.url))

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-status-'))
}

function makeCtx(projectDir: string): CliContext {
  return { projectDir, adaptersDir: realAdaptersDir, env: {}, json: false }
}

const lockFixture = {
  version: 1,
  entries: [
    {
      artifactId: 'skill:lumem-memory',
      installedAt: '2026-08-07T12:00:00.000Z',
      destPath: '/tmp/proj/.claude/skills/lumem-memory/SKILL.md',
      hash: 'abc123',
      mode: 'copy',
    },
    {
      artifactId: 'hook:lumem-hook',
      installedAt: '2026-08-07T12:00:01.000Z',
      destPath: '/tmp/proj/.lumem/bin/lumem-hook.mjs',
      hash: 'def456',
      mode: 'symlink',
    },
  ],
}

describe('runStatus', () => {
  it('reports lockfileFound false and nothing installed without a .lumem dir', () => {
    const projectDir = tmpDir()
    const { report, exitCode } = runStatus(makeCtx(projectDir))

    expect(exitCode).toBe(0)
    expect(report.lockfileFound).toBe(false)
    expect(report.installed).toEqual([])
  })

  it('lists entries from a hand-written lockfile', () => {
    const projectDir = tmpDir()
    const lumemDir = path.join(projectDir, '.lumem')
    fs.mkdirSync(lumemDir)
    fs.writeFileSync(path.join(lumemDir, 'lumem-lock.json'), JSON.stringify(lockFixture, null, 2))

    const { report, exitCode } = runStatus(makeCtx(projectDir))

    expect(exitCode).toBe(0)
    expect(report.lockfileFound).toBe(true)
    expect(report.installed).toEqual([
      {
        artifactId: 'skill:lumem-memory',
        destPath: '/tmp/proj/.claude/skills/lumem-memory/SKILL.md',
        mode: 'copy',
        installedAt: '2026-08-07T12:00:00.000Z',
      },
      {
        artifactId: 'hook:lumem-hook',
        destPath: '/tmp/proj/.lumem/bin/lumem-hook.mjs',
        mode: 'symlink',
        installedAt: '2026-08-07T12:00:01.000Z',
      },
    ])
  })

  it('produces a JSON-serializable report (round-trip)', () => {
    const projectDir = tmpDir()
    const lumemDir = path.join(projectDir, '.lumem')
    fs.mkdirSync(lumemDir)
    fs.writeFileSync(path.join(lumemDir, 'lumem-lock.json'), JSON.stringify(lockFixture))

    const { report } = runStatus(makeCtx(projectDir))
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })
})

describe('renderStatus', () => {
  it('prints the empty message when nothing is installed', () => {
    const { report } = runStatus(makeCtx(tmpDir()))
    expect(renderStatus(report)).toBe('nothing installed — run `lumem install`')
  })

  it('lists installed artifacts with their destination and mode', () => {
    const projectDir = tmpDir()
    const lumemDir = path.join(projectDir, '.lumem')
    fs.mkdirSync(lumemDir)
    fs.writeFileSync(path.join(lumemDir, 'lumem-lock.json'), JSON.stringify(lockFixture))

    const { report } = runStatus(makeCtx(projectDir))
    const text = renderStatus(report)
    expect(text).toContain('skill:lumem-memory')
    expect(text).toContain('/tmp/proj/.claude/skills/lumem-memory/SKILL.md')
    expect(text).toContain('copy')
    expect(text).toContain('hook:lumem-hook')
    expect(text).toContain('symlink')
  })
})
