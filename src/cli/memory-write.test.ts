import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { factId } from '../core/memory/store'
import type { CliContext } from './context'
import {
  registerMemoryWriteCommands,
  renderMemoryWrite,
  runMemoryAdd,
  runMemoryEdit,
  runMemoryForget,
} from './memory-write'

const realAdaptersDir = fileURLToPath(new URL('../adapters', import.meta.url))

/** An AWS access key shaped token: AKIA + 16 uppercase/digits. */
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
/** A GitHub token shaped value: ghp_ + 36 alphanumerics. */
const GH_TOKEN = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'

interface Fixture {
  ctx: CliContext
  projectDir: string
  home: string
  /** `<projectDir>/.lumem/memory/<name>.md` */
  projectMemory: (name: string) => string
  /** `<home>/.lumem/memory/<name>.md` */
  globalMemory: (name: string) => string
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-memw-'))
  const projectDir = path.join(root, 'proj')
  const home = path.join(root, 'home')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  return {
    ctx: { projectDir, adaptersDir: realAdaptersDir, env: { HOME: home }, json: false },
    projectDir,
    home,
    projectMemory: (name) => path.join(projectDir, '.lumem', 'memory', `${name}.md`),
    globalMemory: (name) => path.join(home, '.lumem', 'memory', `${name}.md`),
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

const originalExitCode = process.exitCode

afterEach(() => {
  process.exitCode = originalExitCode
  vi.unstubAllEnvs()
})

describe('runMemoryAdd', () => {
  it('writes a project fact to the project memory file with manual provenance', () => {
    const fx = fixture()

    const { result, exitCode } = runMemoryAdd(fx.ctx, {
      body: 'use pnpm for installs',
      type: 'project',
      date: '2026-01-15',
      conf: 'high',
    })

    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.factId).toBe(factId('use pnpm for installs'))
    expect(result.filePath).toBe(fx.projectMemory('project'))
    expect(read(fx.projectMemory('project'))).toBe(
      '- [2026-01-15] use pnpm for installs\n  <!-- src:manual conf:high -->\n',
    )
  })

  it('defaults preference facts to the global scope file', () => {
    const fx = fixture()

    const { result, exitCode } = runMemoryAdd(fx.ctx, {
      body: 'prefer concise answers',
      type: 'preference',
    })

    expect(exitCode).toBe(0)
    expect(result.filePath).toBe(fx.globalMemory('preference'))
    expect(fs.existsSync(fx.globalMemory('preference'))).toBe(true)
  })

  it('defaults corrections to project scope and honours an explicit global scope', () => {
    const fx = fixture()

    const local = runMemoryAdd(fx.ctx, { body: 'never force push main', type: 'correction' })
    const global = runMemoryAdd(fx.ctx, {
      body: 'never delete the lockfile',
      type: 'correction',
      scope: 'global',
    })

    expect(local.result.filePath).toBe(fx.projectMemory('correction'))
    expect(global.result.filePath).toBe(fx.globalMemory('correction'))
    expect(read(fx.projectMemory('correction'))).toContain('never force push main')
    expect(read(fx.globalMemory('correction'))).toContain('never delete the lockfile')
  })

  it('defaults date to today and conf to medium', () => {
    const fx = fixture()

    runMemoryAdd(fx.ctx, { body: 'tests live next to sources', type: 'project' })

    expect(read(fx.projectMemory('project'))).toBe(
      `- [${today()}] tests live next to sources\n  <!-- src:manual conf:medium -->\n`,
    )
  })

  it('appends to an existing memory file, preserving earlier facts', () => {
    const fx = fixture()
    runMemoryAdd(fx.ctx, { body: 'first fact', type: 'project', date: '2026-01-01' })

    const { exitCode } = runMemoryAdd(fx.ctx, {
      body: 'second fact',
      type: 'project',
      date: '2026-01-02',
    })

    expect(exitCode).toBe(0)
    expect(read(fx.projectMemory('project'))).toBe(
      '- [2026-01-01] first fact\n  <!-- src:manual conf:medium -->\n' +
        '- [2026-01-02] second fact\n  <!-- src:manual conf:medium -->\n',
    )
  })

  it('creates the .lumem tree when it does not exist yet', () => {
    const fx = fixture()
    expect(fs.existsSync(path.join(fx.projectDir, '.lumem'))).toBe(false)
    expect(fs.existsSync(path.join(fx.home, '.lumem'))).toBe(false)

    runMemoryAdd(fx.ctx, { body: 'bootstrapped project fact', type: 'project' })
    runMemoryAdd(fx.ctx, { body: 'bootstrapped preference', type: 'preference' })

    expect(fs.existsSync(fx.projectMemory('project'))).toBe(true)
    expect(fs.existsSync(fx.globalMemory('preference'))).toBe(true)
  })

  it('refuses a project fact scoped global without writing anything', () => {
    const fx = fixture()

    const { result, exitCode } = runMemoryAdd(fx.ctx, {
      body: 'this cannot be global',
      type: 'project',
      scope: 'global',
    })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.message).toContain("type 'project'")
    expect(result.message).toContain("scope 'global'")
    expect(fs.existsSync(path.join(fx.projectDir, '.lumem'))).toBe(false)
    expect(fs.existsSync(path.join(fx.home, '.lumem'))).toBe(false)
  })

  it('refuses a preference fact scoped project without writing anything', () => {
    const fx = fixture()

    const { result, exitCode } = runMemoryAdd(fx.ctx, {
      body: 'this cannot be project scoped',
      type: 'preference',
      scope: 'project',
    })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.message).toContain("type 'preference'")
    expect(result.message).toContain("scope 'project'")
    expect(fs.existsSync(path.join(fx.projectDir, '.lumem'))).toBe(false)
    expect(fs.existsSync(path.join(fx.home, '.lumem'))).toBe(false)
  })

