import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AdapterDescriptor, DetectRule } from '../../adapters/schema'
import { detect } from './detect'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-detect-'))
}

function makeDescriptor(rules: DetectRule[]): AdapterDescriptor {
  return {
    id: 'test-adapter',
    minVersion: '1.0.0',
    detect: rules,
    paths: {
      home: '~/.test-adapter',
      skills: { project: '.test/skills', global: '~/.test-adapter/skills' },
      hooksConfig: [],
    },
    capabilities: {
      'hooks.sessionStart': true,
      'hooks.sessionEnd': true,
      'hooks.userPromptSubmit': true,
      'hooks.postToolUse': true,
      'hooks.envProjectDir': true,
      'hooks.requiresTrust': false,
      'hooks.stdoutInjection': true,
      'platform.windows': false,
    },
    eventMap: {},
    injection: ['hook-stdout'],
    headless: { command: ['test-adapter'], promptVia: 'stdin' },
  }
}

// Fixtures shared across tests. NEVER touch the real user home: every rule that
// expands `~` is exercised against an injected HOME.
let fakeHome: string
let emptyHome: string
let binDir: string
let emptyPathDir: string
let fakebinPath: string
let failbinPath: string

beforeAll(() => {
  fakeHome = tmpDir()
  fs.mkdirSync(path.join(fakeHome, '.claude'))
  fs.writeFileSync(path.join(fakeHome, 'settings.json'), '{}')

  emptyHome = tmpDir()
  emptyPathDir = tmpDir()

  binDir = tmpDir()
  fakebinPath = path.join(binDir, 'fakebin')
  fs.writeFileSync(fakebinPath, '#!/bin/sh\necho "fakebin 9.9.9 (test)"\n')
  fs.chmodSync(fakebinPath, 0o755)

  failbinPath = path.join(binDir, 'failbin')
  fs.writeFileSync(failbinPath, '#!/bin/sh\necho "failbin 8.8.8"\nexit 1\n')
  fs.chmodSync(failbinPath, 0o755)

  const noexec = path.join(binDir, 'noexec')
  fs.writeFileSync(noexec, '#!/bin/sh\necho "noexec 7.7.7"\n')
  fs.chmodSync(noexec, 0o644)
})

describe('detect: dir rules', () => {
  it('matches an existing directory under the injected HOME', () => {
    const result = detect(makeDescriptor([{ type: 'dir', path: '~/.claude' }]), {
      HOME: fakeHome,
      PATH: emptyPathDir,
    })
    expect(result.detected).toBe(true)
    expect(result.matchedRules).toBe(1)
    expect(result.binPath).toBeUndefined()
    expect(result.version).toBeUndefined()
  })

  it('uses the injected HOME instead of the real one', () => {
    // The real ~/.claude may exist on a dev machine; against emptyHome it must not match.
    const result = detect(makeDescriptor([{ type: 'dir', path: '~/.claude' }]), {
      HOME: emptyHome,
      PATH: emptyPathDir,
    })
    expect(result.detected).toBe(false)
    expect(result.matchedRules).toBe(0)
  })

  it('does not match when the path is a file, not a directory', () => {
    const result = detect(makeDescriptor([{ type: 'dir', path: '~/settings.json' }]), {
      HOME: fakeHome,
      PATH: emptyPathDir,
    })
    expect(result.detected).toBe(false)
    expect(result.matchedRules).toBe(0)
  })
})

describe('detect: file rules', () => {
  it('matches an existing file under the injected HOME', () => {
    const result = detect(makeDescriptor([{ type: 'file', path: '~/settings.json' }]), {
      HOME: fakeHome,
      PATH: emptyPathDir,
    })
    expect(result.detected).toBe(true)
    expect(result.matchedRules).toBe(1)
  })

  it('does not match when the path is a directory, not a file', () => {
    const result = detect(makeDescriptor([{ type: 'file', path: '~/.claude' }]), {
      HOME: fakeHome,
      PATH: emptyPathDir,
    })
    expect(result.detected).toBe(false)
    expect(result.matchedRules).toBe(0)
  })

  it('matches an absolute path without touching HOME expansion', () => {
    const result = detect(makeDescriptor([{ type: 'file', path: fakebinPath }]), {
      HOME: emptyHome,
      PATH: emptyPathDir,
    })
    expect(result.detected).toBe(true)
    expect(result.matchedRules).toBe(1)
  })
})

