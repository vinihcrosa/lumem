// Event handlers for the lumem hook (PRD §5.3).
//
// HARD CONSTRAINT, inherited from main.ts: this module is bundled into
// `dist/lumem-hook.mjs` and runs on every session event, so it may import ONLY
// `node:` builtins and dependency-free core modules. That is why the config is
// read here with a plain `JSON.parse` instead of `core/config` — the latter
// links zod, which must never reach this bundle. Same reason `end` imports
// `consolidate/gate` (whose whole import chain is zod-free) and never
// `consolidate/run`.
//
// Every handler fails open: a missing field, a wrong type or an unwritable disk
// resolves to "do nothing, quietly". `runHook` still catches whatever escapes,
// but escaping is meant to be the exception, not the mechanism.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { correctionSignal, redact } from '../core/capture/heuristics'
import { type Signal, appendSignal, sessionFileName } from '../core/capture/journal'
import { detectRecovery } from '../core/capture/recovery'
import { type GateConfig, checkGate } from '../core/consolidate/gate'
import { buildInjection } from '../core/memory/budget'
import {
  type MemoryFile,
  type MemoryScope,
  type MemoryType,
  memoryLayout,
  readMemoryFile,
} from '../core/memory/store'
import { type HookHandlers, type HookInput, resolveProjectDir } from './runtime'

/**
 * The `node:child_process` spawn surface the runner launch needs, narrowed to
 * what is actually used so a test double is a three-line function.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore' },
) => { unref: () => void }

/** Ambient state the handlers depend on, injected so tests never touch the real env or clock. */
export interface HandlerDeps {
  env: NodeJS.ProcessEnv
  now: () => Date
  /** Injected so tests observe the runner launch without starting a process. */
  spawn: SpawnFn
}

/** PRD §5.4: one injected block never exceeds 4 KB unless the config says otherwise. */
const DEFAULT_INJECTION_BYTES = 4096

const CONFIG_FILE_NAME = 'lumem.config.json'

/** Where `lumem install` puts the consolidation runner, relative to `.lumem`. */
const RUNNER_REL_PATH = ['bin', 'lumem-runner.mjs']

/** Gate thresholds a project config may override; anything else is ignored. */
const GATE_KEYS = ['minSignals', 'minDurationMin', 'minHoursBetween', 'lockTtlMin'] as const

/** Tools that touch a file even when the path does not arrive as `file_path`. */
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

/** Response containers a harness may use to report a command's exit status. */
const RESPONSE_KEYS = ['tool_response', 'tool_result']

/**
 * Exit code recorded for a FAILED tool call whose payload carries no code.
 *
 * `PostToolUseFailure` reports the failure as `error: { type, message }` — there
 * is no exit code in it, and the rest of the shape is not contractual — so lumem
 * reads no guessed field. The event's own existence is the signal: it fires only
 * after a call fails, and any non-zero code is what makes `detectRecovery` able
 * to see that failure later. Defaulting to 0 here is precisely the bug that kept
 * `recovery` from ever firing in production.
 */
const FAILED_EXIT = 1

/** Hand-rolled shape checks: no schema library may be linked into this bundle. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function rec(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/** Session id as sent by the harness: snake, then camel, then the shared journal. */
export function resolveSessionId(payload: Record<string, unknown>): string {
  return str(payload.session_id) ?? str(payload.sessionId) ?? 'unknown'
}

function hasSessionId(payload: Record<string, unknown>): boolean {
  return str(payload.session_id) !== undefined || str(payload.sessionId) !== undefined
}

