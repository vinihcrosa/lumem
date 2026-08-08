import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AdapterDescriptor } from '../../adapters/schema'
import type { Signal } from '../capture/journal'
import { readSignals } from '../capture/journal'
import { type LumemConfig, readConfig } from '../config'
import { loadDescriptors } from '../harness/load'
import { readLocalState, updateCompactionFlags, writeLocalState } from '../memory/limits'
import type { MemoryFile, MemoryType } from '../memory/store'
import { memoryLayout, readMemoryFile } from '../memory/store'
import { appendLog } from '../shared/log'
import { checkGate } from './gate'
import { acquireLock, releaseLock } from './lock'
import { type ConsolidationPatch, applyPatch, parsePatch } from './patch'

/**
 * How long the consolidation LLM gets. Generous on purpose: this process is
 * detached from the session that spawned it, so nobody is waiting on it.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000

/** Bytes of a failed command's output that reach the log — never the whole thing. */
const OUTPUT_EXCERPT = 500

/**
 * Spawns the headless agent CLI and returns its combined output. Injected in
 * tests; the default implementation is {@link spawnLlm}.
 */
export type RunLlm = (
  cmd: string[],
  prompt: string,
  timeoutMs: number,
) => { ok: boolean; stdout: string; stderr: string }

export interface RunConsolidationOptions {
  projectDir: string
  sessionFile: string
  harnessId: string
  adaptersDir: string
  assetsDir: string
  /** Root of the global memory scope: `<homeDir>/.lumem`. */
  homeDir: string
  /** Waive the gate thresholds — never the lock. */
  force?: boolean
  /** Run the LLM and return the patch without touching a single memory file. */
  dryRun?: boolean
  now?: () => Date
  runLlm?: RunLlm
}

export interface ConsolidationResult {
  ran: boolean
  /** Why it did not run; empty once the gate and the lock are cleared. */
  gateReasons: string[]
  /** The model's patch, once parsed — present on dry runs too. */
  patch?: ConsolidationPatch
  applied?: { applied: unknown[]; discarded: unknown[]; filesWritten: string[] }
  error?: string
}

type LogLevel = 'info' | 'warn' | 'error'
type Log = (level: LogLevel, event: string, data?: Record<string, unknown>) => void

/** Everything the locked section needs that the entry point already computed. */
interface RunContext {
  config: LumemConfig | undefined
  lumemDir: string
  localDir: string
  log: Log
  now: () => Date
}

/**
 * Consolidate one finished session into durable memory.
 *
 * The authoritative gate check lives here, not in the hook that spawned us: the
 * runner starts later, so the world may have moved on (another runner won the
 * race, the session was already consolidated). Order matters — config, gate,
 * then lock — because everything before the lock must be free to fail without
 * leaving a lock file behind.
 *
 * Never throws: every failure is reported through `error`, and the lock is
 * released in a `finally` no matter how the flow ends.
 */
export function runConsolidation(opts: RunConsolidationOptions): ConsolidationResult {
  const now = opts.now ?? ((): Date => new Date())
  const lumemDir = path.join(opts.projectDir, '.lumem')
  const localDir = path.join(lumemDir, 'local')
  const logFile = path.join(localDir, 'lumem.log')
  const log: Log = (level, event, data) => appendLog(logFile, { level, event, data })

  const { config, error: configError } = readConfig(lumemDir)
  if (configError !== undefined) {
    // A broken config must not block consolidation: fall back to the defaults
    // every dependency already carries.
    log('warn', 'consolidate.config-unavailable', { error: configError })
  }

  if (config?.consolidation.enabled === false) {
    const gateReasons = ['consolidation disabled in config']
    log('info', 'consolidate.refused', { gateReasons })
    return { ran: false, gateReasons }
  }

  const gate = checkGate({
    sessionFile: opts.sessionFile,
    localDir,
    config: config?.gate,
    now: now(),
    force: opts.force === true,
  })
  if (!gate.pass) {
    log('info', 'consolidate.refused', { gateReasons: gate.reasons, force: opts.force === true })
    return { ran: false, gateReasons: gate.reasons }
  }

  const lock = acquireLock(localDir, config?.gate.lockTtlMin)
  if (lock === null) {
    const gateReasons = ['lock: another consolidation is already running']
    log('info', 'consolidate.refused', { gateReasons })
    return { ran: false, gateReasons }
  }

  try {
    return runLocked(opts, { config, lumemDir, localDir, log, now })
  } catch (err) {
    const error = describeError(err)
    log('error', 'consolidate.failed', { error })
    return { ran: false, gateReasons: [], error }
  } finally {
    releaseLock(lock)
  }
}

