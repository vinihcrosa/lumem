import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { defaultConfig, writeConfig } from '../src/core/config'
import type { FixtureSpec } from './types'

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const FIXTURES_DIR = path.join(REPO_ROOT, 'eval', 'fixtures')
export const MOCK_DIR = path.join(REPO_ROOT, 'eval', 'mock-responses')
export const ADAPTERS_DIR = path.join(REPO_ROOT, 'src', 'adapters')
export const ASSETS_DIR = path.join(REPO_ROOT, 'assets')

/** The harness whose descriptor drives the headless command in real mode. */
export const DEFAULT_HARNESS_ID = 'claude-code'

const expectationsSchema = z
  .object({
    emptyPatch: z.boolean().optional(),
    maxAdds: z.number().int().nonnegative().optional(),
    minAdds: z.number().int().nonnegative().optional(),
    mustNotContain: z.array(z.string().min(1)).optional(),
    mustReplaceId: z
      .string()
      .regex(/^[0-9a-f]{8}$/)
      .optional(),
    noSecrets: z.boolean().optional(),
    shouldMentionAny: z.array(z.string().min(1)).optional(),
    mustAddTypeScope: z
      .array(
        z.enum(['project/project', 'correction/project', 'preference/global', 'correction/global']),
      )
      .optional(),
  })
  .strict()

const fixtureFileSchema = z
  .object({ description: z.string().min(10), expect: expectationsSchema })
  .strict()

/**
 * Which fixture memory file lands where. A fixture only names the file; the
 * scope is implied by the layout, exactly as `memoryLayout` defines it.
 */
const MEMORY_TARGETS: Record<string, { scope: 'project' | 'global'; file: string }> = {
  'project.md': { scope: 'project', file: 'project.md' },
  'correction.md': { scope: 'project', file: 'correction.md' },
  'preference.md': { scope: 'global', file: 'preference.md' },
  'global-correction.md': { scope: 'global', file: 'correction.md' },
}

export const MEMORY_FILE_NAMES = Object.keys(MEMORY_TARGETS)

/** Fixture directory names, sorted, so a run order never depends on the filesystem. */
export function listFixtures(dir: string = FIXTURES_DIR): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/** Load and validate one fixture's `expect.json`. Throws with the fixture named. */
export function loadFixture(name: string, dir: string = FIXTURES_DIR): FixtureSpec {
  const fixtureDir = path.join(dir, name)
  const file = path.join(fixtureDir, 'expect.json')

  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(`fixture '${name}': ${file} not found`)
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new Error(`fixture '${name}': ${file} is not valid JSON: ${message(err)}`)
  }

  const parsed = fixtureFileSchema.safeParse(data)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue === undefined ? '' : issue.path.join('.')
    throw new Error(
      `fixture '${name}': invalid expect.json${at === '' ? '' : ` at ${at}`}: ${
        issue?.message ?? 'unknown'
      }`,
    )
  }

  if (!fs.existsSync(path.join(fixtureDir, 'journal.jsonl'))) {
    throw new Error(`fixture '${name}': journal.jsonl not found`)
  }

  return { name, dir: fixtureDir, description: parsed.data.description, expect: parsed.data.expect }
}

/** A fixture unpacked into a throwaway project. Nothing here touches the real repo. */
export interface MaterializedFixture {
  root: string
  projectDir: string
  homeDir: string
  sessionFile: string
  cleanup: () => void
}

/**
 * Build a complete, gate-passing project from a fixture in a temp directory:
 * config, journal under `local/sessions/`, and whichever memory files the
 * fixture ships. The adapters and the skill asset come from the real repo — the
 * point of the harness is to measure the shipped prompt, not a copy of it.
 */
export function materializeFixture(
  spec: FixtureSpec,
  opts?: { harnessId?: string; tmpDir?: string },
): MaterializedFixture {
  const harnessId = opts?.harnessId ?? DEFAULT_HARNESS_ID
  const root = fs.mkdtempSync(path.join(opts?.tmpDir ?? os.tmpdir(), 'lumem-eval-'))
  const projectDir = path.join(root, 'repo')
  const homeDir = path.join(root, 'home')
  const lumemDir = path.join(projectDir, '.lumem')
  const sessionFile = path.join(lumemDir, 'local', 'sessions', `${spec.name}.jsonl`)

  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
  fs.mkdirSync(path.join(homeDir, '.lumem', 'memory'), { recursive: true })
  fs.mkdirSync(path.join(lumemDir, 'memory'), { recursive: true })

  fs.copyFileSync(path.join(spec.dir, 'journal.jsonl'), sessionFile)
  writeConfig(lumemDir, defaultConfig([{ id: harnessId, minVersion: '0.0.0' }]))

  const memoryDir = path.join(spec.dir, 'memory')
  if (fs.existsSync(memoryDir)) {
    for (const entry of fs.readdirSync(memoryDir)) {
      const target = MEMORY_TARGETS[entry]
      if (target === undefined) {
        fs.rmSync(root, { recursive: true, force: true })
        throw new Error(
          `fixture '${spec.name}': unknown memory file '${entry}'; expected one of ${MEMORY_FILE_NAMES.join(', ')}`,
        )
      }
      const base = target.scope === 'project' ? lumemDir : path.join(homeDir, '.lumem')
      fs.copyFileSync(path.join(memoryDir, entry), path.join(base, 'memory', target.file))
    }
  }

  return {
    root,
    projectDir,
    homeDir,
    sessionFile,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
