import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AdapterDescriptor } from '../../adapters/schema'
import { expandHome } from '../shared/fsx'

export interface DetectionResult {
  detected: boolean
  matchedRules: number
  version?: string
  binPath?: string
}

const SEMVER_TOKEN = /\d+\.\d+\.\d+[-\w.]*/

/**
 * Expand a leading `~` against the injected home when provided (for
 * testability), falling back to `expandHome` (os.homedir()) otherwise.
 */
function resolveHome(p: string, home?: string): string {
  if (home === undefined) return expandHome(p)
  if (p === '~') return home
  if (p.startsWith('~/')) return path.join(home, p.slice(2))
  return p
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Search each PATH entry for an executable regular file named `name` (POSIX only). */
function findBin(name: string, pathEnv: string | undefined): string | undefined {
  if (!name || !pathEnv) return undefined
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // not executable or unreadable: keep searching
    }
  }
  return undefined
}

/**
 * Run `binPath versionArgs` synchronously and extract the first
 * semver-looking token from stdout or stderr. Any failure (spawn error,
 * timeout, nonzero exit, no match) yields undefined.
 */
function probeVersion(binPath: string, versionArgs: string[]): string | undefined {
  // Capture output via a temp FILE, not a pipe: with a pipe, spawnSync stays
  // blocked while any grandchild keeps the inherited stdout fd open (e.g.
  // `codex --version` spawning an update check), even after the timeout kills
  // the child. A file fd has no reader to block on.
  let tmpDir: string | undefined
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-probe-'))
    const outPath = path.join(tmpDir, 'out')
    const fd = fs.openSync(outPath, 'w')
    let failed: boolean
    try {
      const result = spawnSync(binPath, versionArgs, {
        timeout: 3000,
        killSignal: 'SIGKILL',
        stdio: ['ignore', fd, fd],
      })
      failed = result.error !== undefined || result.status !== 0
    } finally {
      fs.closeSync(fd)
    }
    if (failed) return undefined
    const match = fs.readFileSync(outPath, 'utf8').match(SEMVER_TOKEN)
    return match?.[0]
  } catch {
    return undefined
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Evaluate a descriptor's detect rules against the filesystem. Rules are
 * alternatives: one match is enough for `detected`. Never throws.
 */
export function detect(
  descriptor: AdapterDescriptor,
  env?: { PATH?: string; HOME?: string },
): DetectionResult {
  const result: DetectionResult = { detected: false, matchedRules: 0 }
  try {
    const pathEnv = env?.PATH ?? process.env.PATH
    for (const rule of descriptor.detect) {
      try {
        if (rule.type === 'dir') {
          if (isDirectory(resolveHome(rule.path, env?.HOME))) result.matchedRules += 1
        } else if (rule.type === 'file') {
          if (isFile(resolveHome(rule.path, env?.HOME))) result.matchedRules += 1
        } else {
          const binPath = findBin(rule.name, pathEnv)
          if (binPath) {
            result.matchedRules += 1
            result.binPath ??= binPath
            if (rule.versionArgs?.length && result.version === undefined) {
              result.version = probeVersion(binPath, rule.versionArgs)
            }
          }
        }
      } catch {
        // a broken rule never fails detection as a whole
      }
    }
    result.detected = result.matchedRules > 0
  } catch {
    // detect() never throws
  }
  return result
}
