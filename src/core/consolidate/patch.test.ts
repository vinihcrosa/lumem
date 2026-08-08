import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Fact, MemoryFile, MemoryScope, MemoryType } from '../memory/store'
import {
  SecretRefusalError,
  addFact,
  factId,
  readMemoryFile,
  writeMemoryFile,
} from '../memory/store'
import type { ConsolidationPatch } from './patch'
import { applyPatch, consolidationPatchSchema, parsePatch } from './patch'

const GH_TOKEN = `ghp_${'A1b2C3d4'.repeat(5)}`

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-patch-'))
}

function makeFile(dir: string, type: MemoryType, scope: MemoryScope): MemoryFile {
  return { path: path.join(dir, `${scope}.${type}.md`), type, scope, facts: [], warnings: [] }
}

function seed(file: MemoryFile, body: string, conf: Fact['conf'] = 'medium'): Fact {
  return addFact(file, { date: '2026-01-01', body, src: 'sess_seed', conf })
}

function patchOf(partial: Partial<ConsolidationPatch>): ConsolidationPatch {
  return { version: 1, add: [], replace: [], remove: [], ...partial }
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const VALID_PATCH = {
  version: 1,
  add: [{ type: 'project', scope: 'project', body: 'Auth usa cookie', conf: 'high' }],
  replace: [],
  remove: [],
}

describe('consolidationPatchSchema', () => {
  it('accepts a well-formed patch', () => {
    const result = consolidationPatchSchema.safeParse(VALID_PATCH)
    expect(result.success).toBe(true)
  })

  it('rejects unknown top-level keys', () => {
    const result = consolidationPatchSchema.safeParse({ ...VALID_PATCH, extra: true })
    expect(result.success).toBe(false)
  })

  it('rejects unknown keys inside an entry', () => {
    const result = consolidationPatchSchema.safeParse({
      ...VALID_PATCH,
      add: [{ ...VALID_PATCH.add[0], sneaky: 1 }],
    })
    expect(result.success).toBe(false)
  })
})

describe('parsePatch', () => {
  it('parses a bare JSON object', () => {
    const { patch, error } = parsePatch(JSON.stringify(VALID_PATCH))
    expect(error).toBeUndefined()
    expect(patch?.add[0]?.body).toBe('Auth usa cookie')
  })

  it('parses JSON wrapped in markdown fences with a preamble', () => {
    const raw = `Sure! Here is the patch you asked for.\n\n\`\`\`json\n${JSON.stringify(
      VALID_PATCH,
      null,
      2,
    )}\n\`\`\`\n\nLet me know if you want changes.`
    const { patch, error } = parsePatch(raw)
    expect(error).toBeUndefined()
    expect(patch?.version).toBe(1)
    expect(patch?.add).toHaveLength(1)
  })

  it('skips a braced blob in the preamble that is not JSON', () => {
    const raw = `The patch {see below} is ready:\n${JSON.stringify(VALID_PATCH)}`
    const { patch, error } = parsePatch(raw)
    expect(error).toBeUndefined()
    expect(patch?.add[0]?.conf).toBe('high')
  })

  it('keeps braces that live inside JSON strings', () => {
    const body = 'Usar template {{name}} no prompt'
    const raw = JSON.stringify({ ...VALID_PATCH, add: [{ ...VALID_PATCH.add[0], body }] })
    const { patch, error } = parsePatch(raw)
    expect(error).toBeUndefined()
    expect(patch?.add[0]?.body).toBe(body)
  })

  it('errors when the output holds no JSON object', () => {
    const { patch, error } = parsePatch('nada para consolidar hoje')
    expect(patch).toBeUndefined()
    expect(error).toBeTruthy()
  })

  it('errors on invalid JSON', () => {
    const { patch, error } = parsePatch('{ "version": 1, "add": [ }')
    expect(patch).toBeUndefined()
    expect(error).toMatch(/json/i)
  })

  it('errors naming the offending field path on a schema violation', () => {
    const raw = JSON.stringify({
      ...VALID_PATCH,
      add: [{ ...VALID_PATCH.add[0], conf: 'certeza' }],
    })
    const { patch, error } = parsePatch(raw)
    expect(patch).toBeUndefined()
    expect(error).toContain('add.0.conf')
  })

  it('errors naming the path for a bad nested type', () => {
    const raw = JSON.stringify({ ...VALID_PATCH, remove: [{ targetId: 1, reason: 'x' }] })
    const { error } = parsePatch(raw)
    expect(error).toContain('remove.0.targetId')
  })

  it('errors when version is not 1', () => {
    const { patch, error } = parsePatch(JSON.stringify({ ...VALID_PATCH, version: 2 }))
    expect(patch).toBeUndefined()
    expect(error).toContain('version')
  })

  it('errors when a required array is missing', () => {
    const { error } = parsePatch(JSON.stringify({ version: 1, add: [] }))
    expect(error).toContain('replace')
  })
})

describe('applyPatch add', () => {
  it('adds to the file matching {type, scope} and persists it', () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    const report = applyPatch({
      patch: patchOf({
        add: [{ type: 'project', scope: 'project', body: 'Auth usa cookie', conf: 'high' }],
      }),
      files: [file],
      sessionId: 'sess_a1b2',
      date: '2026-08-07',
    })

    expect(report.discarded).toEqual([])
    expect(report.filesWritten).toEqual([file.path])
    expect(report.applied).toEqual([
      { op: 'add', factId: factId('Auth usa cookie'), type: 'project', scope: 'project' },
    ])

    const onDisk = readMemoryFile(file.path, { type: 'project', scope: 'project' })
    expect(onDisk.facts).toHaveLength(1)
    expect(onDisk.facts[0]).toMatchObject({
      body: 'Auth usa cookie',
      date: '2026-08-07',
      src: 'sess_a1b2',
      conf: 'high',
    })
  })

  it('routes a correction by scope when both correction files exist', () => {
    const dir = tmpDir()
    const projectCorrection = makeFile(dir, 'correction', 'project')
    const globalCorrection = makeFile(dir, 'correction', 'global')
    const report = applyPatch({
      patch: patchOf({
        add: [{ type: 'correction', scope: 'global', body: 'Nunca usar rm -rf', conf: 'high' }],
      }),
      files: [projectCorrection, globalCorrection],
      sessionId: 'sess_x',
    })

    expect(report.filesWritten).toEqual([globalCorrection.path])
    expect(fs.existsSync(projectCorrection.path)).toBe(false)
  })

  it('discards an illegal type/scope combination and keeps the other entries', () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    const report = applyPatch({
      patch: patchOf({
        add: [
          { type: 'project', scope: 'global', body: 'Escopo errado', conf: 'low' },
          { type: 'preference', scope: 'project', body: 'Escopo errado tambem', conf: 'low' },
          { type: 'project', scope: 'project', body: 'Escopo certo', conf: 'medium' },
        ],
      }),
      files: [file],
      sessionId: 'sess_x',
    })

    expect(report.applied).toHaveLength(1)
    expect(report.applied[0]?.factId).toBe(factId('Escopo certo'))
    expect(report.discarded).toHaveLength(2)
    expect(report.discarded.every((d) => d.op === 'add')).toBe(true)
    expect(report.discarded[0]?.reason).toBe('illegal type/scope combination')
  })

  it("discards with 'no target file' when no file matches", () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    const report = applyPatch({
      patch: patchOf({
        add: [{ type: 'preference', scope: 'global', body: 'Prefere pt-BR', conf: 'high' }],
      }),
      files: [file],
      sessionId: 'sess_x',
    })

    expect(report.applied).toEqual([])
    expect(report.discarded).toEqual([{ op: 'add', reason: 'no target file' }])
    expect(report.filesWritten).toEqual([])
  })

  it("discards with 'duplicate' when the derived id already exists", () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    seed(file, 'Auth usa cookie')
    writeMemoryFile(file)

    const report = applyPatch({
      patch: patchOf({
        add: [{ type: 'project', scope: 'project', body: '  Auth   usa cookie ', conf: 'high' }],
      }),
      files: [file],
      sessionId: 'sess_x',
    })

    expect(report.applied).toEqual([])
    expect(report.discarded).toEqual([{ op: 'add', reason: 'duplicate' }])
    expect(report.filesWritten).toEqual([])
  })

  it('discards a duplicate that appears twice within the same patch', () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    const report = applyPatch({
      patch: patchOf({
        add: [
          { type: 'project', scope: 'project', body: 'Deploy via GitHub Actions', conf: 'high' },
          { type: 'project', scope: 'project', body: 'Deploy via GitHub Actions', conf: 'low' },
        ],
      }),
      files: [file],
      sessionId: 'sess_x',
    })

    expect(report.applied).toHaveLength(1)
    expect(report.discarded).toEqual([{ op: 'add', reason: 'duplicate' }])
  })
})

