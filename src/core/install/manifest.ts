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

function listSkills(skillsRoot: string): { name: string; srcPath: string }[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const skills: { name: string; srcPath: string }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const srcPath = path.join(skillsRoot, entry.name, 'SKILL.md')
    if (fs.existsSync(srcPath)) skills.push({ name: entry.name, srcPath })
  }
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
      artifacts.push({
        id: `skill:${skill.name}@${d.id}`,
        kind: 'skill',
        version,
        srcPath: skill.srcPath,
        hash: hashFile(skill.srcPath),
        dest: {
          harness: d.id,
          scope: 'project',
          relPath: path.posix.join(d.paths.skills.project, skill.name, 'SKILL.md'),
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
