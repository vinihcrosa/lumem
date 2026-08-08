import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { builtinModules } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const hooksDir = fileURLToPath(new URL('.', import.meta.url))
const bundlePath = path.join(repoRoot, 'dist', 'lumem-hook.mjs')

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-hook-'))
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function runHookBin(args: string[], stdin: string, env?: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(process.execPath, [bundlePath, ...args], {
    input: stdin,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, ...env },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Every module specifier reachable from `entry` through relative imports. */
function collectSpecifiers(entry: string, seen = new Set<string>(), out: string[] = []): string[] {
  if (seen.has(entry)) return out
  seen.add(entry)
  const source = fs.readFileSync(entry, 'utf8')
  for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    const spec = match[1] as string
    out.push(spec)
    if (spec.startsWith('.')) {
      collectSpecifiers(path.resolve(path.dirname(entry), `${spec}.ts`), seen, out)
    }
  }
  return out
}

const NODE_BUILTINS = new Set(builtinModules)

/**
 * A specifier is acceptable only if it names a node builtin. tsup strips the
 * `node:` prefix on the way out (`removeNodeProtocol` defaults to true), so
 * both `node:fs` and the bare `fs` count — anything else is an external dep.
 */
function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith('node:')) return true
  return NODE_BUILTINS.has(spec)
}

/** Every module specifier the bundle still imports at runtime. */
function bundleSpecifiers(code: string): string[] {
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  const specs: string[] = []
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specs.push(match[1] as string)
  }
  return specs
}

// `test/global-setup.ts` builds the bundles once, before any suite starts. This
// only confirms the one this file spawns is there, so a misconfigured run says
// so plainly instead of surfacing as a puzzling module-not-found from a spawn.
beforeAll(() => {
  expect(fs.existsSync(bundlePath), `bundle not built: ${bundlePath}`).toBe(true)
  expect(fs.statSync(bundlePath).size, `bundle is empty: ${bundlePath}`).toBeGreaterThan(0)
})

describe('lumem-hook bundle', () => {
  it('is produced by the build', () => {
    expect(fs.existsSync(bundlePath)).toBe(true)
  })

  it('carries zero external dependencies — every import specifier is a node builtin', () => {
    const code = fs.readFileSync(bundlePath, 'utf8')
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/from\s*['"]zod['"]/)
    expect(code).not.toMatch(/from\s*['"]commander['"]/)

    const specs = bundleSpecifiers(code)
    const external = specs.filter((s) => !isNodeBuiltin(s))
    expect(external).toEqual([])
    // not vacuous: the bundle does import builtins, and a real dep would fail
    expect(specs.length).toBeGreaterThan(0)
    expect(isNodeBuiltin('zod')).toBe(false)
    expect(isNodeBuiltin('commander')).toBe(false)
  })

  it('keeps the hook source module graph free of non-builtin imports', () => {
    const specs = collectSpecifiers(path.join(hooksDir, 'main.ts'))
    const external = specs.filter((s) => !s.startsWith('node:') && !s.startsWith('.'))
    expect(external).toEqual([])
    expect(specs.length).toBeGreaterThan(0)
  })
})

describe('lumem-hook chaos: always exit 0', () => {
  it('exits 0 on a normal payload', () => {
    const dir = tmpDir()
    const result = runHookBin(
      ['claude-code', 'inject'],
      JSON.stringify({ cwd: dir, session_id: 's1' }),
    )
    expect(result.status).toBe(0)
  })

  it('exits 0 on malformed JSON on stdin', () => {
    const dir = tmpDir()
    const result = runHookBin(['claude-code', 'capture-prompt'], '{not json at all', {
      CLAUDE_PROJECT_DIR: dir,
    })
    expect(result.status).toBe(0)
  })

  it('exits 0 on empty stdin', () => {
    const result = runHookBin(['codex', 'capture-tool'], '')
    expect(result.status).toBe(0)
  })

  it('exits 0 on a non-object payload', () => {
    const result = runHookBin(['codex', 'end'], '[1,2,3]')
    expect(result.status).toBe(0)
  })

  it('exits 0 on an unknown event name', () => {
    const result = runHookBin(['claude-code', 'SessionStart'], '{"cwd":"/tmp"}')
    expect(result.status).toBe(0)
  })

  it('exits 0 with no args at all', () => {
    const result = runHookBin([], '')
    expect(result.status).toBe(0)
  })

  it('exits 0 when the project dir is unwritable', () => {
    const dir = tmpDir()
    const blocker = path.join(dir, 'blocked')
    fs.writeFileSync(blocker, 'i am a file, not a directory')
    const result = runHookBin(['claude-code', 'nope'], '', { CLAUDE_PROJECT_DIR: blocker })
    expect(result.status).toBe(0)
  })

  it('writes nothing to stdout when no handler is registered', () => {
    const dir = tmpDir()
    const result = runHookBin(['claude-code', 'inject'], JSON.stringify({ cwd: dir }))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('logs failures into <projectDir>/.lumem/local/lumem.log', () => {
    const dir = tmpDir()
    const result = runHookBin(['claude-code', 'not-an-event'], '', { CLAUDE_PROJECT_DIR: dir })
    expect(result.status).toBe(0)

    const logFile = path.join(dir, '.lumem', 'local', 'lumem.log')
    expect(fs.existsSync(logFile)).toBe(true)
    const lines = fs
      .readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines.length).toBeGreaterThan(0)
    const entry = JSON.parse(lines[0] as string)
    expect(typeof entry.ts).toBe('string')
    expect(typeof entry.event).toBe('string')
  })
})
