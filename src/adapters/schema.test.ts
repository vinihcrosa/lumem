import { describe, expect, it } from 'vitest'
import { type AdapterDescriptor, adapterDescriptorSchema } from './schema'

const validDescriptor = (): unknown => ({
  id: 'claude-code',
  minVersion: '1.0.0',
  detect: [
    { type: 'dir', path: '.claude' },
    { type: 'bin', name: 'claude', versionArgs: ['--version'] },
    { type: 'file', path: 'CLAUDE.md' },
  ],
  paths: {
    home: '~/.claude',
    skills: { project: '.claude/skills', global: '~/.claude/skills' },
    hooksConfig: [
      { scope: 'project', path: '.claude/settings.json', format: 'json', strategy: 'merge-json' },
      { scope: 'global', path: '~/.claude/settings.json', format: 'json', strategy: 'own-file' },
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
  },
  eventMap: {
    inject: 'SessionStart',
    capturePrompt: 'UserPromptSubmit',
    captureTool: 'PostToolUse',
    captureToolFailure: 'PostToolUseFailure',
    end: 'SessionEnd',
  },
  injection: ['hook-stdout', 'context-doc-block'],
  headless: {
    command: ['claude', '-p'],
    promptVia: 'arg',
    modelFlag: '--model',
    defaultModel: 'sonnet',
  },
})

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>

describe('adapterDescriptorSchema', () => {
  it('parses a valid full descriptor', () => {
    const parsed: AdapterDescriptor = adapterDescriptorSchema.parse(validDescriptor())
    expect(parsed.id).toBe('claude-code')
    expect(parsed.detect).toHaveLength(3)
    expect(parsed.paths.contextDoc?.maxBytes).toBe(4096)
    expect(parsed.eventMap.inject).toBe('SessionStart')
    expect(parsed.eventMap.captureToolFailure).toBe('PostToolUseFailure')
  })

  // Optional by design: a harness whose PostToolUse already covers both outcomes
  // (Codex) has nothing to map here, and must still be a valid descriptor.
  it('parses a descriptor whose eventMap omits captureToolFailure', () => {
    const d = asRecord(validDescriptor())
    d.eventMap = {
      inject: 'SessionStart',
      capturePrompt: 'UserPromptSubmit',
      captureTool: 'PostToolUse',
      end: 'SessionEnd',
    }
    const parsed = adapterDescriptorSchema.parse(d)
    expect(parsed.eventMap.captureTool).toBe('PostToolUse')
    expect(parsed.eventMap.captureToolFailure).toBeUndefined()
  })

  it('parses a minimal descriptor without optional fields', () => {
    const d = asRecord(validDescriptor())
    const paths = asRecord(d.paths)
    paths.contextDoc = undefined
    const headless = asRecord(d.headless)
    headless.modelFlag = undefined
    headless.defaultModel = undefined
    d.eventMap = {}
    const parsed = adapterDescriptorSchema.parse(d)
    expect(parsed.paths.contextDoc).toBeUndefined()
    expect(parsed.headless.modelFlag).toBeUndefined()
    expect(parsed.eventMap).toEqual({})
  })

  it('rejects a missing required field and names its path', () => {
    const d = asRecord(validDescriptor())
    const skills = asRecord(asRecord(d.paths).skills)
    skills.global = undefined
    const result = adapterDescriptorSchema.safeParse(d)
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'paths.skills.global')
      expect(issue).toBeDefined()
      expect(issue?.message).toBe('Required')
    }
  })

  it('rejects a non-kebab-case id', () => {
    const d = asRecord(validDescriptor())
    d.id = 'Not_Kebab'
    expect(adapterDescriptorSchema.safeParse(d).success).toBe(false)
  })

  it('rejects an empty id', () => {
    const d = asRecord(validDescriptor())
    d.id = ''
    expect(adapterDescriptorSchema.safeParse(d).success).toBe(false)
  })

  it('rejects a wrong injection enum value', () => {
    const d = asRecord(validDescriptor())
    d.injection = ['telepathy']
    const result = adapterDescriptorSchema.safeParse(d)
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'injection.0')
      expect(issue).toBeDefined()
    }
  })

  it('rejects a wrong hooksConfig scope enum value', () => {
    const d = asRecord(validDescriptor())
    const paths = asRecord(d.paths)
    paths.hooksConfig = [{ scope: 'user', path: 'x.json', format: 'json', strategy: 'merge-json' }]
    expect(adapterDescriptorSchema.safeParse(d).success).toBe(false)
  })

  it('rejects an unknown detect rule type', () => {
    const d = asRecord(validDescriptor())
    d.detect = [{ type: 'env', name: 'HOME' }]
    expect(adapterDescriptorSchema.safeParse(d).success).toBe(false)
  })

  it('rejects an empty detect array', () => {
    const d = asRecord(validDescriptor())
    d.detect = []
    expect(adapterDescriptorSchema.safeParse(d).success).toBe(false)
  })

  it('rejects an empty headless command array', () => {
    const d = asRecord(validDescriptor())
    const headless = asRecord(d.headless)
    headless.command = []
    expect(adapterDescriptorSchema.safeParse(d).success).toBe(false)
  })

  it('rejects a non-positive or non-integer contextDoc.maxBytes', () => {
    for (const bad of [0, -10, 1.5]) {
      const d = asRecord(validDescriptor())
      const paths = asRecord(d.paths)
      paths.contextDoc = { project: 'CLAUDE.md', maxBytes: bad }
      expect(adapterDescriptorSchema.safeParse(d).success).toBe(false)
    }
  })

  it('rejects a missing capability flag and names its path', () => {
    const d = asRecord(validDescriptor())
    const capabilities = asRecord(d.capabilities)
    capabilities['platform.windows'] = undefined
    const result = adapterDescriptorSchema.safeParse(d)
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path.join('.') === 'capabilities.platform.windows',
      )
      expect(issue).toBeDefined()
    }
  })
})