  it('refuses an AWS-key-shaped body and leaves no file behind', () => {
    const fx = fixture()

    const { result, exitCode } = runMemoryAdd(fx.ctx, {
      body: `deploy with ${AWS_KEY}`,
      type: 'project',
    })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('secret')
    expect(result.message).toContain('aws-access-key')
    expect(fs.existsSync(fx.projectMemory('project'))).toBe(false)
  })

  it('refuses a GitHub-token-shaped body leaving the existing file byte-identical', () => {
    const fx = fixture()
    runMemoryAdd(fx.ctx, { body: 'keep this fact', type: 'project', date: '2026-01-01' })
    const before = fs.readFileSync(fx.projectMemory('project'))

    const { result, exitCode } = runMemoryAdd(fx.ctx, {
      body: `token is ${GH_TOKEN}`,
      type: 'project',
    })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('github-token')
    expect(fs.readFileSync(fx.projectMemory('project')).equals(before)).toBe(true)
  })

  it('refuses a duplicate body and leaves the file byte-identical', () => {
    const fx = fixture()
    runMemoryAdd(fx.ctx, { body: 'use pnpm for installs', type: 'project', date: '2026-01-01' })
    const before = fs.readFileSync(fx.projectMemory('project'))

    const { result, exitCode } = runMemoryAdd(fx.ctx, {
      body: '  use   pnpm for installs  ',
      type: 'project',
      date: '2026-02-02',
    })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('duplicate')
    expect(fs.readFileSync(fx.projectMemory('project')).equals(before)).toBe(true)
  })

  it('rejects a malformed date without writing', () => {
    const fx = fixture()

    const { result, exitCode } = runMemoryAdd(fx.ctx, {
      body: 'bad date fact',
      type: 'project',
      date: '15/01/2026',
    })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('15/01/2026')
    expect(fs.existsSync(fx.projectMemory('project'))).toBe(false)
  })

  it('rejects an empty body without writing', () => {
    const fx = fixture()

    const { result, exitCode } = runMemoryAdd(fx.ctx, { body: '   ', type: 'project' })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(fs.existsSync(fx.projectMemory('project'))).toBe(false)
  })

