import { describe, expect, it } from 'vitest'
import { LUMEM_MARKER, mergeHookConfig, unmergeHookConfig } from './hooks-config'

type Json = Record<string, unknown>

const BUNDLE = '/home/u/project/.lumem/bin/lumem-hook.mjs'

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Shape of assets/harness/claude-code/hooks.tmpl.json, already rendered. */
const RENDERED = json({
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: `node "${BUNDLE}" claude-code inject`, timeout: 5 }] },
    ],
    PostToolUse: [
      {
        matcher: '*',
        hooks: [
          { type: 'command', command: `node "${BUNDLE}" claude-code capture-tool`, timeout: 2 },
        ],
      },
    ],
  },
})

/** A realistic settings.json: the user's own permissions, env, hooks and extras. */
const USER_SETTINGS = json({
  permissions: { allow: ['Bash(npm run test:*)'], deny: ['Bash(rm:*)'] },
  env: { FOO: 'bar' },
  statusLine: { type: 'command', command: 'my-statusline.sh' },
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
  },
  somethingUnknown: { keep: true },
})

function parse(content: string): Json {
  return JSON.parse(content) as Json
}

function hooksOf(content: string): Json {
  return parse(content).hooks as Json
}

function entriesOf(content: string, event: string): Json[] {
  return (hooksOf(content)[event] ?? []) as Json[]
}

function lumemEntriesOf(content: string, event: string): Json[] {
  return entriesOf(content, event).filter((entry) => entry[LUMEM_MARKER] === true)
}

function userEntriesOf(content: string, event: string): Json[] {
  return entriesOf(content, event).filter((entry) => entry[LUMEM_MARKER] !== true)
}

/** Deep copy with every ownership marker dropped, for comparing against the template. */
function stripMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMarkers)
  if (typeof value === 'object' && value !== null) {
    const out: Json = {}
    for (const [key, inner] of Object.entries(value)) {
      if (key !== LUMEM_MARKER) out[key] = stripMarkers(inner)
    }
    return out
  }
  return value
}

describe('mergeHookConfig — no usable existing file', () => {
  it('writes the rendered template, tagged as lumem-owned', () => {
    const result = mergeHookConfig(undefined, RENDERED)

    expect(result.replacedInvalid).toBeUndefined()
    expect(result.ownedKeys).toEqual(['hooks.SessionStart', 'hooks.PostToolUse'])
    expect(Object.keys(hooksOf(result.content))).toEqual(['SessionStart', 'PostToolUse'])
    expect(stripMarkers(parse(result.content))).toEqual(parse(RENDERED))
    expect(lumemEntriesOf(result.content, 'SessionStart')).toHaveLength(1)
    expect(lumemEntriesOf(result.content, 'PostToolUse')).toHaveLength(1)
    expect(userEntriesOf(result.content, 'SessionStart')).toEqual([])
  })

  it('treats an empty or whitespace-only file the same as a missing one', () => {
    const fresh = mergeHookConfig(undefined, RENDERED)
    for (const existing of ['', '   ', '\n\t \n']) {
      const result = mergeHookConfig(existing, RENDERED)
      expect(result.content).toBe(fresh.content)
      expect(result.ownedKeys).toEqual(fresh.ownedKeys)
      expect(result.replacedInvalid).toBeUndefined()
    }
  })
})

describe('mergeHookConfig — merging into a user settings.json', () => {
  it('preserves every other top-level key, with its original order', () => {
    const result = mergeHookConfig(USER_SETTINGS, RENDERED)
    const before = parse(USER_SETTINGS)
    const after = parse(result.content)

    expect(Object.keys(after)).toEqual(Object.keys(before))
    expect(after.permissions).toEqual(before.permissions)
    expect(after.env).toEqual(before.env)
    expect(after.statusLine).toEqual(before.statusLine)
    expect(after.somethingUnknown).toEqual(before.somethingUnknown)
    expect(result.replacedInvalid).toBeUndefined()
  })

  it('appends lumem entries after the user entries of the same event', () => {
    const result = mergeHookConfig(USER_SETTINGS, RENDERED)
    const userSessionStart = (hooksOf(USER_SETTINGS).SessionStart as Json[])[0]
    const merged = entriesOf(result.content, 'SessionStart')

    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual(userSessionStart)
    expect(merged[0]?.[LUMEM_MARKER]).toBeUndefined()
    expect(merged[1]?.[LUMEM_MARKER]).toBe(true)
  })

  it('leaves events lumem does not use untouched and keeps event order', () => {
    const result = mergeHookConfig(USER_SETTINGS, RENDERED)

    expect(hooksOf(result.content).PreToolUse).toEqual(hooksOf(USER_SETTINGS).PreToolUse)
    // user events first, in their original order, then the events lumem adds
    expect(Object.keys(hooksOf(result.content))).toEqual([
      'SessionStart',
      'PreToolUse',
      'PostToolUse',
    ])
  })

  it('adds a hooks object to a settings.json that has none', () => {
    const noHooks = json({ permissions: { allow: [] } })
    const result = mergeHookConfig(noHooks, RENDERED)

    expect(parse(result.content).permissions).toEqual({ allow: [] })
    expect(Object.keys(hooksOf(result.content))).toEqual(['SessionStart', 'PostToolUse'])
    expect(result.replacedInvalid).toBeUndefined()
  })

  it('reports the hooks.<Event> paths it owns', () => {
    expect(mergeHookConfig(USER_SETTINGS, RENDERED).ownedKeys).toEqual([
      'hooks.SessionStart',
      'hooks.PostToolUse',
    ])
  })
})

