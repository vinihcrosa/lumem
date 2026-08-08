import { z } from 'zod'
import type { MemoryFile, MemoryScope, MemoryType } from '../memory/store'
import { SecretRefusalError, addFact, factId, removeFact, writeMemoryFile } from '../memory/store'
import { scanSecrets } from '../shared/secrets'

/**
 * The patch returned by the consolidation LLM. UNTRUSTED input: every field is
 * validated by `consolidationPatchSchema` before it is ever applied.
 */
export interface ConsolidationPatch {
  version: 1
  add: {
    type: 'project' | 'preference' | 'correction'
    scope: 'project' | 'global'
    body: string
    conf: 'low' | 'medium' | 'high'
  }[]
  replace: { targetId: string; body: string; conf: 'low' | 'medium' | 'high' }[]
  remove: { targetId: string; reason: string }[]
}

const confSchema = z.enum(['low', 'medium', 'high'])

/** Strict schema: unknown keys are rejected at every level, never stripped. */
export const consolidationPatchSchema: z.ZodType<ConsolidationPatch> = z
  .object({
    version: z.literal(1),
    add: z.array(
      z
        .object({
          type: z.enum(['project', 'preference', 'correction']),
          scope: z.enum(['project', 'global']),
          body: z.string().min(1),
          conf: confSchema,
        })
        .strict(),
    ),
    replace: z.array(
      z.object({ targetId: z.string().min(1), body: z.string().min(1), conf: confSchema }).strict(),
    ),
    remove: z.array(z.object({ targetId: z.string().min(1), reason: z.string() }).strict()),
  })
  .strict()

/** Index of the `}` that closes the `{` at `start`, or -1 when unbalanced. */
function matchBalanced(raw: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Top-level balanced `{...}` slices of `raw`, in order; nested objects are skipped. */
function jsonCandidates(raw: string): string[] {
  const candidates: string[] = []
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{') continue
    const end = matchBalanced(raw, i)
    if (end === -1) continue
    candidates.push(raw.slice(i, end + 1))
    i = end
  }
  return candidates
}

/**
 * Tolerant entry point for LLM output: pull the first balanced top-level JSON
 * object out of whatever wrapping the model produced (fences, preamble,
 * trailing chatter), then validate it. Errors name the offending field path.
 */
export function parsePatch(raw: string): { patch?: ConsolidationPatch; error?: string } {
  let jsonError: string | undefined
  let schemaError: string | undefined

  // Try EVERY candidate against the schema, not just the first one that parses:
  // a harness may wrap the answer in an envelope (`claude -p --output-format
  // json`), and the first balanced object would then be the envelope rather
  // than the patch. Whichever candidate validates wins.
  for (const candidate of jsonCandidates(raw)) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch (err) {
      jsonError ??= err instanceof Error ? err.message : String(err)
      continue
    }

    const result = consolidationPatchSchema.safeParse(value)
    if (result.success) return { patch: result.data }

    if (schemaError === undefined) {
      const issue = result.error.issues[0]
      const at = issue === undefined ? '' : issue.path.join('.')
      schemaError =
        issue === undefined
          ? 'invalid patch'
          : at === ''
            ? `invalid patch: ${issue.message}`
            : `invalid patch at ${at}: ${issue.message}`
    }
  }

  if (schemaError !== undefined) return { error: schemaError }
  return { error: `invalid JSON: ${jsonError ?? 'no JSON object found in output'}` }
}

export interface PatchReport {
  applied: { op: 'add' | 'replace' | 'remove'; factId: string; type: string; scope: string }[]
  discarded: { op: string; reason: string }[]
  filesWritten: string[]
}

/** Which scopes each memory type may legally live in (PRD §5.2). */
const LEGAL_SCOPES: Record<MemoryType, MemoryScope[]> = {
  project: ['project'],
  preference: ['global'],
  correction: ['project', 'global'],
}

/** Provenance token: `sess_<id>`, unless already prefixed or the literal 'manual'. */
function normalizeSrc(sessionId: string): string {
  if (sessionId === 'manual' || sessionId.startsWith('sess_')) return sessionId
  return `sess_${sessionId}`
}

