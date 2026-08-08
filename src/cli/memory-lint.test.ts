import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { factId } from '../core/memory/store'
import type { CliContext } from './context'
import { registerMemoryLintCommand, renderMemoryLint, runMemoryLint } from './memory-lint'

const realAdaptersDir = fileURLToPath(new URL('../adapters', import.meta.url))

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-memory-lint-'))
}

/** Joins on-disk lines into a file body with the trailing newline the format requires. */
function lines(...parts: string[]): string {
  return `${parts.join('\n')}\n`
}

/** Writes a memory file inside <base>/.lumem/memory/<name> using the exact PRD format. */
function writeMemory(base: string, name: string, content: string): string {
  const file = path.join(base, '.lumem', 'memory', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

// NEVER the real home: HOME is always injected into the context.
function makeCtx(projectDir: string, home: string): CliContext {
  return { projectDir, adaptersDir: realAdaptersDir, env: { HOME: home }, json: false }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** A YYYY-MM-DD date `n` days before now, so age assertions never depend on the clock. */
function daysAgo(n: number): string {
  const date = new Date(Date.now() - n * 86_400_000)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

const TODAY = daysAgo(0)

const DUP_A = 'the CLI uses commander for argument parsing'
const DUP_B = 'the CLI uses commander to parse arguments'

/** project.md with one near-duplicate pair; global memory stays empty. */
function withDuplicates(): { ctx: CliContext; projectDir: string; file: string } {
  const projectDir = tmpDir()
  const file = writeMemory(
    projectDir,
    'project.md',
    lines(
      `- [${TODAY}] ${DUP_A}`,
      '  <!-- src:sess_a1 conf:high -->',
      `- [${TODAY}] ${DUP_B}`,
      '  <!-- src:sess_a2 conf:high -->',
    ),
  )
  return { ctx: makeCtx(projectDir, tmpDir()), projectDir, file }
}

describe('runMemoryLint', () => {
  it('reports nothing and exits 0 when there is no memory at all', () => {
    const { report, exitCode } = runMemoryLint(makeCtx(tmpDir(), tmpDir()))

    expect(exitCode).toBe(0)
    expect(report.findings).toEqual([])
    expect(report.factsChecked).toBe(0)
    expect(report.filesChecked).toBe(0)
  })

  it('reports nothing and exits 0 for clean memory, counting facts and files', () => {
    const projectDir = tmpDir()
    const home = tmpDir()
    writeMemory(
      projectDir,
      'project.md',
      lines(`- [${TODAY}] deploy runs on GitHub Actions`, '  <!-- src:sess_a1 conf:high -->'),
    )
    writeMemory(
      home,
      'preference.md',
      lines(`- [${TODAY}] prefers short answers`, '  <!-- src:manual conf:medium -->'),
    )

    const { report, exitCode } = runMemoryLint(makeCtx(projectDir, home))
    expect(exitCode).toBe(0)
    expect(report.findings).toEqual([])
    expect(report.factsChecked).toBe(2)
    expect(report.filesChecked).toBe(2)
  })

  it('exits 3 when there are findings', () => {
    const { ctx, file } = withDuplicates()
    const { report, exitCode } = runMemoryLint(ctx)

    expect(exitCode).toBe(3)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.kind).toBe('near-duplicate')
    expect(report.findings[0]?.file).toBe(file)
    expect(report.findings[0]?.factIds.slice().sort()).toEqual(
      [factId(DUP_A), factId(DUP_B)].sort(),
    )
    expect(report.factsChecked).toBe(2)
    expect(report.filesChecked).toBe(1)
  })

  it('honours staleDays', () => {
    const projectDir = tmpDir()
    writeMemory(
      projectDir,
      'project.md',
      lines(`- [${daysAgo(10)}] deploy runs on GitHub Actions`, '  <!-- src:sess_a1 conf:high -->'),
    )
    const ctx = makeCtx(projectDir, tmpDir())

    expect(runMemoryLint(ctx).report.findings).toEqual([])
    const tightened = runMemoryLint(ctx, { staleDays: 5 })
    expect(tightened.exitCode).toBe(3)
    expect(tightened.report.findings.map((f) => f.kind)).toEqual(['stale'])
  })

  it('checks dead references against the project directory', () => {
    const projectDir = tmpDir()
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'src', 'kept.ts'), 'export {}\n')
    writeMemory(
      projectDir,
      'project.md',
      lines(
        `- [${TODAY}] the entry point lives in src/gone.ts`,
        '  <!-- src:sess_a1 conf:high -->',
        `- [${TODAY}] tests for the store live in src/kept.ts`,
        '  <!-- src:sess_a2 conf:high -->',
      ),
    )

    const { report } = runMemoryLint(makeCtx(projectDir, tmpDir()))
    const dead = report.findings.filter((f) => f.kind === 'dead-reference')
    expect(dead).toHaveLength(1)
    expect(dead[0]?.factIds).toEqual([factId('the entry point lives in src/gone.ts')])
    expect(dead[0]?.message).toContain('src/gone.ts')
  })

  it('never writes anything to disk', () => {
    const { ctx, file } = withDuplicates()
    const before = fs.readFileSync(file, 'utf8')
    const stateDir = path.join(ctx.projectDir, '.lumem', 'local')

    runMemoryLint(ctx)

    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.existsSync(stateDir)).toBe(false)
  })

  it('produces a JSON-serializable report (round-trip)', () => {
    const { ctx } = withDuplicates()
    const { report } = runMemoryLint(ctx)
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })
})

