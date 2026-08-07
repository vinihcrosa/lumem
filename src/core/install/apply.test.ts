import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from '../shared/fsx'
import { applyPlan } from './apply'
import { type LockEntry, readLock, writeLock } from './lockfile'
import type { ManifestArtifact } from './manifest'
import { type InstallPlan, type PlanAction, planInstall } from './plan'

interface Fixture {
  root: string
  projectDir: string
  lumemDir: string
  srcDir: string
  backupsDir: string
  lockPath: string
}

function setup(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-apply-'))
  const projectDir = path.join(root, 'project')
  const lumemDir = path.join(projectDir, '.lumem')
  const srcDir = path.join(root, 'pkg')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(srcDir, { recursive: true })
  return {
    root,
    projectDir,
    lumemDir,
    srcDir,
    backupsDir: path.join(lumemDir, 'local', 'backups'),
    lockPath: path.join(lumemDir, 'lumem-lock.json'),
  }
}

function artifactAt(
  fx: Fixture,
  opts: {
    id: string
    kind: ManifestArtifact['kind']
    file: string
    relPath: string
    content: string
  },
): ManifestArtifact {
  const srcPath = path.join(fx.srcDir, opts.file)
  fs.mkdirSync(path.dirname(srcPath), { recursive: true })
  fs.writeFileSync(srcPath, opts.content)
  return {
    id: opts.id,
    kind: opts.kind,
    version: '0.1.0',
    srcPath,
    hash: sha256(opts.content),
    dest: { harness: 'claude-code', scope: 'project', relPath: opts.relPath },
  }
}

function skillArtifact(fx: Fixture, name: string, content: string): ManifestArtifact {
  return artifactAt(fx, {
    id: `skill:${name}@claude-code`,
    kind: 'skill',
    file: `skills/${name}/SKILL.md`,
    relPath: path.join('.claude', 'skills', name, 'SKILL.md'),
    content,
  })
}

function destOf(fx: Fixture, artifact: ManifestArtifact): string {
  return path.join(fx.projectDir, artifact.dest.relPath)
}

function actionFor(
  type: PlanAction['type'],
  artifact: ManifestArtifact,
  fx: Fixture,
  mode: 'symlink' | 'copy' = 'copy',
  reason = 'test',
): PlanAction {
  return {
    type,
    artifactId: artifact.id,
    kind: artifact.kind,
    destPath: destOf(fx, artifact),
    mode,
    reason,
  }
}

function planOf(...actions: PlanAction[]): InstallPlan {
  return { actions }
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

/** Stable textual snapshot of a tree: kind, relative path, and content/link target. */
function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (cur: string): void => {
    const entries = fs
      .readdirSync(cur, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const full = path.join(cur, entry.name)
      const rel = path.relative(dir, full)
      if (entry.isSymbolicLink()) {
        out.push(`l ${rel} -> ${fs.readlinkSync(full)}`)
      } else if (entry.isDirectory()) {
        out.push(`d ${rel}`)
        walk(full)
      } else {
        out.push(`f ${rel} ${fs.readFileSync(full, 'utf8')}`)
      }
    }
  }
  walk(dir)
  return out
}

