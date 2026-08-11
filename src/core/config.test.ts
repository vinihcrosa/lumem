import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CORRECTION_MARKERS } from './capture/heuristics'
import {
  CONFIG_FILE_NAME,
  type LumemConfig,
  defaultConfig,
  lumemConfigSchema,
  readConfig,
  writeConfig,
} from './config'
import { DEFAULT_GATE_CONFIG } from './consolidate/gate'
import { DEFAULT_FILE_BUDGETS } from './memory/limits'
import { DEFAULT_VERIFICATION, defaultVerification } from './verification'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-config-'))
}

function configFile(dir: string): string {
  return path.join(dir, CONFIG_FILE_NAME)
}

const HARNESSES = [
  { id: 'claude-code', minVersion: '2.1.224' },
  { id: 'codex', minVersion: '0.147.0' },
]

describe('defaultConfig', () => {
  it('mirrors the shared constants instead of restating them', () => {
    const config = defaultConfig(HARNESSES)

    expect(config.version).toBe(1)
    expect(config.budgets.files).toEqual(DEFAULT_FILE_BUDGETS)
    expect(config.gate).toEqual(DEFAULT_GATE_CONFIG)
    expect(config.heuristics.correctionMarkers).toEqual(DEFAULT_CORRECTION_MARKERS)
  })

  it('budgets injection at 4096 bytes and enables auto consolidation', () => {
    const config = defaultConfig([])

    expect(config.budgets.injectionBytes).toBe(4096)
    expect(config.consolidation).toEqual({ enabled: true, runtime: 'auto' })
    expect(config.consolidation.model).toBeUndefined()
  })

  it('adds one symlink/project entry per harness', () => {
    const config = defaultConfig(HARNESSES)

    expect(Object.keys(config.harnesses)).toEqual(['claude-code', 'codex'])
    expect(config.harnesses['claude-code']).toEqual({
      minVersion: '2.1.224',
      installMode: 'symlink',
      scope: 'project',
    })
    expect(config.harnesses.codex?.minVersion).toBe('0.147.0')
  })

  it('leaves harnesses empty when none is given', () => {
    expect(defaultConfig([]).harnesses).toEqual({})
  })

  it('copies the shared constants — mutating the result never leaks into them', () => {
    const config = defaultConfig(HARNESSES)

    config.budgets.files.project.lines = 1
    config.gate.minSignals = 999
    config.heuristics.correctionMarkers.push('mutated')

    expect(DEFAULT_FILE_BUDGETS.project.lines).not.toBe(1)
    expect(DEFAULT_GATE_CONFIG.minSignals).not.toBe(999)
    expect(DEFAULT_CORRECTION_MARKERS).not.toContain('mutated')
  })
})

describe('lumemConfigSchema', () => {
  it('accepts the default config', () => {
    expect(lumemConfigSchema.safeParse(defaultConfig(HARNESSES)).success).toBe(true)
  })

  it('rejects an unknown top-level key', () => {
    const broken = { ...defaultConfig([]), surprise: true }
    expect(lumemConfigSchema.safeParse(broken).success).toBe(false)
  })
})

describe('writeConfig / readConfig', () => {
  it('round-trips a config through disk', () => {
    const dir = tmpDir()
    const config = defaultConfig(HARNESSES)

    writeConfig(dir, config)
    const { config: read, error } = readConfig(dir)

    expect(error).toBeUndefined()
    expect(read).toEqual(config)
  })

  it('round-trips the optional consolidation model', () => {
    const dir = tmpDir()
    const config: LumemConfig = {
      ...defaultConfig(HARNESSES),
      consolidation: { enabled: false, runtime: 'claude-code', model: 'haiku' },
    }

    writeConfig(dir, config)

    expect(readConfig(dir).config).toEqual(config)
  })

  it('writes 2-space JSON with a trailing newline', () => {
    const dir = tmpDir()
    writeConfig(dir, defaultConfig(HARNESSES))

    const raw = fs.readFileSync(configFile(dir), 'utf8')
    expect(raw.endsWith('}\n')).toBe(true)
    expect(raw).toContain('\n  "version": 1')
  })

  it('is byte-identical across two writes of the same config', () => {
    const a = tmpDir()
    const b = tmpDir()
    const config = defaultConfig(HARNESSES)

    writeConfig(a, config)
    writeConfig(b, config)
    writeConfig(a, config)

    expect(fs.readFileSync(configFile(a))).toEqual(fs.readFileSync(configFile(b)))
  })

  it('serializes harness keys in a stable order regardless of insertion order', () => {
    const a = tmpDir()
    const b = tmpDir()

    writeConfig(a, defaultConfig([...HARNESSES]))
    writeConfig(b, defaultConfig([...HARNESSES].reverse()))

    expect(fs.readFileSync(configFile(a), 'utf8')).toBe(fs.readFileSync(configFile(b), 'utf8'))
  })
})

