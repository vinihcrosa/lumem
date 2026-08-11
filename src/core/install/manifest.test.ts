import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
