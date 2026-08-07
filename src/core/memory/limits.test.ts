import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FileBudgets, LocalState } from './limits'
import {
  DEFAULT_FILE_BUDGETS,
  checkSoftLimits,
  readLocalState,
  updateCompactionFlags,
  writeLocalState,
} from './limits'
import type { Fact, MemoryFile, MemoryType } from './store'
import { factId, serializeFacts } from './store'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-limits-'))
}

function statePath(localDir: string): string {
  return path.join(localDir, 'state.json')
}

function makeFile(type: MemoryType, bodies: string[]): MemoryFile {
  const scope = type === 'preference' ? ('global' as const) : ('project' as const)
  const facts: Fact[] = bodies.map((body) => ({
    id: factId(body),
    date: '2026-08-07',
    body,
    src: 'm',
    conf: 'low',
    type,
    scope,
  }))
  return { path: `/nonexistent/${type}.md`, type, scope, facts, warnings: [] }
}

/** N distinct short facts: 2 serialized lines each, tiny byte footprint. */
function shortBodies(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `f${i}`)
}

describe('DEFAULT_FILE_BUDGETS', () => {
  it('matches PRD §5.5 exactly', () => {
    expect(DEFAULT_FILE_BUDGETS).toEqual({
      project: { lines: 150, bytes: 12288 },
      correction: { lines: 100, bytes: 8192 },
      preference: { lines: 60, bytes: 4096 },
    })
  })
})

describe('checkSoftLimits', () => {
  it('reports zero and does not exceed for an empty file', () => {
    expect(checkSoftLimits(makeFile('project', []))).toEqual({
      exceeded: false,
      lines: 0,
      bytes: 0,
    })
  })

  it('measures the serialized content, not the fact count', () => {
    const file = makeFile('project', ['alpha', 'beta'])
    const serialized = serializeFacts(file.facts)
    const result = checkSoftLimits(file)
    expect(result.lines).toBe(4)
    expect(result.bytes).toBe(Buffer.byteLength(serialized, 'utf8'))
  })

  it('is not exceeded when under both dimensions', () => {
    const result = checkSoftLimits(makeFile('preference', shortBodies(5)))
    expect(result.lines).toBeLessThanOrEqual(DEFAULT_FILE_BUDGETS.preference.lines)
    expect(result.bytes).toBeLessThanOrEqual(DEFAULT_FILE_BUDGETS.preference.bytes)
    expect(result.exceeded).toBe(false)
  })

  it('is exceeded when only the line budget is blown', () => {
    // 40 tiny facts => 80 lines (> 60) but only a few hundred bytes (< 4096)
    const result = checkSoftLimits(makeFile('preference', shortBodies(40)))
    expect(result.lines).toBeGreaterThan(DEFAULT_FILE_BUDGETS.preference.lines)
    expect(result.bytes).toBeLessThan(DEFAULT_FILE_BUDGETS.preference.bytes)
    expect(result.exceeded).toBe(true)
  })

  it('is exceeded when only the byte budget is blown by multi-byte bodies', () => {
    // 4 facts => 8 lines (< 60); each body is 700 accented chars = 1400 utf8 bytes
    const bodies = Array.from({ length: 4 }, (_, i) => `${'á'.repeat(700)}${i}`)
    const result = checkSoftLimits(makeFile('preference', bodies))
    expect(result.lines).toBeLessThan(DEFAULT_FILE_BUDGETS.preference.lines)
    expect(result.bytes).toBeGreaterThan(DEFAULT_FILE_BUDGETS.preference.bytes)
    expect(result.exceeded).toBe(true)
  })

  it('treats a file sitting exactly on the budget as within it', () => {
    const file = makeFile('project', shortBodies(3))
    const measured = checkSoftLimits(file)
    const budgets: FileBudgets = {
      ...DEFAULT_FILE_BUDGETS,
      project: { lines: measured.lines, bytes: measured.bytes },
    }
    expect(checkSoftLimits(file, budgets).exceeded).toBe(false)
  })

  it('applies the budget of the file type', () => {
    // 70 tiny facts => 140 lines: over preference (60) and correction (100), under project (150)
    const bodies = shortBodies(70)
    expect(checkSoftLimits(makeFile('project', bodies)).exceeded).toBe(false)
    expect(checkSoftLimits(makeFile('correction', bodies)).exceeded).toBe(true)
    expect(checkSoftLimits(makeFile('preference', bodies)).exceeded).toBe(true)
  })

  it('honours custom budgets', () => {
    const file = makeFile('project', shortBodies(2))
    const budgets: FileBudgets = {
      project: { lines: 1, bytes: 100000 },
      correction: { lines: 100, bytes: 8192 },
      preference: { lines: 60, bytes: 4096 },
    }
    expect(checkSoftLimits(file).exceeded).toBe(false)
    expect(checkSoftLimits(file, budgets).exceeded).toBe(true)
  })
})

