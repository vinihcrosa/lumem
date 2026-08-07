import { describe, expect, it } from 'vitest'
import type { AdapterDescriptor } from '../../adapters/schema'
import { type DetectionInput, compareVersions, resolveMode } from './mode'

interface DescriptorOverrides {
  capabilities?: Partial<AdapterDescriptor['capabilities']>
  injection?: AdapterDescriptor['injection']
  minVersion?: string
}

const descriptor = (overrides: DescriptorOverrides = {}): AdapterDescriptor => ({
  id: 'claude-code',
  minVersion: overrides.minVersion ?? '1.0.0',
  detect: [{ type: 'dir', path: '.claude' }],
  paths: {
    home: '~/.claude',
    skills: { project: '.claude/skills', global: '~/.claude/skills' },
    hooksConfig: [
      { scope: 'project', path: '.claude/settings.json', format: 'json', strategy: 'merge-json' },
    ],
    contextDoc: { project: 'CLAUDE.md', maxBytes: 4096 },
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
    ...overrides.capabilities,
  },
  eventMap: { inject: 'SessionStart' },
  injection: overrides.injection ?? ['hook-stdout', 'context-doc-block', 'skill-instruction'],
  headless: { command: ['claude', '-p'], promptVia: 'arg' },
})

const detection = (overrides: Partial<DetectionInput> = {}): DetectionInput => ({
  detected: true,
  matchedRules: 2,
  version: '2.0.0',
  binPath: '/usr/local/bin/claude',
  ...overrides,
})

const noHooks: DescriptorOverrides['capabilities'] = {
  'hooks.sessionStart': false,
  'hooks.sessionEnd': false,
  'hooks.userPromptSubmit': false,
  'hooks.postToolUse': false,
}

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('treats missing segments as 0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('2', '2.0.0')).toBe(0)
  })

  it('compares segments numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('0.9.0', '1.0.0')).toBe(-1)
  })

  it('strips leading non-digits per segment', () => {
    expect(compareVersions('v2.0', '2.0.0')).toBe(0)
    expect(compareVersions('v1.5', 'v1.4')).toBe(1)
  })

  it('ignores pre-release identifiers', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0)
    expect(compareVersions('2.0.0-rc.1', '2.0.0')).toBe(0)
  })

  it('never throws on garbage input', () => {
    expect(() => compareVersions('garbage', '')).not.toThrow()
    expect(compareVersions('garbage', '0')).toBe(0)
  })
})

