import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { beforeAll, describe, expect, it } from 'vitest'
import { CONFIG_FILE_NAME, readConfig } from '../core/config'
import type { CliContext } from './context'
import { type InitReport, registerInitCommand, renderInit, runInit } from './init'

const realAdaptersDir = fileURLToPath(new URL('../adapters', import.meta.url))

const ENTRIES = [
  '.lumem/memory',
  '.lumem/local',
  '.lumem/lumem.config.json',
  '.lumem/lumem-lock.json',
  '.lumem/.gitignore',
]

function tmpDir(prefix = 'lumem-init-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// Fixtures. NEVER the real home: HOME and PATH are always injected, so nothing
// is detected unless this file plants it.
let emptyHome: string
let claudeHome: string
let emptyPathDir: string

beforeAll(() => {
  emptyHome = tmpDir('lumem-init-home-')
  emptyPathDir = tmpDir('lumem-init-path-')

  claudeHome = tmpDir('lumem-init-home-')
  fs.mkdirSync(path.join(claudeHome, '.claude'))
})

function makeCtx(overrides: Partial<CliContext> = {}): CliContext {
  return {
    projectDir: tmpDir(),
    adaptersDir: realAdaptersDir,
    env: { HOME: emptyHome, PATH: emptyPathDir },
    json: false,
    ...overrides,
  }
}

function withClaude(overrides: Partial<CliContext> = {}): CliContext {
  return makeCtx({ env: { HOME: claudeHome, PATH: emptyPathDir }, ...overrides })
}

function read(projectDir: string, relative: string): string {
  return fs.readFileSync(path.join(projectDir, relative), 'utf8')
}

describe('runInit on a fresh project', () => {
  it('creates the five .lumem entries', () => {
    const ctx = makeCtx()
    const { report, exitCode } = runInit(ctx)

    expect(exitCode).toBe(0)
    expect([...report.created].sort()).toEqual([...ENTRIES].sort())
    expect(report.skipped).toEqual([])

    for (const entry of ENTRIES) {
      expect(fs.existsSync(path.join(ctx.projectDir, entry))).toBe(true)
    }
    expect(fs.statSync(path.join(ctx.projectDir, '.lumem/memory')).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(ctx.projectDir, '.lumem/local')).isDirectory()).toBe(true)
  })

  it('gitignores local/ with exactly that one line', () => {
    const ctx = makeCtx()
    runInit(ctx)

    expect(read(ctx.projectDir, '.lumem/.gitignore')).toBe('local/\n')
  })

  it('writes an empty lockfile and a readable config', () => {
    const ctx = withClaude()
    runInit(ctx)

    expect(JSON.parse(read(ctx.projectDir, '.lumem/lumem-lock.json'))).toEqual({
      version: 1,
      entries: [],
    })

    const { config, error } = readConfig(path.join(ctx.projectDir, '.lumem'))
    expect(error).toBeUndefined()
    expect(config?.version).toBe(1)
    expect(Object.keys(config?.harnesses ?? {})).toEqual(['claude-code'])
  })
})

describe('runInit re-run', () => {
  it('is a no-op: nothing created, everything skipped, bytes untouched', () => {
    const ctx = withClaude()
    expect(runInit(ctx).report.created).toHaveLength(5)

    const configBefore = fs.readFileSync(path.join(ctx.projectDir, '.lumem', CONFIG_FILE_NAME))
    const gitignoreBefore = fs.readFileSync(path.join(ctx.projectDir, '.lumem/.gitignore'))
    const lockBefore = fs.readFileSync(path.join(ctx.projectDir, '.lumem/lumem-lock.json'))

    const { report, exitCode } = runInit(ctx)

    expect(exitCode).toBe(0)
    expect(report.created).toEqual([])
    expect([...report.skipped].sort()).toEqual([...ENTRIES].sort())

    expect(fs.readFileSync(path.join(ctx.projectDir, '.lumem', CONFIG_FILE_NAME))).toEqual(
      configBefore,
    )
    expect(fs.readFileSync(path.join(ctx.projectDir, '.lumem/.gitignore'))).toEqual(gitignoreBefore)
    expect(fs.readFileSync(path.join(ctx.projectDir, '.lumem/lumem-lock.json'))).toEqual(lockBefore)
  })

  it('never rewrites a config the user edited', () => {
    const ctx = makeCtx()
    runInit(ctx)

    const configPath = path.join(ctx.projectDir, '.lumem', CONFIG_FILE_NAME)
    const edited = read(ctx.projectDir, `.lumem/${CONFIG_FILE_NAME}`).replace(
      '"injectionBytes": 4096',
      '"injectionBytes": 2048',
    )
    fs.writeFileSync(configPath, edited)

    runInit(ctx)

    expect(fs.readFileSync(configPath, 'utf8')).toBe(edited)
  })
})

describe('runInit --dry-run', () => {
  it('writes nothing and reports what would be created', () => {
    const ctx = withClaude()
    const { report, exitCode } = runInit(ctx, { dryRun: true })

    expect(exitCode).toBe(0)
    expect([...report.created].sort()).toEqual([...ENTRIES].sort())
    expect(fs.existsSync(path.join(ctx.projectDir, '.lumem'))).toBe(false)
  })

  it('reports the already-present entries of a partial project', () => {
    const ctx = makeCtx()
    fs.mkdirSync(path.join(ctx.projectDir, '.lumem/memory'), { recursive: true })

    const { report } = runInit(ctx, { dryRun: true })

    expect(report.skipped).toEqual(['.lumem/memory'])
    expect(report.created).not.toContain('.lumem/memory')
    expect(fs.existsSync(path.join(ctx.projectDir, '.lumem', CONFIG_FILE_NAME))).toBe(false)
  })
})

