import path from 'node:path'
import { atomicWrite, readJsonSafe } from '../shared/fsx'
import type { MemoryFile, MemoryType } from './store'
import { serializeFacts } from './store'

/** Soft limit for one memory file: exceeding either dimension flags it for compaction. */
export interface FileBudget {
  lines: number
  bytes: number
}

export type FileBudgets = Record<'project' | 'correction' | 'preference', FileBudget>

/** PRD §5.5: 150 lines / 12 KB, 100 / 8 KB, 60 / 4 KB. */
export const DEFAULT_FILE_BUDGETS: FileBudgets = {
  project: { lines: 150, bytes: 12288 },
  correction: { lines: 100, bytes: 8192 },
  preference: { lines: 60, bytes: 4096 },
}

/** Machine-local, gitignored state kept at `<lumemDir>/local/state.json`. */
export interface LocalState {
  lastConsolidationAt?: string
  compactionFlags: MemoryType[]
}

const STATE_FILE = 'state.json'
const MEMORY_TYPES: readonly MemoryType[] = ['project', 'correction', 'preference']

function statePath(localDir: string): string {
  return path.join(localDir, STATE_FILE)
}

function emptyState(): LocalState {
  return { compactionFlags: [] }
}

/** Deduplicated and sorted, so a given set of flags always serializes identically. */
function normalizeFlags(flags: Iterable<MemoryType>): MemoryType[] {
  return [...new Set(flags)].sort()
}

function isMemoryType(value: unknown): value is MemoryType {
  return MEMORY_TYPES.some((type) => type === value)
}

/**
 * Read `<localDir>/state.json`. A missing, corrupt, or malformed file yields
 * the default state — this function never throws.
 */
export function readLocalState(localDir: string): LocalState {
  const raw = readJsonSafe<unknown>(statePath(localDir))
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyState()
  const candidate = raw as Record<string, unknown>
  if (!Array.isArray(candidate.compactionFlags)) return emptyState()
  if (!candidate.compactionFlags.every(isMemoryType)) return emptyState()
  const { lastConsolidationAt } = candidate
  if (lastConsolidationAt !== undefined && typeof lastConsolidationAt !== 'string') {
    return emptyState()
  }
  return {
    ...(lastConsolidationAt !== undefined ? { lastConsolidationAt } : {}),
    compactionFlags: normalizeFlags(candidate.compactionFlags),
  }
}

/**
 * Write the local state atomically with a stable key order, deduplicated and
 * sorted flags, and a trailing newline, so identical states always produce
 * byte-identical files.
 */
export function writeLocalState(localDir: string, state: LocalState): void {
  const normalized = {
    ...(state.lastConsolidationAt !== undefined
      ? { lastConsolidationAt: state.lastConsolidationAt }
      : {}),
    compactionFlags: normalizeFlags(state.compactionFlags),
  }
  atomicWrite(statePath(localDir), `${JSON.stringify(normalized, null, 2)}\n`)
}

/** Lines in serialized content, which ends with a single trailing newline when non-empty. */
function countLines(content: string): number {
  if (content === '') return 0
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * Measure a memory file against its type's budget. Both dimensions are taken
 * from the serialized on-disk form, and going over either one exceeds.
 */
export function checkSoftLimits(
  file: MemoryFile,
  budgets: FileBudgets = DEFAULT_FILE_BUDGETS,
): { exceeded: boolean; lines: number; bytes: number } {
  const content = serializeFacts(file.facts)
  const lines = countLines(content)
  const bytes = Buffer.byteLength(content, 'utf8')
  const budget = budgets[file.type]
  return { exceeded: lines > budget.lines || bytes > budget.bytes, lines, bytes }
}

/**
 * Reconcile the compaction flags of every type present in `files`: a type is
 * flagged when any of its files exceeds and unflagged when none does. Types
 * absent from `files` — and `lastConsolidationAt` — are preserved. The updated
 * state is persisted and returned.
 */
export function updateCompactionFlags(
  localDir: string,
  files: MemoryFile[],
  budgets: FileBudgets = DEFAULT_FILE_BUDGETS,
): LocalState {
  const checked = new Set<MemoryType>()
  const exceeded = new Set<MemoryType>()
  for (const file of files) {
    checked.add(file.type)
    if (checkSoftLimits(file, budgets).exceeded) exceeded.add(file.type)
  }

  const previous = readLocalState(localDir)
  const flags = new Set(previous.compactionFlags)
  for (const type of checked) {
    if (exceeded.has(type)) flags.add(type)
    else flags.delete(type)
  }

  const next: LocalState = {
    ...(previous.lastConsolidationAt !== undefined
      ? { lastConsolidationAt: previous.lastConsolidationAt }
      : {}),
    compactionFlags: normalizeFlags(flags),
  }
  writeLocalState(localDir, next)
  return next
}