  it('dry-run reports the write it would perform without touching disk', () => {
    const fx = fixture()

    const { result, exitCode } = runMemoryAdd(fx.ctx, {
      body: 'would be added',
      type: 'project',
      dryRun: true,
    })

    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.message.startsWith('dry-run:')).toBe(true)
    expect(result.factId).toBe(factId('would be added'))
    expect(result.filePath).toBe(fx.projectMemory('project'))
    expect(fs.existsSync(fx.projectMemory('project'))).toBe(false)
    expect(fs.existsSync(path.join(fx.projectDir, '.lumem'))).toBe(false)
  })

  it('dry-run leaves an existing file byte-identical', () => {
    const fx = fixture()
    runMemoryAdd(fx.ctx, { body: 'existing fact', type: 'project', date: '2026-01-01' })
    const before = fs.readFileSync(fx.projectMemory('project'))

    const { exitCode } = runMemoryAdd(fx.ctx, {
      body: 'another fact',
      type: 'project',
      dryRun: true,
    })

    expect(exitCode).toBe(0)
    expect(fs.readFileSync(fx.projectMemory('project')).equals(before)).toBe(true)
  })

  it('dry-run still reports a secret refusal and writes nothing', () => {
    const fx = fixture()

    const { result, exitCode } = runMemoryAdd(fx.ctx, {
      body: `deploy with ${AWS_KEY}`,
      type: 'project',
      dryRun: true,
    })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('aws-access-key')
    expect(fs.existsSync(fx.projectMemory('project'))).toBe(false)
  })

  it('produces a JSON round-trippable result', () => {
    const fx = fixture()
    const { result } = runMemoryAdd(fx.ctx, { body: 'round trip me', type: 'project' })

    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
})

describe('runMemoryEdit', () => {
  it('replaces the body in place and returns the new derived id', () => {
    const fx = fixture()
    const added = runMemoryAdd(fx.ctx, {
      body: 'use npm for installs',
      type: 'project',
      date: '2026-01-01',
      conf: 'high',
    })
    const id = added.result.factId ?? ''

    const { result, exitCode } = runMemoryEdit(fx.ctx, id, { body: 'use pnpm for installs' })

    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.factId).toBe(factId('use pnpm for installs'))
    expect(result.factId).not.toBe(id)
    expect(result.filePath).toBe(fx.projectMemory('project'))
    expect(read(fx.projectMemory('project'))).toBe(
      '- [2026-01-01] use pnpm for installs\n  <!-- src:manual conf:high -->\n',
    )
  })

  it('keeps the fact position and leaves sibling facts untouched', () => {
    const fx = fixture()
    runMemoryAdd(fx.ctx, { body: 'first', type: 'project', date: '2026-01-01' })
    const middle = runMemoryAdd(fx.ctx, { body: 'middle', type: 'project', date: '2026-01-02' })
    runMemoryAdd(fx.ctx, { body: 'last', type: 'project', date: '2026-01-03' })

    runMemoryEdit(fx.ctx, middle.result.factId ?? '', { body: 'middle rewritten' })

    expect(read(fx.projectMemory('project'))).toBe(
      '- [2026-01-01] first\n  <!-- src:manual conf:medium -->\n' +
        '- [2026-01-02] middle rewritten\n  <!-- src:manual conf:medium -->\n' +
        '- [2026-01-03] last\n  <!-- src:manual conf:medium -->\n',
    )
  })

  it('edits a fact living in a global file', () => {
    const fx = fixture()
    const added = runMemoryAdd(fx.ctx, { body: 'prefer tabs', type: 'preference' })

    const { result, exitCode } = runMemoryEdit(fx.ctx, added.result.factId ?? '', {
      body: 'prefer spaces',
    })

    expect(exitCode).toBe(0)
    expect(result.filePath).toBe(fx.globalMemory('preference'))
    expect(read(fx.globalMemory('preference'))).toContain('prefer spaces')
  })

  it('fails on an unknown id without writing', () => {
    const fx = fixture()
    runMemoryAdd(fx.ctx, { body: 'existing fact', type: 'project', date: '2026-01-01' })
    const before = fs.readFileSync(fx.projectMemory('project'))

    const { result, exitCode } = runMemoryEdit(fx.ctx, 'deadbeef', { body: 'whatever' })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('deadbeef')
    expect(fs.readFileSync(fx.projectMemory('project')).equals(before)).toBe(true)
  })

  it('refuses to edit a body into an apparent secret, leaving the file byte-identical', () => {
    const fx = fixture()
    const added = runMemoryAdd(fx.ctx, { body: 'harmless', type: 'project', date: '2026-01-01' })
    const before = fs.readFileSync(fx.projectMemory('project'))

    const { result, exitCode } = runMemoryEdit(fx.ctx, added.result.factId ?? '', {
      body: `token ${GH_TOKEN}`,
    })

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('github-token')
    expect(fs.readFileSync(fx.projectMemory('project')).equals(before)).toBe(true)
  })

  it('refuses an edit that duplicates another fact in the same file', () => {
    const fx = fixture()
    runMemoryAdd(fx.ctx, { body: 'alpha', type: 'project', date: '2026-01-01' })
    const beta = runMemoryAdd(fx.ctx, { body: 'beta', type: 'project', date: '2026-01-02' })
    const before = fs.readFileSync(fx.projectMemory('project'))

    const { result, exitCode } = runMemoryEdit(fx.ctx, beta.result.factId ?? '', { body: 'alpha' })

    expect(exitCode).toBe(1)
    expect(result.message).toContain('duplicate')
    expect(fs.readFileSync(fx.projectMemory('project')).equals(before)).toBe(true)
  })

  it('dry-run reports the new id without touching disk', () => {
    const fx = fixture()
    const added = runMemoryAdd(fx.ctx, { body: 'before edit', type: 'project', date: '2026-01-01' })
    const before = fs.readFileSync(fx.projectMemory('project'))

    const { result, exitCode } = runMemoryEdit(fx.ctx, added.result.factId ?? '', {
      body: 'after edit',
      dryRun: true,
    })

    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.message.startsWith('dry-run:')).toBe(true)
    expect(result.factId).toBe(factId('after edit'))
    expect(fs.readFileSync(fx.projectMemory('project')).equals(before)).toBe(true)
  })

  it('produces a JSON round-trippable result', () => {
    const fx = fixture()
    const added = runMemoryAdd(fx.ctx, { body: 'json edit source', type: 'project' })
    const { result } = runMemoryEdit(fx.ctx, added.result.factId ?? '', {
      body: 'json edit target',
    })

    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
})