describe('runInit harness selection', () => {
  it('defaults to every detected harness', () => {
    const ctx = withClaude()
    runInit(ctx)

    const { config } = readConfig(path.join(ctx.projectDir, '.lumem'))
    expect(Object.keys(config?.harnesses ?? {})).toEqual(['claude-code'])
    expect(config?.harnesses['claude-code']?.minVersion).toBe('2.1.224')
    expect(config?.harnesses['claude-code']?.installMode).toBe('symlink')
    expect(config?.harnesses['claude-code']?.scope).toBe('project')
  })

  it('filters the config to the harnesses passed in opts', () => {
    const ctx = withClaude()
    const { report, exitCode } = runInit(ctx, { harnesses: ['codex'] })

    expect(exitCode).toBe(0)

    const { config } = readConfig(path.join(ctx.projectDir, '.lumem'))
    expect(Object.keys(config?.harnesses ?? {})).toEqual(['codex'])

    expect(report.harnesses.find((h) => h.id === 'codex')?.selected).toBe(true)
    expect(report.harnesses.find((h) => h.id === 'claude-code')?.selected).toBe(false)
    expect(report.harnesses.find((h) => h.id === 'claude-code')?.detected).toBe(true)
  })

  it('fails with exit 1 on an unknown harness id and writes nothing', () => {
    const ctx = withClaude()
    const { report, exitCode } = runInit(ctx, { harnesses: ['claude-code', 'emacs-doctor'] })

    expect(exitCode).toBe(1)
    expect(report.created).toEqual([])
    expect(fs.existsSync(path.join(ctx.projectDir, '.lumem'))).toBe(false)
    expect(report.notes.join('\n')).toContain('emacs-doctor')
    expect(renderInit(report)).toContain('emacs-doctor')
  })

  it('initializes with an empty harness map when none is detected, and says so', () => {
    const ctx = makeCtx()
    const { report, exitCode } = runInit(ctx)

    expect(exitCode).toBe(0)
    expect(report.created).toHaveLength(5)
    expect(report.harnesses.every((h) => !h.detected && !h.selected)).toBe(true)

    const { config } = readConfig(path.join(ctx.projectDir, '.lumem'))
    expect(config?.harnesses).toEqual({})
    expect(report.notes.join('\n')).toMatch(/harness/i)
  })

  it('grades each harness in the report', () => {
    const { report } = runInit(withClaude())

    expect(report.harnesses.find((h) => h.id === 'claude-code')?.grade).toBe('full')
    expect(report.harnesses.find((h) => h.id === 'codex')?.grade).toBe('unavailable')
  })
})

describe('runInit and a user-authored .gitignore', () => {
  it('leaves a differently-worded ignore untouched', () => {
    const ctx = makeCtx()
    const lumemDir = path.join(ctx.projectDir, '.lumem')
    fs.mkdirSync(lumemDir, { recursive: true })
    fs.writeFileSync(path.join(lumemDir, '.gitignore'), '/local\n*.tmp\n')

    const { report } = runInit(ctx)

    expect(report.skipped).toContain('.lumem/.gitignore')
    expect(report.created).not.toContain('.lumem/.gitignore')
    expect(read(ctx.projectDir, '.lumem/.gitignore')).toBe('/local\n*.tmp\n')
  })
})

describe('InitReport', () => {
  it('round-trips through JSON', () => {
    const { report } = runInit(withClaude())
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })
})

describe('renderInit', () => {
  it('lists created and skipped entries', () => {
    const ctx = withClaude()
    const first = runInit(ctx).report
    const text = renderInit(first)

    expect(text).toContain('.lumem/lumem.config.json')
    expect(text).toContain('claude-code')

    const second = renderInit(runInit(ctx).report)
    expect(second).toContain('.lumem/.gitignore')
  })

  it('returns a non-empty string for every report', () => {
    expect(renderInit(runInit(makeCtx(), { dryRun: true }).report).length).toBeGreaterThan(0)
  })
})

describe('registerInitCommand', () => {
  function parse(argv: string[], ctx: CliContext): InitReport {
    const program = new Command()
    program.exitOverride()
    let captured: InitReport | undefined
    registerInitCommand(
      program,
      () => ctx,
      (_json, report) => {
        captured = report as InitReport
      },
    )
    program.parse(['node', 'lumem', ...argv])
    if (captured === undefined) throw new Error('emit was never called')
    return captured
  }

  it('runs a dry-run init from the command line', () => {
    const ctx = withClaude()
    const report = parse(['init', '--dry-run'], ctx)

    expect(report.created).toHaveLength(5)
    expect(fs.existsSync(path.join(ctx.projectDir, '.lumem'))).toBe(false)
  })

  it('collects a repeated --harness flag', () => {
    const ctx = withClaude()
    const report = parse(['init', '--harness', 'claude-code', '--harness', 'codex'], ctx)

    expect(report.harnesses.filter((h) => h.selected).map((h) => h.id)).toEqual([
      'claude-code',
      'codex',
    ])

    const { config } = readConfig(path.join(ctx.projectDir, '.lumem'))
    expect(Object.keys(config?.harnesses ?? {})).toEqual(['claude-code', 'codex'])
  })
})
