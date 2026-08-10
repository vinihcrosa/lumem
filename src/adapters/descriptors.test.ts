import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadDescriptors } from '../core/harness/load'

const adaptersDir = dirname(fileURLToPath(import.meta.url))

describe('shipped descriptors', () => {
  const { descriptors, errors } = loadDescriptors(adaptersDir)

  it('loads both descriptors without errors', () => {
    expect(errors).toEqual([])
    expect(descriptors.map((d) => d.id).sort()).toEqual(['claude-code', 'codex'])
  })

  it('claude-code has verified critical fields', () => {
    const cc = descriptors.find((d) => d.id === 'claude-code')
    expect(cc).toBeDefined()
    expect(cc?.minVersion).toBe('2.1.224')
    expect(cc?.paths.skills.project).toBe('.claude/skills')
    expect(cc?.paths.hooksConfig[0]?.strategy).toBe('merge-json')
    expect(cc?.injection[0]).toBe('hook-stdout')
    expect(cc?.capabilities['hooks.requiresTrust']).toBe(false)
    expect(cc?.eventMap.inject).toBe('SessionStart')
  })

  it('codex has verified critical fields (research 2026-08-07)', () => {
    const cx = descriptors.find((d) => d.id === 'codex')
    expect(cx).toBeDefined()
    expect(cx?.minVersion).toBe('0.147.0')
    // skills live in .agents/skills, NOT .codex/skills (deprecated)
    expect(cx?.paths.skills.project).toBe('.agents/skills')
    expect(cx?.paths.skills.global).toBe('~/.agents/skills')
    expect(cx?.paths.hooksConfig[0]?.path).toBe('.codex/hooks.json')
    expect(cx?.paths.hooksConfig[0]?.strategy).toBe('own-file')
    expect(cx?.paths.contextDoc?.maxBytes).toBe(32768)
    expect(cx?.capabilities['hooks.requiresTrust']).toBe(true)
    expect(cx?.capabilities['hooks.envProjectDir']).toBe(false)
    expect(cx?.capabilities['hooks.stdoutInjection']).toBe(true)
    expect(cx?.injection).toEqual(['hook-stdout', 'context-doc-block', 'skill-instruction'])
  })

  it('both harnesses map the four lumem events', () => {
    for (const d of descriptors) {
      expect(d.eventMap.inject).toBeDefined()
      expect(d.eventMap.capturePrompt).toBeDefined()
      expect(d.eventMap.captureTool).toBeDefined()
      expect(d.eventMap.end).toBeDefined()
    }
  })

  // Asserted on purpose, not by accident. Claude Code's `PostToolUse` fires only
  // after a tool call SUCCEEDS: a failed call goes to `PostToolUseFailure`, so
  // lumem must subscribe to both or it never sees a failure at all. Codex has no
  // failure variant among its 11 events, so its `PostToolUse` covers both
  // outcomes and the key must stay ABSENT there rather than be filled in.
  it('maps captureToolFailure for claude-code and deliberately not for codex', () => {
    const cc = descriptors.find((d) => d.id === 'claude-code')
    const cx = descriptors.find((d) => d.id === 'codex')

    expect(cc?.eventMap.captureTool).toBe('PostToolUse')
    expect(cc?.eventMap.captureToolFailure).toBe('PostToolUseFailure')

    expect(cx?.eventMap.captureTool).toBe('PostToolUse')
    expect(cx?.eventMap.captureToolFailure).toBeUndefined()
    expect(Object.keys(cx?.eventMap ?? {})).not.toContain('captureToolFailure')
  })
})
