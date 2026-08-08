import fs from 'node:fs'
import path from 'node:path'
import type { AdapterDescriptor } from '../adapters/schema'
import { detect } from '../core/harness/detect'
import { loadDescriptors } from '../core/harness/load'
import { resolveMode } from '../core/harness/mode'
import { type Lockfile, readLock } from '../core/install/lockfile'
import type { CliContext } from './context'
import { reportedDrift } from './sync'

export interface DoctorHarnessReport {
  id: string
  detected: boolean
  version?: string
  minVersion: string
  grade: string
  missing: string[]
  fallbacks: Record<string, string>
  warnings: string[]
}

/** One lockfile entry whose destination no longer matches what lumem installed. */
export interface DoctorDriftReport {
  artifactId: string
  destPath: string
  state: string
}

/** A harness whose installed hooks stay inert until the user trusts them. */
export interface DoctorTrustReport {
  harness: string
  hooksInstalled: boolean
  requiresTrust: boolean
}

/** The most recent error line of `.lumem/local/lumem.log`. */
export interface DoctorFailure {
  ts: string
  event: string
  message: string
}

export interface DoctorReport {
  harnesses: DoctorHarnessReport[]
  descriptorErrors: { file: string; message: string }[]
  drift: DoctorDriftReport[]
  trust: DoctorTrustReport[]
  /** Harnesses running below the minimum version their descriptor declares. */
  versionIssues: string[]
  lastFailure?: DoctorFailure
}

const LUMEM_DIR = '.lumem'
const LOG_REL_PATH = ['local', 'lumem.log']

/** Manifest id prefix of the per-harness hook configuration. */
const HOOK_CONFIG_PREFIX = 'hook-config:'

export function runDoctor(ctx: CliContext): { report: DoctorReport; exitCode: number } {
  const { descriptors, errors } = loadDescriptors(ctx.adaptersDir)

  const harnesses = descriptors.map((descriptor): DoctorHarnessReport => {
    const mode = resolveMode(descriptor, detect(descriptor, ctx.env))
    return {
      id: descriptor.id,
      detected: mode.detected,
      ...(mode.version !== undefined ? { version: mode.version } : {}),
      minVersion: descriptor.minVersion,
      grade: mode.grade,
      missing: mode.missing,
      fallbacks: mode.fallbacks,
      warnings: mode.warnings,
    }
  })

  const lumemDir = path.join(ctx.projectDir, LUMEM_DIR)
  const lock = readLock(lumemDir)

  const drift = reportedDrift(lock).map((entry) => ({
    artifactId: entry.artifactId,
    destPath: entry.destPath,
    state: entry.state,
  }))
  const trust = trustReminders(descriptors, lock)
  const versionIssues = harnesses.flatMap((harness) => {
    const issue = versionIssue(harness)
    return issue === undefined ? [] : [issue]
  })
  const lastFailure = readLastFailure(path.join(lumemDir, ...LOG_REL_PATH))

  const report: DoctorReport = {
    harnesses,
    descriptorErrors: errors,
    drift,
    trust,
    versionIssues,
    ...(lastFailure !== undefined ? { lastFailure } : {}),
  }

  // Absent harnesses, descriptor errors and past failures are diagnostics.
  // Drift and an unsupported version are the two states that make this project
  // behave differently than installed, which is what CI must catch (exit 3).
  return { report, exitCode: drift.length > 0 || versionIssues.length > 0 ? 3 : 0 }
}

/**
 * Harnesses that need a `/hooks` round-trip before anything runs: the
 * descriptor declares hooks must be trusted *and* the lockfile shows a hook
 * config was installed. Only those are listed, so the section exists exactly
 * when there is something for the user to do.
 */