describe('resolveMode', () => {
  describe('rule 1: not detected', () => {
    it('grades unavailable with empty missing, fallbacks and warnings', () => {
      const mode = resolveMode(
        descriptor(),
        detection({ detected: false, version: undefined, binPath: undefined, matchedRules: 0 }),
      )

      expect(mode.harness).toBe('claude-code')
      expect(mode.detected).toBe(false)
      expect(mode.grade).toBe('unavailable')
      expect(mode.missing).toEqual([])
      expect(mode.fallbacks).toEqual({})
      expect(mode.warnings).toEqual([])
    })

    it('skips version and trust checks when not detected', () => {
      const mode = resolveMode(
        descriptor({ minVersion: '9.9.9', capabilities: { 'hooks.requiresTrust': true } }),
        detection({ detected: false, version: '0.0.1' }),
      )

      expect(mode.grade).toBe('unavailable')
      expect(mode.warnings).toEqual([])
      expect(mode.missing).toEqual([])
    })
  })

  describe('rule 2: full', () => {
    it('grades full when all four hook capabilities are true', () => {
      const mode = resolveMode(descriptor(), detection())

      expect(mode.grade).toBe('full')
      expect(mode.detected).toBe(true)
      expect(mode.missing).toEqual([])
      expect(mode.fallbacks).toEqual({})
      expect(mode.warnings).toEqual([])
    })

    it('echoes harness id and detected version', () => {
      const mode = resolveMode(descriptor(), detection({ version: '3.1.4' }))

      expect(mode.harness).toBe('claude-code')
      expect(mode.version).toBe('3.1.4')
    })
  })

  describe('rule 3: skill-only', () => {
    it('grades skill-only when all four hook capabilities are false', () => {
      const mode = resolveMode(descriptor({ capabilities: noHooks }), detection())

      expect(mode.grade).toBe('skill-only')
      expect(mode.missing).toEqual(
        expect.arrayContaining([
          'hooks.sessionStart',
          'hooks.sessionEnd',
          'hooks.userPromptSubmit',
          'hooks.postToolUse',
        ]),
      )
      expect(mode.fallbacks).toEqual({
        injection: 'context-doc-block',
        capture: 'skill-instruction',
        consolidation: 'manual',
      })
    })

    it('falls back injection to skill-instruction when only hook-stdout is available', () => {
      const mode = resolveMode(
        descriptor({ capabilities: noHooks, injection: ['hook-stdout'] }),
        detection(),
      )

      expect(mode.fallbacks.injection).toBe('skill-instruction')
    })
  })

  describe('rule 4: degraded (mixed)', () => {
    it('maps missing sessionStart to an injection fallback', () => {
      const mode = resolveMode(
        descriptor({ capabilities: { 'hooks.sessionStart': false } }),
        detection(),
      )

      expect(mode.grade).toBe('degraded')
      expect(mode.missing).toEqual(['hooks.sessionStart'])
      expect(mode.fallbacks).toEqual({ injection: 'context-doc-block' })
    })

    it('maps missing sessionEnd to a manual consolidation fallback', () => {
      const mode = resolveMode(
        descriptor({ capabilities: { 'hooks.sessionEnd': false } }),
        detection(),
      )

      expect(mode.grade).toBe('degraded')
      expect(mode.missing).toEqual(['hooks.sessionEnd'])
      expect(mode.fallbacks).toEqual({ consolidation: 'manual' })
    })

    it('maps missing userPromptSubmit to a skill-instruction capture fallback', () => {
      const mode = resolveMode(
        descriptor({ capabilities: { 'hooks.userPromptSubmit': false } }),
        detection(),
      )

      expect(mode.grade).toBe('degraded')
      expect(mode.missing).toEqual(['hooks.userPromptSubmit'])
      expect(mode.fallbacks).toEqual({ capture: 'skill-instruction' })
    })

    it('maps missing postToolUse to a skill-instruction capture fallback', () => {
      const mode = resolveMode(
        descriptor({ capabilities: { 'hooks.postToolUse': false } }),
        detection(),
      )

      expect(mode.grade).toBe('degraded')
      expect(mode.missing).toEqual(['hooks.postToolUse'])
      expect(mode.fallbacks).toEqual({ capture: 'skill-instruction' })
    })

    it('lists every false capability and sets a single capture fallback for both', () => {
      const mode = resolveMode(
        descriptor({
          capabilities: { 'hooks.userPromptSubmit': false, 'hooks.postToolUse': false },
        }),
        detection(),
      )

      expect(mode.grade).toBe('degraded')
      expect(mode.missing).toEqual(['hooks.userPromptSubmit', 'hooks.postToolUse'])
      expect(mode.fallbacks).toEqual({ capture: 'skill-instruction' })
    })
  })

  describe('rule 5: envProjectDir', () => {
    it('adds a projectResolution fallback without degrading the grade', () => {
      const mode = resolveMode(
        descriptor({ capabilities: { 'hooks.envProjectDir': false } }),
        detection(),
      )

      expect(mode.grade).toBe('full')
      expect(mode.missing).toEqual([])
      expect(mode.fallbacks).toEqual({ projectResolution: 'stdin-cwd' })
    })
  })

  describe('rule 6: version check', () => {
    it('caps full at degraded and warns with both versions when below minimum', () => {
      const mode = resolveMode(descriptor({ minVersion: '2.5.0' }), detection({ version: '2.4.9' }))

      expect(mode.grade).toBe('degraded')
      expect(mode.missing).toContain('minVersion')
      expect(mode.warnings).toHaveLength(1)
      expect(mode.warnings[0]).toContain('2.4.9')
      expect(mode.warnings[0]).toContain('2.5.0')
    })

    it('keeps skill-only at skill-only when below minimum', () => {
      const mode = resolveMode(
        descriptor({ capabilities: noHooks, minVersion: '2.5.0' }),
        detection({ version: '1.0.0' }),
      )

      expect(mode.grade).toBe('skill-only')
      expect(mode.missing).toContain('minVersion')
      expect(mode.warnings).toHaveLength(1)
    })

    it('does not warn when the version meets the minimum', () => {
      const mode = resolveMode(descriptor({ minVersion: '1.0.0' }), detection({ version: '1.0.0' }))

      expect(mode.grade).toBe('full')
      expect(mode.warnings).toEqual([])
      expect(mode.missing).not.toContain('minVersion')
    })

    it('skips the version check when detection has no version', () => {
      const mode = resolveMode(
        descriptor({ minVersion: '9.9.9' }),
        detection({ version: undefined }),
      )

      expect(mode.grade).toBe('full')
      expect(mode.warnings).toEqual([])
      expect(mode.version).toBeUndefined()
    })
  })

  describe('rule 7: requiresTrust', () => {
    it('adds a trust reminder mentioning /hooks without changing the grade', () => {
      const mode = resolveMode(
        descriptor({ capabilities: { 'hooks.requiresTrust': true } }),
        detection(),
      )

      expect(mode.grade).toBe('full')
      expect(mode.warnings).toHaveLength(1)
      expect(mode.warnings[0]).toContain('/hooks')
    })
  })

  describe('rule 8: purity', () => {
    it('never throws on garbage version strings', () => {
      const call = () =>
        resolveMode(descriptor({ minVersion: 'not-a-version' }), detection({ version: '???' }))
      expect(call).not.toThrow()
    })

    it('is deterministic and does not mutate its inputs', () => {
      const desc = descriptor({ capabilities: { 'hooks.sessionEnd': false } })
      const input = detection()
      const snapshotDesc = structuredClone(desc)
      const snapshotInput = structuredClone(input)

      const first = resolveMode(desc, input)
      const second = resolveMode(desc, input)

      expect(first).toEqual(second)
      expect(desc).toEqual(snapshotDesc)
      expect(input).toEqual(snapshotInput)
    })
  })
})
