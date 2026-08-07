import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite, sha256 } from '../shared/fsx'
import { scanSecrets } from '../shared/secrets'

export type MemoryType = 'project' | 'preference' | 'correction'
export type MemoryScope = 'project' | 'global'

export interface Fact {
  /** Derived, never stored on disk: sha256(normalized body) truncated to 8 hex chars. */
  id: string
  /** YYYY-MM-DD */
  date: string
  /** Logical body; may contain \n. Continuation lines are indented 2 spaces on disk. */
  body: string
  /** Provenance token, e.g. 'sess_a1b2' or 'manual'. */
  src: string
  conf: 'low' | 'medium' | 'high'
  type: MemoryType
  scope: MemoryScope
}

export interface MemoryFile {
  path: string
  type: MemoryType
  scope: MemoryScope
  facts: Fact[]
  warnings: string[]
}

export class SecretRefusalError extends Error {
  hits: { factId: string; kind: string }[]

  constructor(hits: { factId: string; kind: string }[]) {
    super(`refusing to write memory file: ${hits.length} secret hit(s) detected`)
    this.name = 'SecretRefusalError'
    this.hits = hits
  }
}

const BULLET_RE = /^- \[([^\]]*)\] (.*)$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const PROVENANCE_RE = /^ {2}<!-- src:(\S+) conf:(\S+) -->$/
const CONTINUATION_RE = /^ {2}(.*)$/
const CONF_VALUES: readonly Fact['conf'][] = ['low', 'medium', 'high']

/** Stable fact id: sha256 of the body with whitespace runs collapsed, truncated to 8 hex chars. */
export function factId(body: string): string {
  return sha256(body.trim().replace(/\s+/g, ' ')).slice(0, 8)
}

interface OpenBullet {
  startLine: number
  date: string
  bodyLines: string[]
  /** True when the bullet was rejected (malformed date): consume its block silently. */
  skip: boolean
}

/**
 * Tolerant parser for the on-disk fact format. Never throws: malformed input
 * is skipped or repaired, with a warning per incident.
 */
export function parseMemoryFacts(
  content: string,
  meta: { type: MemoryType; scope: MemoryScope },
): { facts: Fact[]; warnings: string[] } {
  const facts: Fact[] = []
  const warnings: string[] = []

  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  let open: OpenBullet | undefined

  const pushFact = (bullet: OpenBullet, src: string, conf: Fact['conf']): void => {
    const body = bullet.bodyLines.join('\n')
    facts.push({ id: factId(body), date: bullet.date, body, src, conf, ...meta })
  }

  const closeWithoutProvenance = (): void => {
    if (open !== undefined && !open.skip) {
      warnings.push(
        `line ${open.startLine}: fact missing provenance comment; using src 'unknown', conf 'low'`,
      )
      pushFact(open, 'unknown', 'low')
    }
    open = undefined
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const lineNo = i + 1

    const bullet = BULLET_RE.exec(line)
    if (bullet !== null) {
      closeWithoutProvenance()
      const date = bullet[1] ?? ''
      if (DATE_RE.test(date)) {
        open = { startLine: lineNo, date, bodyLines: [bullet[2] ?? ''], skip: false }
      } else {
        warnings.push(`line ${lineNo}: skipped fact with malformed date '${date}'`)
        open = { startLine: lineNo, date, bodyLines: [], skip: true }
      }
      continue
    }

    if (open !== undefined) {
      const provenance = PROVENANCE_RE.exec(line)
      if (provenance !== null) {
        if (!open.skip) {
          const rawConf = provenance[2] ?? ''
          let conf = CONF_VALUES.find((c) => c === rawConf)
          if (conf === undefined) {
            warnings.push(`line ${lineNo}: unknown conf '${rawConf}'; using 'low'`)
            conf = 'low'
          }
          pushFact(open, provenance[1] ?? 'unknown', conf)
        }
        open = undefined
        continue
      }
      const continuation = CONTINUATION_RE.exec(line)
      if (continuation !== null) {
        if (!open.skip) open.bodyLines.push(continuation[1] ?? '')
        continue
      }
      closeWithoutProvenance()
    }

    if (line.trim() === '') continue
    warnings.push(`line ${lineNo}: skipped line that is neither a fact bullet nor a continuation`)
  }
  closeWithoutProvenance()

  return { facts, warnings }
}

