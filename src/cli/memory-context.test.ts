import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import type { CliContext } from './context'
import { registerMemoryContextCommand, runMemoryContext } from './memory-context'

const realAdaptersDir = fileURLToPath(new URL('../adapters', import.meta.url))

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-memory-context-'))
}

function writeMemory(base: string, name: string, content: string): void {
  const file = path.join(base, '.lumem', 'memory', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

// NEVER the real home: HOME is always injected into the context.
function makeCtx(projectDir: string, home: string): CliContext {
  return { projectDir, adaptersDir: realAdaptersDir, env: { HOME: home }, json: false }
}

// ASCII-only bodies keep the byte budget arithmetic below exact.
const PROJECT_BODY = 'use pnpm not npm'
const CORRECTION_BODY = 'never commit to main'
const PREFERENCE_BODY = 'short answers please'

function populated(): CliContext {
  const projectDir = tmpDir()
  const home = tmpDir()
  writeMemory(
    projectDir,
    'project.md',
    `- [2026-08-07] ${PROJECT_BODY}\n  <!-- src:s1 conf:high -->\n`,
  )
  writeMemory(
    projectDir,
    'correction.md',
    `- [2026-08-06] ${CORRECTION_BODY}\n  <!-- src:s2 conf:high -->\n`,
  )
  writeMemory(
    home,
    'preference.md',
    `- [2026-08-04] ${PREFERENCE_BODY}\n  <!-- src:manual conf:medium -->\n`,
  )
  return makeCtx(projectDir, home)
}

describe('runMemoryContext', () => {
  it('prints the injection block with every fact under the default budget', () => {
    const { text, exitCode } = runMemoryContext(populated())

    expect(exitCode).toBe(0)
    expect(text).toContain('# lumem memory')
    expect(text).toContain('## corrections')
    expect(text).toContain(`- [2026-08-06] ${CORRECTION_BODY}`)
    expect(text).toContain('## project')
    expect(text).toContain(`- [2026-08-07] ${PROJECT_BODY}`)
    expect(text).toContain('## preferences')
    expect(text).toContain(`- [2026-08-04] ${PREFERENCE_BODY}`)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(4096)
  })

  it('respects a small budgetBytes — truncation is observable', () => {
    const ctx = populated()
    const full = runMemoryContext(ctx).text
    // 15 (doc header) + 15 ('## corrections') + 36 (correction bullet) = 66 bytes;
    // the next section would need 43 more, so it must be dropped.
    const { text, exitCode } = runMemoryContext(ctx, { budgetBytes: 100 })

    expect(exitCode).toBe(0)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(100)
    expect(text.length).toBeLessThan(full.length)
    expect(text).toContain(CORRECTION_BODY)
    expect(text).not.toContain(PROJECT_BODY)
    expect(text).not.toContain(PREFERENCE_BODY)
  })

  it('never emits more bytes than a tiny budget allows', () => {
    const { text, exitCode } = runMemoryContext(populated(), { budgetBytes: 10 })
    expect(exitCode).toBe(0)
    expect(text).toBe('')
  })

  it('returns an empty string and exit 0 when there is no .lumem at all', () => {
    const { text, exitCode } = runMemoryContext(makeCtx(tmpDir(), tmpDir()))
    expect(text).toBe('')
    expect(exitCode).toBe(0)
  })

  it('returns an empty string when .lumem exists but holds no fact', () => {
    const projectDir = tmpDir()
    writeMemory(projectDir, 'project.md', '')
    const { text, exitCode } = runMemoryContext(makeCtx(projectDir, tmpDir()))
    expect(text).toBe('')
    expect(exitCode).toBe(0)
  })

  it('never throws on a malformed memory file (hook path stays fail-open)', () => {
    const projectDir = tmpDir()
    writeMemory(projectDir, 'project.md', 'lixo solto\n- [ontem] data quebrada\n')
    const { text, exitCode } = runMemoryContext(makeCtx(projectDir, tmpDir()))
    expect(text).toBe('')
    expect(exitCode).toBe(0)
  })
})

describe('registerMemoryContextCommand', () => {
  function wire(ctx: CliContext): { parent: Command } {
    const parent = new Command()
    parent.exitOverride()
    const memoryCmd = parent.command('memory')
    registerMemoryContextCommand(memoryCmd, () => ctx)
    return { parent }
  }

  async function run(parent: Command, argv: string[]): Promise<{ out: string; code: unknown }> {
    const previous = process.exitCode
    process.exitCode = undefined
    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    })
    try {
      await parent.parseAsync(argv, { from: 'user' })
      return { out: chunks.join(''), code: process.exitCode }
    } finally {
      spy.mockRestore()
      process.exitCode = previous
    }
  }

  it('registers context as a subcommand of memory', () => {
    const { parent } = wire(populated())
    const memoryCmd = parent.commands.find((c) => c.name() === 'memory')
    expect(memoryCmd?.commands.map((c) => c.name())).toContain('context')
  })

  it('writes the raw injection text to stdout, with no JSON wrapper or decoration', async () => {
    const ctx = populated()
    const { parent } = wire(ctx)
    const { out, code } = await run(parent, ['memory', 'context'])

    expect(out).toBe(runMemoryContext(ctx).text)
    expect(out.startsWith('# lumem memory\n')).toBe(true)
    expect(code).toBe(0)
  })

  it('ignores ctx.json — the hook consumes raw text', async () => {
    const ctx = { ...populated(), json: true }
    const { parent } = wire(ctx)
    const { out } = await run(parent, ['memory', 'context'])
    expect(out).toBe(runMemoryContext(ctx).text)
    expect(out).not.toContain('{')
  })

  it('prints nothing and exits 0 when there is no memory', async () => {
    const { parent } = wire(makeCtx(tmpDir(), tmpDir()))
    const { out, code } = await run(parent, ['memory', 'context'])
    expect(out).toBe('')
    expect(code).toBe(0)
  })
})

describe('memory context matches what the hook injects', () => {
  it('includes the docs pointer when the project has ADRs', () => {
    const ctx = makeCtx(tmpDir(), tmpDir())
    fs.mkdirSync(path.join(ctx.projectDir, 'docs', 'adr'), { recursive: true })
    fs.writeFileSync(
      path.join(ctx.projectDir, 'docs', 'adr', '2026-08-08-cookie-sessions.md'),
      '---\ntitle: Session cookies over JWT\n---\n',
    )

    // This command is what skill-only mode runs in place of the hook, so a
    // block that differs from the injected one would mislead exactly the
    // agents that cannot rely on hooks.
    expect(runMemoryContext(ctx).text).toContain('docs/adr/')
  })

  it('omits it when the project has none', () => {
    expect(runMemoryContext(makeCtx(tmpDir(), tmpDir())).text).not.toContain('docs/adr/')
  })
})
