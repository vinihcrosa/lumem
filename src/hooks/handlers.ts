// Event handlers for the lumem hook (PRD §5.3).
//
// HARD CONSTRAINT, inherited from main.ts: this module is bundled into
// `dist/lumem-hook.mjs` and runs on every session event, so it may import ONLY
// `node:` builtins and dependency-free core modules. That is why the config is
// read here with a plain `JSON.parse` instead of `core/config` — the latter
// links zod, which must never reach this bundle.
//
// Every handler fails open: a missing field, a wrong type or an unwritable disk
// resolves to "do nothing, quietly". `runHook` still catches whatever escapes,
// but escaping is meant to be the exception, not the mechanism.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { correctionSignal, redact } from '../core/capture/heuristics'
import { type Signal, appendSignal, sessionFileName } from '../core/capture/journal'
import { detectRecovery } from '../core/capture/recovery'
import { buildInjection } from '../core/memory/budget'
import {
  type MemoryFile,
  type MemoryScope,
  type MemoryType,
  memoryLayout,
  readMemoryFile,
} from '../core/memory/store'
import { type HookHandlers, type HookInput, resolveProjectDir } from './runtime'

/** Ambient state the handlers depend on, injected so tests never touch the real env or clock. */
export interface HandlerDeps {
  env: NodeJS.ProcessEnv
  now: () => Date
}

/** PRD §5.4: one injected block never exceeds 4 KB unless the config says otherwise. */
const DEFAULT_INJECTION_BYTES = 4096

const CONFIG_FILE_NAME = 'lumem.config.json'

/** Tools that touch a file even when the path does not arrive as `file_path`. */
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

/** Response containers a harness may use to report a command's exit status. */
const RESPONSE_KEYS = ['tool_response', 'tool_result']

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
 * `budgets.injectionBytes` from `<lumemDir>/lumem.config.json`, read with a
 * plain `JSON.parse`: the validated reader lives in `core/config`, which pulls
 * zod. A missing, unreadable, malformed or implausible value falls back to the
 * PRD default rather than failing the injection.
 */
function injectionBudget(lumemDir: string): number {
  try {
    const file = path.join(lumemDir, CONFIG_FILE_NAME)
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    const value = num(rec(rec(parsed).budgets).injectionBytes)
    if (value !== undefined && value > 0) return value
  } catch {
    // no config yet, unreadable, or not JSON: the default is the contract
  }
  return DEFAULT_INJECTION_BYTES
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

/** Exit status across the shapes harnesses actually send; absent means "it worked". */
function exitCodeOf(payload: Record<string, unknown>): number {
  for (const key of RESPONSE_KEYS) {
    const response = rec(payload[key])
    const value = num(response.exit_code) ?? num(response.exitCode)
    if (value !== undefined) return value
  }
  return 0
}

/** PostToolUse: derive file and command signals from the tool call. */
function captureTool(input: HookInput, deps: HandlerDeps): void {
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
  const exit = exitCodeOf(input.payload)

  if (exit === 0) {
    // `detectRecovery` scans backwards and stops at the first entry for the same
    // work, so it MUST run before this command's own signal is appended.
    const recovery = detectRecovery(ctx.sessionFile, cmd, ctx.ts)
    if (recovery !== null) appendSignal(ctx.sessionsDir, ctx.sessionId, recovery)
  }

  appendSignal(ctx.sessionsDir, ctx.sessionId, { t: 'cmd', ts: ctx.ts, cmd, exit })
}

/** SessionEnd: close the journal for this session. */
function end(input: HookInput, deps: HandlerDeps): void {
  const ctx = resolveContext(input, deps)
  if (ctx === undefined) return

  appendSignal(ctx.sessionsDir, ctx.sessionId, sessionSignal(ctx, input.harnessId, 'end'))
  // T40: spawn the detached consolidation runner here (the gate and the lock
  // decide whether it actually runs); the hook must never wait for it.
}

/** Build the handler table over injectable ambient state. */
export function createHandlers(deps?: Partial<HandlerDeps>): HookHandlers {
  const resolved: HandlerDeps = {
    env: deps?.env ?? process.env,
    now: deps?.now ?? (() => new Date()),
  }

  return {
    inject: (input) => inject(input, resolved),
    'capture-prompt': (input) => capturePrompt(input, resolved),
    'capture-tool': (input) => captureTool(input, resolved),
    end: (input) => end(input, resolved),
  }
}

/** The table main.ts registers, bound to the real process env and clock. */
export const handlers: HookHandlers = createHandlers()
