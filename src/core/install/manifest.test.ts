import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256 } from '../shared/fsx'
import { type ManifestDescriptor, buildManifest } from './manifest'

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function descriptor(
  id: string,
  opts: { skillsProject: string; hooksPath: string },
): ManifestDescriptor {
  return {
    id,
    paths: {
      home: `~/.${id}`,
      skills: { project: opts.skillsProject, global: `~/.${id}/skills` },
      hooksConfig: [
        { scope: 'project', path: opts.hooksPath, format: 'json', strategy: 'merge-json' },
      ],
    },
  }
}

describe('buildManifest', () => {
  let tmp: string
  let assetsDir: string
  let distDir: string

  const claude = descriptor('claude-code', {
    skillsProject: '.claude/skills',
    hooksPath: '.claude/settings.json',
  })
  const codex = descriptor('codex', {
    skillsProject: '.codex/skills',
    hooksPath: '.codex/config.json',
  })

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-manifest-'))
    assetsDir = path.join(tmp, 'assets')
    distDir = path.join(tmp, 'dist')
    write(path.join(assetsDir, 'skills', 'lumem-memory', 'SKILL.md'), '# lumem-memory\n')
    write(path.join(assetsDir, 'skills', 'zz-extra', 'SKILL.md'), '# zz-extra\n')
    write(path.join(assetsDir, 'harness', 'claude-code', 'hooks.tmpl.json'), '{"hooks":{}}\n')
    write(path.join(distDir, 'lumem-hook.mjs'), 'export const hook = 1\n')
    write(path.join(distDir, 'lumem-runner.mjs'), 'export const runner = 1\n')
    write(path.join(distDir, 'lumem-spec.mjs'), 'export const spec = 1\n')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('emits one skill artifact per skill directory per descriptor', () => {
    const out = buildManifest({
      assetsDir,
      distDir,
      version: '1.2.3',
      descriptors: [claude, codex],
    })
    const skills = out.filter((a) => a.kind === 'skill')
    expect(skills.map((a) => a.id).sort()).toEqual([
      'skill:lumem-memory@claude-code',
      'skill:lumem-memory@codex',
      'skill:zz-extra@claude-code',
      'skill:zz-extra@codex',
    ])
    const srcPath = path.join(assetsDir, 'skills', 'lumem-memory', 'SKILL.md')
    expect(out.find((a) => a.id === 'skill:lumem-memory@claude-code')).toEqual({
      id: 'skill:lumem-memory@claude-code',
      kind: 'skill',
      version: '1.2.3',
      srcPath,
      hash: sha256(fs.readFileSync(srcPath)),
      dest: {
        harness: 'claude-code',
        scope: 'project',
        relPath: '.claude/skills/lumem-memory/SKILL.md',
      },
    })
    expect(out.find((a) => a.id === 'skill:zz-extra@codex')?.dest).toEqual({
      harness: 'codex',
      scope: 'project',
      relPath: '.codex/skills/zz-extra/SKILL.md',
    })
  })

  it('emits a hook-config artifact from the harness template, targeting hooksConfig[0]', () => {
    const out = buildManifest({
      assetsDir,
      distDir,
      version: '0.1.0',
      descriptors: [claude, codex],
    })
    const tmplPath = path.join(assetsDir, 'harness', 'claude-code', 'hooks.tmpl.json')
    expect(out.find((a) => a.id === 'hook-config:claude-code')).toEqual({
      id: 'hook-config:claude-code',
      kind: 'hook-config',
      version: '0.1.0',
      srcPath: tmplPath,
      hash: sha256(fs.readFileSync(tmplPath)),
      dest: { harness: 'claude-code', scope: 'project', relPath: '.claude/settings.json' },
    })
  })

  it('skips hook-config without error when the template is missing', () => {
    const out = buildManifest({
      assetsDir,
      distDir,
      version: '0.1.0',
      descriptors: [claude, codex],
    })
    expect(out.find((a) => a.id === 'hook-config:codex')).toBeUndefined()
  })

  it('emits hook-bundle artifacts once with harness "*" regardless of descriptor count', () => {
    const out = buildManifest({
      assetsDir,
      distDir,
      version: '0.1.0',
      descriptors: [claude, codex],
    })
    const bundles = out.filter((a) => a.kind === 'hook-bundle')
    expect(bundles).toHaveLength(3)
    const hookPath = path.join(distDir, 'lumem-hook.mjs')
    expect(bundles.find((a) => a.id === 'hook-bundle:lumem-hook')).toEqual({
      id: 'hook-bundle:lumem-hook',
      kind: 'hook-bundle',
      version: '0.1.0',
      srcPath: hookPath,
      hash: sha256(fs.readFileSync(hookPath)),
      dest: { harness: '*', scope: 'project', relPath: '.lumem/bin/lumem-hook.mjs' },
    })
    expect(bundles.find((a) => a.id === 'hook-bundle:lumem-runner')?.dest.relPath).toBe(
      '.lumem/bin/lumem-runner.mjs',
    )
    expect(bundles.find((a) => a.id === 'hook-bundle:lumem-spec')?.dest.relPath).toBe(
      '.lumem/bin/lumem-spec.mjs',
    )
  })

  it('is deterministic: identical output for the same tree, sorted by id', () => {
    const opts = { assetsDir, distDir, version: '0.1.0', descriptors: [codex, claude] }
    const first = buildManifest(opts)
    const second = buildManifest(opts)
    expect(second).toEqual(first)
    expect(first.map((a) => a.id)).toEqual([...first.map((a) => a.id)].sort())
  })

  it('changing one fixture file changes only that artifact hash', () => {
    const opts = { assetsDir, distDir, version: '0.1.0', descriptors: [claude] }
    const before = buildManifest(opts)
    write(path.join(assetsDir, 'skills', 'lumem-memory', 'SKILL.md'), '# lumem-memory v2\n')
    const after = buildManifest(opts)
    expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id))
    for (const [i, artifact] of after.entries()) {
      if (artifact.id === 'skill:lumem-memory@claude-code') {
        expect(artifact.hash).not.toBe(before[i]?.hash)
      } else {
        expect(artifact).toEqual(before[i])
      }
    }
  })

  it('throws with the offending path when a dist bundle is missing', () => {
    const runnerPath = path.join(distDir, 'lumem-runner.mjs')
    fs.rmSync(runnerPath)
    expect(() =>
      buildManifest({ assetsDir, distDir, version: '0.1.0', descriptors: [claude] }),
    ).toThrow(runnerPath)
  })

  it('ignores stray files and skill directories without SKILL.md', () => {
    write(path.join(assetsDir, 'skills', 'README.md'), 'not a skill\n')
    fs.mkdirSync(path.join(assetsDir, 'skills', 'no-skill-md'))
    const out = buildManifest({ assetsDir, distDir, version: '0.1.0', descriptors: [claude] })
    const skillIds = out.filter((a) => a.kind === 'skill').map((a) => a.id)
    expect(skillIds).toEqual(['skill:lumem-memory@claude-code', 'skill:zz-extra@claude-code'])
  })

  it('emits only bundles when assets has no skills or templates', () => {
    fs.rmSync(path.join(assetsDir, 'skills'), { recursive: true })
    fs.rmSync(path.join(assetsDir, 'harness'), { recursive: true })
    const out = buildManifest({ assetsDir, distDir, version: '0.1.0', descriptors: [claude] })
    expect(out.map((a) => a.id)).toEqual([
      'hook-bundle:lumem-hook',
      'hook-bundle:lumem-runner',
      'hook-bundle:lumem-spec',
    ])
  })
})

