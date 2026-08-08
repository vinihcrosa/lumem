import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { writeLock } from '../core/install/lockfile'
import { sha256 } from '../core/shared/fsx'
import type { CliContext } from './context'
import { renderDoctor, runDoctor } from './doctor'

const realAdaptersDir = fileURLToPath(new URL('../adapters', import.meta.url))

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-doctor-'))
}

function writeExecutable(dir: string, name: string, stdout: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\necho "${stdout}"\n`)
  fs.chmodSync(file, 0o755)
  return file
}

// An empty temp dir, never the repo root: dogfooding `lumem install` here would
// otherwise give these tests a real lockfile to find drift in, and doctor now
// exits 3 on drift.
let emptyProject: string | undefined
function projectlessDir(): string {
  emptyProject ??= tmpDir()
  return emptyProject
}

function makeCtx(overrides: Partial<CliContext> = {}): CliContext {
  return {
    projectDir: projectlessDir(),
    adaptersDir: realAdaptersDir,
    env: {},
    json: false,
    ...overrides,
  }
}

// Fixtures. NEVER the real home: every detection runs against an injected HOME/PATH.
let claudeHome: string
let codexHome: string
let emptyHome: string
let claudeBinDir: string
let oldClaudeBinDir: string
let emptyPathDir: string

beforeAll(() => {
  claudeHome = tmpDir()
  fs.mkdirSync(path.join(claudeHome, '.claude'))

  codexHome = tmpDir()
  fs.mkdirSync(path.join(codexHome, '.codex'))

  emptyHome = tmpDir()
  emptyPathDir = tmpDir()

  claudeBinDir = tmpDir()
  writeExecutable(claudeBinDir, 'claude', '2.1.230 (Claude Code)')

  oldClaudeBinDir = tmpDir()
  writeExecutable(oldClaudeBinDir, 'claude', '1.0.0 (Claude Code)')
})

describe('runDoctor', () => {
  it('detects claude-code (full) via fake home + bin, leaves codex unavailable', () => {
    const { report, exitCode } = runDoctor(
      makeCtx({ env: { HOME: claudeHome, PATH: claudeBinDir } }),
    )

    expect(exitCode).toBe(0)
    expect(report.descriptorErrors).toEqual([])

    const claude = report.harnesses.find((h) => h.id === 'claude-code')
    expect(claude).toBeDefined()
    expect(claude?.detected).toBe(true)
    expect(claude?.version).toBe('2.1.230')
    expect(claude?.grade).toBe('full')
    expect(claude?.minVersion).toBe('2.1.224')
    expect(claude?.missing).toEqual([])

    const codex = report.harnesses.find((h) => h.id === 'codex')
    expect(codex).toBeDefined()
    expect(codex?.detected).toBe(false)
    expect(codex?.grade).toBe('unavailable')
    expect(codex?.version).toBeUndefined()
  })

  it('detects codex via the ~/.codex dir rule alone, with a trust warning', () => {
    const { report, exitCode } = runDoctor(
      makeCtx({ env: { HOME: codexHome, PATH: emptyPathDir } }),
    )

    expect(exitCode).toBe(0)

    const codex = report.harnesses.find((h) => h.id === 'codex')
    expect(codex?.detected).toBe(true)
    expect(codex?.version).toBeUndefined()
    expect(codex?.warnings.some((w) => w.includes('trust'))).toBe(true)

    const claude = report.harnesses.find((h) => h.id === 'claude-code')
    expect(claude?.detected).toBe(false)
    expect(claude?.grade).toBe('unavailable')
  })

  it('grades an old claude-code version as degraded and warns about the minimum', () => {
    const { report } = runDoctor(makeCtx({ env: { HOME: emptyHome, PATH: oldClaudeBinDir } }))

    const claude = report.harnesses.find((h) => h.id === 'claude-code')
    expect(claude?.detected).toBe(true)
    expect(claude?.version).toBe('1.0.0')
    expect(claude?.grade).toBe('degraded')
    expect(claude?.missing).toContain('minVersion')
    expect(claude?.warnings.some((w) => w.includes('2.1.224'))).toBe(true)
  })

  it('surfaces descriptor errors without failing the run', () => {
    const brokenDir = tmpDir()
    fs.writeFileSync(path.join(brokenDir, 'broken.json'), '{ not json')

    const { report, exitCode } = runDoctor(
      makeCtx({ adaptersDir: brokenDir, env: { HOME: emptyHome, PATH: emptyPathDir } }),
    )

    expect(exitCode).toBe(0)
    expect(report.harnesses).toEqual([])
    expect(report.descriptorErrors).toHaveLength(1)
    expect(report.descriptorErrors[0]?.file).toContain('broken.json')
  })

  it('produces a JSON-serializable report (round-trip)', () => {
    const { report } = runDoctor(makeCtx({ env: { HOME: claudeHome, PATH: claudeBinDir } }))
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })
})

describe('renderDoctor', () => {
  it('renders a detected harness with version and grade', () => {
    const { report } = runDoctor(makeCtx({ env: { HOME: claudeHome, PATH: claudeBinDir } }))
    const text = renderDoctor(report)
    expect(text).toContain('✔ claude-code 2.1.230 (full)')
    expect(text).toContain('✖ codex — não detectado')
  })

  it('renders warnings and fallbacks as indented lines', () => {
    const { report } = runDoctor(makeCtx({ env: { HOME: codexHome, PATH: emptyPathDir } }))
    const text = renderDoctor(report)
    const indented = text.split('\n').filter((line) => line.startsWith('  '))
    expect(indented.some((line) => line.includes('trust'))).toBe(true)
    // codex lacks hooks.envProjectDir → projectResolution fallback
    expect(indented.some((line) => line.includes('projectResolution'))).toBe(true)
  })

  it('renders descriptor errors', () => {
    const brokenDir = tmpDir()
    fs.writeFileSync(path.join(brokenDir, 'oops.json'), 'nope')
    const { report } = runDoctor(
      makeCtx({ adaptersDir: brokenDir, env: { HOME: emptyHome, PATH: emptyPathDir } }),
    )
    const text = renderDoctor(report)
    expect(text).toContain('oops.json')
  })
})

// ── T19: drift, trust, last failure and version issues ──────────────────────

interface LockFixture {
  artifactId: string
  relPath: string
  /** Bytes on disk; omit to leave the destination missing. */
  content?: string
  /** Recorded source hash; defaults to the hash of `content`. */
  hash?: string
  /** Recorded destination hash, set by install for rendered artifacts. */
  contentHash?: string
}

/** A project dir holding only `.lumem/lumem-lock.json` and the files it tracks. */
function projectWithLock(entries: LockFixture[]): string {
  const projectDir = tmpDir()
  const lumemDir = path.join(projectDir, '.lumem')
  fs.mkdirSync(lumemDir, { recursive: true })

  writeLock(lumemDir, {
    version: 1,
    entries: entries.map((entry) => {
      const destPath = path.join(projectDir, entry.relPath)
      if (entry.content !== undefined) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.writeFileSync(destPath, entry.content)
      }
      return {
        artifactId: entry.artifactId,
        installedAt: '2026-01-01T00:00:00.000Z',
        destPath,
        hash: entry.hash ?? sha256(entry.content ?? ''),
        ...(entry.contentHash !== undefined ? { contentHash: entry.contentHash } : {}),
        mode: 'copy' as const,
      }
    }),
  })

  return projectDir
}

function writeLog(projectDir: string, content: string): void {
  const file = path.join(projectDir, '.lumem', 'local', 'lumem.log')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const SKILL_ARTIFACT = 'skill:alpha-skill@claude-code'
const SKILL_REL = '.claude/skills/alpha-skill/SKILL.md'

function claudeCtx(projectDir: string): CliContext {
  return makeCtx({ projectDir, env: { HOME: claudeHome, PATH: claudeBinDir } })
}

describe('runDoctor drift', () => {
  it('reports a managed file edited after install and exits 3', () => {
    const projectDir = projectWithLock([
      {
        artifactId: SKILL_ARTIFACT,
        relPath: SKILL_REL,
        content: '# mine\n',
        hash: sha256('# alpha-skill\n'),
      },
    ])

    const { report, exitCode } = runDoctor(claudeCtx(projectDir))

    expect(exitCode).toBe(3)
    expect(report.drift).toEqual([
      {
        artifactId: SKILL_ARTIFACT,
        destPath: path.join(projectDir, SKILL_REL),
        state: 'modified',
      },
    ])
    const text = renderDoctor(report)
    expect(text).toContain('drift:')
    expect(text).toContain(path.join(projectDir, SKILL_REL))
  })

  it('reports a deleted managed file as missing', () => {
    const projectDir = projectWithLock([{ artifactId: SKILL_ARTIFACT, relPath: SKILL_REL }])

    const { report, exitCode } = runDoctor(claudeCtx(projectDir))

    expect(exitCode).toBe(3)
    expect(report.drift.map((entry) => entry.state)).toEqual(['missing'])
  })

  it('stays silent and exits 0 when every tracked file matches the lock', () => {
    const projectDir = projectWithLock([
      { artifactId: SKILL_ARTIFACT, relPath: SKILL_REL, content: '# alpha-skill\n' },
    ])

    const { report, exitCode } = runDoctor(claudeCtx(projectDir))

    expect(exitCode).toBe(0)
    expect(report.drift).toEqual([])
    expect(renderDoctor(report)).not.toContain('drift:')
  })

  it('does not flag a rendered hook config whose bytes match the recorded contentHash', () => {
    const rendered = '{ "bundle": "/tmp/lumem-hook.mjs" }\n'
    const projectDir = projectWithLock([
      {
        artifactId: 'hook-config:claude-code',
        relPath: '.claude/settings.json',
        content: rendered,
        hash: sha256('{ "bundle": "{{HOOK_BUNDLE}}" }\n'),
        contentHash: sha256(rendered),
      },
    ])

    const { report, exitCode } = runDoctor(claudeCtx(projectDir))

    expect(exitCode).toBe(0)
    expect(report.drift).toEqual([])
  })

  it('treats a missing .lumem as no drift at all', () => {
    const { report, exitCode } = runDoctor(claudeCtx(tmpDir()))

    expect(exitCode).toBe(0)
    expect(report.drift).toEqual([])
  })
})

describe('runDoctor trust reminders', () => {
  it('reminds the user to run /hooks for codex once its hooks are installed', () => {
    const projectDir = projectWithLock([
      { artifactId: 'hook-config:codex', relPath: '.codex/hooks.json', content: '{}\n' },
    ])

    const { report, exitCode } = runDoctor(
      makeCtx({ projectDir, env: { HOME: codexHome, PATH: emptyPathDir } }),
    )

    expect(exitCode).toBe(0)
    expect(report.trust).toEqual([{ harness: 'codex', hooksInstalled: true, requiresTrust: true }])

    const text = renderDoctor(report)
    expect(text).toContain('trust:')
    expect(text).toContain('/hooks')
  })

  it('says nothing about trust for claude-code, which does not require it', () => {
    const projectDir = projectWithLock([
      { artifactId: 'hook-config:claude-code', relPath: '.claude/settings.json', content: '{}\n' },
    ])

    const { report } = runDoctor(claudeCtx(projectDir))

    expect(report.trust).toEqual([])
    const text = renderDoctor(report)
    expect(text).not.toContain('trust:')
    expect(text).not.toContain('/hooks')
  })

  it('stays quiet until the hooks are actually in the lockfile', () => {
    const { report } = runDoctor(
      makeCtx({ projectDir: tmpDir(), env: { HOME: codexHome, PATH: emptyPathDir } }),
    )

    expect(report.trust).toEqual([])
  })
})

describe('runDoctor last failure', () => {
  it('reports the most recent error line of the log', () => {
    const projectDir = tmpDir()
    writeLog(
      projectDir,
      [
        JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', level: 'info', event: 'hook.ok' }),
        JSON.stringify({
          ts: '2026-01-02T00:00:00.000Z',
          level: 'error',
          event: 'consolidate.failed',
          data: { error: 'primeira falha' },
        }),
        JSON.stringify({
          ts: '2026-01-03T00:00:00.000Z',
          level: 'error',
          event: 'runner.failed',
          data: { error: 'patch inválido' },
        }),
        JSON.stringify({ ts: '2026-01-04T00:00:00.000Z', level: 'info', event: 'hook.ok' }),
        '',
      ].join('\n'),
    )

    const { report, exitCode } = runDoctor(claudeCtx(projectDir))

    expect(exitCode).toBe(0)
    expect(report.lastFailure).toEqual({
      ts: '2026-01-03T00:00:00.000Z',
      event: 'runner.failed',
      message: 'patch inválido',
    })

    const text = renderDoctor(report)
    expect(text).toContain('última falha:')
    expect(text).toContain('patch inválido')
  })

  it('skips corrupt lines instead of throwing', () => {
    const projectDir = tmpDir()
    writeLog(
      projectDir,
      [
        '{ not json',
        'nope',
        JSON.stringify({
          ts: '2026-02-01T00:00:00.000Z',
          level: 'error',
          event: 'hook.failed',
          data: { error: 'stdin ilegível' },
        }),
        '{ also not json',
      ].join('\n'),
    )

    const { report } = runDoctor(claudeCtx(projectDir))

    expect(report.lastFailure?.event).toBe('hook.failed')
  })

  it('reports nothing when the log is entirely corrupt', () => {
    const projectDir = tmpDir()
    writeLog(projectDir, 'nope\n{ still not json\n\n')

    const { report, exitCode } = runDoctor(claudeCtx(projectDir))

    expect(report.lastFailure).toBeUndefined()
    expect(exitCode).toBe(0)
    expect(renderDoctor(report)).not.toContain('última falha:')
  })

  it('reports nothing when there is no log at all', () => {
    const { report } = runDoctor(claudeCtx(tmpDir()))

    expect(report.lastFailure).toBeUndefined()
  })
})

describe('runDoctor version issues', () => {
  it('lists a harness below its minimum version and exits 3', () => {
    const { report, exitCode } = runDoctor(
      makeCtx({ projectDir: tmpDir(), env: { HOME: emptyHome, PATH: oldClaudeBinDir } }),
    )

    expect(exitCode).toBe(3)
    expect(report.versionIssues).toHaveLength(1)
    expect(report.versionIssues[0]).toContain('claude-code')
    expect(report.versionIssues[0]).toContain('1.0.0')
    expect(report.versionIssues[0]).toContain('2.1.224')
    expect(renderDoctor(report)).toContain('versão abaixo do mínimo:')
  })

  it('stays empty for a supported version', () => {
    const { report, exitCode } = runDoctor(claudeCtx(tmpDir()))

    expect(exitCode).toBe(0)
    expect(report.versionIssues).toEqual([])
    expect(renderDoctor(report)).not.toContain('versão abaixo do mínimo:')
  })
})

describe('the extended DoctorReport', () => {
  it('round-trips through JSON with every section populated', () => {
    const projectDir = projectWithLock([
      { artifactId: 'hook-config:codex', relPath: '.codex/hooks.json', content: '{}\n' },
      { artifactId: SKILL_ARTIFACT, relPath: SKILL_REL, content: '# mine\n', hash: sha256('#\n') },
    ])
    writeLog(
      projectDir,
      `${JSON.stringify({
        ts: '2026-03-01T00:00:00.000Z',
        level: 'error',
        event: 'consolidate.failed',
        data: { error: 'boom' },
      })}\n`,
    )

    const { report, exitCode } = runDoctor(
      makeCtx({ projectDir, env: { HOME: codexHome, PATH: oldClaudeBinDir } }),
    )

    expect(exitCode).toBe(3)
    expect(report.drift).toHaveLength(1)
    expect(report.trust).toHaveLength(1)
    expect(report.versionIssues).toHaveLength(1)
    expect(report.lastFailure?.message).toBe('boom')
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })
})