/**
 * The part of the flow that owns the lock. Free to throw: the caller turns any
 * escape into an `error` result and releases the lock either way.
 */
function runLocked(opts: RunConsolidationOptions, ctx: RunContext): ConsolidationResult {
  const descriptor = resolveDescriptor(opts, ctx.config)
  const globalLumemDir = path.join(opts.homeDir, '.lumem')
  const { signals } = readSignals(opts.sessionFile)

  const prompt = buildPrompt({
    skill: readSkill(opts.assetsDir),
    signals,
    files: loadMemory(ctx.lumemDir, globalLumemDir),
    compactionFlags: readLocalState(ctx.localDir).compactionFlags,
  })
  const cmd = buildCommand(descriptor, ctx.config)

  ctx.log('info', 'consolidate.started', {
    harness: descriptor.id,
    cmd,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    signals: signals.length,
    dryRun: opts.dryRun === true,
  })

  const result = (opts.runLlm ?? spawnLlm)(cmd, prompt, DEFAULT_LLM_TIMEOUT_MS)
  if (!result.ok) {
    const error = `consolidation command failed: ${excerpt(result.stderr || result.stdout)}`
    ctx.log('error', 'consolidate.llm-failed', { cmd, error })
    return { ran: false, gateReasons: [], error }
  }

  const parsed = parsePatch(result.stdout)
  if (parsed.patch === undefined) {
    const error = parsed.error ?? 'invalid patch'
    ctx.log('error', 'consolidate.parse-failed', { error, output: excerpt(result.stdout) })
    return { ran: false, gateReasons: [], error }
  }
  const patch = parsed.patch

  if (opts.dryRun === true) {
    ctx.log('info', 'consolidate.dry-run', {
      add: patch.add.length,
      replace: patch.replace.length,
      remove: patch.remove.length,
    })
    return { ran: true, gateReasons: [], patch }
  }

  // Re-read right before applying: the prompt copy is minutes old by now.
  const report = applyPatch({
    patch,
    files: loadMemory(ctx.lumemDir, globalLumemDir),
    sessionId: resolveSessionId(opts.sessionFile, signals),
    date: localDate(ctx.now()),
  })

  writeLocalState(ctx.localDir, {
    ...readLocalState(ctx.localDir),
    lastConsolidationAt: ctx.now().toISOString(),
  })
  updateCompactionFlags(
    ctx.localDir,
    loadMemory(ctx.lumemDir, globalLumemDir),
    ctx.config?.budgets.files,
  )

  ctx.log('info', 'consolidate.applied', {
    applied: report.applied.length,
    discarded: report.discarded.length,
    filesWritten: report.filesWritten,
  })
  return { ran: true, gateReasons: [], patch, applied: report }
}

/**
 * The descriptor whose `headless` block runs the consolidation: whatever
 * `consolidation.runtime` names, or — on `'auto'` — the harness that ended the
 * session. Throws when it cannot be loaded, which the caller reports.
 */
function resolveDescriptor(
  opts: RunConsolidationOptions,
  config: LumemConfig | undefined,
): AdapterDescriptor {
  const runtime = config?.consolidation.runtime
  const wanted = runtime !== undefined && runtime !== 'auto' ? runtime : opts.harnessId

  const { descriptors, errors } = loadDescriptors(opts.adaptersDir)
  const descriptor = descriptors.find((candidate) => candidate.id === wanted)
  if (descriptor !== undefined) return descriptor

  const detail = errors.length > 0 ? `; ${errors[0]?.message ?? ''}` : ''
  throw new Error(`no adapter descriptor for harness '${wanted}' in ${opts.adaptersDir}${detail}`)
}

/** The four durable memory files, read fresh. Missing files come back empty. */
function loadMemory(projectLumemDir: string, globalLumemDir: string): MemoryFile[] {
  return memoryLayout(projectLumemDir, globalLumemDir).map((entry) =>
    readMemoryFile(entry.path, { type: entry.type, scope: entry.scope }),
  )
}

/** The prompt text: the shipped skill, minus its harness-facing front matter. */
function readSkill(assetsDir: string): string {
  const file = path.join(assetsDir, 'skills', 'lumem-consolidate', 'SKILL.md')
  return stripFrontmatter(fs.readFileSync(file, 'utf8'))
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[^\S\r\n]*\r?\n?/

function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_RE, '').trimStart()
}

/**
 * Assemble the consolidation prompt: the skill (which documents both input
 * blocks), then the journal, then the current memory, then — only when a file
 * is over its soft limit — the compaction instruction naming those files.
 */
