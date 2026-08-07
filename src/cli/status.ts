import { existsSync } from 'node:fs'
import path from 'node:path'
import { readLock } from '../core/install/lockfile'
import type { CliContext } from './context'

export interface StatusReport {
  installed: { artifactId: string; destPath: string; mode: string; installedAt: string }[]
  lockfileFound: boolean
}

export function runStatus(ctx: CliContext): { report: StatusReport; exitCode: number } {
  const lumemDir = path.join(ctx.projectDir, '.lumem')
  const lockfileFound = existsSync(path.join(lumemDir, 'lumem-lock.json'))
  const lock = readLock(lumemDir)

  const installed = lock.entries.map((entry) => ({
    artifactId: entry.artifactId,
    destPath: entry.destPath,
    mode: entry.mode,
    installedAt: entry.installedAt,
  }))

  return { report: { installed, lockfileFound }, exitCode: 0 }
}

export function renderStatus(report: StatusReport): string {
  if (report.installed.length === 0) {
    return 'nada instalado — rode `lumem install`'
  }
  return report.installed
    .map((entry) => `${entry.artifactId} → ${entry.destPath} (${entry.mode}, ${entry.installedAt})`)
    .join('\n')
}
