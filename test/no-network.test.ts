// T45 — zero-network audit (NFR-3).
//
// lumem reads and writes the user's project and nothing else: no telemetry, no
// model calls, no update checks. Two layers prove it, because either alone is
// weak — static analysis misses a dynamic import, and a runtime probe misses a
// path the fixture never took.
//
//   1. Static: every file under `src/` is scanned for network surface at all.
//      Zero hits, reported with file:line when there are any.
//   2. Runtime: the real `dist/cli.js` runs every runtime command with DNS,
//      sockets and fetch made impossible by a preloaded blocker. Every command
//      must reach its expected exit code without ever tripping the blocker.
//
// `install` and `sync` are excluded on purpose: NFR-3 explicitly allows them to
// touch the network (they fetch adapters and skills), so they are not asserted.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const srcDir = path.join(repoRoot, 'src')
const cliPath = path.join(repoRoot, 'dist', 'cli.js')

const CLI_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// layer 1 — static scan
// ---------------------------------------------------------------------------

interface Hit {
  file: string
  line: number
  surface: string
  text: string
}

/**
 * Every way a Node program can open a socket, plus the two browser APIs and the
 * HTTP client library that would appear if one were ever vendored in.
 */
const NETWORK_SURFACES: { name: string; re: RegExp }[] = [
  { name: 'node: network builtin', re: /\bnode:(https|http2|http|dgram|net|tls|dns)\b/ },
  {
    name: 'bare network builtin import',
    re: /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](https|http2|http|dgram|net|tls|dns)['"]/,
  },
  { name: 'fetch()', re: /(?<![\w$.])fetch\s*\(/ },
  { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket', re: /\bWebSocket\b/ },
  { name: 'undici', re: /\bundici\b/ },
]

function scanText(text: string, file: string): Hit[] {
  const hits: Hit[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    for (const surface of NETWORK_SURFACES) {
      if (surface.re.test(line)) {
        hits.push({ file, line: i + 1, surface: surface.name, text: line.trim().slice(0, 120) })
      }
    }
  }
  return hits
}

/** Every file under `src/` except the test files, which may name what they forbid. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      sourceFiles(full, out)
      continue
    }
    if (entry.isFile() && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('static: src/ has no network surface at all', () => {
  const files = sourceFiles(srcDir)

  it('scans a meaningful number of files', () => {
    // guards against a silent walk failure turning this suite green for free
    expect(files.length).toBeGreaterThan(30)
    expect(files.some((file) => file.endsWith(path.join('hooks', 'main.ts')))).toBe(true)
    expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false)
  })

  it('detects every surface it claims to detect', () => {
    const sample = [
      "import http from 'node:http'",
      "import { Socket } from 'net'",
      "const res = await fetch('https://example.com')",
      'const xhr = new XMLHttpRequest()',
      "const ws = new WebSocket('wss://example.com')",
      "import { request } from 'undici'",
    ].join('\n')
    const found = new Set(scanText(sample, 'sample').map((hit) => hit.surface))
    expect([...found].sort()).toEqual([...NETWORK_SURFACES.map((surface) => surface.name)].sort())
  })

  it('does not fire on innocent lookalikes', () => {
    const innocent = [
      "import { prefetch } from './cache'",
      'const url = "https://example.com/docs" // a comment, not a call',
      'function refetchLater(): void {}',
    ].join('\n')
    expect(scanText(innocent, 'innocent')).toEqual([])
  })

  it('finds zero network references in src/', () => {
    const hits = files.flatMap((file) =>
      scanText(fs.readFileSync(file, 'utf8'), path.relative(repoRoot, file)),
    )
    expect(hits.map((hit) => `${hit.file}:${hit.line} [${hit.surface}] ${hit.text}`)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// layer 2 — runtime, with the network made impossible
// ---------------------------------------------------------------------------

/** Any appearance of this string in a command's output means lumem reached out. */
const SENTINEL = 'NETWORK_ACCESS_ATTEMPTED'

/**
 * A CJS preload (`node --require`) that replaces every outbound primitive with
 * a throw. Portable: no sandbox, no firewall rules, no root — it works the same
 * on a laptop and in CI, and it is inherited by child processes through
 * NODE_OPTIONS. Written as source rather than imported so this suite stays a
 * single self-contained file.
 */
const BLOCKER_SOURCE = `'use strict'
const SENTINEL = ${JSON.stringify(SENTINEL)}

function boom(what) {
  return function () {
    throw new Error(SENTINEL + ': ' + what)
  }
}

const net = require('node:net')
net.Socket.prototype.connect = boom('net.Socket.connect')
net.connect = boom('net.connect')
net.createConnection = boom('net.createConnection')

const dns = require('node:dns')
const DNS_FNS = [
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCname',
  'resolveMx',
  'resolveNs',
  'resolveSrv',
  'resolveTxt',
]
for (const fn of DNS_FNS) {
  if (typeof dns[fn] === 'function') dns[fn] = boom('dns.' + fn)
  if (dns.promises && typeof dns.promises[fn] === 'function') {
    dns.promises[fn] = boom('dns.promises.' + fn)
  }
}

const tls = require('node:tls')
tls.connect = boom('tls.connect')

for (const name of ['node:http', 'node:https']) {
  const mod = require(name)
  mod.request = boom(name + '.request')
  mod.get = boom(name + '.get')
}

globalThis.fetch = boom('fetch')
globalThis.XMLHttpRequest = boom('XMLHttpRequest')
globalThis.WebSocket = boom('WebSocket')
`

/** A stand-in `claude` binary, so `doctor` walks its real detect + probe path. */
const FAKE_HARNESS = '#!/bin/sh\necho "2.9.9 (Claude Code)"\n'

let sandbox = ''
let blockerPath = ''
let projectDir = ''
let homeDir = ''
let binDir = ''

beforeAll(() => {
  // Nothing here builds: `test/global-setup.ts` produces the bundles once,
  // before any suite starts. This only confirms the CLI this file spawns is
  // there, so a misconfigured run says so plainly instead of surfacing as a
  // puzzling module-not-found from every spawn below.
  expect(fs.existsSync(cliPath), `bundle not built: ${cliPath}`).toBe(true)
  expect(fs.statSync(cliPath).size, `bundle is empty: ${cliPath}`).toBeGreaterThan(0)

  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-offline-'))
  blockerPath = path.join(sandbox, 'block-network.cjs')
  fs.writeFileSync(blockerPath, BLOCKER_SOURCE)

  projectDir = path.join(sandbox, 'project')
  homeDir = path.join(sandbox, 'home')
  binDir = path.join(sandbox, 'bin')
  fs.mkdirSync(projectDir)
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
  fs.mkdirSync(binDir)
  fs.writeFileSync(path.join(binDir, 'claude'), FAKE_HARNESS, { mode: 0o755 })
})

afterAll(() => {
  if (sandbox !== '') fs.rmSync(sandbox, { recursive: true, force: true })
})

interface CliRun {
  status: number | null
  stdout: string
  stderr: string
}

function runCli(args: string[]): CliRun {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: {
      ...process.env,
      HOME: homeDir,
      // only the stand-in harness is reachable: detection stays hermetic
      PATH: binDir,
      NODE_OPTIONS: `--require ${blockerPath}`,
    },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function expectOffline(run: CliRun, what: string, exitCode: number): void {
  expect(`${run.stdout}\n${run.stderr}`, `${what}: tripped the network blocker`).not.toContain(
    SENTINEL,
  )
  expect(run.status, `${what}: unexpected exit code (stderr: ${run.stderr})`).toBe(exitCode)
}

describe('runtime: the blocker is armed', () => {
  it('carries a NODE_OPTIONS-safe path', () => {
    // NODE_OPTIONS splits on whitespace: a path with a space would silently
    // disarm every assertion below.
    expect(blockerPath).not.toMatch(/\s/)
  })

  it('turns fetch into a hard failure', () => {
    const probe = spawnSync(process.execPath, ['-e', "fetch('https://example.com')"], {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      env: { ...process.env, NODE_OPTIONS: `--require ${blockerPath}` },
    })
    expect(probe.stderr).toContain(SENTINEL)
    expect(probe.status).not.toBe(0)
  })

  it('turns DNS resolution into a hard failure', () => {
    const probe = spawnSync(
      process.execPath,
      ['-e', "require('node:dns').lookup('example.com', () => {})"],
      {
        encoding: 'utf8',
        timeout: CLI_TIMEOUT_MS,
        env: { ...process.env, NODE_OPTIONS: `--require ${blockerPath}` },
      },
    )
    expect(probe.stderr).toContain(SENTINEL)
    expect(probe.status).not.toBe(0)
  })

  it('turns a raw socket connect into a hard failure', () => {
    const probe = spawnSync(
      process.execPath,
      ['-e', "new (require('node:net').Socket)().connect(80, '127.0.0.1')"],
      {
        encoding: 'utf8',
        timeout: CLI_TIMEOUT_MS,
        env: { ...process.env, NODE_OPTIONS: `--require ${blockerPath}` },
      },
    )
    expect(probe.stderr).toContain(SENTINEL)
    expect(probe.status).not.toBe(0)
  })
})

// Declaration order is execution order inside a file: `init` must create
// `.lumem` before the commands that read it, and `add` before the second read.
describe('runtime: every command works with the network unplugged', () => {
  it('init exits 0 and creates .lumem', () => {
    const run = runCli(['init'])
    expectOffline(run, 'lumem init', 0)
    expect(fs.existsSync(path.join(projectDir, '.lumem', 'lumem.config.json'))).toBe(true)
  })

  it('doctor exits 0 and reports the detected harness', () => {
    const run = runCli(['doctor'])
    expectOffline(run, 'lumem doctor', 0)
    // not vacuous: detection really ran, including the version subprocess probe
    expect(run.stdout).toContain('claude-code')
    expect(run.stdout).toContain('2.9.9')
  })

  it('doctor --json exits 0', () => {
    const run = runCli(['doctor', '--json'])
    expectOffline(run, 'lumem doctor --json', 0)
    expect(() => JSON.parse(run.stdout)).not.toThrow()
  })

  it('status exits 0', () => {
    const run = runCli(['status'])
    expectOffline(run, 'lumem status', 0)
    expect(run.stdout.trim().length).toBeGreaterThan(0)
  })

  it('memory list exits 0 on an empty store', () => {
    expectOffline(runCli(['memory', 'list']), 'lumem memory list', 0)
  })

  it('memory context exits 0 on an empty store', () => {
    const run = runCli(['memory', 'context'])
    expectOffline(run, 'lumem memory context', 0)
    expect(run.stdout).toBe('')
  })

  it('memory add exits 0 and writes the fact', () => {
    const run = runCli(['memory', 'add', 'usa vitest para os testes', '--type', 'project'])
    expectOffline(run, 'lumem memory add', 0)
    const file = path.join(projectDir, '.lumem', 'memory', 'project.md')
    expect(fs.readFileSync(file, 'utf8')).toContain('usa vitest para os testes')
  })

  it('memory list exits 0 and shows the fact', () => {
    const run = runCli(['memory', 'list'])
    expectOffline(run, 'lumem memory list (after add)', 0)
    expect(run.stdout).toContain('usa vitest para os testes')
  })

  it('memory context exits 0 and renders the injection block', () => {
    const run = runCli(['memory', 'context'])
    expectOffline(run, 'lumem memory context (after add)', 0)
    expect(run.stdout).toContain('usa vitest para os testes')
  })

  it('memory show exits 1 for an unknown id, still offline', () => {
    // a FAILING command must not reach the network either
    expectOffline(runCli(['memory', 'show', 'deadbeef']), 'lumem memory show <unknown>', 1)
  })

  it('init is idempotent on a second run', () => {
    // asserted through --json: the rendered text is user-facing prose and may
    // be reworded or translated without breaking this contract
    const run = runCli(['init', '--json'])
    expectOffline(run, 'lumem init (re-run)', 0)
    const report = JSON.parse(run.stdout) as { created: string[]; skipped: string[] }
    expect(report.created).toEqual([])
    expect(report.skipped.length).toBeGreaterThan(0)
  })
})
