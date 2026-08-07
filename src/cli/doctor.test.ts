import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
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

function makeCtx(overrides: Partial<CliContext> = {}): CliContext {
  return {
    projectDir: process.cwd(),
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