function trustReminders(descriptors: AdapterDescriptor[], lock: Lockfile): DoctorTrustReport[] {
  const installed = new Set(
    lock.entries
      .filter((entry) => entry.artifactId.startsWith(HOOK_CONFIG_PREFIX))
      .map((entry) => entry.artifactId.slice(HOOK_CONFIG_PREFIX.length)),
  )

  return descriptors
    .map((descriptor) => ({
      harness: descriptor.id,
      hooksInstalled: installed.has(descriptor.id),
      requiresTrust: descriptor.capabilities['hooks.requiresTrust'],
    }))
    .filter((entry) => entry.hooksInstalled && entry.requiresTrust)
}

/**
 * The version warning the mode layer already produced, attributed to its
 * harness. `missing` carrying 'minVersion' is that layer's verdict — this only
 * surfaces it as its own section.
 */
function versionIssue(harness: DoctorHarnessReport): string | undefined {
  if (!harness.missing.includes('minVersion')) return undefined
  const warning = harness.warnings.find((entry) => entry.includes(harness.minVersion))
  return `${harness.id}: ${
    warning ??
    `detected version ${harness.version ?? 'unknown'} is below the minimum supported version ${
      harness.minVersion
    }`
  }`
}

/**
 * Last `level: 'error'` line of the JSONL log, scanning backwards — the log is
 * append-only, so the last one is the most recent. Tolerant by design: a
 * missing, truncated or half-written log is normal (it is written from
 * fail-open hook paths), so unparseable lines are skipped and nothing throws.
 */
function readLastFailure(logFile: string): DoctorFailure | undefined {
  let raw: string
  try {
    raw = fs.readFileSync(logFile, 'utf8')
  } catch {
    return undefined
  }

  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (line === undefined || line === '') continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue

    const entry = parsed as Record<string, unknown>
    if (entry.level !== 'error') continue
    return {
      ts: typeof entry.ts === 'string' ? entry.ts : '',
      event: typeof entry.event === 'string' ? entry.event : '',
      message: failureMessage(entry),
    }
  }

  return undefined
}

/** Loggers put the human-readable cause under `data.error`, some under `data.message`. */
function failureMessage(entry: Record<string, unknown>): string {
  const data = entry.data
  if (typeof data === 'object' && data !== null) {
    for (const key of ['error', 'message', 'reason']) {
      const value = (data as Record<string, unknown>)[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return typeof entry.message === 'string' ? entry.message : ''
}

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = []

  for (const harness of report.harnesses) {
    if (harness.detected) {
      const version = harness.version !== undefined ? ` ${harness.version}` : ''
      lines.push(`✔ ${harness.id}${version} (${harness.grade})`)
    } else {
      lines.push(`✖ ${harness.id} — não detectado`)
    }
    for (const capability of harness.missing) {
      lines.push(`  missing: ${capability}`)
    }
    for (const [need, via] of Object.entries(harness.fallbacks)) {
      lines.push(`  fallback: ${need} → ${via}`)
    }
    for (const warning of harness.warnings) {
      lines.push(`  aviso: ${warning}`)
    }
  }

  if (report.versionIssues.length > 0) {
    lines.push('versão abaixo do mínimo:')
    for (const issue of report.versionIssues) {
      lines.push(`  ${issue}`)
    }
  }

  if (report.drift.length > 0) {
    lines.push('drift:')
    for (const entry of report.drift) {
      lines.push(`  ${entry.state} ${entry.artifactId} → ${entry.destPath}`)
    }
    lines.push('  rode `lumem sync` para reconciliar (`--force` sobrescreve edições locais)')
  }

  if (report.trust.length > 0) {
    lines.push('trust:')
    for (const entry of report.trust) {
      lines.push(
        `  ${entry.harness}: hooks instalados — rode \`/hooks\` no harness para revisar e confiar; até lá eles não rodam`,
      )
    }
  }

  if (report.lastFailure !== undefined) {
    const { ts, event, message } = report.lastFailure
    lines.push('última falha:')
    lines.push(`  ${ts} ${event}${message !== '' ? `: ${message}` : ''}`)
  }

  if (report.descriptorErrors.length > 0) {
    lines.push('descriptor errors:')
    for (const error of report.descriptorErrors) {
      lines.push(`  ${error.file}: ${error.message}`)
    }
  }

  return lines.join('\n')
}
