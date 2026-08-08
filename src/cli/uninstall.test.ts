import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CliContext } from './context'
import { runInit } from './init'
import { runInstall, setInstallDirs } from './install'
import {
  type UninstallReport,
  registerUninstallCommand,
  renderUninstall,
  runUninstall,
} from './uninstall'

const realAdaptersDir = fileURLToPath(new URL('../adapters', import.meta.url))

const SKILLS = ['alpha-skill', 'beta-skill']

/** Everything install produces for claude-code, plus the shared bundles. */
const CLAUDE_ARTIFACTS = [
  'hook-bundle:lumem-hook',
  'hook-bundle:lumem-runner',
  'hook-config:claude-code',
  'skill:alpha-skill@claude-code',
  'skill:beta-skill@claude-code',
]

const CLAUDE_FILES = [
  '.claude/skills/alpha-skill/SKILL.md',
  '.claude/skills/beta-skill/SKILL.md',
  '.claude/settings.json',
]

const CODEX_FILES = [
  '.agents/skills/alpha-skill/SKILL.md',
  '.agents/skills/beta-skill/SKILL.md',
  '.codex/hooks.json',
]

const BUNDLE_FILES = ['.lumem/bin/lumem-hook.mjs', '.lumem/bin/lumem-runner.mjs']

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// Fixtures. NEVER the real home nor the real assets/dist: HOME and PATH are
// always injected and the resolvers are always pointed at these temp dirs.
let assetsDir: string
let distDir: string
let emptyPathDir: string