describe('applyPatch secret pre-scan', () => {
  it('discards an add whose body holds a secret and applies the others', () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    const report = applyPatch({
      patch: patchOf({
        add: [
          { type: 'project', scope: 'project', body: `Token do CI ${GH_TOKEN}`, conf: 'high' },
          { type: 'project', scope: 'project', body: 'CI roda no GitHub Actions', conf: 'high' },
        ],
      }),
      files: [file],
      sessionId: 'sess_x',
    })

    expect(report.discarded).toEqual([{ op: 'add', reason: 'secret' }])
    expect(report.applied).toHaveLength(1)

    const onDisk = readMemoryFile(file.path, { type: 'project', scope: 'project' })
    expect(onDisk.facts).toHaveLength(1)
    expect(onDisk.facts[0]?.body).toBe('CI roda no GitHub Actions')
  })

  it('discards a replace whose body holds a secret and leaves the old fact intact', () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    const old = seed(file, 'Deploy manual via ssh')
    writeMemoryFile(file)

    const report = applyPatch({
      patch: patchOf({
        replace: [{ targetId: old.id, body: `Deploy usa ${GH_TOKEN}`, conf: 'high' }],
      }),
      files: [file],
      sessionId: 'sess_x',
    })

    expect(report.applied).toEqual([])
    expect(report.discarded).toEqual([{ op: 'replace', reason: 'secret' }])
    expect(report.filesWritten).toEqual([])

    const onDisk = readMemoryFile(file.path, { type: 'project', scope: 'project' })
    expect(onDisk.facts.map((f) => f.id)).toEqual([old.id])
  })

  it('refuses the whole write when a pre-existing fact holds a secret', () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    seed(file, `Fato antigo sujo ${GH_TOKEN}`)

    expect(() =>
      applyPatch({
        patch: patchOf({
          add: [{ type: 'project', scope: 'project', body: 'Fato novo limpo', conf: 'high' }],
        }),
        files: [file],
        sessionId: 'sess_x',
      }),
    ).toThrow(SecretRefusalError)
    expect(fs.existsSync(file.path)).toBe(false)
  })
})

