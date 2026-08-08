import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256 } from '../shared/fsx'
import type { LockEntry, Lockfile } from './lockfile'
import type { ManifestArtifact } from './manifest'
import { planInstall, planUninstall } from './plan'

interface Fixture {
  root: string
  projectDir: string
  srcDir: string
  globalHome: string
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-plan-'))
  const projectDir = path.join(root, 'project')
  const srcDir = path.join(root, 'artifacts')
  const globalHome = path.join(root, 'home')
  for (const dir of [projectDir, srcDir, globalHome]) fs.mkdirSync(dir, { recursive: true })
  return { root, projectDir, srcDir, globalHome }
}

let seq = 0

function makeArtifact(
  f: Fixture,
  opts: {
    id?: string
    kind?: ManifestArtifact['kind']
    content?: string
    dest?: Partial<ManifestArtifact['dest']>
  } = {},
): ManifestArtifact {
  seq += 1
  const id = opts.id ?? `skill:demo-${seq}@claude`
  const content = opts.content ?? `content of ${id}\n`
  const srcPath = path.join(f.srcDir, `src-${seq}.md`)
  fs.writeFileSync(srcPath, content)
  return {
    id,
    kind: opts.kind ?? 'skill',
    version: '1.0.0',
    srcPath,
    hash: sha256(content),
    dest: {
      harness: 'claude',
      scope: 'project',
      relPath: `.claude/skills/demo-${seq}/SKILL.md`,
      ...opts.dest,
    },
  }
}

function destOf(f: Fixture, a: ManifestArtifact): string {
  return path.join(f.projectDir, a.dest.relPath)
}

function writeDest(destPath: string, content: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(destPath, content)
}

function entryFor(
  a: ManifestArtifact,
  destPath: string,
  overrides: Partial<LockEntry> = {},
): LockEntry {
  return {
    artifactId: a.id,
    installedAt: '2026-08-07T12:00:00.000Z',
    destPath,
    hash: a.hash,
    mode: 'copy',
    ...overrides,
  }
}

function lockOf(...entries: LockEntry[]): Lockfile {
  return { version: 1, entries }
}

const emptyLock: Lockfile = { version: 1, entries: [] }

function plan(
  f: Fixture,
  artifacts: ManifestArtifact[],
  lock: Lockfile = emptyLock,
  extra: {
    mode?: 'symlink' | 'copy'
    force?: boolean
    hookConfigStrategy?: Record<string, 'merge-json' | 'own-file'>
  } = {},
) {
  return planInstall({
    artifacts,
    lock,
    projectDir: f.projectDir,
    globalDirs: { '*': f.globalHome },
    mode: extra.mode ?? 'copy',
    force: extra.force,
    ...(extra.hookConfigStrategy !== undefined
      ? { hookConfigStrategy: extra.hookConfigStrategy }
      : {}),
  })
}

