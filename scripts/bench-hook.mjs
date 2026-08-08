#!/usr/bin/env node
// Hook latency bench (NFR-2: p95 < 150 ms for capture hooks).
//
// A slow hook makes the agent feel broken, and the cost is paid on every
// prompt and every tool call — so this runs the REAL bundle as a real process,
// cold each time, the way a harness invokes it.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNS = Number(process.env.BENCH_RUNS ?? 100)
const BUDGET_MS = Number(process.env.BENCH_BUDGET_MS ?? 150)
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bundle = path.join(repoRoot, 'dist', 'lumem-hook.mjs')

if (!fs.existsSync(bundle)) {
  console.error(`missing ${bundle} — run \`npm run build\` first`)
  process.exit(1)
}

// A realistic project: memory to inject, a journal with history to scan.
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-bench-'))
const lumemDir = path.join(projectDir, '.lumem')
const sessionsDir = path.join(lumemDir, 'local', 'sessions')
fs.mkdirSync(path.join(lumemDir, 'memory'), { recursive: true })
fs.mkdirSync(sessionsDir, { recursive: true })

const facts = Array.from(
  { length: 40 },
  (_, i) =>
    `- [2026-08-07] Fact number ${i}: a decision recorded with the reason it was made, long enough to be realistic.\n  <!-- src:sess_bench conf:medium -->`,
).join('\n')
fs.writeFileSync(path.join(lumemDir, 'memory', 'project.md'), `${facts}\n`)
fs.writeFileSync(path.join(lumemDir, 'lumem.config.json'), JSON.stringify({ version: 1 }))

const sessionId = 'bench'
const journal = path.join(sessionsDir, `${sessionId}.jsonl`)
fs.writeFileSync(
  journal,
  Array.from(
    { length: 500 },
    (_, i) =>
      JSON.stringify({ t: 'file', ts: '2026-08-07T14:00:00Z', path: `src/f${i}.ts`, tool: 'Edit' }),
  ).join('\n') + '\n',
)

const payloads = {
  'capture-prompt': {
    session_id: sessionId,
    cwd: projectDir,
    prompt: 'na verdade, não faz assim — sempre roda o lint antes de commitar',
  },
  'capture-tool': {
    session_id: sessionId,
    cwd: projectDir,
    tool_name: 'Bash',
    tool_input: { command: 'npm run test:e2e' },
    tool_response: { exit_code: 0 },
  },
  inject: { session_id: sessionId, cwd: projectDir },
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx]
}

function bench(event, payload) {
  const input = JSON.stringify(payload)
  const samples = []
  for (let i = 0; i < RUNS; i += 1) {
    const started = process.hrtime.bigint()
    execFileSync(process.execPath, [bundle, 'claude-code', event], {
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  samples.sort((a, b) => a - b)
  return {
    event,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: samples[samples.length - 1],
  }
}

const results = Object.entries(payloads).map(([event, payload]) => bench(event, payload))
fs.rmSync(projectDir, { recursive: true, force: true })

const fmt = (n) => `${n.toFixed(1)} ms`
console.log(`hook latency over ${RUNS} cold runs (budget p95 < ${BUDGET_MS} ms)\n`)
for (const r of results) {
  console.log(`  ${r.event.padEnd(15)} p50 ${fmt(r.p50).padStart(9)}   p95 ${fmt(r.p95).padStart(9)}   max ${fmt(r.max).padStart(9)}`)
}

// Only capture hooks carry the 150 ms budget: they fire on every prompt and
// tool call. `inject` fires once per session and has its own 2 s deadline.
const overBudget = results.filter((r) => r.event.startsWith('capture-') && r.p95 >= BUDGET_MS)
if (overBudget.length > 0) {
  console.error(`\nFAIL: ${overBudget.map((r) => `${r.event} p95 ${fmt(r.p95)}`).join(', ')}`)
  process.exit(1)
}
console.log('\nOK')
