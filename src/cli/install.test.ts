import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CliContext } from './context'
import { runInit } from './init'
import {
  type InstallReport,
  registerInstallCommand,
  renderInstall,
  resolveAssetsDir,
  resolveDistDir,
  runInstall,
  setInstallDirs,
} from './install'

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

const CLAUDE_FILES = [
  '.claude/skills/alpha-skill/SKILL.md',
  '.claude/skills/beta-skill/SKILL.md',
  '.claude/settings.json',
  '.lumem/bin/lumem-hook.mjs',
  '.lumem/bin/lumem-runner.mjs',
  '.lumem/bin/lumem-spec.mjs',
]

/**
 * Shaped like the real harness templates: everything lumem injects lives under
 * `hooks.<Event>`, which is what merge-json adds to and unmerge takes back out.
 */
const HOOKS_TEMPLATE = `${JSON.stringify(
  {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node "{{HOOK_BUNDLE}}" inject' }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'node "{{HOOK_BUNDLE}}" end' }] }],
    },
  },
  null,
  2,
)}\n`

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// Fixtures. NEVER the real home nor the real assets/dist: HOME and PATH are
// always injected and the resolvers are always pointed at these temp dirs.
let assetsDir: string
let distDir: string
let emptyPathDir: string

beforeAll(() => {
  assetsDir = tmpDir('lumem-install-assets-')
  for (const name of SKILLS) {
    const dir = path.join(assetsDir, 'skills', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`)
  }
  for (const harness of ['claude-code', 'codex']) {
    const dir = path.join(assetsDir, 'harness', harness)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'hooks.tmpl.json'), HOOKS_TEMPLATE)
  }

  distDir = tmpDir('lumem-install-dist-')
  fs.writeFileSync(path.join(distDir, 'lumem-hook.mjs'), 'export const hook = 1\n')
  fs.writeFileSync(path.join(distDir, 'lumem-runner.mjs'), 'export const runner = 1\n')
  fs.writeFileSync(path.join(distDir, 'lumem-spec.mjs'), 'export const spec = 1\n')

  emptyPathDir = tmpDir('lumem-install-path-')
})

beforeEach(() => {
  setInstallDirs({ assetsDir, distDir })
})

afterEach(() => {
  setInstallDirs({})
})

/** A fake home where only the named harnesses are detectable. */
function makeHome(harnesses: string[]): string {
  const home = tmpDir('lumem-install-home-')
  for (const id of harnesses) {
    fs.mkdirSync(path.join(home, id === 'claude-code' ? '.claude' : '.codex'))
  }
  return home
}

function makeCtx(home: string): CliContext {
  return {
    projectDir: tmpDir('lumem-install-proj-'),
    adaptersDir: realAdaptersDir,
    env: { HOME: home, PATH: emptyPathDir },
    json: false,
  }
}

function initProject(ctx: CliContext, harnesses?: string[]): CliContext {
  const { exitCode } = runInit(ctx, harnesses !== undefined ? { harnesses } : {})
  expect(exitCode).toBe(0)
  return ctx
}

function abs(ctx: CliContext, relative: string): string {
  return path.join(ctx.projectDir, relative)
}

interface LockEntry {
  artifactId: string
  destPath: string
  mode: string
  hash: string
}

function readLockEntries(ctx: CliContext): LockEntry[] {
  const raw = fs.readFileSync(abs(ctx, '.lumem/lumem-lock.json'), 'utf8')
  return (JSON.parse(raw) as { entries: LockEntry[] }).entries
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

describe('runInstall without .lumem', () => {
  it('fails with exit 1, tells the user to run `lumem init`, and writes nothing', () => {
    const ctx = makeCtx(makeHome(['claude-code']))
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runInstall(ctx)

    expect(exitCode).toBe(1)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]?.message).toContain('lumem init')
    expect(report.applied).toEqual([])
    expect(report.actions).toEqual([])
    expect(snapshot(ctx.projectDir)).toEqual(before)
    expect(renderInstall(report)).toContain('lumem init')
  })
})

describe('runInstall into a configured and detected harness', () => {
  it('plans and applies every artifact of the manifest', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))

    const { report, exitCode } = runInstall(ctx)

    expect(exitCode).toBe(0)
    expect(report.errors).toEqual([])
    expect(report.harnesses).toEqual(['claude-code'])
    expect(report.dryRun).toBe(false)
    expect([...report.actions.map((a) => a.artifactId)].sort()).toEqual(
      [...CLAUDE_ARTIFACTS].sort(),
    )
    expect(report.actions.every((a) => a.type === 'create')).toBe(true)
    expect([...report.applied.map((a) => a.artifactId)].sort()).toEqual(
      [...CLAUDE_ARTIFACTS].sort(),
    )

    for (const file of CLAUDE_FILES) {
      expect(fs.existsSync(abs(ctx, file))).toBe(true)
    }
  })

  it('records every artifact in the project lockfile', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    runInstall(ctx)

    expect([...readLockEntries(ctx).map((e) => e.artifactId)].sort()).toEqual(
      [...CLAUDE_ARTIFACTS].sort(),
    )
  })

  it('renders the installed hook bundle path into the hook config', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    runInstall(ctx)

    expect(fs.readFileSync(abs(ctx, '.claude/settings.json'), 'utf8')).toContain(
      abs(ctx, '.lumem/bin/lumem-hook.mjs'),
    )
  })
})

describe('runInstall into a settings.json the user already owns', () => {
  type Json = Record<string, unknown>

  const settings = '.claude/settings.json'

  /** A settings.json as a real project holds it: permissions plus a hook of the user's own. */
  const USER_SETTINGS = `${JSON.stringify(
    {
      permissions: { allow: ['Bash(npm run test:*)'], deny: ['Bash(rm:*)'] },
      env: { FOO: 'bar' },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
      },
    },
    null,
    2,
  )}\n`

  function withUserSettings(): CliContext {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    fs.mkdirSync(abs(ctx, '.claude'), { recursive: true })
    fs.writeFileSync(abs(ctx, settings), USER_SETTINGS)
    return ctx
  }

  function read(ctx: CliContext): Json {
    return JSON.parse(fs.readFileSync(abs(ctx, settings), 'utf8')) as Json
  }

  function entriesOf(ctx: CliContext, event: string): Json[] {
    return ((read(ctx).hooks as Json)[event] ?? []) as Json[]
  }

  it('merges without --force: exit 0, no conflict, every user key intact', () => {
    const ctx = withUserSettings()

    const { report, exitCode } = runInstall(ctx)

    // a merge-json destination is not a conflict — merging is how it is honored
    expect(exitCode).toBe(0)
    expect(report.errors).toEqual([])
    expect(report.skipped).toEqual([])
    const action = report.actions.find((a) => a.artifactId === 'hook-config:claude-code')
    expect(action?.type).toBe('update')
    expect(action?.reason).toMatch(/merg/i)

    const before = JSON.parse(USER_SETTINGS) as Json
    const after = read(ctx)
    expect(Object.keys(after)).toEqual(Object.keys(before))
    expect(after.permissions).toEqual(before.permissions)
    expect(after.env).toEqual(before.env)
  })

  it("keeps the user's hook and adds lumem's beside it, marked as lumem's", () => {
    const ctx = withUserSettings()

    expect(runInstall(ctx).exitCode).toBe(0)

    const sessionStart = entriesOf(ctx, 'SessionStart')
    expect(sessionStart).toHaveLength(2)
    expect(sessionStart[0]).toEqual({ hooks: [{ type: 'command', command: 'echo mine' }] })
    expect(sessionStart[1]?.__lumem__).toBe(true)
    expect(JSON.stringify(sessionStart[1])).toContain(abs(ctx, '.lumem/bin/lumem-hook.mjs'))
    expect(entriesOf(ctx, 'SessionEnd')).toHaveLength(1)
  })

  it('keeps the user file recoverable as a backup', () => {
    const ctx = withUserSettings()

    const { report } = runInstall(ctx)

    const applied = report.applied.find((e) => e.artifactId === 'hook-config:claude-code')
    expect(applied?.backupPath).toBeDefined()
    expect(fs.readFileSync(applied?.backupPath ?? '', 'utf8')).toBe(USER_SETTINGS)
  })

  it('is idempotent: a second run skips and leaves the file byte-identical', () => {
    const ctx = withUserSettings()
    expect(runInstall(ctx).exitCode).toBe(0)
    const afterFirst = fs.readFileSync(abs(ctx, settings))

    const { report, exitCode } = runInstall(ctx)

    expect(exitCode).toBe(0)
    expect(report.applied).toEqual([])
    expect(report.skipped.every((entry) => entry.reason === 'up-to-date')).toBe(true)
    expect(fs.readFileSync(abs(ctx, settings))).toEqual(afterFirst)
  })

  it('backs up and replaces a settings.json it cannot parse', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    fs.mkdirSync(abs(ctx, '.claude'), { recursive: true })
    fs.writeFileSync(abs(ctx, settings), '{ not json at all\n')

    const { report, exitCode } = runInstall(ctx)

    expect(exitCode).toBe(0)
    const applied = report.applied.find((e) => e.artifactId === 'hook-config:claude-code')
    expect(applied?.backupPath).toBeDefined()
    expect(fs.readFileSync(applied?.backupPath ?? '', 'utf8')).toBe('{ not json at all\n')
    expect(entriesOf(ctx, 'SessionStart')).toHaveLength(1)
  })

  it('leaves an own-file harness owning its whole config', () => {
    const ctx = initProject(makeCtx(makeHome(['codex'])))

    expect(runInstall(ctx).exitCode).toBe(0)

    const written = fs.readFileSync(abs(ctx, '.codex/hooks.json'), 'utf8')
    expect(written).toBe(
      HOOKS_TEMPLATE.replaceAll('{{HOOK_BUNDLE}}', abs(ctx, '.lumem/bin/lumem-hook.mjs')),
    )
    expect(written).not.toContain('__lumem__')
  })
})

describe('runInstall --dry-run', () => {
  it('writes nothing at all and still reports the planned actions', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runInstall(ctx, { dryRun: true })

    expect(exitCode).toBe(0)
    expect(report.dryRun).toBe(true)
    expect(report.actions).toHaveLength(CLAUDE_ARTIFACTS.length)
    expect(report.applied).toHaveLength(CLAUDE_ARTIFACTS.length)
    expect(report.applied.every((entry) => entry.action.startsWith('would-'))).toBe(true)
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })
})

describe('runInstall idempotence', () => {
  it('reports zero applied and all skips on the second run, with a byte-identical lockfile', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))

    expect(runInstall(ctx).exitCode).toBe(0)
    const lockAfterFirst = fs.readFileSync(abs(ctx, '.lumem/lumem-lock.json'))
    const treeAfterFirst = snapshot(ctx.projectDir)

    const { report, exitCode } = runInstall(ctx)

    expect(exitCode).toBe(0)
    expect(report.applied).toEqual([])
    expect(report.skipped).toHaveLength(CLAUDE_ARTIFACTS.length)
    expect(report.skipped.every((entry) => entry.reason === 'up-to-date')).toBe(true)
    expect(fs.readFileSync(abs(ctx, '.lumem/lumem-lock.json'))).toEqual(lockAfterFirst)
    expect(snapshot(ctx.projectDir)).toEqual(treeAfterFirst)
  })
})

describe('runInstall install mode', () => {
  const skill = '.claude/skills/alpha-skill/SKILL.md'

  it('symlinks by default', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    runInstall(ctx)

    expect(fs.lstatSync(abs(ctx, skill)).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(abs(ctx, skill))).toBe(
      path.join(assetsDir, 'skills', 'alpha-skill', 'SKILL.md'),
    )
  })

  it('copies real bytes with --copy', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    runInstall(ctx, { copy: true })

    const stat = fs.lstatSync(abs(ctx, skill))
    expect(stat.isSymbolicLink()).toBe(false)
    expect(stat.isFile()).toBe(true)
    expect(fs.readFileSync(abs(ctx, skill), 'utf8')).toBe('# alpha-skill\n')
    expect(readLockEntries(ctx).every((entry) => entry.mode === 'copy')).toBe(true)
  })

  it('honors installMode "copy" from the config when the flag is absent', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    const configPath = abs(ctx, '.lumem/lumem.config.json')
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, 'utf8')
        .replaceAll('"installMode": "symlink"', '"installMode": "copy"'),
    )

    runInstall(ctx)

    expect(fs.lstatSync(abs(ctx, skill)).isSymbolicLink()).toBe(false)
  })
})

describe('runInstall post-install notes', () => {
  it('tells the user to run /hooks for a harness that requires trust', () => {
    const ctx = initProject(makeCtx(makeHome(['codex'])))

    const { report, exitCode } = runInstall(ctx)

    expect(exitCode).toBe(0)
    expect(report.harnesses).toEqual(['codex'])
    expect(report.notes.join('\n')).toContain('/hooks')
    expect(renderInstall(report)).toContain('/hooks')
  })

  it('stays quiet about trust for a harness that does not require it', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))

    const { report } = runInstall(ctx)

    expect(report.notes.join('\n')).not.toContain('/hooks')
  })

  it('notes a harness that is configured but not detected, and leaves it out', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])), ['claude-code', 'codex'])

    const { report, exitCode } = runInstall(ctx)

    expect(exitCode).toBe(0)
    expect(report.harnesses).toEqual(['claude-code'])
    expect(
      report.notes.some((note) => note.includes('codex') && note.includes('not detected')),
    ).toBe(true)
    expect(fs.existsSync(abs(ctx, '.agents/skills/alpha-skill/SKILL.md'))).toBe(false)
  })

  it('installs an undetected harness anyway when it is named explicitly', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])), ['claude-code', 'codex'])

    const { report, exitCode } = runInstall(ctx, { harnesses: ['codex'] })

    expect(exitCode).toBe(0)
    expect(report.harnesses).toEqual(['codex'])
    expect(fs.existsSync(abs(ctx, '.agents/skills/alpha-skill/SKILL.md'))).toBe(true)
  })
})

describe('runInstall --global', () => {
  it('installs skills under the harness home derived from ctx.env.HOME', () => {
    const home = makeHome(['claude-code'])
    const ctx = initProject(makeCtx(home))

    const { exitCode } = runInstall(ctx, { global: true })

    expect(exitCode).toBe(0)
    expect(fs.existsSync(path.join(home, '.claude/skills/alpha-skill/SKILL.md'))).toBe(true)
    expect(fs.existsSync(abs(ctx, '.claude/skills/alpha-skill/SKILL.md'))).toBe(false)

    const entry = readLockEntries(ctx).find((e) => e.artifactId === 'skill:alpha-skill@claude-code')
    expect(entry?.destPath).toBe(path.join(home, '.claude/skills/alpha-skill/SKILL.md'))
  })

  it('follows the descriptor global skills path even when it leaves the harness home', () => {
    const home = makeHome(['codex'])
    const ctx = initProject(makeCtx(home))

    runInstall(ctx, { global: true })

    expect(fs.existsSync(path.join(home, '.agents/skills/alpha-skill/SKILL.md'))).toBe(true)
  })

  it('keeps the hook bundles and the lockfile in the project', () => {
    const home = makeHome(['claude-code'])
    const ctx = initProject(makeCtx(home))

    runInstall(ctx, { global: true })

    expect(fs.existsSync(abs(ctx, '.lumem/bin/lumem-hook.mjs'))).toBe(true)
    expect(fs.existsSync(abs(ctx, '.lumem/lumem-lock.json'))).toBe(true)
  })
})

describe('runInstall conflicts', () => {
  const skill = '.claude/skills/alpha-skill/SKILL.md'

  it('skips the conflicting artifact, exits 3, and leaves the file untouched', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    fs.mkdirSync(path.dirname(abs(ctx, skill)), { recursive: true })
    fs.writeFileSync(abs(ctx, skill), '# mine\n')

    const { report, exitCode } = runInstall(ctx)

    expect(exitCode).toBe(3)
    expect(report.errors).toEqual([])
    expect(report.skipped.map((entry) => entry.artifactId)).toContain(
      'skill:alpha-skill@claude-code',
    )
    expect(report.applied).toHaveLength(CLAUDE_ARTIFACTS.length - 1)
    expect(fs.readFileSync(abs(ctx, skill), 'utf8')).toBe('# mine\n')
  })

  it('takes over the file with --force, keeping a backup', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    fs.mkdirSync(path.dirname(abs(ctx, skill)), { recursive: true })
    fs.writeFileSync(abs(ctx, skill), '# mine\n')

    const { report, exitCode } = runInstall(ctx, { force: true })

    expect(exitCode).toBe(0)
    expect(report.skipped).toEqual([])
    expect(fs.lstatSync(abs(ctx, skill)).isSymbolicLink()).toBe(true)

    const applied = report.applied.find((e) => e.artifactId === 'skill:alpha-skill@claude-code')
    expect(applied?.backupPath).toBeDefined()
    expect(fs.readFileSync(applied?.backupPath ?? '', 'utf8')).toBe('# mine\n')
  })
})

describe('runInstall failures', () => {
  it('exits 1 when an artifact cannot be written', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    fs.mkdirSync(abs(ctx, '.claude'), { recursive: true })
    // a regular file where the skills directory must go: every skill write fails
    fs.writeFileSync(abs(ctx, '.claude/skills'), 'not a directory\n')

    const { report, exitCode } = runInstall(ctx)

    expect(exitCode).toBe(1)
    expect(report.errors.map((e) => e.artifactId)).toContain('skill:alpha-skill@claude-code')
    expect(fs.readFileSync(abs(ctx, '.claude/skills'), 'utf8')).toBe('not a directory\n')
  })

  it('exits 1 on an unknown harness id and writes nothing', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runInstall(ctx, { harnesses: ['claude-code', 'emacs-doctor'] })

    expect(exitCode).toBe(1)
    expect(report.applied).toEqual([])
    expect(report.actions).toEqual([])
    expect(report.errors.map((e) => e.message).join('\n')).toContain('emacs-doctor')
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })

  it('exits 1 with the build hint when the dist bundles are missing', () => {
    setInstallDirs({ assetsDir, distDir: tmpDir('lumem-install-nodist-') })
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    const before = snapshot(ctx.projectDir)

    const { report, exitCode } = runInstall(ctx)

    expect(exitCode).toBe(1)
    expect(report.errors.map((e) => e.message).join('\n')).toContain('run the build first')
    expect(report.applied).toEqual([])
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })
})

describe('asset and dist resolvers', () => {
  it('finds the repo layout when nothing overrides them', () => {
    setInstallDirs({})

    expect(fs.existsSync(path.join(resolveAssetsDir(), 'skills'))).toBe(true)
    expect(path.basename(resolveDistDir())).toBe('dist')
  })

  it('honors the LUMEM_ASSETS_DIR and LUMEM_DIST_DIR env overrides', () => {
    setInstallDirs({})
    process.env.LUMEM_ASSETS_DIR = assetsDir
    process.env.LUMEM_DIST_DIR = distDir
    try {
      expect(resolveAssetsDir()).toBe(assetsDir)
      expect(resolveDistDir()).toBe(distDir)
    } finally {
      // the only test that touches process.env: unset again before anything else runs
      Reflect.deleteProperty(process.env, 'LUMEM_ASSETS_DIR')
      Reflect.deleteProperty(process.env, 'LUMEM_DIST_DIR')
    }
  })

  it('lets setInstallDirs win over the environment', () => {
    setInstallDirs({ assetsDir, distDir })

    expect(resolveAssetsDir()).toBe(assetsDir)
    expect(resolveDistDir()).toBe(distDir)
  })
})

describe('InstallReport', () => {
  it('round-trips through JSON', () => {
    const ctx = initProject(makeCtx(makeHome(['codex'])))
    const { report } = runInstall(ctx)

    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })
})

describe('renderInstall', () => {
  it('lists applied artifacts and their destinations', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    const text = renderInstall(runInstall(ctx).report)

    expect(text).toContain('skill:alpha-skill@claude-code')
    expect(text).toContain(abs(ctx, '.claude/skills/alpha-skill/SKILL.md'))
  })

  it('returns a non-empty string for every report', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))

    expect(renderInstall(runInstall(ctx, { dryRun: true }).report).length).toBeGreaterThan(0)
    expect(renderInstall(runInstall(ctx).report).length).toBeGreaterThan(0)
    expect(renderInstall(runInstall(ctx).report).length).toBeGreaterThan(0)
  })
})

describe('registerInstallCommand', () => {
  function parse(argv: string[], ctx: CliContext): InstallReport {
    const program = new Command()
    program.exitOverride()
    let captured: InstallReport | undefined
    registerInstallCommand(
      program,
      () => ctx,
      (_json, report) => {
        captured = report as InstallReport
      },
    )
    const previousExitCode = process.exitCode
    program.parse(['node', 'lumem', ...argv])
    process.exitCode = previousExitCode
    if (captured === undefined) throw new Error('emit was never called')
    return captured
  }

  it('runs a dry-run install from the command line', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    const before = snapshot(ctx.projectDir)

    const report = parse(['install', '--dry-run'], ctx)

    expect(report.dryRun).toBe(true)
    expect(report.actions).toHaveLength(CLAUDE_ARTIFACTS.length)
    expect(snapshot(ctx.projectDir)).toEqual(before)
  })

  it('passes --harness and --copy through', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])), ['claude-code', 'codex'])

    const report = parse(['install', '--harness', 'codex', '--copy'], ctx)

    expect(report.harnesses).toEqual(['codex'])
    expect(fs.lstatSync(abs(ctx, '.agents/skills/alpha-skill/SKILL.md')).isSymbolicLink()).toBe(
      false,
    )
  })

  it('passes --global through', () => {
    const home = makeHome(['claude-code'])
    const ctx = initProject(makeCtx(home))

    parse(['install', '--global'], ctx)

    expect(fs.existsSync(path.join(home, '.claude/skills/beta-skill/SKILL.md'))).toBe(true)
  })
})

describe('runInstall of the spec bundle (002 T5)', () => {
  it('IT-12 copies lumem-spec.mjs into .lumem/bin rather than symlinking it', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    expect(runInstall(ctx).exitCode).toBe(0)

    const dest = abs(ctx, '.lumem/bin/lumem-spec.mjs')
    expect(fs.existsSync(dest)).toBe(true)
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(dest, 'utf8')).toBe('export const spec = 1\n')
  })

  it('IT-13 records it in the lockfile in copy mode with a content hash', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    runInstall(ctx)

    const entry = readLockEntries(ctx).find((e) => e.artifactId === 'hook-bundle:lumem-spec')
    expect(entry?.mode).toBe('copy')
    expect(entry?.destPath).toBe(abs(ctx, '.lumem/bin/lumem-spec.mjs'))
    expect(entry?.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('IT-14 is idempotent: a second install leaves the file and the lockfile untouched', () => {
    const ctx = initProject(makeCtx(makeHome(['claude-code'])))
    runInstall(ctx)
    const before = fs.readFileSync(abs(ctx, '.lumem/bin/lumem-spec.mjs'))
    const lockBefore = fs.readFileSync(abs(ctx, '.lumem/lumem-lock.json'))

    const { report } = runInstall(ctx)

    expect(report.applied).toEqual([])
    expect(report.skipped.map((s) => s.artifactId)).toContain('hook-bundle:lumem-spec')
    expect(fs.readFileSync(abs(ctx, '.lumem/bin/lumem-spec.mjs'))).toEqual(before)
    expect(fs.readFileSync(abs(ctx, '.lumem/lumem-lock.json'))).toEqual(lockBefore)
  })
})