/** Serialize facts to the on-disk format; ends with a single trailing newline when non-empty. */
export function serializeFacts(facts: Fact[]): string {
  let out = ''
  for (const fact of facts) {
    const [first, ...rest] = fact.body.split('\n')
    out += `- [${fact.date}] ${first ?? ''}\n`
    for (const line of rest) out += `  ${line}\n`
    out += `  <!-- src:${fact.src} conf:${fact.conf} -->\n`
  }
  return out
}

/** Read and parse a memory file; a missing file yields empty facts with no warning. */
export function readMemoryFile(
  filePath: string,
  meta: { type: MemoryType; scope: MemoryScope },
): MemoryFile {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: filePath, ...meta, facts: [], warnings: [] }
    }
    throw err
  }
  const { facts, warnings } = parseMemoryFacts(content, meta)
  return { path: filePath, ...meta, facts, warnings }
}

/**
 * THE single choke point for durable memory writes: every fact's body and src
 * are scanned for secrets; any hit refuses the whole write (nothing touches
 * disk), otherwise the file is written atomically.
 */
export function writeMemoryFile(file: MemoryFile): void {
  const hits: { factId: string; kind: string }[] = []
  for (const fact of file.facts) {
    for (const hit of scanSecrets(`${fact.body}\n${fact.src}`)) {
      hits.push({ factId: fact.id, kind: hit.kind })
    }
  }
  if (hits.length > 0) throw new SecretRefusalError(hits)
  atomicWrite(file.path, serializeFacts(file.facts))
}

/** Append a fact to `file` (in memory). Throws on duplicate id or malformed date. */
export function addFact(
  file: MemoryFile,
  input: { date?: string; body: string; src: string; conf: Fact['conf'] },
): Fact {
  const date = input.date ?? localToday()
  if (!DATE_RE.test(date)) throw new Error(`invalid date '${date}': expected YYYY-MM-DD`)
  const id = factId(input.body)
  if (file.facts.some((fact) => fact.id === id)) {
    throw new Error(`duplicate fact id '${id}': an equivalent fact already exists`)
  }
  const fact: Fact = {
    id,
    date,
    body: input.body,
    src: input.src,
    conf: input.conf,
    type: file.type,
    scope: file.scope,
  }
  file.facts.push(fact)
  return fact
}

/** Remove the fact with `id` from `file` (in memory). Returns whether it existed. */
export function removeFact(file: MemoryFile, id: string): boolean {
  const index = file.facts.findIndex((fact) => fact.id === id)
  if (index === -1) return false
  file.facts.splice(index, 1)
  return true
}

/** Case-insensitive substring search on fact bodies, in file order. */
export function searchFacts(files: MemoryFile[], q: string): Fact[] {
  const needle = q.toLowerCase()
  return files.flatMap((file) => file.facts.filter((f) => f.body.toLowerCase().includes(needle)))
}

/** The four durable memory files defined by PRD §5.2. */
export function memoryLayout(
  projectLumemDir: string,
  globalLumemDir: string,
): { path: string; type: MemoryType; scope: MemoryScope }[] {
  return [
    { path: path.join(projectLumemDir, 'memory', 'project.md'), type: 'project', scope: 'project' },
    {
      path: path.join(projectLumemDir, 'memory', 'correction.md'),
      type: 'correction',
      scope: 'project',
    },
    {
      path: path.join(globalLumemDir, 'memory', 'preference.md'),
      type: 'preference',
      scope: 'global',
    },
    {
      path: path.join(globalLumemDir, 'memory', 'correction.md'),
      type: 'correction',
      scope: 'global',
    },
  ]
}

function localToday(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}