describe('applyPatch replace', () => {
  it('replaces a fact in the same file with a new derived id', () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    const other = makeFile(dir, 'preference', 'global')
    const old = seed(file, 'Deploy manual via ssh', 'low')
    writeMemoryFile(file)

    const report = applyPatch({
      patch: patchOf({
        replace: [{ targetId: old.id, body: 'Deploy via GitHub Actions', conf: 'high' }],
      }),
      files: [file, other],
      sessionId: 'a1b2',
      date: '2026-05-05',
    })

    expect(report.discarded).toEqual([])
    expect(report.filesWritten).toEqual([file.path])
    expect(report.applied).toEqual([
      {
        op: 'replace',
        factId: factId('Deploy via GitHub Actions'),
        type: 'project',
        scope: 'project',
      },
    ])

    const onDisk = readMemoryFile(file.path, { type: 'project', scope: 'project' })
    expect(onDisk.facts).toHaveLength(1)
    expect(onDisk.facts[0]).toMatchObject({
      id: factId('Deploy via GitHub Actions'),
      body: 'Deploy via GitHub Actions',
      date: '2026-05-05',
      src: 'sess_a1b2',
      conf: 'high',
    })
    expect(fs.existsSync(other.path)).toBe(false)
  })

  it('finds the target across files and writes only its owner', () => {
    const dir = tmpDir()
    const project = makeFile(dir, 'project', 'project')
    const preference = makeFile(dir, 'preference', 'global')
    seed(project, 'Fato de projeto')
    const target = seed(preference, 'Prefere respostas curtas')
    writeMemoryFile(project)
    writeMemoryFile(preference)

    const report = applyPatch({
      patch: patchOf({
        replace: [{ targetId: target.id, body: 'Prefere respostas muito curtas', conf: 'medium' }],
      }),
      files: [project, preference],
      sessionId: 'sess_x',
    })

    expect(report.filesWritten).toEqual([preference.path])
    expect(report.applied[0]?.scope).toBe('global')
    expect(report.applied[0]?.type).toBe('preference')
  })

  it("discards with 'unknown target' when the id is not found", () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    const report = applyPatch({
      patch: patchOf({ replace: [{ targetId: 'deadbeef', body: 'Novo corpo', conf: 'low' }] }),
      files: [file],
      sessionId: 'sess_x',
    })

    expect(report.applied).toEqual([])
    expect(report.discarded).toEqual([{ op: 'replace', reason: 'unknown target' }])
    expect(report.filesWritten).toEqual([])
  })

  it("discards with 'duplicate' when the new body collides with another fact", () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    const old = seed(file, 'Deploy manual via ssh')
    seed(file, 'Deploy via GitHub Actions')
    writeMemoryFile(file)

    const report = applyPatch({
      patch: patchOf({
        replace: [{ targetId: old.id, body: 'Deploy via GitHub Actions', conf: 'high' }],
      }),
      files: [file],
      sessionId: 'sess_x',
    })

    expect(report.discarded).toEqual([{ op: 'replace', reason: 'duplicate' }])
    const onDisk = readMemoryFile(file.path, { type: 'project', scope: 'project' })
    expect(onDisk.facts).toHaveLength(2)
  })
})