describe('mergeHookConfig — idempotence', () => {
  it('replaces its own entries instead of appending duplicates (3 runs)', () => {
    const first = mergeHookConfig(undefined, RENDERED)
    const second = mergeHookConfig(first.content, RENDERED)
    const third = mergeHookConfig(second.content, RENDERED)

    expect(second.content).toBe(third.content)
    expect(first.content).toBe(second.content)
    for (const event of ['SessionStart', 'PostToolUse']) {
      expect(lumemEntriesOf(third.content, event)).toHaveLength(1)
      expect(entriesOf(third.content, event)).toHaveLength(1)
    }
  })

  it('replaces its own entries in a user file without touching the user entries', () => {
    const first = mergeHookConfig(USER_SETTINGS, RENDERED)
    const second = mergeHookConfig(first.content, RENDERED)
    const third = mergeHookConfig(second.content, RENDERED)

    expect(second.content).toBe(third.content)
    expect(first.content).toBe(second.content)
    expect(lumemEntriesOf(third.content, 'SessionStart')).toHaveLength(1)
    expect(userEntriesOf(third.content, 'SessionStart')).toEqual(
      hooksOf(USER_SETTINGS).SessionStart,
    )
  })

  it('re-renders a stale lumem entry (new bundle path) in place', () => {
    const stale = mergeHookConfig(USER_SETTINGS, RENDERED).content
    const moved = RENDERED.replaceAll(BUNDLE, '/elsewhere/lumem-hook.mjs')
    const result = mergeHookConfig(stale, moved)

    expect(result.content).not.toContain(BUNDLE)
    expect(result.content).toContain('/elsewhere/lumem-hook.mjs')
    expect(entriesOf(result.content, 'SessionStart')).toHaveLength(2)
  })
})

describe('mergeHookConfig — unmergeable existing content', () => {
  it('signals replacedInvalid for a file that is not valid JSON', () => {
    const result = mergeHookConfig('{ this is not json', RENDERED)

    expect(result.replacedInvalid).toBe(true)
    expect(result.content).toBe(mergeHookConfig(undefined, RENDERED).content)
  })

  it('signals replacedInvalid for JSON that is not an object', () => {
    for (const existing of ['[1, 2]', '"nope"', 'null', '42']) {
      expect(mergeHookConfig(existing, RENDERED).replacedInvalid).toBe(true)
    }
  })

  it('signals replacedInvalid when hooks is not an object or an event is not an array', () => {
    expect(mergeHookConfig(json({ hooks: 'nope' }), RENDERED).replacedInvalid).toBe(true)
    expect(
      mergeHookConfig(json({ hooks: { SessionStart: 'nope' } }), RENDERED).replacedInvalid,
    ).toBe(true)
    // an event lumem never writes to is passed through, whatever it holds
    const odd = mergeHookConfig(json({ hooks: { Whatever: 'nope' } }), RENDERED)
    expect(odd.replacedInvalid).toBeUndefined()
    expect(hooksOf(odd.content).Whatever).toBe('nope')
  })

  it('refuses a rendered template that is not a JSON object', () => {
    expect(() => mergeHookConfig(undefined, 'not json')).toThrow(/rendered/)
  })
})

describe('mergeHookConfig — formatting', () => {
  it('emits 2-space JSON with a trailing newline', () => {
    const result = mergeHookConfig(USER_SETTINGS, RENDERED)

    expect(result.content.endsWith('}\n')).toBe(true)
    expect(result.content.split('\n')[1]).toMatch(/^ {2}"permissions": \{$/)
    expect(result.content).toBe(json(parse(result.content)))
  })
})

describe('unmergeHookConfig', () => {
  it('removes lumem entries and keeps the user hooks', () => {
    const merged = mergeHookConfig(USER_SETTINGS, RENDERED).content
    const result = unmergeHookConfig(merged)

    expect(result).toBeDefined()
    expect(result).toBe(USER_SETTINGS)
  })

  it('returns undefined when only lumem content remains', () => {
    const merged = mergeHookConfig(undefined, RENDERED).content
    expect(unmergeHookConfig(merged)).toBeUndefined()
  })

  it('keeps unrelated top-level keys and drops the emptied hooks object', () => {
    const merged = mergeHookConfig(json({ permissions: { allow: [] } }), RENDERED).content
    const result = unmergeHookConfig(merged)

    expect(result).toBe(json({ permissions: { allow: [] } }))
    expect(parse(result as string).hooks).toBeUndefined()
  })

  it('prunes an event array emptied by the removal but keeps the others', () => {
    const existing = json({
      hooks: {
        SessionStart: [{ [LUMEM_MARKER]: true, hooks: [] }],
        PreToolUse: [{ matcher: 'Bash' }],
      },
    })
    const result = unmergeHookConfig(existing) as string

    expect(Object.keys(hooksOf(result))).toEqual(['PreToolUse'])
    expect(entriesOf(result, 'PreToolUse')).toEqual([{ matcher: 'Bash' }])
  })

  it('only touches the events listed in ownedKeys when they are given', () => {
    const merged = mergeHookConfig(USER_SETTINGS, RENDERED).content
    const result = unmergeHookConfig(merged, ['hooks.SessionStart']) as string

    expect(lumemEntriesOf(result, 'SessionStart')).toEqual([])
    expect(lumemEntriesOf(result, 'PostToolUse')).toHaveLength(1)
  })

  it('returns a file without lumem entries byte-for-byte', () => {
    expect(unmergeHookConfig(USER_SETTINGS)).toBe(USER_SETTINGS)
  })

  it('never destroys a file it cannot parse', () => {
    expect(unmergeHookConfig('{ this is not json')).toBe('{ this is not json')
  })

  it('returns undefined for an object that is empty or holds only an empty hooks', () => {
    expect(unmergeHookConfig(json({}))).toBeUndefined()
    expect(unmergeHookConfig(json({ hooks: {} }))).toBeUndefined()
  })
})
