import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
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
  try {
    const result = spawnSync(binPath, versionArgs, { timeout: 3000, encoding: 'utf8' })
    if (result.error || result.status !== 0) return undefined
    const match = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.match(SEMVER_TOKEN)
    return match?.[0]
  } catch {
    return undefined
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