function buildPrompt(input: {
  skill: string
  signals: Signal[]
  files: MemoryFile[]
  compactionFlags: MemoryType[]
}): string {
  const sections = [input.skill.trimEnd(), renderJournal(input.signals), renderMemory(input.files)]
  const compaction = renderCompaction(input.files, input.compactionFlags)
  if (compaction !== undefined) sections.push(compaction)
  return `${sections.join('\n\n')}\n`
}

function renderJournal(signals: Signal[]): string {
  const lines = signals.map((signal) => JSON.stringify(signal))
  const body = lines.length > 0 ? lines.join('\n') : '(the journal is empty)'
  return `## Session journal\n\n\`\`\`jsonl\n${body}\n\`\`\``
}

/**
 * One fact per line, exactly as the skill documents it:
 * `<id>  [date]  (type/scope)  conf:<conf>  <body>`. Multi-line bodies are
 * flattened — the block is line-oriented and the model reads it that way.
 */
function renderMemory(files: MemoryFile[]): string {
  const lines = files.flatMap((file) =>
    file.facts.map(
      (fact) =>
        `${fact.id}  [${fact.date}]  (${fact.type}/${fact.scope})  conf:${fact.conf}  ${flatten(
          fact.body,
        )}`,
    ),
  )
  const body = lines.length > 0 ? lines.join('\n') : '(no facts recorded yet)'
  return `## Current memory\n\n\`\`\`text\n${body}\n\`\`\``
}

function renderCompaction(files: MemoryFile[], flags: MemoryType[]): string | undefined {
  if (flags.length === 0) return undefined
  const flagged = files.filter((file) => flags.includes(file.type))
  return [
    '## Compaction',
    '',
    `compact: ${flags.join(', ')}`,
    '',
    'These files are over their soft limit. Apply the compaction rules above to them:',
    '',
    ...flagged.map((file) => `- ${file.type} (${file.scope}): ${file.path}`),
  ].join('\n')
}

/** The headless invocation, with the model appended only when both halves exist. */
function buildCommand(descriptor: AdapterDescriptor, config: LumemConfig | undefined): string[] {
  const { command, modelFlag, defaultModel } = descriptor.headless
  const model = config?.consolidation.model ?? defaultModel
  if (modelFlag === undefined || model === undefined) return [...command]
  return [...command, modelFlag, model]
}

/**
 * Provenance for every fact this run writes: the id the journal reports, or the
 * journal's own file name when no session boundary was captured.
 */
function resolveSessionId(sessionFile: string, signals: Signal[]): string {
  for (const signal of signals) {
    if (signal.t === 'session' && signal.sessionId.length > 0) return signal.sessionId
  }
  return path.basename(sessionFile).replace(/\.jsonl$/, '')
}

/**
 * Run the headless CLI, feeding the prompt on stdin and capturing stdout and
 * stderr into a temp FILE rather than a pipe.
 *
 * The file is not an optimization: with a pipe, `spawnSync` stays blocked while
 * any grandchild still holds the inherited stdout fd — an update check, a
 * daemon the CLI forks — even after the timeout kills the child. Same fix as
 * `probeVersion` in core/harness/detect.ts. stdin stays a pipe because that is
 * how `input` is delivered.
 */
function spawnLlm(
  cmd: string[],
  prompt: string,
  timeoutMs: number,
): { ok: boolean; stdout: string; stderr: string } {
  const [bin, ...args] = cmd
  if (bin === undefined) return { ok: false, stdout: '', stderr: 'empty headless command' }

  let tmpDir: string | undefined
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-consolidate-'))
    const outPath = path.join(tmpDir, 'out')
    const fd = fs.openSync(outPath, 'w')

    let failure: string | undefined
    try {
      const result = spawnSync(bin, args, {
        input: prompt,
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        stdio: ['pipe', fd, fd],
      })
      if (result.error !== undefined) failure = describeError(result.error)
      else if (result.status !== 0) {
        failure = result.signal !== null ? `killed by ${result.signal}` : `exit ${result.status}`
      }
    } finally {
      fs.closeSync(fd)
    }

    const output = fs.readFileSync(outPath, 'utf8')
    if (failure !== undefined) {
      return {
        ok: false,
        stdout: output,
        stderr: `${failure}${output === '' ? '' : `: ${output}`}`,
      }
    }
    return { ok: true, stdout: output, stderr: '' }
  } catch (err) {
    return { ok: false, stdout: '', stderr: describeError(err) }
  } finally {
    if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** Local-time YYYY-MM-DD, matching the date format facts carry on disk. */
function localDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function flatten(body: string): string {
  return body.split('\n').join(' ')
}

function excerpt(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= OUTPUT_EXCERPT ? trimmed : `${trimmed.slice(0, OUTPUT_EXCERPT)}…`
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
