import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface CliContext {
  /** Project root the command operates on. Defaults to process.cwd(). */
  projectDir: string
  /** Directory containing the adapter descriptor JSON files. */
  adaptersDir: string
  /** Environment slice injected into detection (never read process.env deeper down). */
  env: { PATH?: string; HOME?: string }
  /** Emit machine-readable JSON instead of human text. */
  json: boolean
}

function containsJson(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.endsWith('.json'))
  } catch {
    return false
  }
}

/**
 * Locate the adapters directory. Candidates, first that exists and contains
 * at least one .json file wins:
 *   1. $LUMEM_ADAPTERS_DIR (explicit override)
 *   2. ../adapters relative to this module — dev layout (src/cli → src/adapters)
 *   3. ../src/adapters relative to this module — packaged layout (dist/cli.js → <pkg>/src/adapters)
 */
export function resolveAdaptersDir(): string {
  const candidates: string[] = []
  if (process.env.LUMEM_ADAPTERS_DIR) candidates.push(process.env.LUMEM_ADAPTERS_DIR)
  candidates.push(fileURLToPath(new URL('../adapters', import.meta.url)))
  candidates.push(fileURLToPath(new URL('../src/adapters', import.meta.url)))

  for (const candidate of candidates) {
    if (containsJson(candidate)) return candidate
  }

  throw new Error(
    `could not locate the adapters directory (no candidate contains descriptor .json files); tried: ${candidates.join(
      ', ',
    )}. Set LUMEM_ADAPTERS_DIR to override.`,
  )
}
