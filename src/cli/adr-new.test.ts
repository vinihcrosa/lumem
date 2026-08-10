import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { afterEach, describe, expect, it } from 'vitest'
import { BODY_TEMPLATE, parseAdr } from '../core/adr/format'
import { registerAdrCommands, renderAdrNew, runAdrNew } from './adr-new'
import type { CliContext } from './context'

const realAdaptersDir = fileURLToPath(new URL('../adapters', import.meta.url))

interface Fixture {
  ctx: CliContext
  projectDir: string
  home: string
  /** `<projectDir>/docs/adr` — not created by the fixture. */
  adrDir: string
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-adrnew-'))
  const projectDir = path.join(root, 'proj')
  const home = path.join(root, 'home')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  return {
    ctx: { projectDir, adaptersDir: realAdaptersDir, env: { HOME: home }, json: false },
    projectDir,
    home,
    adrDir: path.join(projectDir, 'docs', 'adr'),
  }
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

function listAdrs(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

const originalExitCode = process.exitCode

afterEach(() => {
  process.exitCode = originalExitCode
})

describe('runAdrNew', () => {
  it('creates docs/adr/<date>-<slug>.md carrying all five frontmatter fields', () => {
    const fx = fixture()
    runAdrNew(fx.ctx, 'JWT for auth', { area: 'auth', date: '2026-03-11' })

    const { result, exitCode } = runAdrNew(fx.ctx, 'Session cookies over JWT', {
      area: 'auth',
      summary: 'Auth uses session cookies because revocation has to be immediate.',
      supersedes: '2026-03-11-jwt-for-auth.md',
      date: '2026-08-08',
    })

    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    const expected = path.join(fx.adrDir, '2026-08-08-session-cookies-over-jwt.md')
    expect(result.path).toBe(expected)
    expect(fs.existsSync(expected)).toBe(true)

    const adr = parseAdr(path.basename(expected), read(expected))
    expect(adr.warnings).toEqual([])
    expect(adr.title).toBe('Session cookies over JWT')
    expect(adr.date).toBe('2026-08-08')
    expect(adr.area).toBe('auth')
    expect(adr.summary).toBe('Auth uses session cookies because revocation has to be immediate.')
    expect(adr.supersedes).toBe('2026-03-11-jwt-for-auth.md')
  })

  it('seeds the four body headings', () => {
    const fx = fixture()

    const { result } = runAdrNew(fx.ctx, 'Body template', { area: 'docs', date: '2026-08-08' })

    const adr = parseAdr('x.md', read(result.path ?? ''))
    expect(adr.body).toBe(BODY_TEMPLATE)
  })

  it('creates docs/adr/ with its parents when absent', () => {
    const fx = fixture()
    expect(fs.existsSync(path.join(fx.projectDir, 'docs'))).toBe(false)

    const { exitCode } = runAdrNew(fx.ctx, 'First decision', { area: 'auth' })

    expect(exitCode).toBe(0)
    expect(fs.statSync(fx.adrDir).isDirectory()).toBe(true)
  })

  it('omits supersedes from the frontmatter when none was given', () => {
    const fx = fixture()

    const { result } = runAdrNew(fx.ctx, 'Stands alone', { area: 'auth', date: '2026-08-08' })

    const content = read(result.path ?? '')
    expect(content).not.toContain('supersedes:')
    expect(parseAdr('x.md', content).supersedes).toBeUndefined()
  })

  it('defaults the date to today and keeps the filename prefix equal to the frontmatter', () => {
    const fx = fixture()

    const { result, exitCode } = runAdrNew(fx.ctx, 'Dated today', { area: 'auth' })

    expect(exitCode).toBe(0)
    const id = path.basename(result.path ?? '')
    expect(id.startsWith(`${today()}-`)).toBe(true)
    expect(parseAdr(id, read(result.path ?? '')).date).toBe(today())
  })

  it('keeps the filename prefix equal to an explicit --date', () => {
    const fx = fixture()

    const { result } = runAdrNew(fx.ctx, 'Backdated', { area: 'auth', date: '2020-01-31' })

    const id = path.basename(result.path ?? '')
    expect(id).toBe('2020-01-31-backdated.md')
    expect(parseAdr(id, read(result.path ?? '')).date).toBe('2020-01-31')
  })

  it('seeds a TODO summary when --summary is absent', () => {
    const fx = fixture()

    const { result, exitCode } = runAdrNew(fx.ctx, 'No summary yet', {
      area: 'auth',
      date: '2026-08-08',
    })

    expect(exitCode).toBe(0)
    const adr = parseAdr('x.md', read(result.path ?? ''))
    expect(adr.summary).toBe('TODO: one sentence on what this decides')
    expect(adr.summary.startsWith('TODO:')).toBe(true)
  })

  it('seeds a TODO summary when --summary is present but blank', () => {
    const fx = fixture()

    const { result } = runAdrNew(fx.ctx, 'Blank summary', {
      area: 'auth',
      summary: '   ',
      date: '2026-08-08',
    })

    expect(parseAdr('x.md', read(result.path ?? '')).summary).toBe(
      'TODO: one sentence on what this decides',
    )
  })

  it('appends -2 on a collision, then -3', () => {
    const fx = fixture()
    const opts = { area: 'auth', date: '2026-08-08' }

    const first = runAdrNew(fx.ctx, 'Session cookies over JWT', opts)
    const second = runAdrNew(fx.ctx, 'Session cookies over JWT', opts)
    const third = runAdrNew(fx.ctx, 'Session cookies over JWT', opts)

    expect([first.exitCode, second.exitCode, third.exitCode]).toEqual([0, 0, 0])
    expect(path.basename(first.result.path ?? '')).toBe('2026-08-08-session-cookies-over-jwt.md')
    expect(path.basename(second.result.path ?? '')).toBe('2026-08-08-session-cookies-over-jwt-2.md')
    expect(path.basename(third.result.path ?? '')).toBe('2026-08-08-session-cookies-over-jwt-3.md')
    expect(listAdrs(fx.adrDir)).toHaveLength(3)
  })

  it('never overwrites the ADR already occupying the name', () => {
    const fx = fixture()
    const opts = { area: 'auth', date: '2026-08-08' }
    const first = runAdrNew(fx.ctx, 'Kept intact', { ...opts, summary: 'The original.' })
    const before = fs.readFileSync(first.result.path ?? '')

    runAdrNew(fx.ctx, 'Kept intact', { ...opts, summary: 'The impostor.' })

    expect(fs.readFileSync(first.result.path ?? '').equals(before)).toBe(true)
  })

  it('fails once every suffix up to -99 is taken, writing nothing', () => {
    const fx = fixture()
    const opts = { area: 'auth', date: '2026-08-08' }
    runAdrNew(fx.ctx, 'Crowded', opts)
    for (let suffix = 2; suffix <= 99; suffix += 1) {
      fs.writeFileSync(path.join(fx.adrDir, `2026-08-08-crowded-${suffix}.md`), '---\n---\n')
    }
    const before = listAdrs(fx.adrDir)

    const { result, exitCode } = runAdrNew(fx.ctx, 'Crowded', opts)

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('2026-08-08-crowded')
    expect(listAdrs(fx.adrDir)).toEqual(before)
  })

  it('rejects an unknown --supersedes target, leaving docs/adr/ unchanged', () => {
    const fx = fixture()
    runAdrNew(fx.ctx, 'The only ADR', { area: 'auth', date: '2026-08-08' })
    const before = listAdrs(fx.adrDir)

    const { result, exitCode } = runAdrNew(fx.ctx, 'Replaces a ghost', {
      area: 'auth',
      supersedes: '2026-01-01-does-not-exist.md',
      date: '2026-08-09',
    })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.path).toBeUndefined()
    expect(result.message).toContain('2026-01-01-does-not-exist.md')
    expect(listAdrs(fx.adrDir)).toEqual(before)
  })

  it('rejects an unknown --supersedes target before creating docs/adr/ at all', () => {
    const fx = fixture()

    const { exitCode } = runAdrNew(fx.ctx, 'Replaces a ghost', {
      area: 'auth',
      supersedes: 'nope.md',
    })

    expect(exitCode).toBe(1)
    expect(fs.existsSync(path.join(fx.projectDir, 'docs'))).toBe(false)
  })

  it('accepts a --supersedes naming an existing ADR', () => {
    const fx = fixture()
    const first = runAdrNew(fx.ctx, 'JWT for auth', { area: 'auth', date: '2026-03-11' })
    const target = path.basename(first.result.path ?? '')

    const { result, exitCode } = runAdrNew(fx.ctx, 'Session cookies over JWT', {
      area: 'auth',
      supersedes: target,
      date: '2026-08-08',
    })

    expect(exitCode).toBe(0)
    expect(parseAdr('x.md', read(result.path ?? '')).supersedes).toBe(target)
  })

  it('accepts a module rule --supersedes and writes it through unresolved', () => {
    const fx = fixture()

    const { result, exitCode } = runAdrNew(fx.ctx, 'Supersedes a rule', {
      area: 'backend',
      supersedes: 'backend-dotnet/no-raw-sql',
      date: '2026-08-08',
    })

    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    const content = read(result.path ?? '')
    expect(content).toContain('supersedes: backend-dotnet/no-raw-sql')
    expect(parseAdr('x.md', content).supersedes).toBe('backend-dotnet/no-raw-sql')
  })

  it('rejects a malformed --date without writing', () => {
    const fx = fixture()

    const { result, exitCode } = runAdrNew(fx.ctx, 'Bad date', { area: 'auth', date: '08/08/2026' })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('08/08/2026')
    expect(fs.existsSync(path.join(fx.projectDir, 'docs'))).toBe(false)
  })

  it('rejects an empty title without writing', () => {
    const fx = fixture()

    const { result, exitCode } = runAdrNew(fx.ctx, '', { area: 'auth' })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('title')
    expect(fs.existsSync(path.join(fx.projectDir, 'docs'))).toBe(false)
  })

  it('rejects a whitespace-only title without writing', () => {
    const fx = fixture()

    const { result, exitCode } = runAdrNew(fx.ctx, '   \t ', { area: 'auth' })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(fx.projectDir, 'docs'))).toBe(false)
  })

