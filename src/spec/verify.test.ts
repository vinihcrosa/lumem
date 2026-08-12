import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultVerification } from '../core/verification'
import type { TaskRecord, VerdictRecord } from './feature'
import type { Fingerprint } from './fingerprint'
import { findProjectDir, gateCommand, readVerification, verdictState } from './verify'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-verify-'))
}

const HASH = 'b0de76df6f1a04cacabaa433c34c3f441fee3b15e3d1d16f6be116476037d38d'
const OTHER = '0000000000000000000000000000000000000000000000000000000000000000'

const fingerprint = (overrides: Partial<Fingerprint> = {}): Fingerprint => ({
  hash: HASH,
  fileCount: 138,
  incomplete: false,
  ...overrides,
})

const verdict = (overrides: Partial<VerdictRecord> = {}): VerdictRecord => ({
  result: 'pass',
  command: 'npm run verify',
  fingerprint: HASH,
  ...overrides,
})

const task = (gate?: string): TaskRecord => ({
  id: 'T1',
  title: 'Parse',
  done: true,
  dependsOn: [],
  testIds: [],
  ...(gate !== undefined ? { gate } : {}),
})

describe('findProjectDir', () => {
  it('UT-01 finds the root two levels above a feature directory', () => {
    const root = tmpDir()
    fs.mkdirSync(path.join(root, '.lumem'))
    const featureDir = path.join(root, 'docs', 'features', '003-x')
    fs.mkdirSync(featureDir, { recursive: true })

    // `path.resolve`, not `realpath`: the walker preserves the form it was given,
    // so a caller's path is echoed back rather than rewritten through a symlink.
    expect(findProjectDir(featureDir)).toBe(path.resolve(root))
  })

  it('UT-02 finds it in the feature directory itself', () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, '.lumem'))

    expect(findProjectDir(dir)).toBe(path.resolve(dir))
  })

  it('UT-03 returns undefined when nothing above holds a .lumem, without looping', () => {
    const dir = path.join(tmpDir(), 'a', 'b', 'c')
    fs.mkdirSync(dir, { recursive: true })

    // Terminates at the filesystem root rather than at a guessed depth.
    expect(findProjectDir(dir)).toBeUndefined()
  })

  it('UT-04 returns undefined for a path that does not exist', () => {
    expect(findProjectDir(path.join(os.tmpdir(), 'lumem-verify-absent', 'x'))).toBeUndefined()
  })

  it('UT-02 ignores a `.lumem` that is a file rather than a directory', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, '.lumem'), 'not a directory\n')

    expect(findProjectDir(dir)).toBeUndefined()
  })
})

describe('gateCommand', () => {
  it('UT-40 prefers the task over the project default', () => {
    expect(
      gateCommand(task('vitest run src/spec'), {
        ...defaultVerification(),
        command: 'npm run verify',
      }),
    ).toBe('vitest run src/spec')
  })

  it('UT-41 falls back to the project default', () => {
    expect(gateCommand(task(), { ...defaultVerification(), command: 'npm run verify' })).toBe(
      'npm run verify',
    )
  })

  it('UT-42 returns undefined with neither, never a fabricated default', () => {
    expect(gateCommand(task(), defaultVerification())).toBeUndefined()
    expect(gateCommand(undefined, undefined)).toBeUndefined()
  })

  it('UT-42 treats a blank command as absent', () => {
    expect(gateCommand(task('   '), { ...defaultVerification(), command: '  ' })).toBeUndefined()
  })
})

