// T47 — packaging (OPS-03, NFR-4).
//
// `npx @vinihcrosa/lumem init` has to work on a machine that has never seen this
// repo, and the only thing standing between that promise and a broken publish is
// the `files` whitelist. Two layers guard it, because either alone is weak:
//
//   1. Static: `package.json` is asserted directly — the publish metadata, and
//      that every path the install path reads at runtime is covered by `files`
//      while every source/test/spec path stays out of it. Cheap, always runs,
//      and fails the moment someone narrows `files`.
//   2. Integration: `scripts/verify-pack.sh` really packs, really installs the
//      tarball elsewhere, and really drives the installed binary end to end.
//      Only this layer catches a file that is covered by `files` but absent, or
//      a runtime path resolver that never worked outside the dev layout.
//
// Layer 2 costs a full build plus an npm install, so it is skippable:
// `SKIP_PACK_TEST=1 vitest run` keeps layer 1 and drops layer 2.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packScript = path.join(repoRoot, 'scripts', 'verify-pack.sh')

/** Generous: a build, a pack, and an npm install of the tarball. */
const PACK_TIMEOUT_MS = 600_000

interface PackageJson {
  name?: string
  version?: string
  description?: string
  keywords?: string[]
  homepage?: string
  repository?: { type?: string; url?: string }
  bugs?: { url?: string }
  author?: string
  type?: string
  license?: string
  sideEffects?: boolean
  private?: boolean
  engines?: { node?: string }
  bin?: Record<string, string>
  files?: string[]
  publishConfig?: { access?: string }
  scripts?: Record<string, string>
}

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson

/**
 * Every file the installed package reads at runtime. `dist/` is produced by the
 * build; the rest is source-controlled and must exist in the repo right now.
 */
const RUNTIME_REQUIRED = [
  'dist/cli.js',
  'dist/lumem-hook.mjs',
  'dist/lumem-runner.mjs',
  'src/adapters/claude-code.json',
  'src/adapters/codex.json',
  'assets/skills/lumem-memory/SKILL.md',
  'assets/skills/lumem-consolidate/SKILL.md',
  'assets/agents/lumem-consolidator.md',
  'assets/harness/claude-code/hooks.tmpl.json',
  'assets/harness/codex/hooks.tmpl.json',
]

/** Nothing here belongs in a consumer's node_modules. */
const MUST_NOT_PUBLISH = [
  'src/cli/index.ts',
  'src/cli/install.ts',
  'src/core/config.ts',
  'src/hooks/main.ts',
  'src/adapters/schema.ts',
  'src/adapters/schema.test.ts',
  'test/packaging.test.ts',
  'scripts/verify-pack.sh',
  '.specs/project/PROJECT.md',
  'tsup.config.ts',
]

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Nothing here builds: `test/global-setup.ts` produces the bundles once, before
// any suite starts. This only confirms they are there, so a misconfigured run
// says so plainly instead of surfacing as a tarball missing its bundles.
beforeAll(() => {
  for (const relPath of RUNTIME_REQUIRED.filter((p) => p.startsWith('dist/'))) {
    const file = path.join(repoRoot, relPath)
    expect(fs.existsSync(file), `bundle not built: ${file}`).toBe(true)
    expect(fs.statSync(file).size, `bundle is empty: ${file}`).toBeGreaterThan(0)
  }
})

/**
 * Does an npm `files` whitelist cover `relPath`? An entry matches the path
 * itself, anything beneath it when it names a directory, or the `dir/*.ext`
 * glob form — the three shapes npm's `files` array uses here.
 */
