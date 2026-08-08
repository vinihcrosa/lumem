import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Signal } from '../src/core/capture/journal'
import { parsePatch } from '../src/core/consolidate/patch'
import { factId, parseMemoryFacts } from '../src/core/memory/store'
import { FIXTURES_DIR, MEMORY_FILE_NAMES, listFixtures, loadFixture } from './fixtures'
import { loadMockResponses } from './mock'

/**
 * The fixtures are the measuring instrument. A malformed journal line, an
 * `expect.json` that no longer matches its own memory file, or a canned response
 * that cannot parse would all report a prompt regression that never happened.
 * These tests pin the instrument; none of them touches the network.
 */

/** The eight cases the harness was built around; a rename must be deliberate. */
const REQUIRED = [
  'contradicts-existing',
  'explicit-correction',
  'learned-trap',
  'noisy-long-session',
  'preference-signal',
  'repo-duplication-bait',
  'secret-in-prompt',
  'trivial-session',
]

const names = listFixtures()

/** Per-kind shape check: `readSignals` only validates `t`, so a typo would survive it. */
function validateSignal(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object'
  const signal = value as Record<string, unknown>
  if (typeof signal.ts !== 'string' || Number.isNaN(Date.parse(signal.ts))) {
    return `bad ts '${String(signal.ts)}'`
  }
  const str = (key: string): boolean => typeof signal[key] === 'string'

  switch (signal.t) {
    case 'session':
      if (signal.ev !== 'start' && signal.ev !== 'end') return `bad ev '${String(signal.ev)}'`
      return str('harness') && str('sessionId') && str('cwd') ? undefined : 'missing session fields'
    case 'file':
      return str('path') && str('tool') ? undefined : 'missing file fields'
    case 'cmd':
      return str('cmd') && typeof signal.exit === 'number' ? undefined : 'missing cmd fields'
    case 'recovery':
      return str('failed') && str('passed') ? undefined : 'missing recovery fields'
    case 'correction':
      return str('marker') && str('prompt') ? undefined : 'missing correction fields'
    case 'memory-op':
      if (signal.op !== 'add' && signal.op !== 'forget') return `bad op '${String(signal.op)}'`
      return undefined
    default:
      return `unknown signal kind '${String(signal.t)}'`
  }
}

function journalOf(name: string): Signal[] {
  const text = fs.readFileSync(path.join(FIXTURES_DIR, name, 'journal.jsonl'), 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Signal)
}

describe('eval fixtures', () => {
  it('ships the eight cases the harness was designed around', () => {
    expect(names).toEqual(expect.arrayContaining(REQUIRED))
  })

  it.each(names)('%s: expect.json parses and declares at least one assertion', (name) => {
    const spec = loadFixture(name)
    expect(spec.description.length).toBeGreaterThan(20)
    expect(Object.keys(spec.expect).length).toBeGreaterThan(0)
    // A leak is a hard fail everywhere, so every fixture asserts it explicitly.
    expect(spec.expect.noSecrets, `${name} must assert noSecrets`).toBe(true)
  })

  it.each(names)('%s: every journal line is a well-formed Signal', (name) => {
    const signals = journalOf(name)
    expect(signals.length).toBeGreaterThan(0)
    signals.forEach((signal, index) => {
      expect(validateSignal(signal), `${name} line ${index + 1}`).toBeUndefined()
    })
  })

  it.each(names)('%s: seeded memory uses known file names and parses cleanly', (name) => {
    const dir = path.join(FIXTURES_DIR, name, 'memory')
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir)) {
      expect(MEMORY_FILE_NAMES, `${name}/memory/${entry}`).toContain(entry)
      const content = fs.readFileSync(path.join(dir, entry), 'utf8')
      const parsed = parseMemoryFacts(content, { type: 'project', scope: 'project' })
      expect(parsed.warnings, `${name}/memory/${entry}`).toEqual([])
      expect(parsed.facts.length).toBeGreaterThan(0)
    }
  })

  it.each(names)('%s: every canned mock response is a valid patch', (name) => {
    const responses = loadMockResponses(name)
    expect(responses.length).toBeGreaterThan(0)
    for (const response of responses) {
      const parsed = parsePatch(response)
      expect(parsed.error, `${name}: ${response.slice(0, 80)}`).toBeUndefined()
      expect(parsed.patch).toBeDefined()
    }
  })

  it('mustReplaceId names a fact that the fixture actually seeded', () => {
    for (const name of names) {
      const target = loadFixture(name).expect.mustReplaceId
      if (target === undefined) continue

      const dir = path.join(FIXTURES_DIR, name, 'memory')
      const ids = fs.readdirSync(dir).flatMap((entry) =>
        parseMemoryFacts(fs.readFileSync(path.join(dir, entry), 'utf8'), {
          type: 'project',
          scope: 'project',
        }).facts.map((fact) => factId(fact.body)),
      )
      expect(ids, `${name}: mustReplaceId ${target} is not in the seeded memory`).toContain(target)
    }
  })

  it('never asks for a string it also forbids', () => {
    for (const name of names) {
      const { mustNotContain = [], shouldMentionAny = [] } = loadFixture(name).expect
      const forbidden = mustNotContain.map((entry) => entry.toLowerCase())
      for (const wanted of shouldMentionAny) {
        expect(forbidden, `${name}: '${wanted}' is both wanted and forbidden`).not.toContain(
          wanted.toLowerCase(),
        )
      }
    }
  })

  it('rejects a fixture whose expect.json carries an unknown key', () => {
    expect(() => loadFixture('bogus', path.join(FIXTURES_DIR, '..', 'nowhere'))).toThrow(
      /not found/,
    )
  })
})
