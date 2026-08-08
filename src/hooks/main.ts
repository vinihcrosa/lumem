// lumem hook entrypoint — bundled to `dist/lumem-hook.mjs`.
//
// Contract: `node lumem-hook.mjs <harnessId> <event>`; payload JSON on stdin;
// text on stdout is injected as context (only `inject` produces any).
//
// Two rules govern this file (PRD principle 1, NFR-1/NFR-2/NFR-6):
//   1. ALWAYS exit 0 — exception, timeout, malformed stdin, unwritable disk.
//   2. ZERO external dependencies — `node:` builtins and dependency-free core
//      modules only, so the bundle stays one small cold-start-friendly file.
// Real event handlers land in T32; the table below is intentionally empty and
// an unregistered event resolves to '' harmlessly.

import fs from 'node:fs'
import path from 'node:path'
import { appendLog } from '../core/shared/log'
import {
  EVENT_DEADLINES_MS,
  type HookHandlers,
  parseArgs,
  parsePayload,
  resolveProjectDir,
  runHook,
} from './runtime'

/** Nothing a harness sends is worth more than this; the rest is dropped. */
const MAX_STDIN_BYTES = 1024 * 1024

/** Bounded retries for a stdout pipe that is momentarily full. */
const MAX_WRITE_RETRIES = 1000

/** Event handlers (T32). Empty for now — every event resolves to ''. */
const handlers: HookHandlers = {}

// Last line of defence: even a failure outside the promise chain exits 0.
process.on('uncaughtException', () => process.exit(0))
process.on('unhandledRejection', () => process.exit(0))

function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return `${err.name}: ${err.message}`
    return String(err)
  } catch {
    return 'unknown error'
  }
}

/** Append a structured line to `<projectDir>/.lumem/local/lumem.log`; never throws. */
function logFailure(
  projectDir: string | undefined,
  event: string,
  data: Record<string, unknown>,
): void {
  if (!projectDir) return
  try {
    appendLog(path.join(projectDir, '.lumem', 'local', 'lumem.log'), {
      level: 'error',
      event,
      data,
    })
  } catch {
    // logging must never break the session
  }
}

/**
 * Read stdin to a string, stopping at `maxBytes` or `timeoutMs` — whichever
 * comes first. A harness that never closes stdin must not hang the session.
 */
function readStdin(maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    if (stdin.isTTY) {
      resolve('')
      return
    }

    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdin.off('data', onData)
      stdin.off('end', finish)
      stdin.off('error', finish)
      stdin.pause()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }

    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      const remaining = maxBytes - total
      if (remaining <= 0) {
        finish()
        return
      }
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf
      chunks.push(slice)
      total += slice.length
      if (total >= maxBytes) finish()
    }

    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    stdin.on('data', onData)
    stdin.on('end', finish)
    stdin.on('error', finish)
  })
}

/**
 * Write to fd 1 synchronously: `process.exit(0)` truncates pending async pipe
 * writes, which would silently swallow injected context.
 */
function writeStdoutSync(text: string): void {
  if (text.length === 0) return
  const buf = Buffer.from(text, 'utf8')
  let offset = 0
  let retries = 0
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(1, buf, offset, buf.length - offset)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if ((code === 'EAGAIN' || code === 'EINTR') && retries < MAX_WRITE_RETRIES) {
        retries += 1
        continue
      }
      return
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const parsed = parseArgs(argv)
  if (!parsed) {
    logFailure(resolveProjectDir({}, process.env), 'hook.bad-args', { argv })
    return
  }

  const deadlineMs = EVENT_DEADLINES_MS[parsed.event]
  const payload = parsePayload(await readStdin(MAX_STDIN_BYTES, deadlineMs))
  const projectDir = resolveProjectDir(payload, process.env)

  const out = await runHook(
    { harnessId: parsed.harnessId, event: parsed.event, payload },
    handlers,
    {
      deadlineMs,
      onError: (err) =>
        logFailure(projectDir, 'hook.error', {
          harnessId: parsed.harnessId,
          hookEvent: parsed.event,
          error: describeError(err),
        }),
    },
  )

  writeStdoutSync(out)
}

void main()
  .catch((err) => {
    logFailure(resolveProjectDir({}, process.env), 'hook.fatal', { error: describeError(err) })
  })
  .finally(() => {
    process.exit(0)
  })
