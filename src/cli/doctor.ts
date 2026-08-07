import { detect } from '../core/harness/detect'
import { loadDescriptors } from '../core/harness/load'
import { resolveMode } from '../core/harness/mode'
import type { CliContext } from './context'

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

export interface DoctorReport {
  harnesses: DoctorHarnessReport[]
  descriptorErrors: { file: string; message: string }[]
}

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

  // Absent harnesses and descriptor errors are diagnostics, not failures (drift → exit 3 lands in T19).
  return { report: { harnesses, descriptorErrors: errors }, exitCode: 0 }
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

  if (report.descriptorErrors.length > 0) {
    lines.push('descriptor errors:')
    for (const error of report.descriptorErrors) {
      lines.push(`  ${error.file}: ${error.message}`)
    }
  }

  return lines.join('\n')
}