describe('runMemoryForget', () => {
  it('removes the fact by id, keeping the others', () => {
    const fx = fixture()
    const doomed = runMemoryAdd(fx.ctx, { body: 'forget me', type: 'project', date: '2026-01-01' })
    runMemoryAdd(fx.ctx, { body: 'keep me', type: 'project', date: '2026-01-02' })

    const { result, exitCode } = runMemoryForget(fx.ctx, doomed.result.factId ?? '')

    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.factId).toBe(doomed.result.factId)
    expect(result.filePath).toBe(fx.projectMemory('project'))
    expect(read(fx.projectMemory('project'))).toBe(
      '- [2026-01-02] keep me\n  <!-- src:manual conf:medium -->\n',
    )
  })

  it('empties the file when the last fact is forgotten', () => {
    const fx = fixture()
    const only = runMemoryAdd(fx.ctx, { body: 'the only fact', type: 'project' })

    const { exitCode } = runMemoryForget(fx.ctx, only.result.factId ?? '')

    expect(exitCode).toBe(0)
    expect(read(fx.projectMemory('project'))).toBe('')
  })

  it('forgets a fact living in a global file', () => {
    const fx = fixture()
    const added = runMemoryAdd(fx.ctx, { body: 'global preference', type: 'preference' })

    const { result, exitCode } = runMemoryForget(fx.ctx, added.result.factId ?? '')

    expect(exitCode).toBe(0)
    expect(result.filePath).toBe(fx.globalMemory('preference'))
    expect(read(fx.globalMemory('preference'))).toBe('')
  })

  it('fails on an unknown id without writing', () => {
    const fx = fixture()
    runMemoryAdd(fx.ctx, { body: 'still here', type: 'project', date: '2026-01-01' })
    const before = fs.readFileSync(fx.projectMemory('project'))

    const { result, exitCode } = runMemoryForget(fx.ctx, 'deadbeef')

    expect(exitCode).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('deadbeef')
    expect(fs.readFileSync(fx.projectMemory('project')).equals(before)).toBe(true)
  })

  it('dry-run reports the removal without touching disk', () => {
    const fx = fixture()
    const added = runMemoryAdd(fx.ctx, { body: 'survives dry run', type: 'project' })
    const before = fs.readFileSync(fx.projectMemory('project'))

    const { result, exitCode } = runMemoryForget(fx.ctx, added.result.factId ?? '', {
      dryRun: true,
    })

    expect(exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.message.startsWith('dry-run:')).toBe(true)
    expect(fs.readFileSync(fx.projectMemory('project')).equals(before)).toBe(true)
  })

  it('produces a JSON round-trippable result', () => {
    const fx = fixture()
    const added = runMemoryAdd(fx.ctx, { body: 'json forget source', type: 'project' })
    const { result } = runMemoryForget(fx.ctx, added.result.factId ?? '')

    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
})

describe('renderMemoryWrite', () => {
  it('renders a success as a single line containing the message', () => {
    const text = renderMemoryWrite({ ok: true, factId: 'abc12345', message: 'added fact abc12345' })

    expect(text.includes('\n')).toBe(false)
    expect(text).toContain('added fact abc12345')
  })

  it('renders a failure as a single line containing the message', () => {
    const text = renderMemoryWrite({ ok: false, message: 'duplicate fact' })

    expect(text.includes('\n')).toBe(false)
    expect(text).toContain('duplicate fact')
  })

  it('collapses a multi-line message onto one line', () => {
    const text = renderMemoryWrite({ ok: false, message: 'first line\nsecond line' })

    expect(text.includes('\n')).toBe(false)
    expect(text).toContain('second line')
  })
})

interface EmitCall {
  json: boolean
  report: unknown
  rendered: string
}

function harness(fx: Fixture): { memoryCmd: Command; calls: EmitCall[] } {
  const calls: EmitCall[] = []
  const memoryCmd = new Command('memory')
  memoryCmd.exitOverride()
  registerMemoryWriteCommands(
    memoryCmd,
    () => fx.ctx,
    (json, report, rendered) => {
      calls.push({ json, report, rendered })
    },
  )
  for (const child of memoryCmd.commands) child.exitOverride()
  return { memoryCmd, calls }
}

function lastResult(calls: EmitCall[]): { ok: boolean; message: string; factId?: string } {
  const call = calls[calls.length - 1]
  if (call === undefined) throw new Error('emit was never called')
  return call.report as { ok: boolean; message: string; factId?: string }
}

describe('registerMemoryWriteCommands', () => {
  it('registers add, edit and forget on the parent command', () => {
    const { memoryCmd } = harness(fixture())

    expect(memoryCmd.commands.map((c) => c.name()).sort()).toEqual(['add', 'edit', 'forget'])
  })

  it('drives add end to end, writing the file and emitting the rendered line', async () => {
    const fx = fixture()
    const { memoryCmd, calls } = harness(fx)

    await memoryCmd.parseAsync(['add', 'use pnpm', '--type', 'project', '--conf', 'high'], {
      from: 'user',
    })

    expect(lastResult(calls).ok).toBe(true)
    expect(calls[0]?.rendered.includes('\n')).toBe(false)
    expect(read(fx.projectMemory('project'))).toContain('use pnpm')
    expect(read(fx.projectMemory('project'))).toContain('conf:high')
    expect(process.exitCode).toBe(0)
  })

  it('passes --scope and --date through to the add pipeline', async () => {
    const fx = fixture()
    const { memoryCmd } = harness(fx)

    await memoryCmd.parseAsync(
      [
        'add',
        'never rebase shared branches',
        '--type',
        'correction',
        '--scope',
        'global',
        '--date',
        '2026-03-04',
      ],
      { from: 'user' },
    )

    expect(read(fx.globalMemory('correction'))).toBe(
      '- [2026-03-04] never rebase shared branches\n  <!-- src:manual conf:medium -->\n',
    )
  })

  it('reports an invalid --type value as a failed result', async () => {
    const fx = fixture()
    const { memoryCmd, calls } = harness(fx)

    await memoryCmd.parseAsync(['add', 'anything', '--type', 'bogus'], { from: 'user' })

    expect(lastResult(calls).ok).toBe(false)
    expect(lastResult(calls).message).toContain('bogus')
    expect(process.exitCode).toBe(1)
    expect(fs.existsSync(path.join(fx.projectDir, '.lumem'))).toBe(false)
  })

  it('reports an invalid --conf value as a failed result', async () => {
    const fx = fixture()
    const { memoryCmd, calls } = harness(fx)

    await memoryCmd.parseAsync(['add', 'anything', '--type', 'project', '--conf', 'certain'], {
      from: 'user',
    })

    expect(lastResult(calls).ok).toBe(false)
    expect(lastResult(calls).message).toContain('certain')
    expect(process.exitCode).toBe(1)
  })

  it('honours --dry-run on add', async () => {
    const fx = fixture()
    const { memoryCmd, calls } = harness(fx)

    await memoryCmd.parseAsync(['add', 'dry added', '--type', 'project', '--dry-run'], {
      from: 'user',
    })

    expect(lastResult(calls).message.startsWith('dry-run:')).toBe(true)
    expect(fs.existsSync(fx.projectMemory('project'))).toBe(false)
  })

  it('drives edit with --body', async () => {
    const fx = fixture()
    const added = runMemoryAdd(fx.ctx, { body: 'old body', type: 'project', date: '2026-01-01' })
    const { memoryCmd, calls } = harness(fx)

    await memoryCmd.parseAsync(['edit', added.result.factId ?? '', '--body', 'new body'], {
      from: 'user',
    })

    expect(lastResult(calls).ok).toBe(true)
    expect(read(fx.projectMemory('project'))).toContain('new body')
  })

  it('fails edit without --body when no editor is configured', async () => {
    const fx = fixture()
    const added = runMemoryAdd(fx.ctx, { body: 'unchanged body', type: 'project' })
    const before = fs.readFileSync(fx.projectMemory('project'))
    const { memoryCmd, calls } = harness(fx)
    vi.stubEnv('EDITOR', '')

    await memoryCmd.parseAsync(['edit', added.result.factId ?? '', '--dry-run'], { from: 'user' })

    expect(lastResult(calls).ok).toBe(false)
    expect(lastResult(calls).message).toContain('--body')
    expect(process.exitCode).toBe(1)
    expect(fs.readFileSync(fx.projectMemory('project')).equals(before)).toBe(true)
  })

  it('honours --dry-run on forget', async () => {
    const fx = fixture()
    const added = runMemoryAdd(fx.ctx, { body: 'to be forgotten', type: 'project' })
    const { memoryCmd, calls } = harness(fx)

    await memoryCmd.parseAsync(['forget', added.result.factId ?? '', '--dry-run'], { from: 'user' })

    expect(lastResult(calls).message.startsWith('dry-run:')).toBe(true)
    expect(read(fx.projectMemory('project'))).toContain('to be forgotten')
  })

  it('drives forget end to end', async () => {
    const fx = fixture()
    const added = runMemoryAdd(fx.ctx, { body: 'to be forgotten', type: 'project' })
    const { memoryCmd, calls } = harness(fx)

    await memoryCmd.parseAsync(['forget', added.result.factId ?? ''], { from: 'user' })

    expect(lastResult(calls).ok).toBe(true)
    expect(read(fx.projectMemory('project'))).toBe('')
  })

  it('forwards ctx.json to emit', async () => {
    const fx = fixture()
    fx.ctx.json = true
    const { memoryCmd, calls } = harness(fx)

    await memoryCmd.parseAsync(['add', 'json mode fact', '--type', 'project'], { from: 'user' })

    expect(calls[0]?.json).toBe(true)
  })
})