describe('verdictState — the order is the contract', () => {
  it('UT-32 reports absent when there is no verdict', () => {
    expect(verdictState(undefined, 'npm run verify', fingerprint())).toBe('absent')
  })

  it('UT-33 reports unverifiable when no command is known', () => {
    expect(verdictState(verdict(), undefined, fingerprint())).toBe('unverifiable')
  })

  it('UT-34 reports fresh for a passing verdict whose fingerprint matches', () => {
    expect(verdictState(verdict(), 'npm run verify', fingerprint())).toBe('fresh')
  })

  it('UT-35 reports stale when the fingerprint differs', () => {
    expect(verdictState(verdict({ fingerprint: OTHER }), 'npm run verify', fingerprint())).toBe(
      'stale',
    )
  })

  it('UT-36 reports stale when the verdict carries no fingerprint at all', () => {
    const older: VerdictRecord = { result: 'pass', command: 'npm run verify' }
    expect(verdictState(older, 'npm run verify', fingerprint())).toBe('stale')
  })

  it('UT-37 reports stale when the computation was incomplete, even on a match', () => {
    const computed = fingerprint({ incomplete: true })
    // A file lumem could not read might be exactly the changed one.
    expect(verdictState(verdict(), 'npm run verify', computed)).toBe('stale')
  })

  it('UT-37 reports stale when nothing was covered at all', () => {
    const computed = fingerprint({ hash: '', fileCount: 0 })
    expect(verdictState(verdict({ fingerprint: '' }), 'npm run verify', computed)).toBe('stale')
  })

  it('UT-38 reports failing for a recorded failure on a matching tree', () => {
    expect(verdictState(verdict({ result: 'fail' }), 'npm run verify', fingerprint())).toBe(
      'failing',
    )
  })

  it('UT-39 reports stale, not failing, when the tree changed under a failure', () => {
    const stale = verdict({ result: 'fail', fingerprint: OTHER })
    // The failure describes a tree that no longer exists; reporting it as a
    // failure would send someone to fix something that may already be fixed.
    expect(verdictState(stale, 'npm run verify', fingerprint())).toBe('stale')
  })

  it('UT-32 puts absent ahead of unverifiable', () => {
    expect(verdictState(undefined, undefined, fingerprint())).toBe('absent')
  })

  it('UT-33 puts unverifiable ahead of stale', () => {
    const older: VerdictRecord = { result: 'pass' }
    expect(verdictState(older, undefined, fingerprint({ incomplete: true }))).toBe('unverifiable')
  })
})

describe('readVerification', () => {
  /** A project holding a `.lumem`, one source file, and a feature directory. */
  function project(): { root: string; featureDir: string } {
    const root = tmpDir()
    fs.mkdirSync(path.join(root, '.lumem'))
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
    const featureDir = path.join(root, 'docs', 'features', '003-x')
    fs.mkdirSync(featureDir, { recursive: true })
    return { root, featureDir }
  }

  it('UT-34 assembles a fresh state when the recorded fingerprint matches', () => {
    const { featureDir } = project()
    const cfg = { ...defaultVerification(), command: 'npm run verify' }

    const first = readVerification(featureDir, undefined, undefined, () => cfg)
    expect(first?.state).toBe('absent')

    const recorded = verdict({ fingerprint: first?.computed.hash })
    const second = readVerification(featureDir, recorded, undefined, () => cfg)

    expect(second?.state).toBe('fresh')
    expect(second?.command).toBe('npm run verify')
    expect(second?.computed.fileCount).toBe(1)
  })

  it('UT-35 goes stale after a covered file changes', () => {
    const { root, featureDir } = project()
    const cfg = { ...defaultVerification(), command: 'npm run verify' }
    const before = readVerification(featureDir, undefined, undefined, () => cfg)
    const recorded = verdict({ fingerprint: before?.computed.hash })

    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2\n')

    expect(readVerification(featureDir, recorded, undefined, () => cfg)?.state).toBe('stale')
  })

  it('UT-42 reports unverifiable when the project names no command', () => {
    const { featureDir } = project()
    const state = readVerification(featureDir, verdict(), undefined, () => defaultVerification())

    expect(state?.state).toBe('unverifiable')
    expect(state?.command).toBeUndefined()
  })

  it('UT-03 returns undefined outside a lumem project', () => {
    const outside = path.join(tmpDir(), 'docs', 'features', '003-x')
    fs.mkdirSync(outside, { recursive: true })

    // Nothing to read a config from and nothing to fingerprint: inventing either
    // would let a verdict pass for lack of anything to check it against.
    expect(readVerification(outside, verdict(), undefined, () => undefined)).toBeUndefined()
  })

  it('UT-41 falls back to the default verification block when the project has no config', () => {
    const { featureDir } = project()
    const state = readVerification(featureDir, verdict(), task('vitest run src'), () => undefined)

    expect(state?.command).toBe('vitest run src')
  })
})
