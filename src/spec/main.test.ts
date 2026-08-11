import fs from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const specDir = fileURLToPath(new URL('.', import.meta.url))
const bundlePath = path.join(repoRoot, 'dist', 'lumem-spec.mjs')

const NODE_BUILTINS = new Set(builtinModules)

/**
 * tsup strips the `node:` prefix on the way out, so both `node:fs` and a bare
 * `fs` count as a builtin. Anything else is an external dependency.
 */
function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith('node:')) return true
  return NODE_BUILTINS.has(spec)
}

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

/** Every specifier reachable from `entry` through relative imports. */
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

beforeAll(() => {
  expect(fs.existsSync(bundlePath), `bundle not built: ${bundlePath}`).toBe(true)
  expect(fs.statSync(bundlePath).size, `bundle is empty: ${bundlePath}`).toBeGreaterThan(0)
})

describe('lumem-spec bundle', () => {
  it('UT-55 is produced by the build', () => {
    expect(fs.existsSync(bundlePath)).toBe(true)
  })

  it('UT-55 carries zero external dependencies — every import specifier is a node builtin', () => {
    const code = fs.readFileSync(bundlePath, 'utf8')
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/from\s*['"]zod['"]/)
    expect(code).not.toMatch(/from\s*['"]commander['"]/)

    const specs = bundleSpecifiers(code)
    expect(specs.filter((spec) => !isNodeBuiltin(spec))).toEqual([])
    // Not vacuous: the bundle does import builtins, and a real dependency would fail.
    expect(specs.length).toBeGreaterThan(0)
    expect(isNodeBuiltin('commander')).toBe(false)
  })

  it('UT-55 keeps the spec source module graph free of non-builtin imports', () => {
    const specs = collectSpecifiers(path.join(specDir, 'main.ts'))
    const external = specs.filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.'))
    expect(external).toEqual([])
    expect(specs.length).toBeGreaterThan(0)
  })
})