function coveredByFiles(entries: string[], relPath: string): boolean {
  return entries.some((raw) => {
    const entry = raw.replace(/^\.\//, '').replace(/\/$/, '')
    if (entry.includes('*')) {
      const pattern = entry.split('*').map(escapeRe).join('[^/]*')
      return new RegExp(`^${pattern}$`).test(relPath)
    }
    return relPath === entry || relPath.startsWith(`${entry}/`)
  })
}

// ---------------------------------------------------------------------------
// layer 1 — package.json invariants
// ---------------------------------------------------------------------------

describe('package.json publish metadata', () => {
  it('is a public, unprivate ESM package under MIT', () => {
    expect(pkg.name).toBe('@vinihcrosa/lumem')
    expect(pkg.type).toBe('module')
    expect(pkg.license).toBe('MIT')
    expect(pkg.sideEffects).toBe(false)
    // `private: true` would make every publish a silent no-op.
    expect(pkg.private).toBeUndefined()
    expect(pkg.publishConfig?.access).toBe('public')
  })

  it('carries the metadata a registry page needs', () => {
    expect(pkg.description).toBeTruthy()
    expect(Array.isArray(pkg.keywords)).toBe(true)
    expect(pkg.keywords?.length ?? 0).toBeGreaterThan(0)
    expect(pkg.author).toBeTruthy()
    expect(pkg.homepage).toMatch(/^https:\/\//)
    expect(pkg.repository?.type).toBe('git')
    expect(pkg.repository?.url).toMatch(/github\.com/)
    expect(pkg.bugs?.url).toMatch(/^https:\/\//)
  })

  it('requires node >=20, matching the build target', () => {
    expect(pkg.engines?.node).toBe('>=20')
  })

  it('exposes exactly one bin, pointing at the built CLI', () => {
    expect(pkg.bin).toEqual({ lumem: './dist/cli.js' })
  })

  it('cannot publish a stale or broken build', () => {
    // prepack rebuilds so the tarball never carries yesterday's bundles;
    // prepublishOnly runs the full gate so a red build cannot reach the registry.
    expect(pkg.scripts?.prepack).toBe('npm run build')
    expect(pkg.scripts?.prepublishOnly).toBe('npm run verify')
  })

  it('wires the packaging gate as an npm script', () => {
    expect(pkg.scripts?.['verify:pack']).toBe('sh scripts/verify-pack.sh')
    expect(fs.existsSync(packScript)).toBe(true)
    // executable by someone: `npm run verify:pack` shells it, CI may exec it directly
    expect((fs.statSync(packScript).mode & 0o111) !== 0).toBe(true)
  })
})

describe('package.json files whitelist', () => {
  const files = pkg.files ?? []

  it('is a whitelist, not an afterthought', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(RUNTIME_REQUIRED)('covers %s', (relPath) => {
    expect(coveredByFiles(files, relPath)).toBe(true)
  })

  it.each(RUNTIME_REQUIRED.filter((p) => !p.startsWith('dist/')))(
    '%s exists in the repo',
    (relPath) => {
      expect(fs.existsSync(path.join(repoRoot, relPath))).toBe(true)
    },
  )

  it.each(MUST_NOT_PUBLISH)('excludes %s', (relPath) => {
    expect(coveredByFiles(files, relPath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// layer 2 — the real thing
// ---------------------------------------------------------------------------

describe.skipIf(process.env.SKIP_PACK_TEST === '1')('verify-pack.sh', () => {
  it(
    'packs, installs the tarball and drives the installed binary end to end',
    () => {
      const result = spawnSync('sh', [packScript], {
        cwd: repoRoot,
        encoding: 'utf8',
        // Below the vitest timeout so the script's own output survives to be
        // reported, instead of vitest killing the worker with nothing to show.
        timeout: PACK_TIMEOUT_MS - 30_000,
        maxBuffer: 32 * 1024 * 1024,
      })

      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      expect(result.status, output).toBe(0)
      expect(output).toContain('RESULT: PASS')
    },
    PACK_TIMEOUT_MS,
  )
})

// `npm pack` is the only consumer of `files` that matters, so assert the
// whitelist against what npm itself resolves rather than against our matcher.
// `--ignore-scripts` skips prepack: npm 10 runs lifecycle scripts even under
// `--dry-run`, and tsup's progress lands on stdout right next to the JSON.
describe.skipIf(process.env.SKIP_PACK_TEST === '1')('npm pack --dry-run', () => {
  it('resolves to exactly the runtime files plus package.json', () => {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    })

    // The report's shape depends on the npm version: <= 11 emits an array of
    // entries, 12 emits an object keyed by package name. The release workflow
    // installs npm@latest (Trusted Publishing needs a recent one), so this test
    // meets both.
    const report: unknown = JSON.parse(raw)
    const entries = (
      Array.isArray(report) ? report : Object.values(report as Record<string, unknown>)
    ) as { files?: { path: string }[] }[]
    const entry = entries[0]
    expect(entry, raw).toBeDefined()
    const packed = (entry?.files ?? []).map((f) => f.path)

    for (const relPath of RUNTIME_REQUIRED) {
      // dist/ is only present when the repo has been built; the integration
      // test above is the one that proves a fresh build lands in the tarball.
      if (relPath.startsWith('dist/') && !fs.existsSync(path.join(repoRoot, relPath))) continue
      expect(packed, `missing from the tarball: ${relPath}`).toContain(relPath)
    }

    expect(packed).toContain('package.json')

    const forbidden = packed.filter(
      (p) =>
        p.endsWith('.test.ts') ||
        p.startsWith('src/cli/') ||
        p.startsWith('src/core/') ||
        p.startsWith('src/hooks/') ||
        p.startsWith('src/runner/') ||
        p.startsWith('test/') ||
        p.startsWith('scripts/') ||
        p.startsWith('.specs/') ||
        p.includes('node_modules'),
    )
    expect(forbidden, `these must never be published: ${forbidden.join(', ')}`).toEqual([])
  })
})
