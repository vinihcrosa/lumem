import fs from 'node:fs'
import path from 'node:path'
import type { AdapterDescriptor } from '../../adapters/schema'
import { sha256 } from '../shared/fsx'

/**
 * Structural subset of AdapterDescriptor that buildManifest needs.
 * Any full AdapterDescriptor is assignable to it.
 */
export type ManifestDescriptor = Pick<AdapterDescriptor, 'id' | 'paths'>

export interface ManifestArtifact {
  id: string
  kind: 'skill' | 'agent' | 'hook-bundle' | 'hook-config'
  version: string
  srcPath: string
  hash: string
  dest: { harness: string; scope: 'project' | 'global'; relPath: string }
}

/** Harness-agnostic bundles copied to a stable path at install time (hooks must never invoke npx). */
/**
 * Every bundle copied into `.lumem/bin/`. The `hook-bundle` kind means "a copied
 * `.mjs` under `.lumem/bin`" — the name predates `lumem-spec.mjs`, which is not a
 * hook but wants exactly the same treatment: copy never symlink, `contentHash`,
 * drift detection, harness-agnostic uninstall. A parallel kind would have to
 * re-earn all four (002 T5, requirement 5).
 */
const BUNDLE_FILES = ['lumem-hook.mjs', 'lumem-runner.mjs', 'lumem-spec.mjs'] as const

function hashFile(filePath: string): string {
  return sha256(fs.readFileSync(filePath))
}

interface SkillFile {
  /** Skill directory name, e.g. `lumem-prd`. */
  name: string
  srcPath: string
  /** Path inside the skill directory, POSIX-separated: `SKILL.md`, `references/x.md`. */
  relPath: string
}

/** Every file under `dir`, recursively, as paths relative to `dir`. Sorted. */
function walk(dir: string, prefix = ''): { srcPath: string; relPath: string }[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: { srcPath: string; relPath: string }[] = []
  for (const entry of entries) {
    const srcPath = path.join(dir, entry.name)
    const relPath = prefix === '' ? entry.name : path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) out.push(...walk(srcPath, relPath))
    else out.push({ srcPath, relPath })
  }
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  return out
}

/**
 * Every file of every skill under `skillsRoot`. A directory without a `SKILL.md`
 * is not a skill and is skipped entirely.
 *
 * The whole tree ships, not only `SKILL.md`: a skill that keeps its templates and
 * protocols in `references/` is useless when only its entry file is installed,
 * and pushing detail out of the entry file is how a skill stays cheap to load.
 */
function listSkills(skillsRoot: string): SkillFile[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const skills: SkillFile[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillDir = path.join(skillsRoot, entry.name)
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue
    for (const file of walk(skillDir)) {
      skills.push({ name: entry.name, srcPath: file.srcPath, relPath: file.relPath })
    }
  }
  skills.sort((a, b) =>
    a.name !== b.name
      ? a.name < b.name
        ? -1
        : 1
      : a.relPath < b.relPath
        ? -1
        : a.relPath > b.relPath
          ? 1
          : 0,
  )
  return skills
}

/**
 * Build the deterministic install manifest for the given adapter descriptors:
 * skill and hook-config artifacts per harness, plus harness-agnostic hook
 * bundles from dist/. Output is sorted by artifact id.
 */
export function buildManifest(opts: {
  assetsDir: string
  distDir: string
  version: string
  descriptors: ManifestDescriptor[]
}): ManifestArtifact[] {
  const { assetsDir, distDir, version, descriptors } = opts
  const artifacts: ManifestArtifact[] = []

  const skills = listSkills(path.join(assetsDir, 'skills'))

  for (const d of descriptors) {
    for (const skill of skills) {
      // The id keeps the file path for anything below the entry file, so a
      // reference drifting is reported as its own artifact rather than as the
      // skill wholesale.
      const suffix = skill.relPath === 'SKILL.md' ? '' : `/${skill.relPath}`
      artifacts.push({
        id: `skill:${skill.name}${suffix}@${d.id}`,
        kind: 'skill',
        version,
        srcPath: skill.srcPath,
        hash: hashFile(skill.srcPath),
        dest: {
          harness: d.id,
          scope: 'project',
          relPath: path.posix.join(d.paths.skills.project, skill.name, skill.relPath),
        },
      })
    }

    const tmplPath = path.join(assetsDir, 'harness', d.id, 'hooks.tmpl.json')
    const hooksTarget = d.paths.hooksConfig[0]
    if (hooksTarget !== undefined && fs.existsSync(tmplPath)) {
      artifacts.push({
        id: `hook-config:${d.id}`,
        kind: 'hook-config',
        version,
        srcPath: tmplPath,
        hash: hashFile(tmplPath),
        dest: { harness: d.id, scope: 'project', relPath: hooksTarget.path },
      })
    }
  }

  for (const bundle of BUNDLE_FILES) {
    const srcPath = path.join(distDir, bundle)
    if (!fs.existsSync(srcPath)) {
      throw new Error(
        `buildManifest: missing bundle ${srcPath} — run the build first (npm run build)`,
      )
    }
    artifacts.push({
      id: `hook-bundle:${bundle.replace(/\.mjs$/, '')}`,
      kind: 'hook-bundle',
      version,
      srcPath,
      hash: hashFile(srcPath),
      dest: { harness: '*', scope: 'project', relPath: `.lumem/bin/${bundle}` },
    })
  }

  artifacts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return artifacts
}