  it('trims the title before writing it', () => {
    const fx = fixture()

    const { result } = runAdrNew(fx.ctx, '  Trimmed title  ', { area: 'auth', date: '2026-08-08' })

    expect(path.basename(result.path ?? '')).toBe('2026-08-08-trimmed-title.md')
    expect(parseAdr('x.md', read(result.path ?? '')).title).toBe('Trimmed title')
  })

  it('dry-run prints the intended content and leaves the filesystem untouched', () => {
    const fx = fixture()

    const { result, exitCode } = runAdrNew(fx.ctx, 'Never written', {
      area: 'auth',
      summary: 'Nothing lands on disk.',
      date: '2026-08-08',
      dryRun: true,
    })

    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.path).toBe(path.join(fx.adrDir, '2026-08-08-never-written.md'))
    expect(result.message).toContain('title: Never written')
    expect(result.message).toContain('summary: Nothing lands on disk.')
    expect(result.message).toContain('## Alternatives considered')
    expect(fs.existsSync(path.join(fx.projectDir, 'docs'))).toBe(false)
  })

  it('dry-run leaves an existing docs/adr/ byte-identical', () => {
    const fx = fixture()
    const first = runAdrNew(fx.ctx, 'Existing', { area: 'auth', date: '2026-08-08' })
    const before = fs.readFileSync(first.result.path ?? '')

    const { exitCode } = runAdrNew(fx.ctx, 'Existing', {
      area: 'auth',
      date: '2026-08-08',
      dryRun: true,
    })

    expect(exitCode).toBe(0)
    expect(listAdrs(fx.adrDir)).toEqual([path.basename(first.result.path ?? '')])
    expect(fs.readFileSync(first.result.path ?? '').equals(before)).toBe(true)
  })

  it('dry-run reports the suffixed path it would take on a collision', () => {
    const fx = fixture()
    runAdrNew(fx.ctx, 'Crowded', { area: 'auth', date: '2026-08-08' })

    const { result } = runAdrNew(fx.ctx, 'Crowded', {
      area: 'auth',
      date: '2026-08-08',
      dryRun: true,
    })

    expect(path.basename(result.path ?? '')).toBe('2026-08-08-crowded-2.md')
  })

  it('works in a project that never ran lumem init', () => {
    const fx = fixture()
    expect(fs.existsSync(path.join(fx.projectDir, '.lumem'))).toBe(false)

    const { result, exitCode } = runAdrNew(fx.ctx, 'No lumem here', { area: 'auth' })

    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(fs.existsSync(result.path ?? '')).toBe(true)
    expect(fs.existsSync(path.join(fx.projectDir, '.lumem'))).toBe(false)
    expect(fs.existsSync(path.join(fx.home, '.lumem'))).toBe(false)
  })

  it('produces a JSON round-trippable result', () => {
    const fx = fixture()

    const created = runAdrNew(fx.ctx, 'Round trip me', { area: 'auth', date: '2026-08-08' })
    const failed = runAdrNew(fx.ctx, '', { area: 'auth' })

    expect(JSON.parse(JSON.stringify(created.result))).toEqual(created.result)
    expect(JSON.parse(JSON.stringify(failed.result))).toEqual(failed.result)
  })
})