describe('readConfig failures', () => {
  it('reports a missing file without throwing', () => {
    const dir = tmpDir()

    expect(() => readConfig(dir)).not.toThrow()
    const { config, error } = readConfig(dir)
    expect(config).toBeUndefined()
    expect(error).toContain(CONFIG_FILE_NAME)
    expect(error).toMatch(/not found|missing/i)
  })

  it('names the problem on malformed JSON', () => {
    const dir = tmpDir()
    fs.writeFileSync(configFile(dir), '{ "version": 1, oops')

    const { config, error } = readConfig(dir)
    expect(config).toBeUndefined()
    expect(error).toMatch(/JSON/i)
  })

  it('names the field path on a schema violation', () => {
    const dir = tmpDir()
    const broken = defaultConfig(HARNESSES) as unknown as Record<string, unknown>
    broken.budgets = { injectionBytes: 'lots', files: DEFAULT_FILE_BUDGETS }
    fs.writeFileSync(configFile(dir), JSON.stringify(broken, null, 2))

    const { config, error } = readConfig(dir)
    expect(config).toBeUndefined()
    expect(error).toContain('budgets.injectionBytes')
  })

  it('names a nested harness field path', () => {
    const dir = tmpDir()
    const broken = defaultConfig(HARNESSES) as unknown as {
      harnesses: Record<string, Record<string, unknown>>
    }
    broken.harnesses['claude-code'] = { minVersion: '1.0.0', installMode: 'hardlink' }
    fs.writeFileSync(configFile(dir), JSON.stringify(broken, null, 2))

    const { error } = readConfig(dir)
    expect(error).toContain('harnesses.claude-code.installMode')
  })

  it('rejects a config whose top-level shape is not an object', () => {
    const dir = tmpDir()
    fs.writeFileSync(configFile(dir), '[]')

    const { config, error } = readConfig(dir)
    expect(config).toBeUndefined()
    expect(error).toBeDefined()
  })
})

describe('the verification block (003 T1)', () => {
  it('UT-61 parses a config that has no verification block at all', () => {
    const dir = tmpDir()
    const config = defaultConfig(HARNESSES)
    writeConfig(dir, config)

    const { config: read, error } = readConfig(dir)

    expect(error).toBeUndefined()
    expect(read?.verification).toBeUndefined()
    // Absence is not a hole to be filled here: a caller wanting settings asks
    // `defaultVerification()`, so nothing has to guess what the author meant.
    expect(defaultVerification().testSuffixes).toEqual(['.test.ts'])
  })

  it('UT-62 fills the list fields when only a command is given', () => {
    const raw = { ...defaultConfig(HARNESSES), verification: { command: 'npm run verify' } }
    const parsed = lumemConfigSchema.safeParse(raw)

    expect(parsed.success).toBe(true)
    const verification = parsed.success ? parsed.data.verification : undefined
    expect(verification?.command).toBe('npm run verify')
    expect(verification?.fingerprintInclude).toEqual(DEFAULT_VERIFICATION.fingerprintInclude)
    expect(verification?.fingerprintExclude).toContain('docs')
    expect(verification?.testPatterns).toEqual(DEFAULT_VERIFICATION.testPatterns)
  })

  it('UT-62 lets a configured list replace the default rather than extend it', () => {
    const raw = {
      ...defaultConfig(HARNESSES),
      verification: { testSuffixes: ['_test.go'] },
    }
    const parsed = lumemConfigSchema.safeParse(raw)

    expect(parsed.success).toBe(true)
    const verification = parsed.success ? parsed.data.verification : undefined
    expect(verification?.testSuffixes).toEqual(['_test.go'])
    expect(verification?.testSuffixes).not.toContain('.test.ts')
  })

  it('UT-63 rejects an unknown key inside verification, naming it', () => {
    const raw = {
      ...defaultConfig(HARNESSES),
      verification: { command: 'x', nonsense: true },
    }
    const parsed = lumemConfigSchema.safeParse(raw)

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain('nonsense')
    }
  })

  it('UT-64 round-trips a verification block byte-identically', () => {
    const dir = tmpDir()
    const config: LumemConfig = {
      ...defaultConfig(HARNESSES),
      verification: { ...defaultVerification(), command: 'npm run verify' },
    }
    writeConfig(dir, config)
    const first = fs.readFileSync(configFile(dir), 'utf8')

    const { config: read, error } = readConfig(dir)
    expect(error).toBeUndefined()
    expect(read?.verification?.command).toBe('npm run verify')

    writeConfig(dir, read as LumemConfig)
    expect(fs.readFileSync(configFile(dir), 'utf8')).toBe(first)
  })

  it('UT-65 omits the key entirely when the block is absent', () => {
    const dir = tmpDir()
    writeConfig(dir, defaultConfig(HARNESSES))
    const text = fs.readFileSync(configFile(dir), 'utf8')

    expect(text).not.toContain('verification')
    expect(text).not.toContain('null')
    // defaultConfig must not invent a command: a project with no gate is
    // unverifiable, and assuming otherwise is the failure 003 exists to close.
    expect(defaultConfig(HARNESSES).verification).toBeUndefined()
  })
})
