export interface SecretHit {
  kind: string
  index: number
  excerpt: string
}

/**
 * Known token formats, flagged wherever they appear. Each pattern is guarded
 * by a lookbehind so a token embedded at the tail of a longer identifier
 * (e.g. `task-…` matching `sk-…`) is not a hit.
 */
const KNOWN_FORMATS: { kind: string; re: RegExp }[] = [
  { kind: 'aws-access-key', re: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/g },
  { kind: 'github-token', re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: 'slack-token', re: /(?<![A-Za-z0-9])xox[baprsc]-[A-Za-z0-9-]{10,}/g },
  { kind: 'private-key', re: /-----BEGIN(?: RSA| EC| OPENSSH| DSA)? PRIVATE KEY-----/g },
  {
    kind: 'jwt',
    re: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  { kind: 'npm-token', re: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g },
  { kind: 'sk-token', re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g },
]

/** Var/key names that suggest the assigned value is sensitive. */
const SECRETISH = /SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH/i

/** .env-style line: `NAME=value` with optional leading `export`. */
const ENV_RE = /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]*)[ \t]*=[ \t]*(\S+)/

/** Generic assignment: `key: value`, `key = value`, `"key": "value"`. */
const ASSIGN_RE =
  /(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1[ \t]*[:=][ \t]*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"',;]+))/g

const MIN_ENV_VALUE_LENGTH = 8
const MIN_ENTROPY_VALUE_LENGTH = 20
const ENTROPY_THRESHOLD = 3.5

function isPlaceholder(value: string): boolean {
  if (/^x+$/i.test(value)) return true
  if (/^\.+$/.test(value)) return true
  if (value.startsWith('<') && value.endsWith('>')) return true
  if (value.startsWith('${') && value.endsWith('}')) return true
  if (value.toLowerCase() === 'changeme') return true
  if (/^your[-_]/i.test(value)) return true
  return false
}

/** Shannon entropy in bits per character. */
function shannonEntropy(value: string): number {
  const freq = new Map<string, number>()
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const count of freq.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/** Strip one pair of matching surrounding quotes, tracking the index shift. */
function unquote(raw: string): { value: string; shift: number } {
  const first = raw.charAt(0)
  const last = raw.charAt(raw.length - 1)
  if (raw.length >= 2 && first === last && (first === '"' || first === "'")) {
    return { value: raw.slice(1, -1), shift: 1 }
  }
  return { value: raw, shift: 0 }
}

/**
 * Scan `text` for apparent secrets. Layered rules: known token formats,
 * .env-style assignments to secret-ish UPPER_CASE names, and a Shannon
 * entropy check for values assigned to secret-ish keys in any casing.
 * Excerpts are redacted (first 4 chars + ellipsis) so hits are safe to log.
 */
export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = []
  const claimed: { start: number; end: number }[] = []

  const overlaps = (start: number, end: number): boolean =>
    claimed.some((c) => start < c.end && end > c.start)

  const claim = (kind: string, start: number, secret: string): void => {
    claimed.push({ start, end: start + secret.length })
    hits.push({ kind, index: start, excerpt: `${secret.slice(0, 4)}…` })
  }

  // Rule 1: known token formats, regardless of context.
  for (const { kind, re } of KNOWN_FORMATS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0
      if (!overlaps(start, start + m[0].length)) claim(kind, start, m[0])
    }
  }

  // Rule 2: .env-style assignment to a secret-ish UPPER_CASE name.
  let offset = 0
  for (const line of text.split('\n')) {
    const m = ENV_RE.exec(line)
    if (m !== null && SECRETISH.test(m[1] ?? '')) {
      const raw = m[2] ?? ''
      const { value, shift } = unquote(raw)
      const start = offset + m[0].length - raw.length + shift
      if (
        value.length >= MIN_ENV_VALUE_LENGTH &&
        !isPlaceholder(value) &&
        !overlaps(start, start + value.length)
      ) {
        claim('env-secret', start, value)
      }
    }
    offset += line.length + 1
  }

  // Rule 3: entropy check for values assigned to secret-ish keys (any casing).
  for (const m of text.matchAll(ASSIGN_RE)) {
    if (!SECRETISH.test(m[2] ?? '')) continue
    const quoted = m[3] ?? m[4]
    const value = quoted ?? m[5] ?? ''
    if (value.length < MIN_ENTROPY_VALUE_LENGTH) continue
    if (isPlaceholder(value)) continue
    if (shannonEntropy(value) <= ENTROPY_THRESHOLD) continue
    const start = (m.index ?? 0) + m[0].length - value.length - (quoted === undefined ? 0 : 1)
    if (!overlaps(start, start + value.length)) claim('high-entropy', start, value)
  }

  return hits.sort((a, b) => a.index - b.index)
}

export function hasSecrets(text: string): boolean {
  return scanSecrets(text).length > 0
}
