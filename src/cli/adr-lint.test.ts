import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { afterEach, describe, expect, it } from 'vitest'
import { serializeAdr } from '../core/adr/format'
import { registerAdrLintCommand, renderAdrLint, runAdrLint } from './adr-lint'
import { registerAdrCommands } from './adr-new'
import type { CliContext } from './context'

const realAdaptersDir = fileURLToPath(new URL('../adapters', import.meta.url))

const A = '2026-01-01-a.md'
const B = '2026-02-02-b.md'
const C = '2026-03-03-c.md'
const GHOST = '2026-09-09-ghost.md'

interface Fixture {
  ctx: CliContext
  projectDir: string
  home: string
  /** `<projectDir>/docs/adr` — not created by the fixture. */
  adrDir: string
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-adrlint-'))
  const projectDir = path.join(root, 'proj')
  const home = path.join(root, 'home')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  return {
    // NEVER the real home: HOME is always injected into the context.
    ctx: { projectDir, adaptersDir: realAdaptersDir, env: { HOME: home }, json: false },
    projectDir,
    home,
    adrDir: path.join(projectDir, 'docs', 'adr'),
  }
}

interface AdrFields {
  summary?: string
  supersedes?: string
  date?: string
}

/** Write `<projectDir>/docs/adr/<id>` through the real serializer. */
function writeAdr(fx: Fixture, id: string, fields: AdrFields = {}): void {
  fs.mkdirSync(fx.adrDir, { recursive: true })
  fs.writeFileSync(
    path.join(fx.adrDir, id),
    serializeAdr({
      title: id,
      date: fields.date ?? id.slice(0, 10),
      area: 'auth',
      summary: fields.summary ?? 'Because it had to be decided.',
      supersedes: fields.supersedes,
      body: '## Context\nWhy.\n',
    }),
  )
}

/** Two clean ADRs, the second superseding the first. */
function clean(): Fixture {
  const fx = fixture()
  writeAdr(fx, A)
  writeAdr(fx, B, { supersedes: A })
  return fx
}

/** One gate (a dangling link) and one informational finding (a TODO summary). */
function mixed(): Fixture {
  const fx = fixture()
  writeAdr(fx, A, { summary: 'TODO: one sentence on what this decides' })
  writeAdr(fx, B, { supersedes: GHOST })
  return fx
}

const originalExitCode = process.exitCode

afterEach(() => {
  process.exitCode = originalExitCode
})

describe('runAdrLint', () => {
  it('exits 0 with nothing to report when the project has no docs/adr at all', () => {
    const fx = fixture()

    const { report, exitCode } = runAdrLint(fx.ctx)

    expect(exitCode).toBe(0)
    expect(report.findings).toEqual([])
    expect(report.adrsChecked).toBe(0)
    expect(fs.existsSync(path.join(fx.projectDir, 'docs'))).toBe(false)
  })

  it('exits 0 for a clean set, counting the ADRs it checked', () => {
    const { report, exitCode } = runAdrLint(clean().ctx)

    expect(exitCode).toBe(0)
    expect(report.findings).toEqual([])
    expect(report.adrsChecked).toBe(2)
  })

  it('exits 3 on a gate, naming the ADR and its dangling target', () => {
    const fx = fixture()
    writeAdr(fx, A)
    writeAdr(fx, B, { supersedes: GHOST })

    const { report, exitCode } = runAdrLint(fx.ctx)

    expect(exitCode).toBe(3)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.kind).toBe('broken-supersedes')
    expect(report.findings[0]?.severity).toBe('gate')
    expect(report.findings[0]?.ids).toEqual([B])
    expect(report.findings[0]?.message).toContain(GHOST)
    expect(report.adrsChecked).toBe(2)
  })

  it('exits 3 on an informational finding alone', () => {
    const fx = fixture()
    writeAdr(fx, A, { summary: 'TODO: one sentence on what this decides' })

    const { report, exitCode } = runAdrLint(fx.ctx)

    expect(exitCode).toBe(3)
    expect(report.findings.map((finding) => finding.severity)).toEqual(['info'])
  })

  it('exits 3 and terminates on a supersedence cycle', () => {
    const fx = fixture()
    writeAdr(fx, A, { supersedes: B })
    writeAdr(fx, B, { supersedes: A })

    const { report, exitCode } = runAdrLint(fx.ctx)

    expect(exitCode).toBe(3)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.kind).toBe('supersedes-cycle')
    expect(report.findings[0]?.ids).toEqual([A, B])
  })

  it('never writes anything to disk', () => {
    const fx = mixed()
    const before = fs.readdirSync(fx.adrDir).sort()
    const contents = before.map((name) => fs.readFileSync(path.join(fx.adrDir, name), 'utf8'))

    runAdrLint(fx.ctx)

    expect(fs.readdirSync(fx.adrDir).sort()).toEqual(before)
    expect(before.map((name) => fs.readFileSync(path.join(fx.adrDir, name), 'utf8'))).toEqual(
      contents,
    )
    expect(fs.existsSync(path.join(fx.projectDir, '.lumem'))).toBe(false)
  })

  it('produces a JSON-serializable report (round-trip)', () => {
    const { report } = runAdrLint(mixed().ctx)

    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })
})

