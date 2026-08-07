import fs from 'node:fs'
import { atomicWrite } from '../shared/fsx'

export const START_MARKER = '<!-- lumem:start -->'
export const END_MARKER = '<!-- lumem:end -->'

export interface UpsertResult {
  action: 'created-file' | 'created-block' | 'updated' | 'unchanged'
  truncated: boolean
}

/** Span of the first well-formed managed block in a file. */
interface BlockSpan {
  /** Index of the first byte of the start marker. */
  start: number
  /** Index just past the start marker (raw inner content begins here). */
  innerStart: number
  /** Index of the first byte of the end marker (raw inner content ends here). */
  innerEnd: number
  /** Index just past the end marker. */
  end: number
}

/**
 * Locate the first start marker and the first end marker after it.
 * Returns undefined when either is missing (malformed blocks are treated
 * as no block so user content is never destroyed).
 */
function findBlock(text: string): BlockSpan | undefined {
  const start = text.indexOf(START_MARKER)
  if (start === -1) return undefined
  const innerStart = start + START_MARKER.length
  const innerEnd = text.indexOf(END_MARKER, innerStart)
  if (innerEnd === -1) return undefined
  return { start, innerStart, innerEnd, end: innerEnd + END_MARKER.length }
}

/** Raw text between the markers for a given block content. */
function renderInner(content: string): string {
  return content === '' ? '\n' : `\n${content}\n`
}

/** A full block: markers wrapping the content. */
function renderBlock(content: string): string {
  return `${START_MARKER}${renderInner(content)}${END_MARKER}`
}

function readFileSafe(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Drop whole lines from the end of `content` until `compose(content)` fits
 * within `maxFileBytes`. User content outside the block is never touched; if
 * even an empty block exceeds the budget the empty block is used anyway.
 */
function fitToBudget(
  compose: (content: string) => string,
  content: string,
  maxFileBytes: number | undefined,
): { text: string; truncated: boolean } {
  let text = compose(content)
  if (maxFileBytes === undefined || Buffer.byteLength(text) <= maxFileBytes) {
    return { text, truncated: false }
  }
  const lines = content.split('\n')
  while (lines.length > 0) {
    lines.pop()
    text = compose(lines.join('\n'))
    if (Buffer.byteLength(text) <= maxFileBytes) return { text, truncated: true }
  }
  return { text: compose(''), truncated: true }
}

/**
 * Create or update the lumem-managed block in `filePath`.
 * - Missing file: the file is created containing only the block.
 * - No block: the block is appended, separated by exactly one blank line;
 *   every pre-existing byte is preserved.
 * - Existing block: only the content between the markers is replaced;
 *   bytes before and after the block are preserved exactly.
 */
export function upsertManagedBlock(
  filePath: string,
  blockContent: string,
  opts?: { maxFileBytes?: number },
): UpsertResult {
  const existing = readFileSafe(filePath)
  let action: Exclude<UpsertResult['action'], 'unchanged'>
  let compose: (content: string) => string

  if (existing === undefined) {
    action = 'created-file'
    compose = (content) => `${renderBlock(content)}\n`
  } else {
    const span = findBlock(existing)
    if (span === undefined) {
      action = 'created-block'
      const sep =
        existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
      compose = (content) => `${existing}${sep}${renderBlock(content)}\n`
    } else {
      action = 'updated'
      const prefix = existing.slice(0, span.innerStart)
      const suffix = existing.slice(span.innerEnd)
      compose = (content) => `${prefix}${renderInner(content)}${suffix}`
    }
  }

  const { text, truncated } = fitToBudget(compose, blockContent, opts?.maxFileBytes)
  if (existing !== undefined && text === existing) {
    return { action: 'unchanged', truncated }
  }
  atomicWrite(filePath, text)
  return { action, truncated }
}

/**
 * Remove the lumem-managed block from `filePath`, including the single
 * separating blank line lumem added when the block sits at the end of the
 * file. Deletes the file when only whitespace would remain.
 */
export function removeManagedBlock(filePath: string): { removed: boolean; fileDeleted: boolean } {
  const existing = readFileSafe(filePath)
  if (existing === undefined) return { removed: false, fileDeleted: false }
  const span = findBlock(existing)
  if (span === undefined) return { removed: false, fileDeleted: false }

  let before = existing.slice(0, span.start)
  let after = existing.slice(span.end)

  if (after === '' || after === '\n') {
    // Block at end of file: drop its trailing newline and the single
    // separating blank line lumem added when appending.
    after = ''
    if (before.endsWith('\n\n')) before = before.slice(0, -1)
  }

  const remaining = before + after
  if (remaining.trim() === '') {
    fs.unlinkSync(filePath)
    return { removed: true, fileDeleted: true }
  }
  atomicWrite(filePath, remaining)
  return { removed: true, fileDeleted: false }
}

/**
 * Content between the markers of the first managed block, or undefined when
 * the file or a well-formed block is missing.
 */
export function readManagedBlock(filePath: string): string | undefined {
  const text = readFileSafe(filePath)
  if (text === undefined) return undefined
  const span = findBlock(text)
  if (span === undefined) return undefined
  let inner = text.slice(span.innerStart, span.innerEnd)
  if (inner.startsWith('\n')) inner = inner.slice(1)
  if (inner.endsWith('\n')) inner = inner.slice(0, -1)
  return inner
}
