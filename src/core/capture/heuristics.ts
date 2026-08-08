import { type SecretHit, scanSecrets } from '../shared/secrets'
import type { Signal } from './journal'

/**
 * Correction heuristics for the prompt hook.
 *
 * PRD boundary (V1): detecting a correction by string matching is fragile and
 * produces false positives, so this module ONLY MARKS a signal in the journal.
 * It has no write path — no filesystem access, no memory mutation. Deciding
 * which corrections become durable facts is the consolidation LLM's job.
 *
 * Everything here is pure and dependency-free: it runs inside the bundled hook.
 */

/** pt-BR + en markers that hint the user is correcting the agent. */
export const DEFAULT_CORRECTION_MARKERS: string[] = [
  'na verdade',
  'não, faz',
  'nao, faz',
  'sempre que',
  'nunca',
  'actually',
  'no, do',
  'always',
  'never',
  'não use',
  'nao use',
  "don't use",
  'do not use',
]

/** Combining marks left behind by NFD decomposition. */
const COMBINING_MARKS = /\p{M}/gu

/** Regex metacharacters that must be escaped when a marker becomes a pattern. */
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

/**
 * Characters treated as "inside a word" for boundary anchoring. The hyphen is
 * included on purpose: it keeps `never` out of `never-ending` and `nunca` out of
 * `nunca-mente`. That trades a rare false negative for fewer false positives,
 * which is the right direction for a heuristic that only marks signals.
 */
const WORD_CHAR = '[\\p{L}\\p{N}_-]'

/** Compiled patterns, keyed by the folded marker. Markers come from config, so this stays small. */
const markerPatterns = new Map<string, RegExp>()

/** Case- and diacritic-insensitive form: NFD, drop combining marks, lowercase. */
function fold(text: string): string {
  return text.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase()
}

function markerPattern(marker: string): RegExp {
  const folded = fold(marker)
  const cached = markerPatterns.get(folded)
  if (cached !== undefined) return cached
  const escaped = folded.replace(REGEX_SPECIALS, '\\$&')
  const pattern = new RegExp(`(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`, 'u')
  markerPatterns.set(folded, pattern)
  return pattern
}

/**
 * First marker (in list order) whose word-boundary-anchored, case- and
 * diacritic-insensitive form occurs in `text`; null when none does. The value
 * returned is the marker exactly as it appears in the list, not its folded form.
 */
export function classifyPrompt(
  text: string,
  markers: string[] = DEFAULT_CORRECTION_MARKERS,
): string | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null
  const haystack = fold(text)
  for (const marker of markers) {
    if (typeof marker !== 'string' || marker.trim().length === 0) continue
    if (markerPattern(marker).test(haystack)) return marker
  }
  return null
}

const DEFAULT_MAX_LEN = 500

/** Value shapes claimed by `scanSecrets`, used to recover each hit's span. */
const PRIVATE_KEY_HEADER = /^-----BEGIN(?: RSA| EC| OPENSSH| DSA)? PRIVATE KEY-----/
const ENV_VALUE_RUN = /^\S+/
const TOKEN_RUN = /^[^\s"',;]+/
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>]+$/

/**
 * `SecretHit` carries an index but no length (its excerpt is already redacted),
 * so the span is recovered from the text: the value run that starts at the hit,
 * shaped by the rule that claimed it. `limit` keeps a greedy run from swallowing
 * the next hit.
 */
function spanEnd(text: string, hit: SecretHit, limit: number): number {
  const rest = text.slice(hit.index, limit)

  if (hit.kind === 'private-key') {
    const header = PRIVATE_KEY_HEADER.exec(rest)
    if (header !== null) return hit.index + header[0].length
  }

  // A quoted value: the scanner points just past the opening quote.
  const opening = hit.index > 0 ? text.charAt(hit.index - 1) : ''
  if (opening === '"' || opening === "'") {
    const closing = rest.indexOf(opening)
    if (closing > 0) return hit.index + closing
  }

  const run = (hit.kind === 'env-secret' ? ENV_VALUE_RUN : TOKEN_RUN).exec(rest)
  if (run === null) return hit.index
  let value = run[0]
  // Known token formats never end in punctuation, so a trailing `.` or `,` is
  // sentence noise rather than part of the secret. The two context-based rules
  // claim the run verbatim, so theirs is left alone.
  if (hit.kind !== 'env-secret' && hit.kind !== 'high-entropy') {
    value = value.replace(TRAILING_PUNCTUATION, '')
  }
  return hit.index + value.length
}

function replaceSecrets(text: string): string {
  const hits = scanSecrets(text)
  if (hits.length === 0) return text
  let out = ''
  let cursor = 0
  for (const [i, hit] of hits.entries()) {
    if (hit.index < cursor) continue
    const end = spanEnd(text, hit, hits[i + 1]?.index ?? text.length)
    if (end <= hit.index) continue
    out += `${text.slice(cursor, hit.index)}[REDACTED:${hit.kind}]`
    cursor = end
  }
  return out + text.slice(cursor)
}

/** Cut point that never splits a surrogate pair. */
function safeCut(text: string, cap: number): number {
  if (cap <= 0) return 0
  const last = text.charCodeAt(cap - 1)
  return last >= 0xd800 && last <= 0xdbff ? cap - 1 : cap
}

/**
 * Make a prompt safe to store in the journal: secrets replaced by
 * `[REDACTED:<kind>]`, newlines flattened to spaces, trimmed, then capped at
 * `maxLen` with a trailing ellipsis (which is extra, so at most `maxLen + 1`).
 * Never throws — on any failure it fails closed and returns an empty string.
 */
export function redact(text: string, maxLen: number = DEFAULT_MAX_LEN): string {
  if (typeof text !== 'string' || text.length === 0) return ''
  try {
    const flat = replaceSecrets(text).replace(/\r?\n/g, ' ').trim()
    const cap = Number.isFinite(maxLen) ? Math.max(0, Math.floor(maxLen)) : DEFAULT_MAX_LEN
    if (flat.length <= cap) return flat
    return `${flat.slice(0, safeCut(flat, cap))}…`
  } catch {
    return ''
  }
}

/**
 * Build a `correction` signal for a prompt that trips a marker, with the prompt
 * already redacted. Returns null when nothing matches. This is a marking
 * decision only: the caller appends it to the journal, and consolidation — not
 * this heuristic — decides whether it ever becomes a durable fact.
 */
export function correctionSignal(text: string, ts: string, markers?: string[]): Signal | null {
  const marker = classifyPrompt(text, markers)
  if (marker === null) return null
  return { t: 'correction', ts, marker, prompt: redact(text) }
}
