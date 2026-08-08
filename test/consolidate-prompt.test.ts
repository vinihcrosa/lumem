import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyPatch, consolidationPatchSchema, parsePatch } from '../src/core/consolidate/patch'
import type { MemoryFile, MemoryScope, MemoryType } from '../src/core/memory/store'

/**
 * The consolidation prompt is the product: if its own examples drift away from
 * the schema the runner enforces, every patch the cheap model produces from it
 * is discarded silently. These tests pin the document to the real code.
 */

const SKILL_PATH = fileURLToPath(
  new URL('../assets/skills/lumem-consolidate/SKILL.md', import.meta.url),
)
const SKILL = fs.readFileSync(SKILL_PATH, 'utf8')

/** Fenced ```json blocks only: ```jsonl (the journal) and ```text are not patches. */
const JSON_FENCE_RE = /^```json\r?\n([\s\S]*?)^```[ \t]*\r?$/gm

const EMPTY_PATCH = '{"version":1,"add":[],"replace":[],"remove":[]}'

const MEMORY_TYPES: readonly MemoryType[] = ['project', 'preference', 'correction']
const MEMORY_SCOPES: readonly MemoryScope[] = ['project', 'global']

function jsonBlocks(): string[] {
  JSON_FENCE_RE.lastIndex = 0
  return [...SKILL.matchAll(JSON_FENCE_RE)].map((match) => match[1] ?? '')
}

function frontmatter(): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?$/m.exec(SKILL)
  const fields: Record<string, string> = {}
  for (const line of (match?.[1] ?? '').split('\n')) {
    const field = /^([a-z][\w-]*):\s*(.*)$/.exec(line.trim())
    if (field !== null) fields[field[1] ?? ''] = (field[2] ?? '').trim()
  }
  return fields
}

/**
 * The legal combinations as the prompt documents them, read out of the markdown
 * table whose header is `| \`type\` | legal \`scope\` | ... |`. Parsing the doc
 * (instead of restating it here) is the point: the table cannot drift from
 * `applyPatch` without this failing.
 */
function documentedCombos(): Set<string> {
  const combos = new Set<string>()
  const lines = SKILL.split('\n')
  const header = lines.findIndex((line) => /^\|\s*`type`\s*\|\s*legal\s*`scope`\s*\|/.test(line))
  expect(header, 'type/scope table not found in SKILL.md').toBeGreaterThanOrEqual(0)
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break
    const cells = line.split('|').slice(1, -1)
    const type = MEMORY_TYPES.find((candidate) => cells[0]?.includes(`\`${candidate}\``))
    if (type === undefined) continue
    for (const scope of MEMORY_SCOPES) {
      if (cells[1]?.includes(`\`${scope}\``) === true) combos.add(`${type}/${scope}`)
    }
  }
  return combos
}

function emptyFile(dir: string, type: MemoryType, scope: MemoryScope): MemoryFile {
  return { path: path.join(dir, `${scope}.${type}.md`), type, scope, facts: [], warnings: [] }
}

/** The four files of PRD §5.2, empty — every legal type/scope pair has a home. */
function emptyFiles(dir: string): MemoryFile[] {
  return [
    emptyFile(dir, 'project', 'project'),
    emptyFile(dir, 'correction', 'project'),
    emptyFile(dir, 'preference', 'global'),
    emptyFile(dir, 'correction', 'global'),
  ]
}

describe('lumem-consolidate SKILL.md', () => {
  it('has frontmatter with the skill name and a description', () => {
    const fields = frontmatter()
    expect(fields.name).toBe('lumem-consolidate')
    expect((fields.description ?? '').length).toBeGreaterThan(20)
  })

  it('every fenced json block is parseable JSON', () => {
    const blocks = jsonBlocks()
    expect(blocks.length).toBeGreaterThanOrEqual(3)
    for (const block of blocks) expect(() => JSON.parse(block)).not.toThrow()
  })

  it('every patch example survives parsePatch and the real zod schema', () => {
    const patches = jsonBlocks().filter((block) => 'version' in (JSON.parse(block) as object))
    expect(patches.length).toBeGreaterThanOrEqual(2)
    for (const block of patches) {
      expect(parsePatch(block).error, `not a valid patch:\n${block}`).toBeUndefined()
      expect(consolidationPatchSchema.safeParse(JSON.parse(block)).success).toBe(true)
    }
  })

  it('documents the empty patch verbatim, and it is valid', () => {
    expect(SKILL).toContain(EMPTY_PATCH)
    expect(parsePatch(EMPTY_PATCH).patch).toEqual({
      version: 1,
      add: [],
      replace: [],
      remove: [],
    })
  })

  it('documents the four anti-junk rules and the secret rule', () => {
    for (const heading of [
      'Do not duplicate the repo',
      'Facts must be falsifiable',
      'No speculation',
      'Prefer removing to accumulating',
      'Secrets — hard rule',
    ]) {
      expect(SKILL).toContain(heading)
    }
  })
})

describe('documented type/scope combinations match applyPatch', () => {
  const documented = documentedCombos()

  for (const type of MEMORY_TYPES) {
    for (const scope of MEMORY_SCOPES) {
      const legal = documented.has(`${type}/${scope}`)
      it(`${type}/${scope} is ${legal ? 'documented and applied' : 'undocumented and discarded'}`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-prompt-'))
        const report = applyPatch({
          patch: {
            version: 1,
            add: [{ type, scope, body: `probe ${type} ${scope}`, conf: 'high' }],
            replace: [],
            remove: [],
          },
          files: emptyFiles(dir),
          sessionId: 'probe',
          date: '2026-08-07',
        })
        if (legal) {
          expect(report.applied).toHaveLength(1)
          expect(report.applied[0]).toMatchObject({ op: 'add', type, scope })
          expect(report.discarded).toHaveLength(0)
        } else {
          expect(report.applied).toHaveLength(0)
          expect(report.discarded[0]?.reason).toBe('illegal type/scope combination')
          expect(report.filesWritten).toHaveLength(0)
        }
      })
    }
  }
})