describe('planInstall', () => {
  it('rule 1: resolves project-scope relPath against projectDir', () => {
    const f = makeFixture()
    const a = makeArtifact(f)
    const { actions } = plan(f, [a])
    expect(actions[0]?.destPath).toBe(path.join(f.projectDir, a.dest.relPath))
    expect(path.isAbsolute(actions[0]?.destPath ?? '')).toBe(true)
  })

  it("rule 1: resolves global scope against globalDirs[harness], falling back to '*'", () => {
    const f = makeFixture()
    const claudeHome = path.join(f.root, 'claude-home')
    const a = makeArtifact(f, { dest: { scope: 'global', relPath: 'skills/a/SKILL.md' } })
    const b = makeArtifact(f, {
      dest: { scope: 'global', harness: 'codex', relPath: 'skills/b/SKILL.md' },
    })
    const { actions } = planInstall({
      artifacts: [a, b],
      lock: emptyLock,
      projectDir: f.projectDir,
      globalDirs: { claude: claudeHome, '*': f.globalHome },
      mode: 'copy',
    })
    const forA = actions.find((x) => x.artifactId === a.id)
    const forB = actions.find((x) => x.artifactId === b.id)
    expect(forA?.destPath).toBe(path.join(claudeHome, 'skills/a/SKILL.md'))
    expect(forB?.destPath).toBe(path.join(f.globalHome, 'skills/b/SKILL.md'))
  })

  it('rule 1: throws when no global dir mapping exists for the harness', () => {
    const f = makeFixture()
    const a = makeArtifact(f, { dest: { scope: 'global' } })
    expect(() =>
      planInstall({
        artifacts: [a],
        lock: emptyLock,
        projectDir: f.projectDir,
        globalDirs: {},
        mode: 'copy',
      }),
    ).toThrow(/global/i)
  })

  it('rule 2: artifact not in lock and dest absent → create', () => {
    const f = makeFixture()
    const a = makeArtifact(f)
    const { actions } = plan(f, [a])
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'create',
      artifactId: a.id,
      kind: 'skill',
      mode: 'copy',
    })
  })

  it("rule 3: in lock, unchanged hash, dest content matches → skip 'up-to-date'", () => {
    const f = makeFixture()
    const a = makeArtifact(f, { content: 'v1\n' })
    const dest = destOf(f, a)
    writeDest(dest, 'v1\n')
    const { actions } = plan(f, [a], lockOf(entryFor(a, dest)))
    expect(actions[0]).toMatchObject({ type: 'skip', reason: 'up-to-date' })
  })

  it('rule 3: symlink dest is hashed via its resolved target content', () => {
    const f = makeFixture()
    const a = makeArtifact(f, { content: 'v1\n' })
    const dest = destOf(f, a)
    const target = path.join(f.root, 'link-target.md')
    fs.writeFileSync(target, 'v1\n')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.symlinkSync(target, dest)
    const lock = lockOf(entryFor(a, dest, { mode: 'symlink' }))
    const { actions } = plan(f, [a], lock, { mode: 'symlink' })
    expect(actions[0]).toMatchObject({ type: 'skip', reason: 'up-to-date', mode: 'symlink' })
  })

  it('rule 4: new artifact version with untouched dest → update', () => {
    const f = makeFixture()
    const a = makeArtifact(f, { content: 'v2\n' })
    const dest = destOf(f, a)
    writeDest(dest, 'v1\n')
    const lock = lockOf(entryFor(a, dest, { hash: sha256('v1\n') }))
    const { actions } = plan(f, [a], lock)
    expect(actions[0]?.type).toBe('update')
  })

  it('rule 5: dest content matches neither lock nor artifact hash → conflict', () => {
    const f = makeFixture()
    const a = makeArtifact(f, { content: 'v2\n' })
    const dest = destOf(f, a)
    writeDest(dest, 'edited by user\n')
    const lock = lockOf(entryFor(a, dest, { hash: sha256('v1\n') }))
    const { actions } = plan(f, [a], lock)
    expect(actions[0]?.type).toBe('conflict')
  })

  it('rule 5: force turns the conflict into update and the reason mentions force', () => {
    const f = makeFixture()
    const a = makeArtifact(f, { content: 'v2\n' })
    const dest = destOf(f, a)
    writeDest(dest, 'edited by user\n')
    const lock = lockOf(entryFor(a, dest, { hash: sha256('v1\n') }))
    const { actions } = plan(f, [a], lock, { force: true })
    expect(actions[0]?.type).toBe('update')
    expect(actions[0]?.reason).toMatch(/force/)
  })

  it('rule 5: force also applies when the artifact is not in the lock', () => {
    const f = makeFixture()
    const a = makeArtifact(f, { content: 'v1\n' })
    const dest = destOf(f, a)
    writeDest(dest, 'pre-existing user file\n')
    const { actions } = plan(f, [a], emptyLock, { force: true })
    expect(actions[0]?.type).toBe('update')
    expect(actions[0]?.reason).toMatch(/force/)
  })

  it('rule 6: not in lock but dest exists with different content → conflict', () => {
    const f = makeFixture()
    const a = makeArtifact(f, { content: 'v1\n' })
    const dest = destOf(f, a)
    writeDest(dest, 'pre-existing user file\n')
    const { actions } = plan(f, [a])
    expect(actions[0]?.type).toBe('conflict')
  })

  it('rule 6: hook-config artifacts are treated the same as skills', () => {
    const f = makeFixture()
    const a = makeArtifact(f, {
      id: 'hook-config:claude',
      kind: 'hook-config',
      content: '{"hooks":[]}\n',
      dest: { relPath: '.claude/settings.json' },
    })
    const dest = destOf(f, a)
    writeDest(dest, '{"hooks":["user stuff"]}\n')
    const { actions } = plan(f, [a])
    expect(actions[0]).toMatchObject({ type: 'conflict', kind: 'hook-config' })
  })

  it("rule 7: in lock but dest missing → create 'reinstall missing'", () => {
    const f = makeFixture()
    const a = makeArtifact(f, { content: 'v1\n' })
    const dest = destOf(f, a)
    const { actions } = plan(f, [a], lockOf(entryFor(a, dest)))
    expect(actions[0]).toMatchObject({ type: 'create', reason: 'reinstall missing' })
  })

  it('rule 8: plan → simulate apply → re-plan yields only skip actions', () => {
    const f = makeFixture()
    const artifacts = [
      makeArtifact(f, { id: 'skill:alpha@claude' }),
      makeArtifact(f, {
        id: 'hook-config:claude',
        kind: 'hook-config',
        content: '{"hooks":[]}\n',
        dest: { relPath: '.claude/settings.json' },
      }),
      makeArtifact(f, {
        id: 'skill:alpha@codex',
        dest: { scope: 'global', harness: 'codex', relPath: 'skills/alpha/SKILL.md' },
      }),
    ]
    const first = plan(f, artifacts)
    expect(first.actions.map((x) => x.type)).toEqual(['create', 'create', 'create'])

    const entries: LockEntry[] = first.actions.map((action) => {
      const artifact = artifacts.find((x) => x.id === action.artifactId)
      if (!artifact) throw new Error(`no artifact for ${action.artifactId}`)
      writeDest(action.destPath, fs.readFileSync(artifact.srcPath, 'utf8'))
      return {
        artifactId: artifact.id,
        installedAt: '2026-08-07T12:00:00.000Z',
        destPath: action.destPath,
        hash: artifact.hash,
        mode: action.mode,
      }
    })

    const second = plan(f, artifacts, lockOf(...entries))
    expect(second.actions.map((x) => x.type)).toEqual(['skip', 'skip', 'skip'])
  })

  it('rule 10: actions are sorted by artifactId', () => {
    const f = makeFixture()
    const artifacts = [
      makeArtifact(f, { id: 'skill:zeta@claude' }),
      makeArtifact(f, { id: 'hook-config:claude', kind: 'hook-config' }),
      makeArtifact(f, { id: 'skill:alpha@claude' }),
    ]
    const { actions } = plan(f, artifacts)
    expect(actions.map((x) => x.artifactId)).toEqual([
      'hook-config:claude',
      'skill:alpha@claude',
      'skill:zeta@claude',
    ])
  })

  it("rule 10: unreadable dest → conflict 'unreadable'", () => {
    const f = makeFixture()
    const a = makeArtifact(f, { content: 'v1\n' })
    // a directory at destPath makes readFileSync fail while lstat succeeds
    fs.mkdirSync(destOf(f, a), { recursive: true })
    const { actions } = plan(f, [a])
    expect(actions[0]).toMatchObject({ type: 'conflict', reason: 'unreadable' })
  })

  it('adopts an identical pre-existing file (not in lock) as update, never conflict', () => {
    const f = makeFixture()
    const a = makeArtifact(f, { content: 'same\n' })
    writeDest(destOf(f, a), 'same\n')
    const { actions } = plan(f, [a])
    expect(actions[0]?.type).toBe('update')
  })

  it('refreshes a stale lock as update when dest already holds the new version', () => {
    const f = makeFixture()
    const a = makeArtifact(f, { content: 'v2\n' })
    const dest = destOf(f, a)
    writeDest(dest, 'v2\n')
    const lock = lockOf(entryFor(a, dest, { hash: sha256('v1\n') }))
    const { actions } = plan(f, [a], lock)
    expect(actions[0]?.type).toBe('update')
  })
})