describe('detect: bin rules', () => {
  it('finds an executable on the injected PATH and extracts the version', () => {
    const result = detect(
      makeDescriptor([{ type: 'bin', name: 'fakebin', versionArgs: ['--version'] }]),
      { HOME: emptyHome, PATH: binDir },
    )
    expect(result.detected).toBe(true)
    expect(result.matchedRules).toBe(1)
    expect(result.binPath).toBe(fakebinPath)
    expect(result.version).toBe('9.9.9')
  })

  it('searches multiple PATH entries', () => {
    const result = detect(
      makeDescriptor([{ type: 'bin', name: 'fakebin', versionArgs: ['--version'] }]),
      { HOME: emptyHome, PATH: `${emptyPathDir}${path.delimiter}${binDir}` },
    )
    expect(result.detected).toBe(true)
    expect(result.binPath).toBe(fakebinPath)
    expect(result.version).toBe('9.9.9')
  })

  it('skips a non-executable file on PATH', () => {
    const result = detect(makeDescriptor([{ type: 'bin', name: 'noexec' }]), {
      HOME: emptyHome,
      PATH: binDir,
    })
    expect(result.detected).toBe(false)
    expect(result.matchedRules).toBe(0)
    expect(result.binPath).toBeUndefined()
  })

  it('sets binPath without probing when versionArgs is absent', () => {
    const result = detect(makeDescriptor([{ type: 'bin', name: 'fakebin' }]), {
      HOME: emptyHome,
      PATH: binDir,
    })
    expect(result.detected).toBe(true)
    expect(result.matchedRules).toBe(1)
    expect(result.binPath).toBe(fakebinPath)
    expect(result.version).toBeUndefined()
  })

  it('keeps version undefined when the probe exits nonzero, but detection still counts', () => {
    const result = detect(
      makeDescriptor([{ type: 'bin', name: 'failbin', versionArgs: ['--version'] }]),
      { HOME: emptyHome, PATH: binDir },
    )
    expect(result.detected).toBe(true)
    expect(result.matchedRules).toBe(1)
    expect(result.binPath).toBe(failbinPath)
    expect(result.version).toBeUndefined()
  })
})

describe('detect: rule combination', () => {
  it('returns detected false with matchedRules 0 when nothing exists', () => {
    const result = detect(
      makeDescriptor([
        { type: 'dir', path: '~/.nothing-here' },
        { type: 'file', path: '~/absent.json' },
        { type: 'bin', name: 'no-such-bin-xyz' },
      ]),
      { HOME: emptyHome, PATH: emptyPathDir },
    )
    expect(result).toEqual({ detected: false, matchedRules: 0 })
  })

  it('detects when only the second of multiple rules matches', () => {
    const result = detect(
      makeDescriptor([
        { type: 'dir', path: '~/.nothing-here' },
        { type: 'dir', path: '~/.claude' },
      ]),
      { HOME: fakeHome, PATH: emptyPathDir },
    )
    expect(result.detected).toBe(true)
    expect(result.matchedRules).toBe(1)
  })

  it('counts every matching rule', () => {
    const result = detect(
      makeDescriptor([
        { type: 'dir', path: '~/.claude' },
        { type: 'file', path: '~/settings.json' },
        { type: 'bin', name: 'fakebin', versionArgs: ['--version'] },
      ]),
      { HOME: fakeHome, PATH: binDir },
    )
    expect(result.detected).toBe(true)
    expect(result.matchedRules).toBe(3)
    expect(result.binPath).toBe(fakebinPath)
    expect(result.version).toBe('9.9.9')
  })
})

describe('detect: robustness', () => {
  it('never throws on degenerate inputs', () => {
    expect(() =>
      detect(
        makeDescriptor([
          { type: 'dir', path: '' },
          { type: 'file', path: '\0bad' },
          { type: 'bin', name: '' },
          { type: 'bin', name: 'x', versionArgs: [] },
        ]),
        { HOME: '', PATH: `${path.delimiter}${path.delimiter}` },
      ),
    ).not.toThrow()
  })

  it('never throws when PATH is undefined in the injected env', () => {
    const result = detect(makeDescriptor([{ type: 'bin', name: 'no-such-bin-xyz' }]), {
      HOME: emptyHome,
      PATH: undefined,
    })
    expect(result.detected).toBe(false)
  })

  it('never throws with an empty rule list', () => {
    const result = detect(makeDescriptor([]), { HOME: emptyHome, PATH: emptyPathDir })
    expect(result).toEqual({ detected: false, matchedRules: 0 })
  })
})
