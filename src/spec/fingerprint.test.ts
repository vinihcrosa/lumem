import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { VerificationConfig } from '../core/verification'
import { defaultVerification } from '../core/verification'
import { computeFingerprint } from './fingerprint'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-fp-'))
}

function write(root: string, relative: string, content: string): string {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

/** A project holding `files`, keyed by path relative to its root. */
function project(files: Record<string, string>): string {
  const root = tmpDir()
  for (const [relative, content] of Object.entries(files)) write(root, relative, content)
  return root
}

const cfg = (overrides: Partial<VerificationConfig> = {}): VerificationConfig => ({
  ...defaultVerification(),
  ...overrides,
})

const TREE = {
  'src/a.ts': 'export const a = 1\n',
  'src/spec/b.ts': 'export const b = 2\n',
  'test/c.test.ts': 'it("x", () => {})\n',
  'package.json': '{"name":"probe"}\n',
  'docs/features/003/tasks.md': '# tasks\n',
  'node_modules/dep/index.js': 'module.exports = 1\n',
  'dist/bundle.mjs': 'export const bundled = 1\n',
}

describe('computeFingerprint — stability', () => {
  it('UT-05 returns the same hash and count for an unchanged tree', () => {
    const root = project(TREE)
    const first = computeFingerprint(root, cfg())
    const second = computeFingerprint(root, cfg())

    expect(first.hash).toBe(second.hash)
    expect(first.fileCount).toBe(second.fileCount)
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(first.incomplete).toBe(false)
  })

  it('UT-06 changes the hash when one byte of a covered file changes', () => {
    const root = project(TREE)
    const before = computeFingerprint(root, cfg())
    write(root, 'src/a.ts', 'export const a = 2\n')

    expect(computeFingerprint(root, cfg()).hash).not.toBe(before.hash)
  })

  it('UT-13 does not depend on the order files were created in', () => {
    const forward = project(TREE)
    const reversed = tmpDir()
    for (const [relative, content] of Object.entries(TREE).reverse()) {
      write(reversed, relative, content)
    }

    expect(computeFingerprint(reversed, cfg()).hash).toBe(computeFingerprint(forward, cfg()).hash)
  })

  it('UT-14 changes the hash when two covered files swap contents', () => {
    const root = project(TREE)
    const before = computeFingerprint(root, cfg())

    write(root, 'src/a.ts', TREE['src/spec/b.ts'])
    write(root, 'src/spec/b.ts', TREE['src/a.ts'])

    // A manifest that hashed contents without their paths would be blind to this.
    expect(computeFingerprint(root, cfg()).hash).not.toBe(before.hash)
    expect(computeFingerprint(root, cfg()).fileCount).toBe(before.fileCount)
  })
})

describe('computeFingerprint — coverage', () => {
  it('UT-07 ignores a file added under docs', () => {
    const root = project(TREE)
    const before = computeFingerprint(root, cfg())
    write(root, 'docs/features/003/verdict.md', '- **Result:** PASS\n')

    // The whole point of D7: recording a verdict cannot invalidate that verdict.
    expect(computeFingerprint(root, cfg()).hash).toBe(before.hash)
  })

  it('UT-08 counts a file added under an included prefix', () => {
    const root = project(TREE)
    const before = computeFingerprint(root, cfg())
    write(root, 'src/new.ts', 'export const n = 3\n')

    const after = computeFingerprint(root, cfg())
    expect(after.hash).not.toBe(before.hash)
    expect(after.fileCount).toBe(before.fileCount + 1)
  })

  it('UT-09 does not cover node_modules nested inside an included prefix', () => {
    const bare = project(TREE)
    const withNested = project(TREE)
    write(withNested, 'src/node_modules/dep/index.js', 'module.exports = 2\n')

    expect(computeFingerprint(withNested, cfg()).hash).toBe(computeFingerprint(bare, cfg()).hash)
  })

  it('UT-10 lets exclusion win over inclusion, checked first', () => {
    const root = project(TREE)
    const explicit = cfg({ fingerprintInclude: ['src'], fingerprintExclude: ['src/spec'] })

    const covered = computeFingerprint(root, explicit)
    const only = computeFingerprint(root, cfg({ fingerprintInclude: ['src/a.ts'] }))

    expect(covered.fileCount).toBe(1)
    expect(covered.hash).toBe(only.hash)
  })

  it('UT-09 excludes dist, which is generated and would make every build a change', () => {
    const root = project(TREE)
    const withMore = project(TREE)
    write(withMore, 'dist/extra.mjs', 'export const x = 1\n')

    expect(computeFingerprint(withMore, cfg()).hash).toBe(computeFingerprint(root, cfg()).hash)
  })

  it('UT-08 covers a top-level file named exactly by a prefix', () => {
    const root = project(TREE)
    const before = computeFingerprint(root, cfg())
    write(root, 'package.json', '{"name":"probe","version":"2"}\n')

    expect(computeFingerprint(root, cfg()).hash).not.toBe(before.hash)
  })

  it('UT-09 does not cover a sibling whose name merely starts with a prefix', () => {
    const root = project(TREE)
    const before = computeFingerprint(root, cfg())
    write(root, 'srcextra/x.ts', 'export const x = 1\n')

    expect(computeFingerprint(root, cfg()).hash).toBe(before.hash)
  })
})

describe('computeFingerprint — degraded input', () => {
  it('UT-11 marks an unreadable covered file incomplete and still produces a hash', () => {
    const root = project(TREE)
    const unreadableDir = path.join(root, 'src', 'locked')
    fs.mkdirSync(unreadableDir)
    write(root, 'src/locked/x.ts', 'export const x = 1\n')
    fs.chmodSync(unreadableDir, 0o000)

    try {
      const result = computeFingerprint(root, cfg())
      expect(result.incomplete).toBe(true)
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(result.fileCount).toBeGreaterThan(0)
    } finally {
      fs.chmodSync(unreadableDir, 0o755)
    }
  })

  it('UT-12 reports an empty hash rather than the hash of nothing', () => {
    const root = project(TREE)
    const result = computeFingerprint(root, cfg({ fingerprintInclude: ['web'] }))

    expect(result).toEqual({ hash: '', fileCount: 0, incomplete: false })
  })

  it('UT-12 treats a project directory that does not exist as empty and incomplete', () => {
    const result = computeFingerprint(path.join(os.tmpdir(), 'lumem-fp-absent'), cfg())

    expect(result.hash).toBe('')
    expect(result.fileCount).toBe(0)
    expect(result.incomplete).toBe(true)
  })
})