describe('applyPatch remove', () => {
  it('removes an existing fact', () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    const doomed = seed(file, 'Fato obsoleto')
    seed(file, 'Fato que fica')
    writeMemoryFile(file)

    const report = applyPatch({
      patch: patchOf({ remove: [{ targetId: doomed.id, reason: 'contradito na sessao' }] }),
      files: [file],
      sessionId: 'sess_x',
    })

    expect(report.applied).toEqual([
      { op: 'remove', factId: doomed.id, type: 'project', scope: 'project' },
    ])
    expect(report.filesWritten).toEqual([file.path])

    const onDisk = readMemoryFile(file.path, { type: 'project', scope: 'project' })
    expect(onDisk.facts.map((f) => f.body)).toEqual(['Fato que fica'])
  })

  it('discards a remove whose target does not exist', () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    seed(file, 'Fato que fica')
    writeMemoryFile(file)

    const report = applyPatch({
      patch: patchOf({ remove: [{ targetId: 'deadbeef', reason: 'sumiu' }] }),
      files: [file],
      sessionId: 'sess_x',
    })

    expect(report.applied).toEqual([])
    expect(report.discarded).toEqual([{ op: 'remove', reason: 'unknown target' }])
    expect(report.filesWritten).toEqual([])
  })
})