const HOOK_TEMPLATE = JSON.stringify(
  {
    hooks: {
      SessionStart: [{ command: ['node', '{{HOOK_BUNDLE}}', 'claude-code', 'inject'] }],
      SessionEnd: [{ command: ['node', '{{HOOK_BUNDLE}}', 'claude-code', 'end'] }],
    },
  },
  null,
  2,
)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('applyPlan — dry run', () => {
  it('writes nothing and prefixes actions with would-', () => {
    const fx = setup()
    const skill = skillArtifact(fx, 'lumem-memory', '# memory\n')
    const before = snapshot(fx.root)

    const report = applyPlan({
      plan: planOf(actionFor('create', skill, fx)),
      artifacts: [skill],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
      dryRun: true,
    })

    expect(snapshot(fx.root)).toEqual(before)
    expect(fs.existsSync(fx.lumemDir)).toBe(false)
    expect(report.applied).toEqual([
      { artifactId: skill.id, action: 'would-create', destPath: destOf(fx, skill) },
    ])
    expect(report.errors).toEqual([])
  })

  it('leaves an existing install and lockfile byte-identical for update and remove', () => {
    const fx = setup()
    const skill = skillArtifact(fx, 'lumem-memory', '# v2\n')
    const dest = destOf(fx, skill)
    writeFile(dest, '# v1\n')
    writeLock(fx.lumemDir, {
      version: 1,
      entries: [
        {
          artifactId: skill.id,
          installedAt: '2026-01-01T00:00:00.000Z',
          destPath: dest,
          hash: sha256('# v1\n'),
          mode: 'copy',
        },
      ],
    })
    const before = snapshot(fx.root)

    const report = applyPlan({
      plan: planOf(actionFor('update', skill, fx), {
        ...actionFor('remove', skill, fx),
        kind: undefined,
      }),
      artifacts: [skill],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
      dryRun: true,
    })

    expect(snapshot(fx.root)).toEqual(before)
    expect(report.applied.map((e) => e.action)).toEqual(['would-update', 'would-remove'])
  })
})