/** Where this invocation may read and write. */
interface HookContext {
  projectDir: string
  lumemDir: string
  sessionsDir: string
  sessionId: string
  /** This session's journal; `detectRecovery` reads it directly. */
  sessionFile: string
  ts: string
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function nowIso(deps: HandlerDeps): string {
  try {
    return deps.now().toISOString()
  } catch {
    // an invalid injected clock must not cost the signal
    return new Date().toISOString()
  }
}

/**
 * Resolve the paths for this invocation, or `undefined` when there are none:
 * no project dir at all, or a project whose `.lumem` does not exist.
 *
 * The second case is the "hook installed globally, session opened in another
 * project" guard: the signal is DISCARDED rather than written into a directory
 * the user never opted into.
 */
function resolveContext(input: HookInput, deps: HandlerDeps): HookContext | undefined {
  const projectDir = resolveProjectDir(input.payload, deps.env)
  if (projectDir === undefined) return undefined

  const lumemDir = path.join(projectDir, '.lumem')
  if (!isDirectory(lumemDir)) return undefined

  const sessionId = resolveSessionId(input.payload)
  const sessionsDir = path.join(lumemDir, 'local', 'sessions')
  return {
    projectDir,
    lumemDir,
    sessionsDir,
    sessionId,
    sessionFile: path.join(sessionsDir, sessionFileName(sessionId)),
    ts: nowIso(deps),
  }
}

function sessionSignal(ctx: HookContext, harness: string, ev: 'start' | 'end'): Signal {
  return { t: 'session', ts: ctx.ts, ev, harness, sessionId: ctx.sessionId, cwd: ctx.projectDir }
}

/**
 * `<lumemDir>/lumem.config.json` as a plain object, read with a plain
 * `JSON.parse`: the validated reader lives in `core/config`, which pulls zod.
 * A missing, unreadable or malformed file reads as `{}`, and every caller
 * falls back to its own default from there.
 */
function readRawConfig(lumemDir: string): Record<string, unknown> {
  try {
    const file = path.join(lumemDir, CONFIG_FILE_NAME)
    return rec(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    // no config yet, unreadable, or not JSON: the defaults are the contract
    return {}
  }
}

/** `budgets.injectionBytes`, or the PRD default when it is absent or implausible. */
function injectionBudget(lumemDir: string): number {
  const value = num(rec(rec(readRawConfig(lumemDir)).budgets).injectionBytes)
  return value !== undefined && value > 0 ? value : DEFAULT_INJECTION_BYTES
}

/**
 * The project's `gate` overrides. Only finite numbers are forwarded; `checkGate`
 * fills every remaining threshold from `DEFAULT_GATE_CONFIG`. Reading them
 * matters: a project that loosened its thresholds must still get a runner.
 */
function gateOverrides(lumemDir: string): Partial<GateConfig> {
  const raw = rec(rec(readRawConfig(lumemDir)).gate)
  const overrides: Partial<GateConfig> = {}
  for (const key of GATE_KEYS) {
    const value = num(raw[key])
    if (value !== undefined) overrides[key] = value
  }
  return overrides
}

function globalLumemDir(deps: HandlerDeps): string {
  return path.join(str(deps.env.HOME) ?? os.homedir(), '.lumem')
}

/** `readMemoryFile` rethrows a non-ENOENT failure; on the hook path that is just "no facts". */
function readMemorySafe(entry: { path: string; type: MemoryType; scope: MemoryScope }): MemoryFile {
  try {
    return readMemoryFile(entry.path, { type: entry.type, scope: entry.scope })
  } catch {
    return { path: entry.path, type: entry.type, scope: entry.scope, facts: [], warnings: [] }
  }
}

/**
 * SessionStart: mark the session in the journal and RETURN the memory block —
 * main.ts owns stdout. No project, or no `.lumem`, means no memory: ''.
 */
function inject(input: HookInput, deps: HandlerDeps): string {
  const ctx = resolveContext(input, deps)
  if (ctx === undefined) return ''

  if (hasSessionId(input.payload)) {
    appendSignal(ctx.sessionsDir, ctx.sessionId, sessionSignal(ctx, input.harnessId, 'start'))
  }

  const files = memoryLayout(ctx.lumemDir, globalLumemDir(deps)).map(readMemorySafe)
  return buildInjection(files, injectionBudget(ctx.lumemDir)).text
}

/**
 * UserPromptSubmit: mark a correction in the journal and nothing else. This
 * path NEVER writes durable memory — consolidation decides what survives.
 */
function capturePrompt(input: HookInput, deps: HandlerDeps): void {
  // `prompt` is the claude-code field; other harnesses send `user_prompt`.
  const prompt = str(input.payload.prompt) ?? str(input.payload.user_prompt)
  if (prompt === undefined) return

  const ctx = resolveContext(input, deps)
  if (ctx === undefined) return

  const signal = correctionSignal(prompt, ctx.ts)
  if (signal === null) return
  appendSignal(ctx.sessionsDir, ctx.sessionId, signal)
}

/** Path a tool call touched, from `file_path` or a known tool's own field. */
function filePathOf(toolName: string, toolInput: Record<string, unknown>): string | undefined {
  const direct = str(toolInput.file_path)
  if (direct !== undefined) return direct
  if (!FILE_TOOLS.has(toolName)) return undefined
  return str(toolInput.notebook_path) ?? str(toolInput.path)
}

/**
 * Exit status across the shapes harnesses actually send, or `whenAbsent` when
 * none of them carries one. What "absent" means is the caller's call: on the
 * success path a call with no code really did exit 0, on the failure path it
 * did not (see {@link FAILED_EXIT}).
 */
function exitCodeOf(payload: Record<string, unknown>, whenAbsent: number): number {
  for (const key of RESPONSE_KEYS) {
    const response = rec(payload[key])
    const value = num(response.exit_code) ?? num(response.exitCode)
    if (value !== undefined) return value
  }
  return whenAbsent
}

/**
 * Journal the file and command signals of one tool call — the shared body of
 * `capture-tool` and `capture-tool-failure`, which see the same payload and
 * differ only in the two decisions the caller passes in:
 *
 * - `whenExitAbsent`: the exit code recorded when the payload carries none.
 * - `mayRecover`: whether a successful command here may close an earlier
 *   failure. Only a success can — a failure is never a recovery — so the
 *   failure event never asks for the lookback.
 *
 * The `file` signal is written for a failed call too, DELIBERATELY: a failed
 * Edit still says the session was working on that file, the signal carries no
 * outcome the failure would contradict, and dropping it would hide exactly the
 * files that gave the most trouble from consolidation.
 */
function captureToolCall(
  input: HookInput,
  deps: HandlerDeps,
  options: { whenExitAbsent: number; mayRecover: boolean },
): void {
  const toolName = str(input.payload.tool_name) ?? ''
  const toolInput = rec(input.payload.tool_input)
  const filePath = filePathOf(toolName, toolInput)
  const command = str(toolInput.command)
  if (filePath === undefined && command === undefined) return

  const ctx = resolveContext(input, deps)
  if (ctx === undefined) return

  if (filePath !== undefined) {
    const tool = toolName === '' ? 'unknown' : toolName
    appendSignal(ctx.sessionsDir, ctx.sessionId, { t: 'file', ts: ctx.ts, path: filePath, tool })
  }

  if (command === undefined) return
  const cmd = redact(command)
  const exit = exitCodeOf(input.payload, options.whenExitAbsent)

  if (options.mayRecover && exit === 0) {
    // `detectRecovery` scans backwards and stops at the first entry for the same
    // work, so it MUST run before this command's own signal is appended.
    const recovery = detectRecovery(ctx.sessionFile, cmd, ctx.ts)
    if (recovery !== null) appendSignal(ctx.sessionsDir, ctx.sessionId, recovery)
  }

  appendSignal(ctx.sessionsDir, ctx.sessionId, { t: 'cmd', ts: ctx.ts, cmd, exit })
}

/** PostToolUse: signals from a tool call that SUCCEEDED — no code means exit 0. */
function captureTool(input: HookInput, deps: HandlerDeps): void {
  captureToolCall(input, deps, { whenExitAbsent: 0, mayRecover: true })
}

/**
 * PostToolUseFailure: the same signals for a tool call that FAILED.
 *
 * Claude Code fires `PostToolUse` only after a call succeeds and this event
 * after one fails — they are separate and mutually exclusive, so subscribing to
 * `PostToolUse` alone means never seeing a failure, and a journal of nothing but
 * `exit=0` leaves `detectRecovery` unable to ever fire.
 */
function captureToolFailure(input: HookInput, deps: HandlerDeps): void {
  captureToolCall(input, deps, { whenExitAbsent: FAILED_EXIT, mayRecover: false })
}

/**
 * Hand this session to the detached consolidation runner — and never wait for
 * it. PRD §6: SessionEnd may not delay the user's session, so the child is
 * spawned `detached` with no stdio and immediately `unref`ed, which lets this
 * process exit while the runner keeps going.
 *
 * The gate check here is only a cheap pre-filter that avoids paying for a node
 * cold start we know would refuse: the runner re-checks it authoritatively,
 * because minutes may pass before it actually starts and another runner may
 * have won the race by then.
 */
function spawnRunner(ctx: HookContext, harnessId: string, deps: HandlerDeps): void {
  try {
    // No bundle means a skill-only install: nothing to spawn, and one statSync
    // is cheaper than re-reading the journal to find that out afterwards.
    const runnerPath = path.join(ctx.lumemDir, ...RUNNER_REL_PATH)
    if (!isFile(runnerPath)) return

    const gate = checkGate({
      sessionFile: ctx.sessionFile,
      localDir: path.join(ctx.lumemDir, 'local'),
      config: gateOverrides(ctx.lumemDir),
      now: deps.now(),
    })
    if (!gate.pass) return

    const child = deps.spawn(
      process.execPath,
      [
        runnerPath,
        '--project-dir',
        ctx.projectDir,
        '--session-file',
        ctx.sessionFile,
        '--harness',
        harnessId,
      ],
      { detached: true, stdio: 'ignore' },
    )
    child.unref()
  } catch {
    // consolidation is best-effort: a failed launch never costs the session
  }
}

/** SessionEnd: close the journal for this session, then fire the runner. */
function end(input: HookInput, deps: HandlerDeps): void {
  const ctx = resolveContext(input, deps)
  if (ctx === undefined) return

  appendSignal(ctx.sessionsDir, ctx.sessionId, sessionSignal(ctx, input.harnessId, 'end'))
  spawnRunner(ctx, input.harnessId, deps)
}

/** Build the handler table over injectable ambient state. */
export function createHandlers(deps?: Partial<HandlerDeps>): HookHandlers {
  const resolved: HandlerDeps = {
    env: deps?.env ?? process.env,
    now: deps?.now ?? (() => new Date()),
    spawn: deps?.spawn ?? spawn,
  }

  return {
    inject: (input) => inject(input, resolved),
    'capture-prompt': (input) => capturePrompt(input, resolved),
    'capture-tool': (input) => captureTool(input, resolved),
    'capture-tool-failure': (input) => captureToolFailure(input, resolved),
    end: (input) => end(input, resolved),
  }
}

/** The table main.ts registers, bound to the real process env and clock. */
export const handlers: HookHandlers = createHandlers()