describe('renderAdrNew', () => {
  it('renders a success on one line containing the path', () => {
    const text = renderAdrNew({ ok: true, path: '/p/docs/adr/x.md', message: 'created /p/x.md' })

    expect(text.includes('\n')).toBe(false)
    expect(text).toContain('created /p/x.md')
  })

  it('renders a failure on one line containing the message', () => {
    const text = renderAdrNew({ ok: false, message: 'empty title: nothing to create' })

    expect(text.includes('\n')).toBe(false)
    expect(text).toContain('empty title')
  })

  it('keeps the multi-line dry-run content readable', () => {
    const fx = fixture()
    const { result } = runAdrNew(fx.ctx, 'Printed', {
      area: 'auth',
      date: '2026-08-08',
      dryRun: true,
    })

    const text = renderAdrNew(result)
    expect(text.split('\n')[0]).toContain('dry-run')
    expect(text).toContain('title: Printed')
    expect(text).toContain('## Consequences')
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
  registerAdrCommands(
    program,
    () => fx.ctx,
    (json, report, rendered) => {
      calls.push({ json, report, rendered })
    },
  )
  // exitOverride turns a parse error into a throw; configureOutput keeps commander
  // from also printing it, so an expected rejection leaves no noise in the run.
  for (const child of program.commands) {
    child.exitOverride()
    for (const grandchild of child.commands) {
      grandchild.exitOverride().configureOutput({ writeErr: () => undefined })
    }
  }
  return { program, calls }
}

function lastResult(calls: EmitCall[]): { ok: boolean; path?: string; message: string } {
  const call = calls[calls.length - 1]
  if (call === undefined) throw new Error('emit was never called')
  return call.report as { ok: boolean; path?: string; message: string }
}

describe('registerAdrCommands', () => {
  it('registers an adr parent carrying new', () => {
    const { program } = harness(fixture())

    const adr = program.commands.find((cmd) => cmd.name() === 'adr')
    expect(adr).toBeDefined()
    expect(adr?.commands.map((cmd) => cmd.name())).toEqual(['new'])
  })

  it('reuses an adr parent a sibling registrar already created', () => {
    const fx = fixture()
    const program = new Command('lumem')
    const parent = program.command('adr')
    parent.command('lint')

    registerAdrCommands(
      program,
      () => fx.ctx,
      () => undefined,
    )

    expect(program.commands.filter((cmd) => cmd.name() === 'adr')).toHaveLength(1)
    expect(parent.commands.map((cmd) => cmd.name()).sort()).toEqual(['lint', 'new'])
  })

  it('drives adr new end to end, writing the file and emitting one line', async () => {
    const fx = fixture()
    const { program, calls } = harness(fx)

    await program.parseAsync(['adr', 'new', 'Wired through', '--area', 'auth'], { from: 'user' })

    expect(lastResult(calls).ok).toBe(true)
    expect(calls[0]?.rendered.includes('\n')).toBe(false)
    expect(fs.existsSync(lastResult(calls).path ?? '')).toBe(true)
    expect(process.exitCode).toBe(0)
  })

  it('parses --summary, --supersedes and --date', async () => {
    const fx = fixture()
    const { program, calls } = harness(fx)
    runAdrNew(fx.ctx, 'JWT for auth', { area: 'auth', date: '2026-03-11' })

    await program.parseAsync(
      [
        'adr',
        'new',
        'Session cookies over JWT',
        '--area',
        'auth',
        '--summary',
        'Revocation has to be immediate.',
        '--supersedes',
        '2026-03-11-jwt-for-auth.md',
        '--date',
        '2026-08-08',
      ],
      { from: 'user' },
    )

    const created = lastResult(calls)
    expect(created.ok).toBe(true)
    const adr = parseAdr(path.basename(created.path ?? ''), read(created.path ?? ''))
    expect(adr.warnings).toEqual([])
    expect(adr.area).toBe('auth')
    expect(adr.date).toBe('2026-08-08')
    expect(adr.summary).toBe('Revocation has to be immediate.')
    expect(adr.supersedes).toBe('2026-03-11-jwt-for-auth.md')
  })

  it('parses --dry-run and writes nothing', async () => {
    const fx = fixture()
    const { program, calls } = harness(fx)

    await program.parseAsync(['adr', 'new', 'Dry', '--area', 'auth', '--dry-run'], { from: 'user' })

    expect(lastResult(calls).message.startsWith('dry-run:')).toBe(true)
    expect(fs.existsSync(path.join(fx.projectDir, 'docs'))).toBe(false)
    expect(process.exitCode).toBe(0)
  })

  it('sets exit code 1 on invalid input', async () => {
    const fx = fixture()
    const { program, calls } = harness(fx)

    await program.parseAsync(['adr', 'new', 'Bad date', '--area', 'auth', '--date', 'yesterday'], {
      from: 'user',
    })

    expect(lastResult(calls).ok).toBe(false)
    expect(process.exitCode).toBe(1)
  })

  it('requires --area', async () => {
    const fx = fixture()
    const { program } = harness(fx)

    await expect(
      program.parseAsync(['adr', 'new', 'No area given'], { from: 'user' }),
    ).rejects.toThrow(/--area/)
  })

  it('forwards ctx.json to emit', async () => {
    const fx = fixture()
    fx.ctx.json = true
    const { program, calls } = harness(fx)

    await program.parseAsync(['adr', 'new', 'Json mode', '--area', 'auth'], { from: 'user' })

    expect(calls[0]?.json).toBe(true)
  })
})