beforeAll(() => {
  assetsDir = tmpDir('lumem-uninstall-assets-')
  for (const name of SKILLS) {
    const dir = path.join(assetsDir, 'skills', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`)
  }
  for (const harness of ['claude-code', 'codex']) {
    const dir = path.join(assetsDir, 'harness', harness)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'hooks.tmpl.json'), '{\n  "bundle": "{{HOOK_BUNDLE}}"\n}\n')
  }

  distDir = tmpDir('lumem-uninstall-dist-')
  fs.writeFileSync(path.join(distDir, 'lumem-hook.mjs'), 'export const hook = 1\n')
  fs.writeFileSync(path.join(distDir, 'lumem-runner.mjs'), 'export const runner = 1\n')

  emptyPathDir = tmpDir('lumem-uninstall-path-')
})

beforeEach(() => {
  setInstallDirs({ assetsDir, distDir })
})

afterEach(() => {
  setInstallDirs({})
})

/** A fake home where only the named harnesses are detectable. */
function makeHome(harnesses: string[]): string {
  const home = tmpDir('lumem-uninstall-home-')
  for (const id of harnesses) {
    fs.mkdirSync(path.join(home, id === 'claude-code' ? '.claude' : '.codex'))
  }
  return home
}

function makeCtx(home: string): CliContext {
  return {
    projectDir: tmpDir('lumem-uninstall-proj-'),
    adaptersDir: realAdaptersDir,
    env: { HOME: home, PATH: emptyPathDir },
    json: false,
  }
}

function abs(ctx: CliContext, relative: string): string {
  return path.join(ctx.projectDir, relative)
}

/** Init + install, asserting both succeeded, so uninstall tests start from a real install. */
function installed(harnesses?: string[], home?: string): CliContext {
  const ctx = makeCtx(home ?? makeHome(harnesses ?? ['claude-code']))
  expect(runInit(ctx, harnesses !== undefined ? { harnesses } : {}).exitCode).toBe(0)
  expect(runInstall(ctx, harnesses !== undefined ? { harnesses } : {}).exitCode).toBe(0)
  return ctx
}

function lockArtifactIds(ctx: CliContext): string[] {
  const raw = fs.readFileSync(abs(ctx, '.lumem/lumem-lock.json'), 'utf8')
  const lock = JSON.parse(raw) as { entries: { artifactId: string }[] }
  return lock.entries.map((entry) => entry.artifactId).sort()
}

/** Full recursive picture of a tree: contents for files, targets for symlinks. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, prefix: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) {
        out[relative] = `symlink:${fs.readlinkSync(absolute)}`
      } else if (entry.isDirectory()) {
        out[`${relative}/`] = '<dir>'
        walk(absolute, relative)
      } else {
        out[relative] = fs.readFileSync(absolute, 'utf8')
      }
    }
  }
  if (fs.existsSync(root)) walk(root, '')
  return out
}

/** Keys present in `after` that are absent from `before` or whose content changed. */
function diffKeys(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((key) => before[key] !== after[key]).sort()
}

describe('runUninstall with nothing installed', () => {
  it('exits 0 with a clear message and writes nothing when .lumem does not exist', () => {
    const ctx = makeCtx(makeHome(['claude-code']))
    fs.writeFileSync(abs(ctx, 'README.md'), '# mine\n')
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runUninstall(ctx)

    expect(exitCode).toBe(0)
    expect(report.removed).toEqual([])
    expect(report.errors).toEqual([])
    expect(report.purged).toBe(false)
    expect(report.notes.join('\n')).toContain('nothing to remove')
    expect(renderUninstall(report)).toContain('nothing to remove')
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })

  it('exits 0 and touches nothing when the lockfile is empty', () => {
    const ctx = makeCtx(makeHome(['claude-code']))
    expect(runInit(ctx).exitCode).toBe(0)
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runUninstall(ctx)

    expect(exitCode).toBe(0)
    expect(report.removed).toEqual([])
    expect(report.notes.join('\n')).toContain('nothing to remove')
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })

  it('exits 0 and touches nothing when the lockfile is corrupt', () => {
    const ctx = makeCtx(makeHome(['claude-code']))
    expect(runInit(ctx).exitCode).toBe(0)
    fs.writeFileSync(abs(ctx, '.lumem/lumem-lock.json'), 'not json at all')
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runUninstall(ctx)

    expect(exitCode).toBe(0)
    expect(report.removed).toEqual([])
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })
})

describe('runUninstall removes everything the lockfile tracks', () => {
  it('removes every artifact and empties the lockfile', () => {
    const ctx = installed()

    const { report, exitCode } = runUninstall(ctx)

    expect(exitCode).toBe(0)
    expect(report.errors).toEqual([])
    expect(report.dryRun).toBe(false)
    expect(report.removed.map((entry) => entry.artifactId).sort()).toEqual([...CLAUDE_ARTIFACTS])
    for (const file of [...CLAUDE_FILES, ...BUNDLE_FILES]) {
      expect(fs.existsSync(abs(ctx, file))).toBe(false)
    }
    expect(lockArtifactIds(ctx)).toEqual([])
  })

  it('reports the absolute destination of every removed artifact', () => {
    const ctx = installed()

    const { report } = runUninstall(ctx)

    for (const entry of report.removed) {
      expect(path.isAbsolute(entry.destPath)).toBe(true)
    }
    expect(report.removed.map((entry) => entry.destPath)).toContain(
      abs(ctx, '.claude/skills/alpha-skill/SKILL.md'),
    )
  })

  it('prunes the directories it emptied, leaving no harness leftovers', () => {
    const ctx = installed()

    runUninstall(ctx)

    expect(fs.existsSync(abs(ctx, '.claude'))).toBe(false)
    expect(fs.existsSync(abs(ctx, '.lumem/bin'))).toBe(false)
  })

  it('keeps directories that still hold user files', () => {
    const ctx = installed()
    fs.writeFileSync(abs(ctx, '.claude/mine.json'), '{}\n')

    runUninstall(ctx)

    expect(fs.readFileSync(abs(ctx, '.claude/mine.json'), 'utf8')).toBe('{}\n')
    expect(fs.existsSync(abs(ctx, '.claude/skills'))).toBe(false)
  })

  it('is idempotent: a second run has nothing left to do', () => {
    const ctx = installed()
    expect(runUninstall(ctx).exitCode).toBe(0)
    const afterFirst = snapshot(ctx.projectDir)

    const { report, exitCode } = runUninstall(ctx)

    expect(exitCode).toBe(0)
    expect(report.removed).toEqual([])
    expect(snapshot(ctx.projectDir)).toEqual(afterFirst)
  })
})

describe('runUninstall keeps memory', () => {
  it('leaves .lumem/memory and lumem.config.json byte-identical', () => {
    const ctx = installed()
    const memoryDir = abs(ctx, '.lumem/memory')
    fs.mkdirSync(path.join(memoryDir, 'projects'), { recursive: true })
    fs.writeFileSync(path.join(memoryDir, 'projects', 'api.md'), '# api\n\n- decision: use zod\n')
    fs.writeFileSync(path.join(memoryDir, 'preferences.md'), '# prefs\n\n- tabs are evil\n')

    const memoryBefore = snapshot(memoryDir)
    const configBefore = fs.readFileSync(abs(ctx, '.lumem/lumem.config.json'))

    const { report, exitCode } = runUninstall(ctx)

    expect(exitCode).toBe(0)
    expect(report.purged).toBe(false)
    expect(snapshot(memoryDir)).toEqual(memoryBefore)
    expect(fs.readFileSync(abs(ctx, '.lumem/lumem.config.json'))).toEqual(configBefore)
    expect(fs.existsSync(abs(ctx, '.lumem'))).toBe(true)
  })
})

describe('runUninstall --harness', () => {
  function installBoth(): CliContext {
    return installed(['claude-code', 'codex'], makeHome(['claude-code', 'codex']))
  }

  it('removes only the named harness and keeps the shared bundles for the other', () => {
    const ctx = installBoth()

    const { report, exitCode } = runUninstall(ctx, { harnesses: ['codex'] })

    expect(exitCode).toBe(0)
    expect(report.errors).toEqual([])
    for (const file of CODEX_FILES) {
      expect(fs.existsSync(abs(ctx, file))).toBe(false)
    }
    for (const file of [...CLAUDE_FILES, ...BUNDLE_FILES]) {
      expect(fs.existsSync(abs(ctx, file))).toBe(true)
    }
    expect(lockArtifactIds(ctx)).toEqual([...CLAUDE_ARTIFACTS])
  })

  it('skips the shared bundles with a reason naming the harness that still uses them', () => {
    const ctx = installBoth()

    const { report } = runUninstall(ctx, { harnesses: ['codex'] })

    const bundle = report.skipped.find((entry) => entry.artifactId === 'hook-bundle:lumem-hook')
    expect(bundle?.reason).toContain('claude-code')
    expect(report.skipped.map((entry) => entry.artifactId)).toContain(
      'skill:alpha-skill@claude-code',
    )
  })

  it('removes the harness hook-config even though its id carries no @suffix', () => {
    const ctx = installBoth()

    const { report } = runUninstall(ctx, { harnesses: ['codex'] })

    expect(report.removed.map((entry) => entry.artifactId)).toContain('hook-config:codex')
    expect(fs.existsSync(abs(ctx, '.codex/hooks.json'))).toBe(false)
    expect(fs.existsSync(abs(ctx, '.claude/settings.json'))).toBe(true)
  })

  it('removes the shared bundles once the last harness goes', () => {
    const ctx = installBoth()
    runUninstall(ctx, { harnesses: ['codex'] })

    const { exitCode } = runUninstall(ctx, { harnesses: ['claude-code'] })

    expect(exitCode).toBe(0)
    for (const file of BUNDLE_FILES) {
      expect(fs.existsSync(abs(ctx, file))).toBe(false)
    }
    expect(lockArtifactIds(ctx)).toEqual([])
  })

  it('notes a harness id the lockfile knows nothing about and removes nothing', () => {
    const ctx = installed()
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runUninstall(ctx, { harnesses: ['emacs-doctor'] })

    expect(exitCode).toBe(0)
    expect(report.removed).toEqual([])
    expect(report.notes.join('\n')).toContain('emacs-doctor')
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })
})

describe('runUninstall --purge', () => {
  it('deletes the whole .lumem directory, memory included', () => {
    const ctx = installed()
    fs.writeFileSync(abs(ctx, '.lumem/memory/notes.md'), '# notes\n')

    const { report, exitCode } = runUninstall(ctx, { purge: true })

    expect(exitCode).toBe(0)
    expect(report.errors).toEqual([])
    expect(report.purged).toBe(true)
    expect(fs.existsSync(abs(ctx, '.lumem'))).toBe(false)
    expect(fs.existsSync(abs(ctx, '.claude'))).toBe(false)
    expect(renderUninstall(report)).toContain('purge')
  })

  it('never purges from a bare uninstall', () => {
    const ctx = installed()

    const { report } = runUninstall(ctx)

    expect(report.purged).toBe(false)
    expect(fs.existsSync(abs(ctx, '.lumem/lumem.config.json'))).toBe(true)
  })

  it('never purges when the flag is explicitly false', () => {
    const ctx = installed()

    const { report, exitCode } = runUninstall(ctx, { purge: false })

    expect(exitCode).toBe(0)
    expect(report.purged).toBe(false)
    expect(fs.existsSync(abs(ctx, '.lumem'))).toBe(true)
  })

  it('refuses a truthy-but-not-true purge with exit 1 and deletes nothing', () => {
    const ctx = installed()
    const before = snapshot(ctx.projectDir)

    // an untyped caller (JSON, argv parsing) handing over anything but `true`
    const { report, exitCode } = runUninstall(ctx, { purge: 'yes' as unknown as boolean })

    expect(exitCode).toBe(1)
    expect(report.purged).toBe(false)
    expect(report.removed).toEqual([])
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]?.message).toContain('purge')
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })

  it('purges nothing on a dry run and says what it would delete', () => {
    const ctx = installed()
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runUninstall(ctx, { purge: true, dryRun: true })

    expect(exitCode).toBe(0)
    expect(report.purged).toBe(false)
    expect(report.notes.join('\n')).toContain('.lumem')
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })

  it('purges even when the lockfile tracks nothing', () => {
    const ctx = makeCtx(makeHome(['claude-code']))
    expect(runInit(ctx).exitCode).toBe(0)

    const { report, exitCode } = runUninstall(ctx, { purge: true })

    expect(exitCode).toBe(0)
    expect(report.purged).toBe(true)
    expect(fs.existsSync(abs(ctx, '.lumem'))).toBe(false)
  })
})

describe('runUninstall restores files lumem wrote into', () => {
  const settings = '.claude/settings.json'
  const userSettings = '{\n  "permissions": { "allow": ["Bash(ls:*)"] }\n}\n'

  it('brings a shared file back exactly as the user had it', () => {
    const ctx = makeCtx(makeHome(['claude-code']))
    expect(runInit(ctx).exitCode).toBe(0)
    fs.mkdirSync(abs(ctx, '.claude'), { recursive: true })
    fs.writeFileSync(abs(ctx, settings), userSettings)

    // --force: install owns the file and keeps the user's bytes as a backup
    const install = runInstall(ctx, { force: true })
    expect(install.exitCode).toBe(0)
    expect(fs.readFileSync(abs(ctx, settings), 'utf8')).not.toBe(userSettings)

    const { report, exitCode } = runUninstall(ctx)

    expect(exitCode).toBe(0)
    expect(fs.readFileSync(abs(ctx, settings), 'utf8')).toBe(userSettings)
    const restored = report.removed.find((entry) => entry.artifactId === 'hook-config:claude-code')
    expect(restored?.backupPath).toBeDefined()
  })

  it('deletes the file when lumem created it and it holds nothing else', () => {
    const ctx = installed()
    expect(fs.existsSync(abs(ctx, settings))).toBe(true)

    const { report, exitCode } = runUninstall(ctx)

    expect(exitCode).toBe(0)
    expect(fs.existsSync(abs(ctx, settings))).toBe(false)
    const removed = report.removed.find((entry) => entry.artifactId === 'hook-config:claude-code')
    expect(removed?.backupPath).toBeUndefined()
  })
})

describe('runUninstall --dry-run', () => {
  it('writes and deletes nothing while reporting everything it would remove', () => {
    const ctx = installed()
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runUninstall(ctx, { dryRun: true })

    expect(exitCode).toBe(0)
    expect(report.dryRun).toBe(true)
    expect(report.removed.map((entry) => entry.artifactId).sort()).toEqual([...CLAUDE_ARTIFACTS])
    expect(report.errors).toEqual([])
    expect(snapshot(ctx.projectDir)).toEqual(before)
    expect(lockArtifactIds(ctx)).toEqual([...CLAUDE_ARTIFACTS])
  })

  it('honors the harness filter on a dry run too', () => {
    const ctx = installed(['claude-code', 'codex'], makeHome(['claude-code', 'codex']))
    const before = snapshot(ctx.projectDir)

    const { report } = runUninstall(ctx, { harnesses: ['codex'], dryRun: true })

    expect(report.removed.map((entry) => entry.artifactId).sort()).toEqual([
      'hook-config:codex',
      'skill:alpha-skill@codex',
      'skill:beta-skill@codex',
    ])
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })
})

describe('install → uninstall round-trip', () => {
  const CLAUDE_MD = [
    '# Project Atlas',
    '',
    'Rules for agents working here:',
    '',
    '- Run `npm test` before every commit.',
    '- Never edit `generated/` by hand.',
    '',
  ].join('\n')

  const AGENTS_MD = [
    '# Agents',
    '',
    'This repo is TypeScript ESM. Use two-space indentation.',
    '',
  ].join('\n')

  it('leaves the project exactly as it was, apart from .lumem', () => {
    const home = makeHome(['claude-code', 'codex'])
    const ctx = makeCtx(home)

    // a real project: two context docs plus an unrelated user file
    fs.writeFileSync(abs(ctx, 'CLAUDE.md'), CLAUDE_MD)
    fs.writeFileSync(abs(ctx, 'AGENTS.md'), AGENTS_MD)
    fs.mkdirSync(abs(ctx, 'src'), { recursive: true })
    fs.writeFileSync(abs(ctx, 'src/index.ts'), 'export const answer = 42\n')

    const projectBefore = snapshot(ctx.projectDir)
    const homeBefore = snapshot(home)

    expect(runInit(ctx).exitCode).toBe(0)

    // memory written between init and install: it must survive untouched
    fs.writeFileSync(abs(ctx, '.lumem/memory/projects.md'), '# projects\n\n- atlas ships weekly\n')
    const memoryBefore = snapshot(abs(ctx, '.lumem/memory'))

    expect(runInstall(ctx).exitCode).toBe(0)
    for (const file of [...CLAUDE_FILES, ...CODEX_FILES, ...BUNDLE_FILES]) {
      expect(fs.existsSync(abs(ctx, file))).toBe(true)
    }

    const { report, exitCode } = runUninstall(ctx)

    expect(exitCode).toBe(0)
    expect(report.errors).toEqual([])
    expect(report.skipped).toEqual([])

    const projectAfter = snapshot(ctx.projectDir)

    // 1. every difference left under the project lives inside .lumem
    const differences = diffKeys(projectBefore, projectAfter)
    expect(differences.filter((key) => !key.startsWith('.lumem'))).toEqual([])
    expect(differences).toContain('.lumem/')

    // 2. every user file is byte-identical
    for (const key of Object.keys(projectBefore)) {
      expect([key, projectAfter[key]]).toEqual([key, projectBefore[key]])
    }
    expect(fs.readFileSync(abs(ctx, 'CLAUDE.md'), 'utf8')).toBe(CLAUDE_MD)
    expect(fs.readFileSync(abs(ctx, 'AGENTS.md'), 'utf8')).toBe(AGENTS_MD)

    // 3. no lumem artifact is left anywhere
    for (const dir of ['.claude', '.codex', '.agents', '.lumem/bin']) {
      expect(fs.existsSync(abs(ctx, dir))).toBe(false)
    }
    expect(lockArtifactIds(ctx)).toEqual([])
    expect(snapshot(home)).toEqual(homeBefore)

    // 4. memory is intact
    expect(snapshot(abs(ctx, '.lumem/memory'))).toEqual(memoryBefore)
    expect(fs.existsSync(abs(ctx, '.lumem/lumem.config.json'))).toBe(true)
  })

  it('leaves nothing at all behind when the round-trip ends with --purge', () => {
    const ctx = makeCtx(makeHome(['claude-code', 'codex']))
    fs.writeFileSync(abs(ctx, 'CLAUDE.md'), CLAUDE_MD)
    const before = snapshot(ctx.projectDir)

    expect(runInit(ctx).exitCode).toBe(0)
    expect(runInstall(ctx).exitCode).toBe(0)

    const { report, exitCode } = runUninstall(ctx, { purge: true })

    expect(exitCode).toBe(0)
    expect(report.purged).toBe(true)
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })
})

describe('runUninstall failures', () => {
  it('exits 1 and keeps going when a destination cannot be removed', () => {
    const ctx = installed()
    const skill = abs(ctx, '.claude/skills/alpha-skill/SKILL.md')
    fs.unlinkSync(skill)
    // a directory where the artifact was: removing it is refused, not forced
    fs.mkdirSync(skill)

    const { report, exitCode } = runUninstall(ctx)

    expect(exitCode).toBe(1)
    expect(report.errors.map((entry) => entry.artifactId)).toEqual([
      'skill:alpha-skill@claude-code',
    ])
    expect(fs.statSync(skill).isDirectory()).toBe(true)
    // the other artifacts still went
    expect(report.removed).toHaveLength(CLAUDE_ARTIFACTS.length - 1)
    expect(fs.existsSync(abs(ctx, '.claude/skills/beta-skill/SKILL.md'))).toBe(false)
    // and the failed one stays tracked, so a later run can retry it
    expect(lockArtifactIds(ctx)).toEqual(['skill:alpha-skill@claude-code'])
  })
})

describe('UninstallReport', () => {
  it('round-trips through JSON', () => {
    const ctx = installed()
    const { report } = runUninstall(ctx)

    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })
})

describe('renderUninstall', () => {
  it('lists every removed artifact and its destination', () => {
    const ctx = installed()
    const text = renderUninstall(runUninstall(ctx).report)

    expect(text).toContain('skill:alpha-skill@claude-code')
    expect(text).toContain(abs(ctx, '.claude/skills/alpha-skill/SKILL.md'))
  })

  it('announces a dry run', () => {
    const ctx = installed()

    expect(renderUninstall(runUninstall(ctx, { dryRun: true }).report)).toContain('dry-run')
  })

  it('returns a non-empty string for every report', () => {
    const ctx = installed()

    expect(renderUninstall(runUninstall(ctx, { dryRun: true }).report).length).toBeGreaterThan(0)
    expect(renderUninstall(runUninstall(ctx).report).length).toBeGreaterThan(0)
    expect(renderUninstall(runUninstall(ctx).report).length).toBeGreaterThan(0)
  })
})

describe('registerUninstallCommand', () => {
  function parse(argv: string[], ctx: CliContext): UninstallReport {
    const program = new Command()
    program.exitOverride()
    let captured: UninstallReport | undefined
    registerUninstallCommand(
      program,
      () => ctx,
      (_json, report) => {
        captured = report as UninstallReport
      },
    )
    const previousExitCode = process.exitCode
    program.parse(['node', 'lumem', ...argv])
    process.exitCode = previousExitCode
    if (captured === undefined) throw new Error('emit was never called')
    return captured
  }

  it('runs a dry-run uninstall from the command line', () => {
    const ctx = installed()
    const before = snapshot(ctx.projectDir)

    const report = parse(['uninstall', '--dry-run'], ctx)

    expect(report.dryRun).toBe(true)
    expect(report.removed).toHaveLength(CLAUDE_ARTIFACTS.length)
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })

  it('passes --harness through', () => {
    const ctx = installed(['claude-code', 'codex'], makeHome(['claude-code', 'codex']))

    const report = parse(['uninstall', '--harness', 'codex'], ctx)

    expect(report.removed.map((entry) => entry.artifactId)).toContain('skill:alpha-skill@codex')
    expect(fs.existsSync(abs(ctx, '.claude/skills/alpha-skill/SKILL.md'))).toBe(true)
  })

  it('does not purge without --purge', () => {
    const ctx = installed()

    const report = parse(['uninstall'], ctx)

    expect(report.purged).toBe(false)
    expect(fs.existsSync(abs(ctx, '.lumem'))).toBe(true)
  })

  it('passes --purge through', () => {
    const ctx = installed()

    const report = parse(['uninstall', '--purge'], ctx)

    expect(report.purged).toBe(true)
    expect(fs.existsSync(abs(ctx, '.lumem'))).toBe(false)
  })
})