describe('applyPatch atomicity', () => {
  it('writes nothing when every entry is discarded', () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    const existing = seed(file, 'Fato existente')
    writeMemoryFile(file)
    const before = fs.readFileSync(file.path, 'utf8')

    const report = applyPatch({
      patch: patchOf({
        add: [
          { type: 'project', scope: 'global', body: 'Escopo ilegal', conf: 'low' },
          { type: 'project', scope: 'project', body: 'Fato existente', conf: 'low' },
          { type: 'project', scope: 'project', body: `Vazou ${GH_TOKEN}`, conf: 'low' },
        ],
        replace: [{ targetId: 'deadbeef', body: 'Nada aqui', conf: 'low' }],
        remove: [{ targetId: 'cafebabe', reason: 'nao existe' }],
      }),
      files: [file],
      sessionId: 'sess_x',
    })

    expect(report.applied).toEqual([])
    expect(report.discarded).toHaveLength(5)
    expect(report.filesWritten).toEqual([])
    expect(fs.readFileSync(file.path, 'utf8')).toBe(before)
    expect(file.facts.map((f) => f.id)).toEqual([existing.id])
  })

  it('never mutates the input MemoryFile objects', () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    const old = seed(file, 'Fato antigo')
    writeMemoryFile(file)
    const snapshot = structuredClone(file)

    applyPatch({
      patch: patchOf({
        add: [{ type: 'project', scope: 'project', body: 'Fato novo', conf: 'high' }],
        replace: [{ targetId: old.id, body: 'Fato revisado', conf: 'high' }],
      }),
      files: [file],
      sessionId: 'sess_x',
    })

    expect(file).toEqual(snapshot)
  })
})

describe('applyPatch provenance and date', () => {
  it('prefixes a bare session id with sess_', () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    applyPatch({
      patch: patchOf({ add: [{ type: 'project', scope: 'project', body: 'A', conf: 'low' }] }),
      files: [file],
      sessionId: 'a1b2',
    })
    const onDisk = readMemoryFile(file.path, { type: 'project', scope: 'project' })
    expect(onDisk.facts[0]?.src).toBe('sess_a1b2')
  })

  it('keeps an already prefixed session id and the manual token', () => {
    const dir = tmpDir()
    const prefixed = makeFile(dir, 'project', 'project')
    const manual = makeFile(dir, 'correction', 'project')
    applyPatch({
      patch: patchOf({ add: [{ type: 'project', scope: 'project', body: 'A', conf: 'low' }] }),
      files: [prefixed],
      sessionId: 'sess_a1b2',
    })
    applyPatch({
      patch: patchOf({ add: [{ type: 'correction', scope: 'project', body: 'B', conf: 'low' }] }),
      files: [manual],
      sessionId: 'manual',
    })

    expect(readMemoryFile(prefixed.path, { type: 'project', scope: 'project' }).facts[0]?.src).toBe(
      'sess_a1b2',
    )
    expect(
      readMemoryFile(manual.path, { type: 'correction', scope: 'project' }).facts[0]?.src,
    ).toBe('manual')
  })

  it('defaults the date to today when opts.date is omitted', () => {
    const dir = tmpDir()
    const file = makeFile(dir, 'project', 'project')
    applyPatch({
      patch: patchOf({
        add: [{ type: 'project', scope: 'project', body: 'Sem data', conf: 'low' }],
      }),
      files: [file],
      sessionId: 'sess_x',
    })
    const onDisk = readMemoryFile(file.path, { type: 'project', scope: 'project' })
    expect(onDisk.facts[0]?.date).toBe(today())
  })
})

describe('parsePatch — envelope tolerance (regression)', () => {
  const patch = { version: 1, add: [], replace: [], remove: [] }

  it('finds the patch when a harness wraps it in a result envelope', () => {
    // `claude -p --output-format json` shape: the answer sits inside a wrapper
    // whose own braces come first. Locking onto the first balanced object would
    // mean consolidation never works against that harness.
    const raw = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'here is the patch',
      patch,
    })
    // The envelope itself is a valid JSON object but not a valid patch; the
    // nested one is. Feed the realistic concatenated form too.
    const concatenated = `{"type":"result","result":"ok"}\n${JSON.stringify(patch)}`
    expect(parsePatch(concatenated).patch).toEqual(patch)
    expect(parsePatch(raw).error).toBeDefined()
  })

  it('still reports the schema error when no candidate validates', () => {
    const result = parsePatch('{"version":2,"add":[],"replace":[],"remove":[]}')
    expect(result.patch).toBeUndefined()
    expect(result.error).toContain('version')
  })

  it('prefers a valid patch over an earlier invalid object', () => {
    const raw = `preamble {"version":"nope"} then\n\`\`\`json\n${JSON.stringify(patch)}\n\`\`\``
    expect(parsePatch(raw).patch).toEqual(patch)
  })
})