describe('readLocalState / writeLocalState', () => {
  it('round-trips a full state', () => {
    const dir = tmpDir()
    const state: LocalState = {
      lastConsolidationAt: '2026-08-07T14:22:00.000Z',
      compactionFlags: ['correction', 'project'],
    }
    writeLocalState(dir, state)
    expect(readLocalState(dir)).toEqual(state)
  })

  it('round-trips a state without lastConsolidationAt', () => {
    const dir = tmpDir()
    writeLocalState(dir, { compactionFlags: [] })
    const read = readLocalState(dir)
    expect(read).toEqual({ compactionFlags: [] })
    expect('lastConsolidationAt' in read).toBe(false)
  })

  it('creates the local directory when it does not exist', () => {
    const dir = path.join(tmpDir(), 'nested', 'local')
    writeLocalState(dir, { compactionFlags: ['project'] })
    expect(fs.existsSync(statePath(dir))).toBe(true)
  })

  it('dedupes and sorts flags, and ends with a trailing newline', () => {
    const dir = tmpDir()
    writeLocalState(dir, { compactionFlags: ['project', 'correction', 'project', 'preference'] })
    const raw = fs.readFileSync(statePath(dir), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual({
      compactionFlags: ['correction', 'preference', 'project'],
    })
    expect(readLocalState(dir).compactionFlags).toEqual(['correction', 'preference', 'project'])
  })

  it('writes a deterministic key order', () => {
    const dir = tmpDir()
    writeLocalState(dir, {
      compactionFlags: ['project'],
      lastConsolidationAt: '2026-08-07T00:00:00Z',
    })
    const raw = fs.readFileSync(statePath(dir), 'utf8')
    expect(raw.indexOf('lastConsolidationAt')).toBeLessThan(raw.indexOf('compactionFlags'))
  })

  it('produces byte-identical files for two identical writes', () => {
    const dirA = tmpDir()
    const dirB = tmpDir()
    const state: LocalState = {
      lastConsolidationAt: '2026-08-07T14:22:00.000Z',
      compactionFlags: ['project', 'correction'],
    }
    writeLocalState(dirA, state)
    writeLocalState(dirB, { ...state, compactionFlags: ['correction', 'project', 'correction'] })
    expect(fs.readFileSync(statePath(dirA))).toEqual(fs.readFileSync(statePath(dirB)))
  })

  it('overwrites a previous state in place', () => {
    const dir = tmpDir()
    writeLocalState(dir, { compactionFlags: ['project'], lastConsolidationAt: 'a' })
    writeLocalState(dir, { compactionFlags: [] })
    expect(readLocalState(dir)).toEqual({ compactionFlags: [] })
    expect(fs.readdirSync(dir)).toEqual(['state.json'])
  })

  it('returns the default state when state.json is missing', () => {
    const dir = tmpDir()
    expect(() => readLocalState(dir)).not.toThrow()
    expect(readLocalState(dir)).toEqual({ compactionFlags: [] })
  })

  it('returns the default state when the local directory is missing', () => {
    const dir = path.join(tmpDir(), 'absent')
    expect(readLocalState(dir)).toEqual({ compactionFlags: [] })
  })

  it('returns the default state when state.json is corrupt', () => {
    const dir = tmpDir()
    fs.writeFileSync(statePath(dir), '{ not json at all')
    expect(() => readLocalState(dir)).not.toThrow()
    expect(readLocalState(dir)).toEqual({ compactionFlags: [] })
  })

  it('returns the default state for structurally invalid contents', () => {
    const cases = [
      '[]',
      'null',
      '"a string"',
      '{}',
      '{"compactionFlags":"project"}',
      '{"compactionFlags":["project","bogus"]}',
      '{"compactionFlags":[],"lastConsolidationAt":42}',
    ]
    for (const contents of cases) {
      const dir = tmpDir()
      fs.writeFileSync(statePath(dir), contents)
      expect(readLocalState(dir), contents).toEqual({ compactionFlags: [] })
    }
  })
})

describe('updateCompactionFlags', () => {
  it('sets the flag when a file exceeds and persists it', () => {
    const dir = tmpDir()
    const state = updateCompactionFlags(dir, [makeFile('preference', shortBodies(40))])
    expect(state.compactionFlags).toEqual(['preference'])
    expect(readLocalState(dir)).toEqual({ compactionFlags: ['preference'] })
  })

  it('keeps the flag without duplicating it on repeated updates', () => {
    const dir = tmpDir()
    const file = makeFile('preference', shortBodies(40))
    updateCompactionFlags(dir, [file])
    const state = updateCompactionFlags(dir, [file])
    expect(state.compactionFlags).toEqual(['preference'])
    expect(readLocalState(dir).compactionFlags).toEqual(['preference'])
  })

  it('clears the flag when the file is back under budget', () => {
    const dir = tmpDir()
    updateCompactionFlags(dir, [makeFile('preference', shortBodies(40))])
    const state = updateCompactionFlags(dir, [makeFile('preference', shortBodies(3))])
    expect(state.compactionFlags).toEqual([])
    expect(readLocalState(dir)).toEqual({ compactionFlags: [] })
  })

  it('handles several files of different types in one call', () => {
    const dir = tmpDir()
    const state = updateCompactionFlags(dir, [
      makeFile('project', shortBodies(3)),
      makeFile('correction', shortBodies(70)),
      makeFile('preference', shortBodies(40)),
    ])
    expect(state.compactionFlags).toEqual(['correction', 'preference'])
    expect(readLocalState(dir).compactionFlags).toEqual(['correction', 'preference'])
  })

  it('flags a type when any file of that type exceeds', () => {
    const dir = tmpDir()
    const state = updateCompactionFlags(dir, [
      makeFile('correction', shortBodies(3)),
      makeFile('correction', shortBodies(70)),
    ])
    expect(state.compactionFlags).toEqual(['correction'])
  })

  it('leaves flags of types absent from the call untouched', () => {
    const dir = tmpDir()
    writeLocalState(dir, { compactionFlags: ['project'] })
    const state = updateCompactionFlags(dir, [makeFile('preference', shortBodies(3))])
    expect(state.compactionFlags).toEqual(['project'])
  })

  it('preserves lastConsolidationAt across updates', () => {
    const dir = tmpDir()
    const at = '2026-08-07T14:22:00.000Z'
    writeLocalState(dir, { lastConsolidationAt: at, compactionFlags: [] })
    const set = updateCompactionFlags(dir, [makeFile('project', shortBodies(80))])
    expect(set).toEqual({ lastConsolidationAt: at, compactionFlags: ['project'] })
    const cleared = updateCompactionFlags(dir, [makeFile('project', shortBodies(2))])
    expect(cleared).toEqual({ lastConsolidationAt: at, compactionFlags: [] })
    expect(readLocalState(dir).lastConsolidationAt).toBe(at)
  })

  it('honours custom budgets', () => {
    const dir = tmpDir()
    const budgets: FileBudgets = {
      project: { lines: 1, bytes: 1 },
      correction: { lines: 100, bytes: 8192 },
      preference: { lines: 60, bytes: 4096 },
    }
    const state = updateCompactionFlags(dir, [makeFile('project', shortBodies(2))], budgets)
    expect(state.compactionFlags).toEqual(['project'])
  })

  it('writes nothing new when no file exceeds', () => {
    const dir = tmpDir()
    const state = updateCompactionFlags(dir, [makeFile('project', [])])
    expect(state).toEqual({ compactionFlags: [] })
    expect(readLocalState(dir)).toEqual({ compactionFlags: [] })
  })
})
