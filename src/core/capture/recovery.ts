import { type Signal, tailSignals } from './journal'

/**
 * Default lookback window. Matches the journal tail default: 64 KiB is a few
 * hundred signals, far more than a single session's recovery lookback needs,
 * and cheap enough to stay inside the hook latency budget (p95 < 150 ms).
 */
const DEFAULT_MAX_BYTES = 65536

const WHITESPACE_RUN = /\s+/g

/** trim + collapse every whitespace run to a single space. */
function normalize(cmd: string): string {
  return cmd.trim().replace(WHITESPACE_RUN, ' ')
}

/**
 * Whether two command lines plausibly do "the same work".
 *
 * Deliberately narrow — a false positive writes a wrong pitfall into memory,
 * which is far more expensive than a missed capture:
 * - normalized strings equal, or
 * - both are a single token and that token is equal (`tsc` ~ ` tsc `), or
 * - both first tokens *and* both second tokens are equal — program plus
 *   subcommand (`npm test -- --watch` ~ `npm test`).
 *
 * Everything else is a miss: `npm test` !~ `npm run build`, `git commit` !~
 * `git push`, and a bare program never matches itself with arguments
 * (`tsc -p a` !~ `tsc`), since a lone program name says nothing about the work.
 */
export function similarCommand(a: string, b: string): boolean {
  const normA = normalize(a)
  const normB = normalize(b)
  if (normA.length === 0 || normB.length === 0) return false
  if (normA === normB) return true

  const tokensA = normA.split(' ')
  const tokensB = normB.split(' ')
  if (tokensA[0] !== tokensB[0]) return false
  if (tokensA.length <= 1 && tokensB.length <= 1) return true
  return tokensA[1] !== undefined && tokensA[1] === tokensB[1]
}

/**
 * Detect that `passedCmd` — a command that just SUCCEEDED — recovers from an
 * earlier failure of the same work in this session. That pair (failed then
 * passed) is the strongest pitfall signal the capture layer has.
 *
 * Reads only the last `opts.maxBytes` (default 64 KiB) of the journal, never
 * the whole file, then scans backwards and **stops at the first entry for the
 * same work**:
 * - `exit !== 0` → a recovery signal `{ t, ts, failed, passed }`
 * - `exit === 0` → `null`; that failure was already recovered from and reported,
 *   so a later success must not emit a duplicate.
 *
 * Call this *before* appending the passing command's own `cmd` signal, or the
 * backwards scan stops on it and always yields `null`.
 *
 * Never throws: a missing, unreadable or corrupted journal yields `null`.
 */
export function detectRecovery(
  sessionFile: string,
  passedCmd: string,
  ts: string,
  opts?: { maxBytes?: number },
): Signal | null {
  if (normalize(passedCmd).length === 0) return null

  const signals = tailSignals(sessionFile, opts?.maxBytes ?? DEFAULT_MAX_BYTES)
  for (let i = signals.length - 1; i >= 0; i--) {
    const signal = signals[i]
    if (signal === undefined || signal.t !== 'cmd') continue
    // Journal lines are only shape-checked on `t`, so a truncated or hand-edited
    // entry can carry the wrong types. Skip it rather than throw.
    if (typeof signal.cmd !== 'string' || typeof signal.exit !== 'number') continue
    if (!similarCommand(signal.cmd, passedCmd)) continue
    if (signal.exit === 0) return null
    return { t: 'recovery', ts, failed: signal.cmd, passed: passedCmd }
  }
  return null
}
