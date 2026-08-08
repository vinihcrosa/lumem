import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { factId } from '../core/memory/store'
import type { CliContext } from './context'
import {
  loadAllMemory,
  registerMemoryReadCommands,
  renderMemoryList,
  renderMemoryShow,
  resolveMemoryPaths,
  runMemoryList,
  runMemorySearch,
  runMemoryShow,
} from './memory-read'

const realAdaptersDir = fileURLToPath(new URL('../adapters', import.meta.url))

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-memory-read-'))
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

const PROJECT_BODY = 'Usa pnpm, nunca npm'
const PROJECT_OLD_BODY = 'Deploy roda no GitHub Actions'
const PROJECT_CORRECTION_BODY = 'Nunca commitar direto na main'
const PREFERENCE_BODY = 'Prefere respostas curtas em português'
const MULTILINE_BODY = 'Primeira linha do fato\nsegunda linha do fato'

/** A fixture with facts in every scope: project.md + correction.md (project), preference.md (global). */
function populated(): { ctx: CliContext; projectDir: string; home: string } {
  const projectDir = tmpDir()
  const home = tmpDir()

  writeMemory(
    projectDir,
    'project.md',
    lines(
      `- [2026-08-07] ${PROJECT_BODY}`,
      '  <!-- src:sess_a1 conf:high -->',
      `- [2026-08-05] ${PROJECT_OLD_BODY}`,
      '  <!-- src:sess_a2 conf:medium -->',
    ),
  )
  writeMemory(
    projectDir,
    'correction.md',
    lines(`- [2026-08-06] ${PROJECT_CORRECTION_BODY}`, '  <!-- src:sess_b1 conf:high -->'),
  )
  writeMemory(
    home,
    'preference.md',
    lines(
      `- [2026-08-04] ${PREFERENCE_BODY}`,
      '  <!-- src:manual conf:medium -->',
      '- [2026-08-03] Primeira linha do fato',
      '  segunda linha do fato',
      '  <!-- src:sess_c1 conf:low -->',
    ),
  )

  return { ctx: makeCtx(projectDir, home), projectDir, home }
}

describe('resolveMemoryPaths', () => {
  it('derives project and global .lumem dirs from the context', () => {
    const paths = resolveMemoryPaths(makeCtx('/tmp/proj', '/tmp/home'))
    expect(paths.projectLumemDir).toBe(path.join('/tmp/proj', '.lumem'))
    expect(paths.globalLumemDir).toBe(path.join('/tmp/home', '.lumem'))
  })

  it('falls back to os.homedir() when the context carries no HOME', () => {
    const ctx: CliContext = {
      projectDir: '/tmp/proj',
      adaptersDir: realAdaptersDir,
      env: {},
      json: false,
    }
    expect(resolveMemoryPaths(ctx).globalLumemDir).toBe(path.join(os.homedir(), '.lumem'))
  })
})

describe('loadAllMemory', () => {
  it('returns the four layout files, empty and warning-free, when nothing exists', () => {
    const files = loadAllMemory(makeCtx(tmpDir(), tmpDir()))
    expect(files).toHaveLength(4)
    expect(files.every((f) => f.facts.length === 0)).toBe(true)
    expect(files.flatMap((f) => f.warnings)).toEqual([])
  })

  it('parses facts from both scopes', () => {
    const { ctx } = populated()
    const files = loadAllMemory(ctx)
    expect(files.flatMap((f) => f.facts)).toHaveLength(5)
  })
})

