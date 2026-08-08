import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bundles = ['cli.js', 'lumem-hook.mjs', 'lumem-runner.mjs']

/**
 * Build the bundles ONCE, before any suite starts.
 *
 * Several suites spawn `dist/*` as real processes. When each of them built on
 * its own, vitest's parallel workers raced: one worker's build deleted or
 * rewrote `dist/` while another was mid-spawn, and the victim failed with
 * Node's loader reporting a missing module — a failure that looked like a
 * product bug and reproduced roughly once per few hundred spawns.
 *
 * Building here, in globalSetup, removes the race by construction: no suite
 * ever builds, so nothing can pull `dist/` out from under a running process.
 */
export default function setup(): void {
  if (process.env.LUMEM_SKIP_TEST_BUILD === '1') return

  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    stdio: 'ignore',
    timeout: 180_000,
  })

  for (const name of bundles) {
    const file = path.join(repoRoot, 'dist', name)
    const size = fs.statSync(file).size
    if (size === 0) throw new Error(`global setup: ${file} built empty`)
  }
}