describe('renderAdrLint', () => {
  it('prints the clean message with the count', () => {
    expect(renderAdrLint(runAdrLint(clean().ctx).report)).toBe('no findings — 2 ADRs checked')
  })

  it('says nothing was checked when there are no ADRs', () => {
    expect(renderAdrLint(runAdrLint(fixture().ctx).report)).toBe('no findings — 0 ADRs checked')
  })

  it('marks a gate distinctly from an informational line', () => {
    const text = renderAdrLint(runAdrLint(mixed().ctx).report)
    const lines = text.split('\n')

    const gateHeader = lines.findIndex((line) => line === 'gate broken-supersedes:')
    const infoHeader = lines.findIndex((line) => line === 'info todo-summary:')
    expect(gateHeader).toBe(0)
    expect(infoHeader).toBeGreaterThan(gateHeader)
    expect(lines[gateHeader + 1]).toContain(B)
    expect(lines[gateHeader + 1]).toContain(GHOST)
    expect(lines[infoHeader + 1]).toContain(A)
    expect(lines[lines.length - 1]).toBe('2 findings (1 gate, 1 info) — 2 ADRs checked')
  })

  it('emits one header per kind', () => {
    const fx = fixture()
    writeAdr(fx, A, { summary: 'TODO: write me' })
    writeAdr(fx, B, { summary: 'TODO: write me too' })
    writeAdr(fx, C, { supersedes: GHOST })

    const headers = renderAdrLint(runAdrLint(fx.ctx).report)
      .split('\n')
      .filter((line) => /^(gate|info) [a-z-]+:$/.test(line))

    expect(headers).toEqual(['gate broken-supersedes:', 'info todo-summary:'])
  })
})

interface EmitCall {
  json: boolean
  report: unknown
  rendered: string
}

function harness(fx: Fixture): { program: Command; calls: EmitCall[] } {
  const calls: EmitCall[] = []
  const program = new Command('lumem')
  program.exitOverride()
  registerAdrLintCommand(
    program,
    () => fx.ctx,
    (json, report, rendered) => {
      calls.push({ json, report, rendered })
    },
  )
  return { program, calls }
}

function adrCommands(program: Command): string[] {
  const adr = program.commands.filter((cmd) => cmd.name() === 'adr')
  expect(adr).toHaveLength(1)
  return (adr[0]?.commands ?? []).map((cmd) => cmd.name()).sort()
}

async function run(program: Command, argv: string[]): Promise<number | string | undefined> {
  process.exitCode = undefined
  await program.parseAsync(argv, { from: 'user' })
  return process.exitCode
}

describe('registerAdrLintCommand', () => {
  it('registers lint under an adr parent', () => {
    const { program } = harness(fixture())

    expect(adrCommands(program)).toEqual(['lint'])
  })

  it('shares one adr parent with adr new, registered in either order', () => {
    for (const lintFirst of [true, false]) {
      const fx = fixture()
      const program = new Command('lumem')
      const register = [
        () =>
          registerAdrLintCommand(
            program,
            () => fx.ctx,
            () => undefined,
          ),
        () =>
          registerAdrCommands(
            program,
            () => fx.ctx,
            () => undefined,
          ),
      ]
      for (const step of lintFirst ? register : register.slice().reverse()) step()

      expect(adrCommands(program)).toEqual(['lint', 'new'])
    }
  })

  it('drives adr lint end to end, emitting the report and exiting 3 on findings', async () => {
    const { program, calls } = harness(mixed())

    expect(await run(program, ['adr', 'lint'])).toBe(3)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.json).toBe(false)
    expect(calls[0]?.rendered).toContain('gate broken-supersedes:')
    expect((calls[0]?.report as { adrsChecked: number }).adrsChecked).toBe(2)
  })

  it('exits 0 when there is nothing to report', async () => {
    const { program, calls } = harness(clean())

    expect(await run(program, ['adr', 'lint'])).toBe(0)
    expect(calls[0]?.rendered).toContain('no findings')
  })

  it('forwards ctx.json to emit', async () => {
    const fx = mixed()
    fx.ctx.json = true
    const { program, calls } = harness(fx)

    await run(program, ['adr', 'lint'])

    expect(calls[0]?.json).toBe(true)
  })
})
