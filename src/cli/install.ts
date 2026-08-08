import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Command } from 'commander'
import type { AdapterDescriptor } from '../adapters/schema'
import { CONFIG_FILE_NAME, type LumemConfig, readConfig } from '../core/config'
import { detect } from '../core/harness/detect'
import { loadDescriptors } from '../core/harness/load'
import { applyPlan } from '../core/install/apply'
import { readLock } from '../core/install/lockfile'
import { type ManifestArtifact, buildManifest } from '../core/install/manifest'
import { planInstall } from '../core/install/plan'
import type { CliContext } from './context'

export interface InstallReport {
  /** Harness ids this run installed into, in descriptor order. */
  harnesses: string[]
  /** The plan, exactly as decided before touching the filesystem. */
  actions: { artifactId: string; type: string; destPath: string; reason: string }[]
  applied: { artifactId: string; action: string; destPath: string; backupPath?: string }[]
  skipped: { artifactId: string; reason: string }[]
  errors: { artifactId: string; message: string }[]
  /** Post-install instructions: trust prompts, absent harnesses, scope caveats. */
  notes: string[]
  dryRun: boolean
}

export interface InstallOptions {
  /** Explicit harness ids; defaults to every configured-and-detected harness. */
  harnesses?: string[]
  /** Install into the harness's global scope instead of the project. */
  global?: boolean
  /** Copy artifact bytes instead of symlinking them. */
  copy?: boolean
  /** Overwrite destinations that differ from what lumem installed. */
  force?: boolean
  dryRun?: boolean
}

const LUMEM_DIR = '.lumem'

/** artifactId for failures that abort the whole command rather than one artifact. */
const COMMAND_SCOPE = '*'

// Layout candidates, mirroring resolveAdaptersDir: dev (src/cli → repo root)
// first, packaged (dist/cli.js → package root) second.
const DEV_ASSETS = fileURLToPath(new URL('../../assets', import.meta.url))
const PKG_ASSETS = fileURLToPath(new URL('../assets', import.meta.url))
const DEV_DIST = fileURLToPath(new URL('../../dist', import.meta.url))
const PKG_DIST = fileURLToPath(new URL('../dist', import.meta.url))

interface InstallDirs {
  assetsDir?: string
  distDir?: string
}

let overrides: InstallDirs = {}

/**
 * Point the asset and dist resolvers at explicit directories — the seam tests
 * use to run against fixtures instead of the real package. Call with `{}` to
 * restore normal resolution.
 */
