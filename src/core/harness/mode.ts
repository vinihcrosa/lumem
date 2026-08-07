import type { AdapterDescriptor } from '../../adapters/schema'

/**
 * Structural twin of `DetectionResult` from src/core/harness/detect.ts (T5, in flight).
 * Defined locally because detect.ts does not exist yet; T7 reconciles the two.
 */
export interface DetectionInput {
  detected: boolean
  matchedRules: number
  version?: string
  binPath?: string
}

export interface OperatingMode {
  harness: string
  detected: boolean
  version?: string
  grade: 'full' | 'degraded' | 'skill-only' | 'unavailable'
  missing: string[]
  fallbacks: Record<string, string>
  warnings: string[]
}

const HOOK_CAPABILITIES = [
  'hooks.sessionStart',
  'hooks.sessionEnd',
  'hooks.userPromptSubmit',
  'hooks.postToolUse',
] as const

const toSegments = (version: string): number[] =>
  version
    .replace(/-.*$/, '')
    .split('.')
    .map((segment) => {
      const value = Number.parseInt(segment.replace(/^\D*/, ''), 10)
      return Number.isNaN(value) ? 0 : value
    })

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = toSegments(a)
  const right = toSegments(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l < r) return -1
    if (l > r) return 1
  }
  return 0
}

const nonHookInjection = (descriptor: AdapterDescriptor): string =>
  descriptor.injection.find((mechanism) => mechanism !== 'hook-stdout') ?? 'skill-instruction'

export function resolveMode(
  descriptor: AdapterDescriptor,
  detection: DetectionInput,
): OperatingMode {
  const mode: OperatingMode = {
    harness: descriptor.id,
    detected: detection.detected,
    grade: 'unavailable',
    missing: [],
    fallbacks: {},
    warnings: [],
  }

  if (!detection.detected) {
    return mode
  }

  if (detection.version !== undefined) {
    mode.version = detection.version
  }

  const capabilities = descriptor.capabilities
  const missingHooks = HOOK_CAPABILITIES.filter((key) => !capabilities[key])

  if (missingHooks.length === 0) {
    mode.grade = 'full'
  } else if (missingHooks.length === HOOK_CAPABILITIES.length) {
    mode.grade = 'skill-only'
  } else {
    mode.grade = 'degraded'
  }

  mode.missing.push(...missingHooks)

  if (!capabilities['hooks.sessionStart']) {
    mode.fallbacks.injection = nonHookInjection(descriptor)
  }
  if (!capabilities['hooks.sessionEnd']) {
    mode.fallbacks.consolidation = 'manual'
  }
  if (!capabilities['hooks.userPromptSubmit'] || !capabilities['hooks.postToolUse']) {
    mode.fallbacks.capture = 'skill-instruction'
  }

  if (!capabilities['hooks.envProjectDir']) {
    mode.fallbacks.projectResolution = 'stdin-cwd'
  }

  if (
    detection.version !== undefined &&
    compareVersions(detection.version, descriptor.minVersion) < 0
  ) {
    mode.warnings.push(
      `detected version ${detection.version} is below the minimum supported version ${descriptor.minVersion}`,
    )
    mode.missing.push('minVersion')
    if (mode.grade === 'full') {
      mode.grade = 'degraded'
    }
  }

  if (capabilities['hooks.requiresTrust']) {
    mode.warnings.push(
      'this harness requires trusting hooks before they run; open /hooks to review and approve them',
    )
  }

  return mode
}
