import type { Signal } from '../capture/journal'
import { readSignals } from '../capture/journal'
import { readLocalState } from '../memory/limits'
import { isLocked } from './lock'

/** Thresholds a session must clear before consolidation is worth an LLM call. */
export interface GateConfig {
  minSignals: number
  minDurationMin: number
  minHoursBetween: number
  lockTtlMin: number
}

/** PRD §6: ≥5 signals, ≥3 min of session, ≥6 h since the last run; 30 min lock TTL. */
export const DEFAULT_GATE_CONFIG: GateConfig = {
  minSignals: 5,
  minDurationMin: 3,
  minHoursBetween: 6,
  lockTtlMin: 30,
}

/**
 * Verdict of the gate plus the measurements behind it, so callers (CLI `status`,
 * the SessionEnd hook) can explain a refusal without re-reading anything.
 */
export interface GateResult {
  /** True only when every condition holds; `reasons` is then empty. */
  pass: boolean
  /** One entry per failed condition, always ordered signals, duration, hours, lock. */
  reasons: string[]
  signals: number
  durationMin: number
  /** Null when this project was never consolidated — which satisfies the condition. */
  hoursSinceLast: number | null
}

const MS_PER_MIN = 60_000
const MS_PER_HOUR = 3_600_000

/**
 * Decide whether the session behind `sessionFile` earns a consolidation run.
 *
 * All four conditions must hold: enough signals, a long enough session, enough
 * time since the last run, and no live lock. `force` waives the first three —
 * it is the `--force` flag of `lumem memory consolidate` — but never the lock,
 * since a second concurrent runner would race the same memory files.
 *
 * Cheap by construction (it sits on the SessionEnd hook path) and total: every
 * dependency reads defensively, so no input makes this throw.
 */
export function checkGate(opts: {
  sessionFile: string
  localDir: string
  config?: Partial<GateConfig>
  now?: Date
  force?: boolean
}): GateResult {
  const config = resolveConfig(opts.config)
  const now = opts.now ?? new Date()

  // One pass over the journal feeds both metrics. `signals` is by definition
  // `countSignals(sessionFile, { excludeSession: true })`, and the duration
  // needs the very same records — calling both helpers would parse the file
  // twice for no gain.
  const { signals: records } = readSignals(opts.sessionFile)
  const signals = records.reduce((count, signal) => (signal.t === 'session' ? count : count + 1), 0)
  const durationMin = measureDuration(records)
  const hoursSinceLast = measureHoursSince(readLocalState(opts.localDir).lastConsolidationAt, now)

  const reasons: string[] = []
  if (opts.force !== true) {
    if (signals < config.minSignals) {
      reasons.push(`signals: ${signals} captured, need ${config.minSignals}`)
    }
    if (durationMin < config.minDurationMin) {
      reasons.push(`duration: ${durationMin} min, need ${config.minDurationMin}`)
    }
    if (hoursSinceLast !== null && hoursSinceLast < config.minHoursBetween) {
      reasons.push(`hours-since-last: ${hoursSinceLast} h, need ${config.minHoursBetween}`)
    }
  }
  if (isLocked(opts.localDir, config.lockTtlMin)) {
    reasons.push('lock: another consolidation is already running')
  }

  return { pass: reasons.length === 0, reasons, signals, durationMin, hoursSinceLast }
}

/**
 * Overlay the defined numeric overrides on {@link DEFAULT_GATE_CONFIG}. An
 * explicitly `undefined` (or non-finite) override keeps the default rather than
 * poisoning the comparison with `NaN`.
 */
function resolveConfig(overrides?: Partial<GateConfig>): GateConfig {
  const config: GateConfig = { ...DEFAULT_GATE_CONFIG }
  if (overrides === undefined) return config
  for (const key of Object.keys(DEFAULT_GATE_CONFIG) as (keyof GateConfig)[]) {
    const value = overrides[key]
    if (typeof value === 'number' && Number.isFinite(value)) config[key] = value
  }
  return config
}

/**
 * Minutes between the first and the last usable timestamp in the journal.
 *
 * Entries without a parseable `ts` are skipped — `readSignals` only validates
 * the `t` field, so a truncated line can reach us shaped wrong. Fewer than two
 * usable timestamps, or a journal written out of order, yields 0.
 */
function measureDuration(signals: Signal[]): number {
  let first: number | undefined
  let last: number | undefined
  for (const signal of signals) {
    const parsed = parseTimestamp((signal as { ts?: unknown }).ts)
    if (parsed === undefined) continue
    if (first === undefined) first = parsed
    last = parsed
  }
  if (first === undefined || last === undefined) return 0
  return round1(Math.max(0, (last - first) / MS_PER_MIN))
}

/**
 * Hours from `lastConsolidationAt` to `now`, or null when the project has never
 * been consolidated — an absent or unreadable timestamp is not evidence of a
 * recent run, so the condition passes. A negative result (clock skew put the
 * last run in the future) is reported as-is and fails the threshold.
 */
function measureHoursSince(lastConsolidationAt: string | undefined, now: Date): number | null {
  const last = parseTimestamp(lastConsolidationAt)
  if (last === undefined) return null
  const nowMs = now.getTime()
  if (Number.isNaN(nowMs)) return null
  return round1((nowMs - last) / MS_PER_HOUR)
}

/** Epoch milliseconds for an ISO string, or undefined when it is not one. */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** One decimal place, so the number we report is the number we compared. */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}