export function setInstallDirs(dirs: InstallDirs): void {
  overrides = { ...dirs }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function explicitDir(override: string | undefined, envVar: string): string | undefined {
  if (override !== undefined && override !== '') return override
  const fromEnv = process.env[envVar]
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined
}

/**
 * Locate the packaged `assets/` directory (skills, agents, harness templates).
 * `setInstallDirs` wins, then `$LUMEM_ASSETS_DIR`, then the dev and packaged
 * layouts — a candidate counts only when it holds a `skills/` directory.
 */
export function resolveAssetsDir(): string {
  const explicit = explicitDir(overrides.assetsDir, 'LUMEM_ASSETS_DIR')
  if (explicit !== undefined) return explicit

  const candidates = [DEV_ASSETS, PKG_ASSETS]
  const found = candidates.find((dir) => isDirectory(path.join(dir, 'skills')))
  if (found === undefined) {
    throw new Error(
      `could not locate the assets directory (no candidate contains a skills/ directory); tried: ${candidates.join(
        ', ',
      )}. Set LUMEM_ASSETS_DIR to override.`,
    )
  }
  return found
}

/**
 * Locate the built bundle directory. Same precedence as `resolveAssetsDir`, but
 * an existing directory is enough: a dist without `lumem-hook.mjs` is
 * buildManifest's error to report ("run the build first"), not this function's.
 */
export function resolveDistDir(): string {
  const explicit = explicitDir(overrides.distDir, 'LUMEM_DIST_DIR')
  if (explicit !== undefined) return explicit
  return [DEV_DIST, PKG_DIST].find(isDirectory) ?? DEV_DIST
}

/** Version stamped on every manifest artifact; unknown outside the package. */
function resolveVersion(): string {
  for (const relative of ['../../package.json', '../package.json']) {
    try {
      const raw = fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
      const pkg = JSON.parse(raw) as { name?: string; version?: string }
      if (pkg.name === 'lumem' && typeof pkg.version === 'string') return pkg.version
    } catch {
      // not this layout: try the next candidate
    }
  }
  return '0.0.0'
}

function expandTilde(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return path.join(home, p.slice(2))
  return p
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Explicit ids win over detection — you may install into a harness before it is
 * present. Without them, every configured-and-detected harness is selected.
 */
function selectDescriptors(
  all: AdapterDescriptor[],
  configured: Set<string>,
  detected: Set<string>,
  requested: string[] | undefined,
): { descriptors: AdapterDescriptor[]; unknown: string[] } {
  if (requested === undefined) {
    return {
      descriptors: all.filter((d) => configured.has(d.id) && detected.has(d.id)),
      unknown: [],
    }
  }

  const known = new Map(all.map((d) => [d.id, d]))
  const wanted = [...new Set(requested)]
  return {
    descriptors: wanted.flatMap((id) => {
      const descriptor = known.get(id)
      return descriptor === undefined ? [] : [descriptor]
    }),
    unknown: wanted.filter((id) => !known.has(id)),
  }
}

/**
 * A single mode applies to the whole plan, so the flag wins and the config only
 * decides when every selected harness agrees on `copy`.
 */
function resolveInstallMode(
  config: LumemConfig,
  selected: AdapterDescriptor[],
  copy: boolean,
): 'symlink' | 'copy' {
  if (copy) return 'copy'
  const entries = selected.flatMap((d) => {
    const entry = config.harnesses[d.id]
    return entry === undefined ? [] : [entry]
  })
  return entries.length > 0 && entries.every((entry) => entry.installMode === 'copy')
    ? 'copy'
    : 'symlink'
}

/**
 * Retarget the project-scoped manifest at each harness's global scope: skills
 * move to `paths.skills.global` under `paths.home` (expanded against the
 * injected HOME). Hook bundles and hook configs stay in the project — the
 * lockfile, the bundles and the hooks that reference them are one unit.
 */
function retargetGlobal(
  artifacts: ManifestArtifact[],
  descriptors: AdapterDescriptor[],
  home: string,
): { artifacts: ManifestArtifact[]; globalDirs: Record<string, string>; notes: string[] } {
  const byId = new Map(descriptors.map((d) => [d.id, d]))
  const globalDirs: Record<string, string> = {}
  for (const descriptor of descriptors) {
    globalDirs[descriptor.id] = expandTilde(descriptor.paths.home, home)
  }

  const notes: string[] = []
  const retargeted = artifacts.map((artifact) => {
    const descriptor = byId.get(artifact.dest.harness)
    if (descriptor === undefined) return artifact

    if (artifact.kind !== 'skill') {
      notes.push(
        `${descriptor.id}: ${artifact.dest.relPath} stays project-scoped — the descriptor declares no global hooks config`,
      )
      return artifact
    }

    const withinSkills = path.posix.relative(descriptor.paths.skills.project, artifact.dest.relPath)
    const skillsFromHome = path.posix.relative(
      descriptor.paths.home,
      descriptor.paths.skills.global,
    )
    return {
      ...artifact,
      dest: {
        ...artifact.dest,
        scope: 'global' as const,
        relPath: path.posix.join(skillsFromHome, withinSkills),
      },
    }
  })

  return { artifacts: retargeted, globalDirs, notes }
}

/**
 * Install the manifest into the selected harnesses: build → plan → apply.
 *
 * Nothing is written before the plan is complete, so every early failure
 * (missing `.lumem`, unknown harness, missing bundles) leaves the project
 * exactly as it was. Conflicts are drift, not failure: they are reported and
 * skipped (exit 3) while a genuine write error exits 1.
 */
export function runInstall(
  ctx: CliContext,
  opts: InstallOptions = {},
): { report: InstallReport; exitCode: number } {
  const dryRun = opts.dryRun === true
  const report: InstallReport = {
    harnesses: [],
    actions: [],
    applied: [],
    skipped: [],
    errors: [],
    notes: [],
    dryRun,
  }

  const lumemDir = path.join(ctx.projectDir, LUMEM_DIR)
  const { config, error } = readConfig(lumemDir)
  if (config === undefined) {
    report.errors.push({
      artifactId: COMMAND_SCOPE,
      message: `${error ?? `${lumemDir}: unreadable`} — run \`lumem init\` in this project first`,
    })
    return { report, exitCode: 1 }
  }

  const { descriptors, errors: descriptorErrors } = loadDescriptors(ctx.adaptersDir)
  for (const descriptorError of descriptorErrors) {
    report.notes.push(`descriptor ${descriptorError.file}: ${descriptorError.message}`)
  }

  const configured = new Set(Object.keys(config.harnesses))
  const detected = new Set(descriptors.filter((d) => detect(d, ctx.env).detected).map((d) => d.id))

  const selection = selectDescriptors(descriptors, configured, detected, opts.harnesses)
  if (selection.unknown.length > 0) {
    const known = descriptors.map((d) => d.id)
    report.errors.push({
      artifactId: COMMAND_SCOPE,
      message: `unknown harness id: ${selection.unknown.join(', ')} — known ids: ${
        known.length > 0 ? known.join(', ') : '(none)'
      }`,
    })
    return { report, exitCode: 1 }
  }

  const selected = selection.descriptors
  const selectedIds = new Set(selected.map((d) => d.id))
  report.harnesses = selected.map((d) => d.id)

  let artifacts: ManifestArtifact[]
  try {
    artifacts = buildManifest({
      assetsDir: resolveAssetsDir(),
      distDir: resolveDistDir(),
      version: resolveVersion(),
      descriptors: selected,
    })
  } catch (err) {
    report.errors.push({ artifactId: COMMAND_SCOPE, message: errorMessage(err) })
    return { report, exitCode: 1 }
  }

  let globalDirs: Record<string, string> = {}
  if (opts.global === true) {
    const home = ctx.env.HOME
    if (home === undefined || home === '') {
      report.errors.push({
        artifactId: COMMAND_SCOPE,
        message: 'HOME is not set — cannot resolve the global scope of any harness',
      })
      return { report, exitCode: 1 }
    }
    const retargeted = retargetGlobal(artifacts, selected, home)
    artifacts = retargeted.artifacts
    globalDirs = retargeted.globalDirs
    report.notes.push(...retargeted.notes)
  }

  const plan = planInstall({
    artifacts,
    lock: readLock(lumemDir),
    projectDir: ctx.projectDir,
    globalDirs,
    mode: resolveInstallMode(config, selected, opts.copy === true),
    ...(opts.force === true ? { force: true } : {}),
  })
  report.actions = plan.actions.map((action) => ({
    artifactId: action.artifactId,
    type: action.type,
    destPath: action.destPath,
    reason: action.reason,
  }))

  const applied = applyPlan({
    plan,
    artifacts,
    lumemDir,
    projectDir: ctx.projectDir,
    ...(dryRun ? { dryRun: true } : {}),
  })
  report.applied = applied.applied.map((entry) => ({
    artifactId: entry.artifactId,
    action: entry.action,
    destPath: entry.destPath,
    ...(entry.backupPath !== undefined ? { backupPath: entry.backupPath } : {}),
  }))
  report.skipped = applied.skipped
  report.errors.push(...applied.errors)

  report.notes.push(...postInstallNotes(config, descriptors, selected, selectedIds, detected))

  const hasConflict = plan.actions.some((action) => action.type === 'conflict')
  return { report, exitCode: report.errors.length > 0 ? 1 : hasConflict ? 3 : 0 }
}

function postInstallNotes(
  config: LumemConfig,
  descriptors: AdapterDescriptor[],
  selected: AdapterDescriptor[],
  selectedIds: Set<string>,
  detected: Set<string>,
): string[] {
  const notes: string[] = []
  const known = new Set(descriptors.map((d) => d.id))

  for (const id of Object.keys(config.harnesses).sort()) {
    if (!known.has(id)) {
      notes.push(`${id}: configured but no adapter descriptor exists for it`)
      continue
    }
    if (detected.has(id)) continue
    notes.push(
      selectedIds.has(id)
        ? `${id}: configured but not detected on this machine — installing anyway`
        : `${id}: configured but not detected on this machine — skipped; pass \`--harness ${id}\` to install anyway`,
    )
  }

  for (const descriptor of selected) {
    if (!Object.hasOwn(config.harnesses, descriptor.id)) {
      notes.push(
        `${descriptor.id}: not configured in ${CONFIG_FILE_NAME} — run \`lumem init --harness ${descriptor.id}\` to persist it`,
      )
    }
    if (descriptor.capabilities['hooks.requiresTrust']) {
      notes.push(
        `${descriptor.id}: run \`/hooks\` in the harness to review and trust the installed hooks — they stay inert until you do`,
      )
    }
  }

  if (selected.length === 0) {
    notes.push(
      'no harness selected — only the shared hook bundles were installed; run `lumem init --harness <id>` once a harness is available',
    )
  }

  return notes
}

export function renderInstall(report: InstallReport): string {
  const lines: string[] = []

  if (report.dryRun) lines.push('dry-run: nada foi escrito')
  if (report.harnesses.length > 0) lines.push(`harnesses: ${report.harnesses.join(', ')}`)

  for (const entry of report.applied) {
    const backup = entry.backupPath !== undefined ? ` (backup: ${entry.backupPath})` : ''
    lines.push(`+ ${entry.action} ${entry.artifactId} → ${entry.destPath}${backup}`)
  }
  for (const entry of report.skipped) {
    lines.push(`= ${entry.artifactId} (${entry.reason})`)
  }
  for (const entry of report.errors) {
    const scope = entry.artifactId === COMMAND_SCOPE ? '' : `${entry.artifactId}: `
    lines.push(`erro: ${scope}${entry.message}`)
  }
  for (const note of report.notes) {
    lines.push(`nota: ${note}`)
  }

  if (lines.length === 0) lines.push('nada a fazer')
  return lines.join('\n')
}

/**
 * Register `lumem install` on `program`. The orchestrator owns wiring, so this
 * module never imports the program itself.
 */
export function registerInstallCommand(
  program: Command,
  buildContext: () => CliContext,
  emit: (json: boolean, report: unknown, rendered: string) => void,
): void {
  program
    .command('install')
    .description('Install lumem skills and hooks into the configured harnesses')
    .option('--harness <id...>', 'harness to install into; defaults to all configured and detected')
    .option('--global', "install into the harness's global scope instead of this project")
    .option('--copy', 'copy artifacts instead of symlinking them')
    .option('--force', 'overwrite destinations that differ from what lumem installed')
    .option('--dry-run', 'report what would be installed without writing anything')
    .action(
      (options: {
        harness?: string[]
        global?: boolean
        copy?: boolean
        force?: boolean
        dryRun?: boolean
      }) => {
        const ctx = buildContext()
        const { report, exitCode } = runInstall(ctx, {
          ...(options.harness !== undefined ? { harnesses: options.harness } : {}),
          ...(options.global === true ? { global: true } : {}),
          ...(options.copy === true ? { copy: true } : {}),
          ...(options.force === true ? { force: true } : {}),
          ...(options.dryRun === true ? { dryRun: true } : {}),
        })
        emit(ctx.json, report, renderInstall(report))
        process.exitCode = exitCode
      },
    )
}