/** Same surface `writeMemoryFile` scans, so a clean pre-scan cannot refuse later. */
function looksSecret(body: string, src: string): boolean {
  return scanSecrets(`${body}\n${src}`).length > 0
}

/**
 * Apply an already-validated patch. Every entry is checked against deep copies
 * of `files`; only once all entries have been processed are the touched files
 * persisted. A patch whose entries are all discarded touches no file at all.
 */
export function applyPatch(opts: {
  patch: ConsolidationPatch
  files: MemoryFile[]
  sessionId: string
  /** YYYY-MM-DD; defaults to today. */
  date?: string
}): PatchReport {
  const { patch } = opts
  const src = normalizeSrc(opts.sessionId)
  const working = opts.files.map((file) => structuredClone(file))
  const applied: PatchReport['applied'] = []
  const discarded: PatchReport['discarded'] = []
  const touched = new Set<MemoryFile>()

  // Rule: pre-scan every incoming body BEFORE anything mutates, so one poisoned
  // entry costs only itself instead of making the whole file unwritable.
  const addSecret = patch.add.map((entry) => looksSecret(entry.body, src))
  const replaceSecret = patch.replace.map((entry) => looksSecret(entry.body, src))

  patch.add.forEach((entry, index) => {
    if (addSecret[index] === true) {
      discarded.push({ op: 'add', reason: 'secret' })
      return
    }
    if (!LEGAL_SCOPES[entry.type].includes(entry.scope)) {
      discarded.push({ op: 'add', reason: 'illegal type/scope combination' })
      return
    }
    const target = working.find((file) => file.type === entry.type && file.scope === entry.scope)
    if (target === undefined) {
      discarded.push({ op: 'add', reason: 'no target file' })
      return
    }
    const id = factId(entry.body)
    if (target.facts.some((fact) => fact.id === id)) {
      discarded.push({ op: 'add', reason: 'duplicate' })
      return
    }
    const fact = addFact(target, { date: opts.date, body: entry.body, src, conf: entry.conf })
    applied.push({ op: 'add', factId: fact.id, type: fact.type, scope: fact.scope })
    touched.add(target)
  })

  patch.replace.forEach((entry, index) => {
    if (replaceSecret[index] === true) {
      discarded.push({ op: 'replace', reason: 'secret' })
      return
    }
    const owner = working.find((file) => file.facts.some((fact) => fact.id === entry.targetId))
    if (owner === undefined) {
      discarded.push({ op: 'replace', reason: 'unknown target' })
      return
    }
    const id = factId(entry.body)
    if (id !== entry.targetId && owner.facts.some((fact) => fact.id === id)) {
      discarded.push({ op: 'replace', reason: 'duplicate' })
      return
    }
    removeFact(owner, entry.targetId)
    const fact = addFact(owner, { date: opts.date, body: entry.body, src, conf: entry.conf })
    applied.push({ op: 'replace', factId: fact.id, type: fact.type, scope: fact.scope })
    touched.add(owner)
  })

  for (const entry of patch.remove) {
    const owner = working.find((file) => file.facts.some((fact) => fact.id === entry.targetId))
    if (owner === undefined) {
      discarded.push({ op: 'remove', reason: 'unknown target' })
      continue
    }
    removeFact(owner, entry.targetId)
    applied.push({ op: 'remove', factId: entry.targetId, type: owner.type, scope: owner.scope })
    touched.add(owner)
  }

  const toWrite = working.filter((file) => touched.has(file))

  // All-or-nothing: refuse before the first byte lands if any file about to be
  // written carries a secret (e.g. one that was already on disk).
  const hits = toWrite.flatMap((file) =>
    file.facts.flatMap((fact) =>
      scanSecrets(`${fact.body}\n${fact.src}`).map((hit) => ({ factId: fact.id, kind: hit.kind })),
    ),
  )
  if (hits.length > 0) throw new SecretRefusalError(hits)

  for (const file of toWrite) writeMemoryFile(file)

  return { applied, discarded, filesWritten: toWrite.map((file) => file.path) }
}