describe('renderMemoryLint', () => {
  it('prints the clean message with the counts', () => {
    const { report } = runMemoryLint(makeCtx(tmpDir(), tmpDir()))
    expect(renderMemoryLint(report)).toBe('no findings — 0 facts across 0 files')
  })

  it('groups findings by kind, shows the fact ids and ends with a summary', () => {
    const { ctx } = withDuplicates()
    const { report } = runMemoryLint(ctx)
    const text = renderMemoryLint(report)
    const rendered = text.split('\n')

    expect(rendered[0]).toBe('near-duplicate:')
    expect(text).toContain(factId(DUP_A))
    expect(text).toContain(factId(DUP_B))
    expect(text).toContain(DUP_B)
    expect(rendered[rendered.length - 1]).toBe('1 finding (1 warn, 0 info) — 2 facts across 1 file')
  })

  it('emits one header per kind', () => {
    const projectDir = tmpDir()
    writeMemory(
      projectDir,
      'project.md',
      lines(
        `- [${daysAgo(400)}] deploy runs on GitHub Actions`,
        '  <!-- src:sess_a1 conf:low -->',
        `- [${TODAY}] the CLI uses commander for argument parsing`,
        '  <!-- src:sess_a2 conf:low -->',
      ),
    )
    const { report } = runMemoryLint(makeCtx(projectDir, tmpDir()))
    const headers = renderMemoryLint(report)
      .split('\n')
      .filter((line) => /^[a-z-]+:$/.test(line))

    expect(headers).toEqual(['low-confidence:', 'stale:'])
    expect(new Set(headers).size).toBe(headers.length)
  })
})

describe('registerMemoryLintCommand', () => {
  interface Emitted {
    json: boolean
    report: unknown
    rendered: string
  }

  function wire(ctx: CliContext): { parent: Command; emitted: Emitted[] } {
    const parent = new Command()
    parent.exitOverride()
    const memoryCmd = parent.command('memory')
    const emitted: Emitted[] = []
    registerMemoryLintCommand(
      memoryCmd,
      () => ctx,
      (json, report, rendered) => {
        emitted.push({ json, report, rendered })
      },
    )
    return { parent, emitted }
  }

  async function run(parent: Command, argv: string[]): Promise<number | string | undefined> {
    const previous = process.exitCode
    process.exitCode = undefined
    try {
      await parent.parseAsync(argv, { from: 'user' })
      return process.exitCode
    } finally {
      process.exitCode = previous
    }
  }

  it('registers lint as a subcommand of memory', () => {
    const { parent } = wire(withDuplicates().ctx)
    const memoryCmd = parent.commands.find((c) => c.name() === 'memory')
    expect(memoryCmd?.commands.map((c) => c.name())).toEqual(['lint'])
  })

  it('emits the report and the rendered text, exiting 3 on findings', async () => {
    const { ctx } = withDuplicates()
    const { parent, emitted } = wire(ctx)

    expect(await run(parent, ['memory', 'lint'])).toBe(3)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.json).toBe(false)
    expect(emitted[0]?.rendered).toContain(factId(DUP_A))
  })

  it('exits 0 when there is nothing to report', async () => {
    const { parent, emitted } = wire(makeCtx(tmpDir(), tmpDir()))

    expect(await run(parent, ['memory', 'lint'])).toBe(0)
    expect(emitted[0]?.rendered).toContain('no findings')
  })

  it('forwards --stale-days', async () => {
    const projectDir = tmpDir()
    writeMemory(
      projectDir,
      'project.md',
      lines(`- [${daysAgo(10)}] deploy runs on GitHub Actions`, '  <!-- src:sess_a1 conf:high -->'),
    )
    const { parent, emitted } = wire(makeCtx(projectDir, tmpDir()))

    expect(await run(parent, ['memory', 'lint'])).toBe(0)
    expect(await run(parent, ['memory', 'lint', '--stale-days', '5'])).toBe(3)
    expect(emitted[1]?.rendered).toContain('stale:')
  })

  it('falls back to the default threshold when --stale-days is unusable', async () => {
    const projectDir = tmpDir()
    writeMemory(
      projectDir,
      'project.md',
      lines(`- [${daysAgo(10)}] deploy runs on GitHub Actions`, '  <!-- src:sess_a1 conf:high -->'),
    )
    const { parent, emitted } = wire(makeCtx(projectDir, tmpDir()))

    expect(await run(parent, ['memory', 'lint', '--stale-days', 'abc'])).toBe(0)
    expect(emitted[0]?.rendered).toContain('no findings')
  })

  it('honours ctx.json in the emit callback', async () => {
    const { ctx } = withDuplicates()
    const { parent, emitted } = wire({ ...ctx, json: true })

    await run(parent, ['memory', 'lint'])
    expect(emitted[0]?.json).toBe(true)
  })
})