describe('buildManifest over the real asset tree (002 T9)', () => {
  const realAssets = fileURLToPath(new URL('../../../assets', import.meta.url))

  /** The real skill destinations: Claude Code uses .claude, Codex uses .agents. */
  const claudeReal = descriptor('claude-code', {
    skillsProject: '.claude/skills',
    hooksPath: '.claude/settings.json',
  })
  const codexReal = descriptor('codex', {
    skillsProject: '.agents/skills',
    hooksPath: '.codex/hooks.json',
  })

  let dist: string

  beforeEach(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-manifest-real-'))
    for (const bundle of ['lumem-hook.mjs', 'lumem-runner.mjs', 'lumem-spec.mjs']) {
      write(path.join(dist, bundle), 'export const x = 1\n')
    }
  })

  afterEach(() => {
    fs.rmSync(dist, { recursive: true, force: true })
  })

  const build = (descriptors = [claudeReal, codexReal]) =>
    buildManifest({ assetsDir: realAssets, distDir: dist, version: '0.2.0', descriptors })

  it('IT-20 ships every spec skill, references included, to both harnesses', () => {
    const skillIds = build()
      .filter((a) => a.kind === 'skill')
      .map((a) => a.id)

    for (const harness of ['claude-code', 'codex']) {
      for (const name of [
        'lumem-spec-preflight',
        'lumem-prd',
        'lumem-tdd',
        'lumem-tasks',
        'lumem-execute-task',
        'lumem-verify',
      ]) {
        expect(skillIds).toContain(`skill:${name}@${harness}`)
      }
      expect(skillIds).toContain(`skill:lumem-prd/references/prd-template.md@${harness}`)
      expect(skillIds).toContain(`skill:lumem-tdd/references/tests-template.md@${harness}`)
      expect(skillIds).toContain(`skill:lumem-tasks/references/task-template.md@${harness}`)
    }
  })

  it('IT-20 puts each file at the destination its harness declares', () => {
    const out = build()
    const dest = (id: string): string | undefined => out.find((a) => a.id === id)?.dest.relPath

    expect(dest('skill:lumem-verify@claude-code')).toBe('.claude/skills/lumem-verify/SKILL.md')
    expect(dest('skill:lumem-prd/references/adr-template.md@claude-code')).toBe(
      '.claude/skills/lumem-prd/references/adr-template.md',
    )
    expect(dest('skill:lumem-verify@codex')).toBe('.agents/skills/lumem-verify/SKILL.md')
  })

  it('IT-20 emits a skill artifact only for a directory holding a SKILL.md', () => {
    const skills = build([claudeReal]).filter((a) => a.kind === 'skill')
    // Every id names one of the shipped skills; `assets/agents` and
    // `assets/harness` are siblings of `skills`, not skills.
    expect(skills.every((a) => a.id.startsWith('skill:lumem-'))).toBe(true)
    expect(skills.length).toBeGreaterThan(8)
  })
})
