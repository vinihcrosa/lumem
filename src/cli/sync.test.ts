import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CliContext } from './context'
import { runInit } from './init'
import { runInstall, setInstallDirs } from './install'
import { type SyncReport, registerSyncCommand, renderSync, runSync } from './sync'

const realAdaptersDir = fileURLToPath(new URL('../adapters', import.meta.url))

const SKILLS = ['alpha-skill', 'beta-skill']

/** Everything the fake assets + dist dirs produce for a single harness. */
const CLAUDE_ARTIFACTS = [
  'hook-bundle:lumem-hook',
  'hook-bundle:lumem-runner',
  'hook-bundle:lumem-spec',
  'hook-config:claude-code',
  'skill:alpha-skill@claude-code',
  'skill:beta-skill@claude-code',
]

const ALPHA = 'skill:alpha-skill@claude-code'
const ALPHA_FILE = '.claude/skills/alpha-skill/SKILL.md'

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** A self-contained assets tree; a fresh one per call so a test may mutate its sources. */
function makeAssets(): string {
  const dir = tmpDir('lumem-sync-assets-')
  for (const name of SKILLS) {
    const skillDir = path.join(dir, 'skills', name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${name}\n`)
  }
  for (const harness of ['claude-code', 'codex']) {
    const harnessDir = path.join(dir, 'harness', harness)
    fs.mkdirSync(harnessDir, { recursive: true })
    fs.writeFileSync(
      path.join(harnessDir, 'hooks.tmpl.json'),
      '{\n  "bundle": "{{HOOK_BUNDLE}}"\n}\n',
    )
  }
  return dir
}

// Fixtures. NEVER the real home nor the real assets/dist: HOME and PATH are
// always injected and the resolvers are always pointed at these temp dirs.
let assetsDir: string
let distDir: string
let emptyPathDir: string

beforeAll(() => {
  assetsDir = makeAssets()

  distDir = tmpDir('lumem-sync-dist-')
  fs.writeFileSync(path.join(distDir, 'lumem-hook.mjs'), 'export const hook = 1\n')
  fs.writeFileSync(path.join(distDir, 'lumem-runner.mjs'), 'export const runner = 1\n')
  fs.writeFileSync(path.join(distDir, 'lumem-spec.mjs'), 'export const spec = 1\n')

  emptyPathDir = tmpDir('lumem-sync-path-')
})

beforeEach(() => {
  setInstallDirs({ assetsDir, distDir })
})

afterEach(() => {
  setInstallDirs({})
})

/** A fake home where only the named harnesses are detectable. */
function makeHome(harnesses: string[]): string {
  const home = tmpDir('lumem-sync-home-')
  for (const id of harnesses) {
    fs.mkdirSync(path.join(home, id === 'claude-code' ? '.claude' : '.codex'))
  }
  return home
}

function makeCtx(home: string): CliContext {
  return {
    projectDir: tmpDir('lumem-sync-proj-'),
    adaptersDir: realAdaptersDir,
    env: { HOME: home, PATH: emptyPathDir },
    json: false,
  }
}

function abs(ctx: CliContext, relative: string): string {
  return path.join(ctx.projectDir, relative)
}

/** An initialized project with every artifact already installed. */
function installedProject(): CliContext {
  const ctx = makeCtx(makeHome(['claude-code']))
  expect(runInit(ctx, {}).exitCode).toBe(0)
  expect(runInstall(ctx).exitCode).toBe(0)
  return ctx
}

/** Flip the project config to copy mode, so destinations hold real bytes. */
function useCopyMode(ctx: CliContext): void {
  const configPath = abs(ctx, '.lumem/lumem.config.json')
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, 'utf8')
      .replaceAll('"installMode": "symlink"', '"installMode": "copy"'),
  )
}

/** Replace a managed symlink with a regular file, exactly as an editor would. */
function userEdit(ctx: CliContext, relative: string, content: string): void {
  const file = abs(ctx, relative)
  fs.rmSync(file, { force: true })
  fs.writeFileSync(file, content)
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

/** Every file kept under .lumem/local/backups, by content. */
function backupContents(ctx: CliContext): string[] {
  const root = abs(ctx, '.lumem/local/backups')
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else found.push(fs.readFileSync(absolute, 'utf8'))
    }
  }
  if (fs.existsSync(root)) walk(root)
  return found
}

describe('runSync without .lumem', () => {
  it('exits 1 telling the user to run `lumem init`, and writes nothing', () => {
    const ctx = makeCtx(makeHome(['claude-code']))
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runSync(ctx)

    expect(exitCode).toBe(1)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]?.message).toContain('lumem init')
    expect(report.drift).toEqual([])
    expect(report.actions).toEqual([])
    expect(report.applied).toEqual([])
    expect(snapshot(ctx.projectDir)).toEqual(before)
    expect(renderSync(report)).toContain('lumem init')
  })
})

describe('runSync with everything up-to-date', () => {
  it('has nothing to do: no drift, no actions, exit 0', () => {
    const ctx = installedProject()
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runSync(ctx)

    expect(exitCode).toBe(0)
    expect(report.errors).toEqual([])
    expect(report.drift).toEqual([])
    expect(report.actions).toEqual([])
    expect(report.applied).toEqual([])
    expect(report.skipped).toHaveLength(CLAUDE_ARTIFACTS.length)
    expect(report.skipped.every((entry) => entry.reason === 'up-to-date')).toBe(true)
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })
})

describe('runSync reconciliation', () => {
  it('reports a deleted destination as drift and reinstalls it', () => {
    const ctx = installedProject()
    fs.rmSync(abs(ctx, ALPHA_FILE), { force: true })

    const { report, exitCode } = runSync(ctx)

    expect(exitCode).toBe(0)
    expect(report.drift).toEqual([
      { artifactId: ALPHA, destPath: abs(ctx, ALPHA_FILE), state: 'missing' },
    ])
    expect(report.actions).toEqual([
      {
        artifactId: ALPHA,
        type: 'create',
        destPath: abs(ctx, ALPHA_FILE),
        reason: 'reinstall missing',
      },
    ])
    expect(report.applied.map((entry) => entry.artifactId)).toEqual([ALPHA])
    expect(fs.existsSync(abs(ctx, ALPHA_FILE))).toBe(true)
  })

  it('updates an artifact whose source changed, with no --force and no drift', () => {
    const assets = makeAssets()
    setInstallDirs({ assetsDir: assets, distDir })
    const ctx = makeCtx(makeHome(['claude-code']))
    expect(runInit(ctx, {}).exitCode).toBe(0)
    useCopyMode(ctx)
    expect(runInstall(ctx).exitCode).toBe(0)

    fs.writeFileSync(path.join(assets, 'skills', 'alpha-skill', 'SKILL.md'), '# alpha-skill v2\n')

    const { report, exitCode } = runSync(ctx)

    expect(exitCode).toBe(0)
    expect(report.drift).toEqual([])
    expect(report.actions.map((action) => ({ id: action.artifactId, type: action.type }))).toEqual([
      { id: ALPHA, type: 'update' },
    ])
    expect(report.applied).toEqual([
      { artifactId: ALPHA, action: 'update', destPath: abs(ctx, ALPHA_FILE) },
    ])
    expect(fs.readFileSync(abs(ctx, ALPHA_FILE), 'utf8')).toBe('# alpha-skill v2\n')
  })
})

describe('runSync drift protection (FR-15)', () => {
  it('never overwrites a user-edited file: drift + conflict + exit 3', () => {
    const ctx = installedProject()
    userEdit(ctx, ALPHA_FILE, '# mine\n')
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runSync(ctx)

    expect(exitCode).toBe(3)
    expect(report.errors).toEqual([])
    expect(report.drift.map((entry) => ({ id: entry.artifactId, state: entry.state }))).toEqual([
      { id: ALPHA, state: 'modified' },
    ])
    expect(report.actions).toHaveLength(1)
    expect(report.actions[0]?.type).toBe('conflict')
    expect(report.actions[0]?.artifactId).toBe(ALPHA)
    expect(report.skipped.map((entry) => entry.artifactId)).toContain(ALPHA)
    expect(report.applied).toEqual([])
    expect(fs.readFileSync(abs(ctx, ALPHA_FILE), 'utf8')).toBe('# mine\n')
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })

  it('notes that the destination replaced a symlink', () => {
    const ctx = installedProject()
    userEdit(ctx, ALPHA_FILE, '# mine\n')

    const { report } = runSync(ctx)

    expect(report.drift[0]?.note).toBe('replaced-by-file')
  })
})

describe('runSync --force', () => {
  it('overwrites the drifted file, keeps a backup, and exits 0', () => {
    const ctx = installedProject()
    userEdit(ctx, ALPHA_FILE, '# mine\n')

    const { report, exitCode } = runSync(ctx, { force: true })

    expect(exitCode).toBe(0)
    expect(report.errors).toEqual([])
    expect(report.drift.map((entry) => entry.artifactId)).toEqual([ALPHA])
    expect(report.actions[0]?.type).toBe('update')
    expect(report.applied.map((entry) => entry.artifactId)).toEqual([ALPHA])
    expect(fs.lstatSync(abs(ctx, ALPHA_FILE)).isSymbolicLink()).toBe(true)
    expect(backupContents(ctx)).toContain('# mine\n')
  })
})

describe('runSync --dry-run', () => {
  it('writes nothing and still reports drift and the planned actions', () => {
    const ctx = installedProject()
    userEdit(ctx, ALPHA_FILE, '# mine\n')
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runSync(ctx, { dryRun: true })

    expect(exitCode).toBe(3)
    expect(report.dryRun).toBe(true)
    expect(report.drift.map((entry) => entry.artifactId)).toEqual([ALPHA])
    expect(report.actions.map((action) => action.type)).toEqual(['conflict'])
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })

  it('keeps a --force dry run free of writes and backups', () => {
    const ctx = installedProject()
    userEdit(ctx, ALPHA_FILE, '# mine\n')
    const before = snapshot(ctx.projectDir)

    const { report } = runSync(ctx, { force: true, dryRun: true })

    expect(report.applied.map((entry) => entry.action)).toEqual(['would-update'])
    expect(backupContents(ctx)).toEqual([])
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })
})

describe('runSync --harness', () => {
  it('reconciles only the named harness', () => {
    const ctx = makeCtx(makeHome(['claude-code']))
    expect(runInit(ctx, { harnesses: ['claude-code', 'codex'] }).exitCode).toBe(0)

    const { report, exitCode } = runSync(ctx, { harnesses: ['codex'] })

    expect(exitCode).toBe(0)
    expect(report.actions.every((action) => !action.artifactId.includes('claude-code'))).toBe(true)
    expect(fs.existsSync(abs(ctx, '.agents/skills/alpha-skill/SKILL.md'))).toBe(true)
    expect(fs.existsSync(abs(ctx, ALPHA_FILE))).toBe(false)
  })
})

describe('SyncReport', () => {
  it('round-trips through JSON', () => {
    const ctx = installedProject()
    userEdit(ctx, ALPHA_FILE, '# mine\n')

    const { report } = runSync(ctx)

    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })
})

describe('renderSync', () => {
  it('lists drift, the conflict and the --force hint', () => {
    const ctx = installedProject()
    userEdit(ctx, ALPHA_FILE, '# mine\n')

    const text = renderSync(runSync(ctx).report)

    expect(text).toContain('drift:')
    expect(text).toContain(abs(ctx, ALPHA_FILE))
    expect(text).toContain('conflict')
    expect(text).toContain('--force')
  })

  it('says everything is in sync when there is nothing to report', () => {
    expect(
      renderSync({ drift: [], actions: [], applied: [], skipped: [], errors: [], dryRun: false }),
    ).toBe('everything in sync')
  })

  it('announces a dry run', () => {
    const ctx = installedProject()
    fs.rmSync(abs(ctx, ALPHA_FILE), { force: true })

    expect(renderSync(runSync(ctx, { dryRun: true }).report)).toContain('dry-run')
  })
})

describe('registerSyncCommand', () => {
  function parse(argv: string[], ctx: CliContext): SyncReport {
    const program = new Command()
    program.exitOverride()
    let captured: SyncReport | undefined
    registerSyncCommand(
      program,
      () => ctx,
      (_json, report) => {
        captured = report as SyncReport
      },
    )
    const previousExitCode = process.exitCode
    program.parse(['node', 'lumem', ...argv])
    process.exitCode = previousExitCode
    if (captured === undefined) throw new Error('emit was never called')
    return captured
  }

  it('runs a dry-run sync from the command line', () => {
    const ctx = installedProject()
    userEdit(ctx, ALPHA_FILE, '# mine\n')
    const before = snapshot(ctx.projectDir)

    const report = parse(['sync', '--dry-run'], ctx)

    expect(report.dryRun).toBe(true)
    expect(report.drift.map((entry) => entry.artifactId)).toEqual([ALPHA])
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })

  it('passes --force through', () => {
    const ctx = installedProject()
    userEdit(ctx, ALPHA_FILE, '# mine\n')

    const report = parse(['sync', '--force'], ctx)

    expect(report.applied.map((entry) => entry.artifactId)).toEqual([ALPHA])
    expect(fs.lstatSync(abs(ctx, ALPHA_FILE)).isSymbolicLink()).toBe(true)
  })

  it('passes --harness through', () => {
    const ctx = makeCtx(makeHome(['claude-code']))
    expect(runInit(ctx, { harnesses: ['claude-code', 'codex'] }).exitCode).toBe(0)

    parse(['sync', '--harness', 'codex'], ctx)

    expect(fs.existsSync(abs(ctx, '.agents/skills/alpha-skill/SKILL.md'))).toBe(true)
  })
})

describe('runSync and the spec bundle (002 T5)', () => {
  it('IT-15 reports drift and refuses to overwrite an edited spec bundle', () => {
    const ctx = installedProject()
    userEdit(ctx, '.lumem/bin/lumem-spec.mjs', '// edited by hand\n')

    const { report, exitCode } = runSync(ctx)

    expect(exitCode).toBe(3)
    const drift = report.drift.find((entry) => entry.artifactId === 'hook-bundle:lumem-spec')
    expect(drift?.state).toBe('modified')
    expect(report.applied).toEqual([])
    expect(fs.readFileSync(abs(ctx, '.lumem/bin/lumem-spec.mjs'), 'utf8')).toBe(
      '// edited by hand\n',
    )
  })

  it('IT-16 --force overwrites the edited spec bundle and keeps a backup', () => {
    const ctx = installedProject()
    userEdit(ctx, '.lumem/bin/lumem-spec.mjs', '// edited by hand\n')

    const { exitCode } = runSync(ctx, { force: true })

    expect(exitCode).toBe(0)
    expect(fs.readFileSync(abs(ctx, '.lumem/bin/lumem-spec.mjs'), 'utf8')).toBe(
      'export const spec = 1\n',
    )
    expect(backupContents(ctx)).toContain('// edited by hand\n')
  })
})
