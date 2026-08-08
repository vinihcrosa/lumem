import fs from 'node:fs'
import path from 'node:path'
import { type ZodError, z } from 'zod'
import { DEFAULT_CORRECTION_MARKERS } from './capture/heuristics'
import { DEFAULT_GATE_CONFIG, type GateConfig } from './consolidate/gate'
import { DEFAULT_FILE_BUDGETS, type FileBudgets } from './memory/limits'
import { atomicWrite } from './shared/fsx'

/** How one harness is configured in this project. */
export interface HarnessConfig {
  minVersion: string
  installMode: 'symlink' | 'copy'
  scope: 'project' | 'global'
}

/**
 * Project configuration, at `<projectDir>/.lumem/lumem.config.json`.
 *
 * Every default comes from the module that owns the concept (budgets from
 * memory/limits, gate from consolidate/gate, markers from capture/heuristics),
 * so there is exactly one place where each number lives.
 */
export interface LumemConfig {
  version: 1
  budgets: {
    /** Ceiling for one injected memory block, in bytes. */
    injectionBytes: number
    files: FileBudgets
  }
  gate: GateConfig
  consolidation: {
    enabled: boolean
    /** `'auto'` picks the runtime from the detected harnesses; anything else names one. */
    runtime: 'auto' | string
    model?: string
  }
  harnesses: Record<string, HarnessConfig>
  heuristics: { correctionMarkers: string[] }
}

export const CONFIG_FILE_NAME = 'lumem.config.json'

/** PRD §5.4: one injected block never exceeds 4 KB. */
const DEFAULT_INJECTION_BYTES = 4096

const fileBudgetSchema = z
  .object({
    lines: z.number().int().positive(),
    bytes: z.number().int().positive(),
  })
  .strict()

const harnessConfigSchema = z
  .object({
    minVersion: z.string().min(1),
    installMode: z.enum(['symlink', 'copy']),
    scope: z.enum(['project', 'global']),
  })
  .strict()

export const lumemConfigSchema: z.ZodType<LumemConfig> = z
  .object({
    version: z.literal(1),
    budgets: z
      .object({
        injectionBytes: z.number().int().positive(),
        files: z
          .object({
            project: fileBudgetSchema,
            correction: fileBudgetSchema,
            preference: fileBudgetSchema,
          })
          .strict(),
      })
      .strict(),
    gate: z
      .object({
        minSignals: z.number().int().nonnegative(),
        minDurationMin: z.number().nonnegative(),
        minHoursBetween: z.number().nonnegative(),
        lockTtlMin: z.number().positive(),
      })
      .strict(),
    consolidation: z
      .object({
        enabled: z.boolean(),
        runtime: z.string().min(1),
        model: z.string().min(1).optional(),
      })
      .strict(),
    harnesses: z.record(harnessConfigSchema),
    heuristics: z.object({ correctionMarkers: z.array(z.string()) }).strict(),
  })
  .strict()

function configPath(lumemDir: string): string {
  return path.join(lumemDir, CONFIG_FILE_NAME)
}

/**
 * The config a fresh project starts with: every value taken from the constant
 * that owns it, deep-copied so mutating the result can never reach back into a
 * shared default.
 */
export function defaultConfig(harnesses: { id: string; minVersion: string }[]): LumemConfig {
  const entries: Record<string, HarnessConfig> = {}
  for (const harness of [...harnesses].sort((a, b) => compareKeys(a.id, b.id))) {
    entries[harness.id] = {
      minVersion: harness.minVersion,
      installMode: 'symlink',
      scope: 'project',
    }
  }

  return {
    version: 1,
    budgets: {
      injectionBytes: DEFAULT_INJECTION_BYTES,
      files: {
        project: { ...DEFAULT_FILE_BUDGETS.project },
        correction: { ...DEFAULT_FILE_BUDGETS.correction },
        preference: { ...DEFAULT_FILE_BUDGETS.preference },
      },
    },
    gate: { ...DEFAULT_GATE_CONFIG },
    consolidation: { enabled: true, runtime: 'auto' },
    harnesses: entries,
    heuristics: { correctionMarkers: [...DEFAULT_CORRECTION_MARKERS] },
  }
}

/**
 * Read and validate `<lumemDir>/lumem.config.json`. Never throws: a missing
 * file, unparseable JSON, and a schema violation each come back as an `error`
 * naming what is wrong and — for schema violations — where.
 */
export function readConfig(lumemDir: string): { config?: LumemConfig; error?: string } {
  const file = configPath(lumemDir)

  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    const reason =
      (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : errorMessage(err)
    return { error: `${file}: ${reason}` }
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    return { error: `${file}: invalid JSON: ${errorMessage(err)}` }
  }

  const result = lumemConfigSchema.safeParse(data)
  if (!result.success) {
    return { error: `${file}: ${formatZodError(result.error)}` }
  }
  return { config: result.data }
}

/**
 * Write the config atomically with a stable key order, sorted harness ids,
 * 2-space indentation and a trailing newline, so the same config always
 * produces a byte-identical file.
 */
export function writeConfig(lumemDir: string, config: LumemConfig): void {
  atomicWrite(configPath(lumemDir), `${JSON.stringify(normalize(config), null, 2)}\n`)
}

function normalize(config: LumemConfig): unknown {
  const { budgets, gate, consolidation, heuristics } = config
  return {
    version: config.version,
    budgets: {
      injectionBytes: budgets.injectionBytes,
      files: {
        project: { lines: budgets.files.project.lines, bytes: budgets.files.project.bytes },
        correction: {
          lines: budgets.files.correction.lines,
          bytes: budgets.files.correction.bytes,
        },
        preference: {
          lines: budgets.files.preference.lines,
          bytes: budgets.files.preference.bytes,
        },
      },
    },
    gate: {
      minSignals: gate.minSignals,
      minDurationMin: gate.minDurationMin,
      minHoursBetween: gate.minHoursBetween,
      lockTtlMin: gate.lockTtlMin,
    },
    consolidation: {
      enabled: consolidation.enabled,
      runtime: consolidation.runtime,
      ...(consolidation.model !== undefined ? { model: consolidation.model } : {}),
    },
    harnesses: Object.fromEntries(
      Object.entries(config.harnesses)
        .sort(([a], [b]) => compareKeys(a, b))
        .map(([id, entry]) => [
          id,
          { minVersion: entry.minVersion, installMode: entry.installMode, scope: entry.scope },
        ]),
    ),
    heuristics: { correctionMarkers: [...heuristics.correctionMarkers] },
  }
}

/** Code-unit order, not locale order: the output must not depend on the machine. */
function compareKeys(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const formatZodError = (error: ZodError): string =>
  error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ')
