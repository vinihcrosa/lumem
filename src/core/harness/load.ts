import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ZodError } from 'zod'
import { type AdapterDescriptor, adapterDescriptorSchema } from '../../adapters/schema'

export interface DescriptorError {
  file: string
  message: string
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const formatZodError = (error: ZodError): string =>
  error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ')

export function loadDescriptors(dir: string): {
  descriptors: AdapterDescriptor[]
  errors: DescriptorError[]
} {
  const descriptors: AdapterDescriptor[] = []
  const errors: DescriptorError[] = []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (err) {
    errors.push({ file: dir, message: `cannot read directory: ${errorMessage(err)}` })
    return { descriptors, errors }
  }

  for (const name of entries.filter((entry) => entry.endsWith('.json')).sort()) {
    const file = join(dir, name)

    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      errors.push({ file, message: `cannot read file: ${errorMessage(err)}` })
      continue
    }

    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch (err) {
      errors.push({ file, message: `invalid JSON: ${errorMessage(err)}` })
      continue
    }

    const result = adapterDescriptorSchema.safeParse(data)
    if (result.success) {
      descriptors.push(result.data)
    } else {
      errors.push({ file, message: formatZodError(result.error) })
    }
  }

  return { descriptors, errors }
}