describe('applyPlan — skip and conflict', () => {
  it('reports skip and conflict in skipped[] keeping their reasons', () => {
    const fx = setup()
    const a = skillArtifact(fx, 'a', 'a\n')
    const b = skillArtifact(fx, 'b', 'b\n')

    const report = applyPlan({
      plan: planOf(
        actionFor('skip', a, fx, 'copy', 'up-to-date'),
        actionFor('conflict', b, fx, 'copy', 'destination modified since install'),
      ),
      artifacts: [a, b],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(report.skipped).toEqual([
      { artifactId: a.id, reason: 'up-to-date' },
      { artifactId: b.id, reason: 'destination modified since install' },
    ])
    expect(report.applied).toEqual([])
    expect(report.errors).toEqual([])
  })

  it('never writes on conflict: dest content and backups untouched', () => {
    const fx = setup()
    const skill = skillArtifact(fx, 'a', 'lumem\n')
    const dest = destOf(fx, skill)
    writeFile(dest, 'user edit\n')

    applyPlan({
      plan: planOf(actionFor('conflict', skill, fx, 'copy', 'destination modified since install')),
      artifacts: [skill],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(fs.readFileSync(dest, 'utf8')).toBe('user edit\n')
    expect(fs.existsSync(fx.backupsDir)).toBe(false)
    expect(readLock(fx.lumemDir).entries).toEqual([])
  })
})

describe('applyPlan — create and update of file artifacts', () => {
  it('symlink mode creates parent dirs and links dest to srcPath', () => {
    const fx = setup()
    const skill = skillArtifact(fx, 'lumem-memory', '# memory\n')
    const dest = destOf(fx, skill)

    const report = applyPlan({
      plan: planOf(actionFor('create', skill, fx, 'symlink')),
      artifacts: [skill],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(dest)).toBe(skill.srcPath)
    expect(fs.readFileSync(dest, 'utf8')).toBe('# memory\n')
    expect(report.applied).toEqual([{ artifactId: skill.id, action: 'create', destPath: dest }])
  })

  it('copy mode writes the bytes of srcPath, not a link', () => {
    const fx = setup()
    const agent = artifactAt(fx, {
      id: 'agent:lumem-consolidator@claude-code',
      kind: 'agent',
      file: 'agents/lumem-consolidator.md',
      relPath: path.join('.claude', 'agents', 'lumem-consolidator.md'),
      content: 'olá, 世界 🚀\n',
    })
    const dest = destOf(fx, agent)

    applyPlan({
      plan: planOf(actionFor('create', agent, fx, 'copy')),
      artifacts: [agent],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(dest, 'utf8')).toBe('olá, 世界 🚀\n')
  })

  it('symlink update repoints an existing symlink to the new srcPath', () => {
    const fx = setup()
    const bundle = artifactAt(fx, {
      id: 'hook-bundle:lumem-hook',
      kind: 'hook-bundle',
      file: 'dist-v2/lumem-hook.mjs',
      relPath: path.join('.lumem', 'bin', 'lumem-hook.mjs'),
      content: 'export const v = 2\n',
    })
    const dest = destOf(fx, bundle)
    const oldSrc = path.join(fx.srcDir, 'dist-v1', 'lumem-hook.mjs')
    writeFile(oldSrc, 'export const v = 1\n')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.symlinkSync(oldSrc, dest)

    applyPlan({
      plan: planOf(actionFor('update', bundle, fx, 'symlink')),
      artifacts: [bundle],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(dest)).toBe(bundle.srcPath)
    expect(fs.readFileSync(dest, 'utf8')).toBe('export const v = 2\n')
    expect(fs.existsSync(fx.backupsDir)).toBe(false)
  })

  it('copy update replaces the bytes of a file it already owns, without a new backup', () => {
    const fx = setup()
    const skill = skillArtifact(fx, 'a', 'v2\n')
    const dest = destOf(fx, skill)
    writeFile(dest, 'v1\n')
    writeLock(fx.lumemDir, {
      version: 1,
      entries: [
        {
          artifactId: skill.id,
          installedAt: '2026-01-01T00:00:00.000Z',
          destPath: dest,
          hash: sha256('v1\n'),
          mode: 'copy',
        },
      ],
    })

    const report = applyPlan({
      plan: planOf(actionFor('update', skill, fx, 'copy')),
      artifacts: [skill],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(fs.readFileSync(dest, 'utf8')).toBe('v2\n')
    expect(fs.existsSync(fx.backupsDir)).toBe(false)
    expect(report.applied[0]?.backupPath).toBeUndefined()
  })

  it('backs up a pre-existing regular file before a copy write and records backupPath', () => {
    const fx = setup()
    const skill = skillArtifact(fx, 'a', 'lumem\n')
    const dest = destOf(fx, skill)
    writeFile(dest, 'handwritten\n')

    const report = applyPlan({
      plan: planOf(actionFor('create', skill, fx, 'copy')),
      artifacts: [skill],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    const backupPath = report.applied[0]?.backupPath as string
    expect(backupPath).toBeDefined()
    expect(backupPath.startsWith(`${fx.backupsDir}${path.sep}`)).toBe(true)
    expect(backupPath.endsWith(path.join('.claude', 'skills', 'a', 'SKILL.md'))).toBe(true)
    expect(fs.readFileSync(backupPath, 'utf8')).toBe('handwritten\n')
    expect(fs.readFileSync(dest, 'utf8')).toBe('lumem\n')
    expect(readLock(fx.lumemDir).entries[0]?.backupPath).toBe(backupPath)
  })

  it('backs up a pre-existing regular file before replacing it with a symlink', () => {
    const fx = setup()
    const skill = skillArtifact(fx, 'a', 'lumem\n')
    const dest = destOf(fx, skill)
    writeFile(dest, 'handwritten\n')

    const report = applyPlan({
      plan: planOf(actionFor('create', skill, fx, 'symlink')),
      artifacts: [skill],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    const backupPath = report.applied[0]?.backupPath as string
    expect(fs.readFileSync(backupPath, 'utf8')).toBe('handwritten\n')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(dest)).toBe(skill.srcPath)
  })

  it('records an error for an action whose artifact is not in the manifest', () => {
    const fx = setup()
    const skill = skillArtifact(fx, 'a', 'a\n')

    const report = applyPlan({
      plan: planOf(actionFor('create', skill, fx)),
      artifacts: [],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(report.applied).toEqual([])
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]?.artifactId).toBe(skill.id)
    expect(report.errors[0]?.message).toContain(skill.id)
  })
})

describe('applyPlan — hook-config', () => {
  function hookConfigArtifact(fx: Fixture): ManifestArtifact {
    return artifactAt(fx, {
      id: 'hook-config:claude-code',
      kind: 'hook-config',
      file: 'harness/claude-code/hooks.tmpl.json',
      relPath: path.join('.claude', 'settings.json'),
      content: HOOK_TEMPLATE,
    })
  }

  it('renders {{HOOK_BUNDLE}} as the absolute path of the installed hook bundle', () => {
    const fx = setup()
    const artifact = hookConfigArtifact(fx)
    const dest = destOf(fx, artifact)

    const report = applyPlan({
      plan: planOf(actionFor('create', artifact, fx)),
      artifacts: [artifact],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    const rendered = fs.readFileSync(dest, 'utf8')
    const bundlePath = path.join(fx.lumemDir, 'bin', 'lumem-hook.mjs')
    expect(rendered).not.toContain('{{HOOK_BUNDLE}}')
    expect(rendered.split(bundlePath)).toHaveLength(3)
    expect(path.isAbsolute(bundlePath)).toBe(true)
    expect(JSON.parse(rendered).hooks.SessionStart[0].command[1]).toBe(bundlePath)
    expect(report.applied[0]?.backupPath).toBeUndefined()
    expect(fs.existsSync(fx.backupsDir)).toBe(false)
  })

  it('backs up and replaces a dest that exists without a lock entry', () => {
    const fx = setup()
    const artifact = hookConfigArtifact(fx)
    const dest = destOf(fx, artifact)
    writeFile(dest, '{ "hooks": { "SessionStart": [] } }\n')

    const report = applyPlan({
      plan: planOf(actionFor('update', artifact, fx)),
      artifacts: [artifact],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    const backupPath = report.applied[0]?.backupPath as string
    expect(backupPath).toBeDefined()
    expect(fs.readFileSync(backupPath, 'utf8')).toBe('{ "hooks": { "SessionStart": [] } }\n')
    expect(report.applied[0]?.reason).toBe('replaced (backup kept)')
    expect(fs.readFileSync(dest, 'utf8')).toContain('lumem-hook.mjs')
  })

  it('overwrites its own file without a backup when a lock entry exists', () => {
    const fx = setup()
    const artifact = hookConfigArtifact(fx)
    const dest = destOf(fx, artifact)
    writeFile(dest, 'stale rendered content\n')
    writeLock(fx.lumemDir, {
      version: 1,
      entries: [
        {
          artifactId: artifact.id,
          installedAt: '2026-01-01T00:00:00.000Z',
          destPath: dest,
          hash: artifact.hash,
          mode: 'copy',
        },
      ],
    })

    const report = applyPlan({
      plan: planOf(actionFor('update', artifact, fx)),
      artifacts: [artifact],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(fs.existsSync(fx.backupsDir)).toBe(false)
    expect(report.applied[0]?.reason).toBeUndefined()
    expect(fs.readFileSync(dest, 'utf8')).toContain('lumem-hook.mjs')
  })
})

describe('applyPlan — lockfile', () => {
  it('records one entry per applied create/update with provenance fields', () => {
    const fx = setup()
    const skill = skillArtifact(fx, 'a', 'a\n')

    applyPlan({
      plan: planOf(actionFor('create', skill, fx, 'symlink')),
      artifacts: [skill],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    const entries = readLock(fx.lumemDir).entries
    expect(entries).toHaveLength(1)
    const entry = entries[0] as LockEntry
    expect(entry.artifactId).toBe(skill.id)
    expect(entry.destPath).toBe(destOf(fx, skill))
    expect(entry.hash).toBe(skill.hash)
    expect(entry.mode).toBe('symlink')
    expect(new Date(entry.installedAt).toISOString()).toBe(entry.installedAt)
  })

  it('replaces the entry with the same artifactId and preserves the others', () => {
    const fx = setup()
    const skill = skillArtifact(fx, 'a', 'v2\n')
    const untouched: LockEntry = {
      artifactId: 'skill:other@codex',
      installedAt: '2020-01-01T00:00:00.000Z',
      destPath: path.join(fx.projectDir, '.codex', 'skills', 'other', 'SKILL.md'),
      hash: 'deadbeef',
      mode: 'copy',
    }
    writeLock(fx.lumemDir, {
      version: 1,
      entries: [
        untouched,
        {
          artifactId: skill.id,
          installedAt: '2020-01-01T00:00:00.000Z',
          destPath: destOf(fx, skill),
          hash: 'stale',
          mode: 'copy',
        },
      ],
    })

    applyPlan({
      plan: planOf(actionFor('update', skill, fx, 'copy')),
      artifacts: [skill],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    const entries = readLock(fx.lumemDir).entries
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual(untouched)
    expect(entries[1]?.hash).toBe(skill.hash)
    expect(entries[1]?.installedAt).not.toBe('2020-01-01T00:00:00.000Z')
  })

  it('writes the lockfile exactly once, at the end', () => {
    const fx = setup()
    const a = skillArtifact(fx, 'a', 'a\n')
    const b = skillArtifact(fx, 'b', 'b\n')
    const c = skillArtifact(fx, 'c', 'c\n')
    const spy = vi.spyOn(fs, 'writeFileSync')

    applyPlan({
      plan: planOf(
        actionFor('create', a, fx),
        actionFor('create', b, fx),
        actionFor('create', c, fx),
      ),
      artifacts: [a, b, c],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    const lockWrites = spy.mock.calls.filter((call) => String(call[0]).includes('lumem-lock.json'))
    expect(lockWrites).toHaveLength(1)
  })
})

describe('applyPlan — mid-failure coherence', () => {
  it('continues after a failing action and keeps the lockfile coherent with what landed', () => {
    const fx = setup()
    const a = skillArtifact(fx, 'a', 'a\n')
    const b = skillArtifact(fx, 'b', 'b\n')
    const c = skillArtifact(fx, 'c', 'c\n')
    fs.mkdirSync(destOf(fx, b), { recursive: true })

    const report = applyPlan({
      plan: planOf(
        actionFor('create', a, fx),
        actionFor('create', b, fx),
        actionFor('create', c, fx),
      ),
      artifacts: [a, b, c],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]?.artifactId).toBe(b.id)
    expect(report.errors[0]?.message).toContain(destOf(fx, b))
    expect(report.applied.map((e) => e.artifactId)).toEqual([a.id, c.id])
    expect(readLock(fx.lumemDir).entries.map((e) => e.artifactId)).toEqual([a.id, c.id])
    expect(fs.readFileSync(destOf(fx, a), 'utf8')).toBe('a\n')
    expect(fs.readFileSync(destOf(fx, c), 'utf8')).toBe('c\n')
  })

  it('keeps failing on a directory dest in symlink mode too', () => {
    const fx = setup()
    const a = skillArtifact(fx, 'a', 'a\n')
    fs.mkdirSync(destOf(fx, a), { recursive: true })

    const report = applyPlan({
      plan: planOf(actionFor('create', a, fx, 'symlink')),
      artifacts: [a],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(report.applied).toEqual([])
    expect(report.errors).toHaveLength(1)
    expect(readLock(fx.lumemDir).entries).toEqual([])
  })
})

describe('applyPlan — remove', () => {
  function seedInstalled(fx: Fixture, entry: LockEntry): void {
    writeLock(fx.lumemDir, { version: 1, entries: [entry] })
  }

  it('deletes the file and drops the lock entry', () => {
    const fx = setup()
    const dest = path.join(fx.projectDir, '.claude', 'skills', 'a', 'SKILL.md')
    writeFile(dest, 'lumem\n')
    seedInstalled(fx, {
      artifactId: 'skill:a@claude-code',
      installedAt: '2026-01-01T00:00:00.000Z',
      destPath: dest,
      hash: sha256('lumem\n'),
      mode: 'copy',
    })

    const report = applyPlan({
      plan: planOf({
        type: 'remove',
        artifactId: 'skill:a@claude-code',
        destPath: dest,
        mode: 'copy',
        reason: 'installed by lumem',
      }),
      artifacts: [],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(fs.existsSync(dest)).toBe(false)
    expect(readLock(fx.lumemDir).entries).toEqual([])
    expect(report.applied).toEqual([
      { artifactId: 'skill:a@claude-code', action: 'remove', destPath: dest },
    ])
  })

  it('removes a symlink install and tolerates an already-missing dest', () => {
    const fx = setup()
    const src = path.join(fx.srcDir, 'skills', 'a', 'SKILL.md')
    writeFile(src, 'lumem\n')
    const linked = path.join(fx.projectDir, '.claude', 'skills', 'a', 'SKILL.md')
    fs.mkdirSync(path.dirname(linked), { recursive: true })
    fs.symlinkSync(src, linked)
    const gone = path.join(fx.projectDir, '.claude', 'skills', 'gone', 'SKILL.md')
    writeLock(fx.lumemDir, {
      version: 1,
      entries: [
        {
          artifactId: 'skill:a@claude-code',
          installedAt: '2026-01-01T00:00:00.000Z',
          destPath: linked,
          hash: sha256('lumem\n'),
          mode: 'symlink',
        },
        {
          artifactId: 'skill:gone@claude-code',
          installedAt: '2026-01-01T00:00:00.000Z',
          destPath: gone,
          hash: 'x',
          mode: 'copy',
        },
      ],
    })

    const report = applyPlan({
      plan: planOf(
        {
          type: 'remove',
          artifactId: 'skill:a@claude-code',
          destPath: linked,
          mode: 'symlink',
          reason: 'installed by lumem',
        },
        {
          type: 'remove',
          artifactId: 'skill:gone@claude-code',
          destPath: gone,
          mode: 'copy',
          reason: 'installed by lumem',
        },
      ),
      artifacts: [],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(fs.existsSync(linked)).toBe(false)
    expect(fs.readFileSync(src, 'utf8')).toBe('lumem\n')
    expect(report.errors).toEqual([])
    expect(report.applied).toHaveLength(2)
    expect(readLock(fx.lumemDir).entries).toEqual([])
  })

  it('restores the backup recorded in the lock entry', () => {
    const fx = setup()
    const dest = path.join(fx.projectDir, '.claude', 'settings.json')
    writeFile(dest, 'rendered by lumem\n')
    const backupPath = path.join(
      fx.backupsDir,
      '2026-01-01T00-00-00-000Z',
      '.claude',
      'settings.json',
    )
    writeFile(backupPath, 'the user original\n')
    seedInstalled(fx, {
      artifactId: 'hook-config:claude-code',
      installedAt: '2026-01-01T00:00:00.000Z',
      destPath: dest,
      hash: sha256('rendered by lumem\n'),
      mode: 'copy',
      backupPath,
    })

    const report = applyPlan({
      plan: planOf({
        type: 'remove',
        artifactId: 'hook-config:claude-code',
        destPath: dest,
        mode: 'copy',
        reason: 'installed by lumem',
      }),
      artifacts: [],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(fs.readFileSync(dest, 'utf8')).toBe('the user original\n')
    expect(report.applied[0]?.backupPath).toBe(backupPath)
    expect(readLock(fx.lumemDir).entries).toEqual([])
  })

  it('skips a non-absolute destPath (the purge marker) instead of deleting anything', () => {
    const fx = setup()

    const report = applyPlan({
      plan: planOf({
        type: 'remove',
        artifactId: '.lumem',
        destPath: '.lumem',
        mode: 'copy',
        reason: 'purge requested: remove the .lumem state directory',
      }),
      artifacts: [],
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })

    expect(report.applied).toEqual([])
    expect(report.errors).toEqual([])
    expect(report.skipped).toEqual([
      { artifactId: '.lumem', reason: 'purge requested: remove the .lumem state directory' },
    ])
  })
})

describe('applyPlan — idempotence with planInstall', () => {
  for (const mode of ['symlink', 'copy'] as const) {
    it(`is a no-op on the second run in ${mode} mode`, () => {
      const fx = setup()
      const artifacts = [
        skillArtifact(fx, 'lumem-memory', '# memory\n'),
        artifactAt(fx, {
          id: 'agent:lumem-consolidator@claude-code',
          kind: 'agent',
          file: 'agents/lumem-consolidator.md',
          relPath: path.join('.claude', 'agents', 'lumem-consolidator.md'),
          content: '# consolidator\n',
        }),
        artifactAt(fx, {
          id: 'hook-bundle:lumem-hook',
          kind: 'hook-bundle',
          file: 'dist/lumem-hook.mjs',
          relPath: path.join('.lumem', 'bin', 'lumem-hook.mjs'),
          content: 'export const hook = 1\n',
        }),
      ]
      const planArgs = { artifacts, projectDir: fx.projectDir, globalDirs: {}, mode }

      const first = applyPlan({
        plan: planInstall({ ...planArgs, lock: readLock(fx.lumemDir) }),
        artifacts,
        lumemDir: fx.lumemDir,
        projectDir: fx.projectDir,
      })
      expect(first.errors).toEqual([])
      expect(first.applied).toHaveLength(3)
      const lockBytes = fs.readFileSync(fx.lockPath)

      const secondPlan = planInstall({ ...planArgs, lock: readLock(fx.lumemDir) })
      expect(secondPlan.actions.map((a) => a.type)).toEqual(['skip', 'skip', 'skip'])

      const second = applyPlan({
        plan: secondPlan,
        artifacts,
        lumemDir: fx.lumemDir,
        projectDir: fx.projectDir,
      })
      expect(second.applied).toEqual([])
      expect(second.errors).toEqual([])
      expect(second.skipped).toHaveLength(3)
      expect(fs.readFileSync(fx.lockPath).equals(lockBytes)).toBe(true)
    })
  }
  it('a rendered hook-config replans as skip, not conflict (idempotence)', () => {
    const fx = setup()
    const artifacts = [
      artifactAt(fx, {
        id: 'hook-config:claude-code',
        kind: 'hook-config',
        file: 'harness/claude-code/hooks.tmpl.json',
        relPath: path.join('.claude', 'settings.json'),
        content: HOOK_TEMPLATE,
      }),
    ]
    const planArgs = { artifacts, projectDir: fx.projectDir, globalDirs: {}, mode: 'copy' as const }

    const first = applyPlan({
      plan: planInstall({ ...planArgs, lock: readLock(fx.lumemDir) }),
      artifacts,
      lumemDir: fx.lumemDir,
      projectDir: fx.projectDir,
    })
    expect(first.errors).toEqual([])
    expect(first.applied).toHaveLength(1)

    // The lock records the source hash for versioning and the rendered hash for
    // drift: without the latter the destination never matches and every replan
    // reports a permanent conflict.
    const entry = readLock(fx.lumemDir).entries[0]
    expect(entry?.contentHash).toBeDefined()
    expect(entry?.contentHash).not.toBe(entry?.hash)

    const secondPlan = planInstall({ ...planArgs, lock: readLock(fx.lumemDir) })
    expect(secondPlan.actions.map((a) => a.type)).toEqual(['skip'])
  })
})