describe('planInstall — merge-json hook configs', () => {
  const MERGE = { 'hook-config:claude': 'merge-json' } as const

  function settingsArtifact(f: Fixture, content = '{"hooks":{"SessionStart":[]}}\n') {
    return makeArtifact(f, {
      id: 'hook-config:claude',
      kind: 'hook-config',
      content,
      dest: { relPath: '.claude/settings.json' },
    })
  }

  it("plans update, not conflict, over the user's pre-existing settings.json", () => {
    const f = makeFixture()
    const a = settingsArtifact(f)
    writeDest(destOf(f, a), '{"permissions":{"allow":["Bash(ls)"]}}\n')

    const { actions } = plan(f, [a], emptyLock, { hookConfigStrategy: MERGE })

    // merging IS how lumem avoids clobbering this file: it is never a conflict
    expect(actions[0]?.type).toBe('update')
    expect(actions[0]?.reason).toMatch(/merg/i)
  })

  it('accepts the strategy keyed by harness as well as by artifact id', () => {
    const f = makeFixture()
    const a = settingsArtifact(f)
    writeDest(destOf(f, a), '{"permissions":{}}\n')

    const { actions } = plan(f, [a], emptyLock, { hookConfigStrategy: { claude: 'merge-json' } })

    expect(actions[0]?.type).toBe('update')
  })

  it('leaves own-file hook configs conflicting exactly as before', () => {
    const f = makeFixture()
    const a = settingsArtifact(f)
    writeDest(destOf(f, a), '{"permissions":{}}\n')

    const own = plan(f, [a], emptyLock, {
      hookConfigStrategy: { 'hook-config:claude': 'own-file' },
    })
    const unlisted = plan(f, [a], emptyLock, {
      hookConfigStrategy: { 'hook-config:codex': 'merge-json' },
    })

    expect(own.actions[0]?.type).toBe('conflict')
    expect(unlisted.actions[0]?.type).toBe('conflict')
  })

  it('never softens drift on a destination lumem already tracks', () => {
    const f = makeFixture()
    const a = settingsArtifact(f)
    const dest = destOf(f, a)
    writeDest(dest, 'edited after install\n')
    const lock = lockOf(entryFor(a, dest, { hash: sha256('v1\n') }))

    const { actions } = plan(f, [a], lock, { hookConfigStrategy: MERGE })

    expect(actions[0]).toMatchObject({
      type: 'conflict',
      reason: 'destination modified since install',
    })
  })

  it('keeps an unreadable destination a conflict', () => {
    const f = makeFixture()
    const a = settingsArtifact(f)
    fs.mkdirSync(destOf(f, a), { recursive: true })

    const { actions } = plan(f, [a], emptyLock, { hookConfigStrategy: MERGE })

    expect(actions[0]).toMatchObject({ type: 'conflict', reason: 'unreadable' })
  })

  it('applies to hook configs only, never to a skill of the same harness', () => {
    const f = makeFixture()
    const skill = makeArtifact(f, { id: 'skill:demo@claude', content: 'lumem\n' })
    writeDest(destOf(f, skill), 'handwritten\n')

    const { actions } = plan(f, [skill], emptyLock, {
      hookConfigStrategy: { claude: 'merge-json' },
    })

    expect(actions[0]?.type).toBe('conflict')
  })

  it('adopts an identical pre-existing merge-json file rather than re-merging it', () => {
    const f = makeFixture()
    const a = settingsArtifact(f, '{"hooks":{}}\n')
    writeDest(destOf(f, a), '{"hooks":{}}\n')

    const { actions } = plan(f, [a], emptyLock, { hookConfigStrategy: MERGE })

    expect(actions[0]).toMatchObject({
      type: 'update',
      reason: 'identical file already present; adopting',
    })
  })
})