describe('runMemoryList', () => {
  it('merges project and global facts with the source file recorded', () => {
    const { ctx, projectDir, home } = populated()
    const { report, exitCode } = runMemoryList(ctx)

    expect(exitCode).toBe(0)
    expect(report.facts).toHaveLength(5)
    expect(report.warnings).toEqual([])

    const projectFact = report.facts.find((f) => f.body === PROJECT_BODY)
    expect(projectFact).toBeDefined()
    expect(projectFact?.scope).toBe('project')
    expect(projectFact?.type).toBe('project')
    expect(projectFact?.src).toBe('sess_a1')
    expect(projectFact?.conf).toBe('high')
    expect(projectFact?.date).toBe('2026-08-07')
    expect(projectFact?.id).toBe(factId(PROJECT_BODY))
    expect(projectFact?.file).toBe(path.join(projectDir, '.lumem', 'memory', 'project.md'))

    const preference = report.facts.find((f) => f.body === PREFERENCE_BODY)
    expect(preference?.scope).toBe('global')
    expect(preference?.type).toBe('preference')
    expect(preference?.file).toBe(path.join(home, '.lumem', 'memory', 'preference.md'))
  })

  it('filters by --type', () => {
    const { ctx } = populated()
    const { report } = runMemoryList(ctx, { type: 'correction' })
    expect(report.facts.map((f) => f.body)).toEqual([PROJECT_CORRECTION_BODY])
  })

  it('filters by --scope', () => {
    const { ctx } = populated()
    const { report } = runMemoryList(ctx, { scope: 'global' })
    expect(report.facts.every((f) => f.scope === 'global')).toBe(true)
    expect(report.facts.map((f) => f.body)).toEqual([PREFERENCE_BODY, MULTILINE_BODY])
  })

  it('combines --type and --scope filters', () => {
    const { ctx } = populated()
    const { report } = runMemoryList(ctx, { type: 'project', scope: 'global' })
    expect(report.facts).toEqual([])
  })

  it('returns an empty report when there is no memory at all', () => {
    const { report, exitCode } = runMemoryList(makeCtx(tmpDir(), tmpDir()))
    expect(exitCode).toBe(0)
    expect(report.facts).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it('surfaces parser warnings from a malformed line', () => {
    const projectDir = tmpDir()
    const home = tmpDir()
    writeMemory(
      projectDir,
      'project.md',
      '- [ontem] fato com data quebrada\n  <!-- src:sess_x conf:high -->\nlixo solto\n',
    )
    const { report, exitCode } = runMemoryList(makeCtx(projectDir, home))

    expect(exitCode).toBe(0)
    expect(report.facts).toEqual([])
    expect(report.warnings.some((w) => w.includes("malformed date 'ontem'"))).toBe(true)
    expect(report.warnings.some((w) => w.includes('neither a fact bullet'))).toBe(true)
    expect(
      report.warnings.every((w) =>
        w.includes(path.join(projectDir, '.lumem', 'memory', 'project.md')),
      ),
    ).toBe(true)
  })

  it('produces a JSON-serializable report (round-trip)', () => {
    const { ctx } = populated()
    const { report } = runMemoryList(ctx)
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })
})

describe('runMemoryShow', () => {
  it('finds a fact by the id displayed in list', () => {
    const { ctx, projectDir } = populated()
    const listed = runMemoryList(ctx).report.facts.find((f) => f.body === PROJECT_BODY)
    expect(listed).toBeDefined()

    const { report, exitCode } = runMemoryShow(ctx, listed?.id ?? '')
    expect(exitCode).toBe(0)
    expect(report.found).toBe(true)
    expect(report.fact?.body).toBe(PROJECT_BODY)
    expect(report.fact?.src).toBe('sess_a1')
    expect(report.fact?.file).toBe(path.join(projectDir, '.lumem', 'memory', 'project.md'))
  })

  it('finds a global fact with a multi-line body', () => {
    const { ctx } = populated()
    const { report, exitCode } = runMemoryShow(ctx, factId(MULTILINE_BODY))
    expect(exitCode).toBe(0)
    expect(report.fact?.body).toBe(MULTILINE_BODY)
    expect(report.fact?.scope).toBe('global')
  })

  it('exits 1 when the id is unknown', () => {
    const { ctx } = populated()
    const { report, exitCode } = runMemoryShow(ctx, 'deadbeef')
    expect(exitCode).toBe(1)
    expect(report.found).toBe(false)
    expect(report.fact).toBeUndefined()
  })

  it('produces a JSON-serializable report (round-trip)', () => {
    const { ctx } = populated()
    const { report } = runMemoryShow(ctx, factId(PREFERENCE_BODY))
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })
})

describe('runMemorySearch', () => {
  it('matches a case-insensitive substring of the body', () => {
    const { ctx } = populated()
    const { report, exitCode } = runMemorySearch(ctx, 'PNPM')
    expect(exitCode).toBe(0)
    expect(report.facts.map((f) => f.body)).toEqual([PROJECT_BODY])
    expect(report.facts[0]?.file).toContain(path.join('.lumem', 'memory', 'project.md'))
  })

  it('matches across scopes and keeps the source file of each hit', () => {
    const { ctx, projectDir, home } = populated()
    const { report } = runMemorySearch(ctx, 'a')
    const files = new Set(report.facts.map((f) => f.file))
    expect(files.has(path.join(projectDir, '.lumem', 'memory', 'project.md'))).toBe(true)
    expect(files.has(path.join(home, '.lumem', 'memory', 'preference.md'))).toBe(true)
  })

  it('returns an empty report when nothing matches', () => {
    const { ctx } = populated()
    const { report, exitCode } = runMemorySearch(ctx, 'não existe isso aqui')
    expect(exitCode).toBe(0)
    expect(report.facts).toEqual([])
  })
})

describe('renderMemoryList', () => {
  it('prints one line per fact with id, date, type/scope and the first body line', () => {
    const { ctx } = populated()
    const { report } = runMemoryList(ctx)
    const lines = renderMemoryList(report).split('\n')

    expect(lines).toContain(
      `${factId(PROJECT_BODY)}  [2026-08-07]  (project/project)  ${PROJECT_BODY}`,
    )
    expect(lines).toContain(
      `${factId(PREFERENCE_BODY)}  [2026-08-04]  (preference/global)  ${PREFERENCE_BODY}`,
    )
    // multi-line bodies collapse to their first line
    expect(lines).toContain(
      `${factId(MULTILINE_BODY)}  [2026-08-03]  (preference/global)  Primeira linha do fato`,
    )
    expect(lines.some((l) => l.includes('segunda linha do fato'))).toBe(false)
  })

  it('prints the empty message when there is no fact', () => {
    const { report } = runMemoryList(makeCtx(tmpDir(), tmpDir()))
    expect(renderMemoryList(report)).toBe('no facts recorded')
  })

  it('renders warnings after the facts', () => {
    const projectDir = tmpDir()
    writeMemory(projectDir, 'project.md', 'lixo solto\n')
    const { report } = runMemoryList(makeCtx(projectDir, tmpDir()))
    const text = renderMemoryList(report)
    expect(text).toContain('no facts recorded')
    expect(text).toContain('warning:')
  })
})

describe('renderMemoryShow', () => {
  it('renders the full body plus provenance', () => {
    const { ctx, home } = populated()
    const { report } = runMemoryShow(ctx, factId(MULTILINE_BODY))
    const text = renderMemoryShow(report)

    expect(text).toContain(factId(MULTILINE_BODY))
    expect(text).toContain('[2026-08-03]')
    expect(text).toContain('(preference/global)')
    expect(text).toContain('Primeira linha do fato')
    expect(text).toContain('segunda linha do fato')
    expect(text).toContain('src:sess_c1')
    expect(text).toContain('conf:low')
    expect(text).toContain(path.join(home, '.lumem', 'memory', 'preference.md'))
  })

  it('renders the not-found message with the requested id', () => {
    const { ctx } = populated()
    const { report } = runMemoryShow(ctx, 'deadbeef')
    expect(renderMemoryShow(report)).toBe('fact deadbeef not found')
  })
})

describe('registerMemoryReadCommands', () => {
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
    registerMemoryReadCommands(
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

  it('registers list, show and search as subcommands of memory', () => {
    const { parent } = wire(populated().ctx)
    const memoryCmd = parent.commands.find((c) => c.name() === 'memory')
    expect(memoryCmd?.commands.map((c) => c.name()).sort()).toEqual(['list', 'search', 'show'])
  })

  it('list emits the report and the rendered text', async () => {
    const { ctx } = populated()
    const { parent, emitted } = wire(ctx)

    expect(await run(parent, ['memory', 'list'])).toBe(0)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.json).toBe(false)
    expect(emitted[0]?.rendered).toContain(PROJECT_BODY)
  })

  it('list forwards --type and --scope', async () => {
    const { ctx } = populated()
    const { parent, emitted } = wire(ctx)

    await run(parent, ['memory', 'list', '--type', 'correction', '--scope', 'project'])
    expect(emitted[0]?.rendered).toContain(PROJECT_CORRECTION_BODY)
    expect(emitted[0]?.rendered).not.toContain(PREFERENCE_BODY)
  })

  it('show accepts a displayed id and sets exit code 1 for an unknown one', async () => {
    const { ctx } = populated()
    const { parent, emitted } = wire(ctx)

    expect(await run(parent, ['memory', 'show', factId(PROJECT_BODY)])).toBe(0)
    expect(emitted[0]?.rendered).toContain(PROJECT_BODY)

    expect(await run(parent, ['memory', 'show', 'deadbeef'])).toBe(1)
    expect(emitted[1]?.rendered).toBe('fact deadbeef not found')
  })

  it('search forwards the query', async () => {
    const { ctx } = populated()
    const { parent, emitted } = wire(ctx)

    await run(parent, ['memory', 'search', 'pnpm'])
    expect(emitted[0]?.rendered).toContain(PROJECT_BODY)
    expect(emitted[0]?.rendered).not.toContain(PREFERENCE_BODY)
  })

  it('honours ctx.json in the emit callback', async () => {
    const { ctx } = populated()
    const { parent, emitted } = wire({ ...ctx, json: true })

    await run(parent, ['memory', 'list'])
    expect(emitted[0]?.json).toBe(true)
  })
})
