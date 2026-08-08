import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { RunLlm } from '../src/core/consolidate/run'
import { MOCK_DIR } from './fixtures'

/**
 * A canned response is either the raw stdout a model would print (use this to
 * exercise fences, preamble and outright garbage) or the patch object itself,
 * which is far easier to read and gets serialized on load.
 */
const mockFileSchema = z
  .object({
    description: z.string().min(1),
    responses: z.array(z.union([z.string(), z.record(z.unknown())])).min(1),
  })
  .strict()

/**
 * Load `<dir>/<fixture>.json` and normalize every entry to a raw stdout string.
 * A missing file is an error, not an empty replay: silently running a fixture
 * against no response would look like a passing mock run.
 */
export function loadMockResponses(fixture: string, dir: string = MOCK_DIR): string[] {
  const file = path.join(dir, `${fixture}.json`)

  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(`fixture '${fixture}': no mock response file at ${file}`)
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new Error(`fixture '${fixture}': ${file} is not valid JSON: ${message(err)}`)
  }

  const parsed = mockFileSchema.safeParse(data)
  if (!parsed.success) {
    throw new Error(
      `fixture '${fixture}': invalid mock file ${file}: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    )
  }

  return parsed.data.responses.map((entry) =>
    typeof entry === 'string' ? entry : JSON.stringify(entry),
  )
}

/**
 * A `RunLlm` that returns one canned response and never spawns anything. Run `i`
 * replays `responses[i % responses.length]`, so k runs over a file with several
 * variants reproduce a spread the variance metric can measure — deterministically.
 */
export function replayLlm(responses: string[], index: number): RunLlm {
  const stdout = responses[index % responses.length] ?? ''
  return () => ({ ok: true, stdout, stderr: '' })
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