describe('planUninstall', () => {
  const at = '2026-08-07T12:00:00.000Z'

  it('rule 9: one remove per lock entry, sorted by artifactId, kind omitted', () => {
    const lock = lockOf(
      {
        artifactId: 'skill:zeta@claude',
        installedAt: at,
        destPath: '/abs/z',
        hash: 'h1',
        mode: 'symlink',
      },
      {
        artifactId: 'skill:alpha@claude',
        installedAt: at,
        destPath: '/abs/a',
        hash: 'h2',
        mode: 'copy',
      },
    )
    const { actions } = planUninstall({ lock })
    expect(actions.map((x) => x.artifactId)).toEqual(['skill:alpha@claude', 'skill:zeta@claude'])
    expect(actions.every((x) => x.type === 'remove' && x.kind === undefined)).toBe(true)
    expect(actions[0]).toMatchObject({ destPath: '/abs/a', mode: 'copy' })
    expect(actions[1]).toMatchObject({ destPath: '/abs/z', mode: 'symlink' })
  })

  it("rule 9: purge adds a final remove for '.lumem' with a purge reason", () => {
    const lock = lockOf({
      artifactId: 'skill:alpha@claude',
      installedAt: at,
      destPath: '/abs/a',
      hash: 'h',
      mode: 'copy',
    })
    const { actions } = planUninstall({ lock, purge: true })
    expect(actions).toHaveLength(2)
    const last = actions.at(-1)
    expect(last).toMatchObject({ type: 'remove', artifactId: '.lumem' })
    expect(last?.reason).toMatch(/purge/)
  })

  it('rule 9: empty lock without purge yields an empty plan', () => {
    expect(planUninstall({ lock: emptyLock }).actions).toEqual([])
  })
})
