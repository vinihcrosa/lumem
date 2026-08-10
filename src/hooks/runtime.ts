// Testable core of the lumem hook entrypoint.
//
// HARD CONSTRAINT (PRD principle 1, NFR-1/NFR-2/NFR-6): this module is bundled
// into `dist/lumem-hook.mjs` and runs on every session event of the user's
// agent. It must carry ZERO external dependencies (no zod, no commander — not
// even a node builtin is needed here) and must never let an error escape: a
// hook that breaks the session is worse than no memory at all.

/** Events lumem understands, mapped from harness-native events by the hook config. */
export type LumemEvent =
  | 'inject'
  | 'capture-prompt'
  | 'capture-tool'
  | 'capture-tool-failure'
  | 'end'

const LUMEM_EVENTS: readonly LumemEvent[] = [
  'inject',
  'capture-prompt',
  'capture-tool',
  'capture-tool-failure',
  'end',
]

/**
 * Per-event wall-clock budget (NFR-2). `inject` may read memory and render a
 * context block; capture events only append to the session journal.
 */
export const EVENT_DEADLINES_MS: Record<LumemEvent, number> = {
  inject: 2000,
  'capture-prompt': 100,
  'capture-tool': 100,
  'capture-tool-failure': 100,
  end: 100,
}

/** One decoded hook invocation: argv dispatch plus the stdin payload. */
export interface HookInput {
  harnessId: string
  event: LumemEvent
  payload: Record<string, unknown>
}

/** An event handler. Only `inject` returns text (it becomes injected context). */
// biome-ignore lint/suspicious/noConfusingVoidType: capture handlers return nothing; `undefined` would reject `async () => {}`
export type HookHandler = (input: HookInput) => Promise<string | void> | string | void

/** Handler table; an event with no entry resolves to '' harmlessly. */
export type HookHandlers = Partial<Record<LumemEvent, HookHandler>>

export interface RunHookOptions {
  /** Overrides `EVENT_DEADLINES_MS[event]` (tests use a short one). */
  deadlineMs?: number
  /** Failure sink. Called for any throw, rejection or timeout; never rethrows. */
  onError?: (err: unknown) => void
}

/** Error passed to `onError` when a handler outlives its deadline. */
export class HookTimeoutError extends Error {
  readonly event: LumemEvent
  readonly deadlineMs: number

  constructor(event: LumemEvent, deadlineMs: number) {
    super(`lumem hook '${event}' exceeded its ${deadlineMs}ms deadline`)
    this.name = 'HookTimeoutError'
    this.event = event
    this.deadlineMs = deadlineMs
  }
}

function isLumemEvent(value: string): value is LumemEvent {
  return (LUMEM_EVENTS as readonly string[]).includes(value)
}

/**
 * Parse the invocation contract `node lumem-hook.mjs <harnessId> <event>`.
 * Returns null for a missing argument or an event lumem does not know — the
 * caller then does nothing and still exits 0.
 */
export function parseArgs(argv: string[]): { harnessId: string; event: LumemEvent } | null {
  const [harnessId, event] = argv
  if (!harnessId || !event) return null
  if (!isLumemEvent(event)) return null
  return { harnessId, event }
}

/**
 * Hand-rolled, tolerant stdin decoding: the payload is a shallow object, so no
 * schema library is warranted (and none may be linked into this bundle).
 * Invalid JSON, empty input, or JSON that is not a plain object all yield `{}`.
 * Never throws.
 */
export function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Project root for this invocation: `CLAUDE_PROJECT_DIR` when the harness sets
 * it, else the payload's `cwd`, else undefined (nothing to read or log into).
 */
export function resolveProjectDir(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const fromEnv = env.CLAUDE_PROJECT_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const fromPayload = payload.cwd
  if (typeof fromPayload === 'string' && fromPayload.length > 0) return fromPayload
  return undefined
}

/**
 * Run the handler registered for `input.event`, racing it against its deadline.
 *
 * Returns the handler's text output (only `inject` produces any) or ''. Any
 * throw, rejection or timeout is reported through `opts.onError` and collapses
 * to ''. This function NEVER rejects — that is the whole point of the hook.
 */
export async function runHook(
  input: HookInput,
  handlers: HookHandlers,
  opts?: RunHookOptions,
): Promise<string> {
  try {
    const handler = handlers[input.event]
    if (!handler) return ''

    const deadlineMs = opts?.deadlineMs ?? EVENT_DEADLINES_MS[input.event]
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new HookTimeoutError(input.event, deadlineMs)), deadlineMs)
      timer.unref?.()
    })

    try {
      const out = await Promise.race([Promise.resolve(handler(input)), deadline])
      return typeof out === 'string' ? out : ''
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (err) {
    try {
      opts?.onError?.(err)
    } catch {
      // the failure sink itself failed: still fail open
    }
    return ''
  }
}
