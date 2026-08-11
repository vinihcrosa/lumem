/**
 * Static checks over the ADR folder: the two link failures a human reader cannot
 * see, plus three complaints that are worth saying out loud but never block.
 *
 * Pure and dependency-free, like its siblings in `core/adr` — no `node:` builtin
 * either, since everything it needs was already read by `readAdrs`. Part of
 * `core/adr` reaches the bundled hook, where the purity assertions in
 * `src/hooks/main.test.ts` fail the moment an external import appears.
 *
 * Never throws: whatever is wrong with the set is a finding, including the
 * things the parser gave up on.
 */

import type { Adr } from './format'
import type { AdrSet } from './store'

export type AdrLintKind =
  /** `supersedes` names a file that is not an ADR under `docs/adr/`. */
  | 'broken-supersedes'
  /** Following `supersedes` returns to an ADR already seen. */
  | 'supersedes-cycle'
  /** A complaint the tolerant parser recorded on the file. */
  | 'missing-frontmatter'
  /** The `date` field disagrees with the filename prefix. */
  | 'date-mismatch'
  /** `summary` is still the placeholder `adr new` seeded. */
  | 'todo-summary'
  /** `feature` names a directory that is not under `docs/features/`. */
  | 'unknown-feature'

export interface AdrFinding {
  kind: AdrLintKind
  /**
   * `gate` for the two link failures: supersedence being readable is the single
   * property the whole design rests on (D11). Everything else is information.
   */
  severity: 'gate' | 'info'
  /** The ADRs involved. One, or every member of a cycle. */
  ids: string[]
  /** One line: what is wrong, and with which file. */
  message: string
}

/** A `supersedes` value containing `/` is a `<module>/<rule>` id, not a filename. */
const MODULE_RULE_SEPARATOR = '/'
/** The placeholder `adr new` seeds when `--summary` is absent. */
const TODO_PREFIX = 'TODO:'
/** `YYYY-MM-DD`, the filename prefix that must equal the `date` field. */
const DATE_LENGTH = 10

const SEVERITY_RANK: Record<AdrFinding['severity'], number> = { gate: 0, info: 1 }

/**
 * Every check, over a set `readAdrs` already produced.
 *
 * Findings come back sorted gates first, then by kind and by the ADR they name,
 * so two runs over the same folder render identically and a gate is never buried
 * under information.
 */
export interface AdrLintOptions {
  /**
   * Feature directory names under `docs/features/`. Passed in rather than read:
   * this module reaches the bundled hook and touches no `node:` builtin. Omit it
   * to skip the `feature` check entirely — nothing is assumed from an absent list,
   * since "no features exist" and "the caller did not look" are different facts.
   */
  features?: readonly string[]
}

export function lintAdrs(set: AdrSet, opts?: AdrLintOptions): AdrFinding[] {
  const findings: AdrFinding[] = [...brokenSupersedes(set), ...supersedesCycles(set)]

  for (const adr of set.adrs) {
    // Consumed, not re-derived: the parser already knows what it could not read.
    for (const warning of adr.warnings) {
      findings.push({
        kind: 'missing-frontmatter',
        severity: 'info',
        ids: [adr.id],
        message: warning,
      })
    }

    const features = opts?.features
    if (features !== undefined && adr.feature !== undefined && !features.includes(adr.feature)) {
      findings.push({
        kind: 'unknown-feature',
        severity: 'info',
        ids: [adr.id],
        message: `feature '${adr.feature}' names no directory under docs/features/; a decision outlives the slice that produced it, so this is a note, not a break`,
      })
    }

    const prefix = adr.id.slice(0, DATE_LENGTH)
    // An absent date is already a warning above; saying it twice helps nobody.
    if (adr.date !== '' && adr.date !== prefix) {
      findings.push({
        kind: 'date-mismatch',
        severity: 'info',
        ids: [adr.id],
        message: `date '${adr.date}' disagrees with the filename prefix '${prefix}'; the filename is the identifier, so the field is what should change`,
      })
    }

    if (adr.summary.startsWith(TODO_PREFIX)) {
      findings.push({
        kind: 'todo-summary',
        severity: 'info',
        ids: [adr.id],
        message:
          'summary is still the seeded placeholder: an ADR nobody can skim is an ADR nobody finds',
      })
    }
  }

  return findings.sort(compareFindings)
}

/**
 * The `supersedes` target when it is another ADR in this set. A module rule and
 * a dangling name both resolve to nothing — the first by design, the second
 * reported as `broken-supersedes`.
 */
function resolvedTarget(set: AdrSet, adr: Adr): string | undefined {
  const target = adr.supersedes
  if (target === undefined || target === '') return undefined
  if (target.includes(MODULE_RULE_SEPARATOR)) return undefined
  return set.byId.has(target) ? target : undefined
}

function brokenSupersedes(set: AdrSet): AdrFinding[] {
  const findings: AdrFinding[] = []
  for (const adr of set.adrs) {
    const target = adr.supersedes
    if (target === undefined || target === '') continue
    // Module rules do not exist in this slice: unresolvable by design, not broken.
    if (target.includes(MODULE_RULE_SEPARATOR)) continue
    if (set.byId.has(target)) continue
    findings.push({
      kind: 'broken-supersedes',
      severity: 'gate',
      ids: [adr.id],
      message: `supersedes '${target}', which is not an ADR under docs/adr/; the chain stops here`,
    })
  }
  return findings
}

/**
 * Every supersedence cycle, once each.
 *
 * `supersedes` is single-valued, so the graph is functional: each ADR has at most
 * one outgoing edge and cycles are therefore disjoint. Walking forward from each
 * unsettled ADR and stopping at the first id already on the current path finds a
 * cycle exactly once; ids settled by an earlier walk are never walked again, so
 * an ADR that merely points *into* a cycle costs one step and reports nothing.
 */
function supersedesCycles(set: AdrSet): AdrFinding[] {
  const findings: AdrFinding[] = []
  /** Ids whose walk already finished, cycle member or not. */
  const settled = new Set<string>()

  for (const start of set.adrs) {
    if (settled.has(start.id)) continue

    const walked: string[] = []
    const positions = new Map<string, number>()
    let current: string | undefined = start.id

    while (current !== undefined && !settled.has(current)) {
      const seenAt = positions.get(current)
      if (seenAt !== undefined) {
        // The tail from the first sighting onwards is the cycle; the head is not.
        findings.push(cycleFinding(walked.slice(seenAt)))
        break
      }
      positions.set(current, walked.length)
      walked.push(current)
      const adr = set.byId.get(current)
      current = adr === undefined ? undefined : resolvedTarget(set, adr)
    }

    for (const id of walked) settled.add(id)
  }

  return findings
}

/**
 * One finding per cycle, rotated to start at the smallest id. The chain order is
 * intrinsic to the graph, so rotating to a fixed member makes the rendering the
 * same whichever member the walk happened to reach first.
 */
function cycleFinding(members: string[]): AdrFinding {
  const ids = rotateToSmallest(members)
  const first = ids[0] ?? ''
  return {
    kind: 'supersedes-cycle',
    severity: 'gate',
    ids,
    message: `supersedence cycle: ${[...ids, first].join(' → ')}; no ADR in it is current`,
  }
}

function rotateToSmallest(members: string[]): string[] {
  let smallest = 0
  for (let index = 1; index < members.length; index += 1) {
    const candidate = members[index]
    const best = members[smallest]
    if (candidate !== undefined && best !== undefined && candidate < best) smallest = index
  }
  return [...members.slice(smallest), ...members.slice(0, smallest)]
}

/**
 * Deterministic order: gates first, then kind, then the ids.
 *
 * Ties stop there on purpose. `sort` is stable, so several warnings on one file
 * keep the order the parser produced them in — which is the order of the lines
 * they came from, and reads better than an alphabetical shuffle of messages.
 */
function compareFindings(a: AdrFinding, b: AdrFinding): number {
  if (a.severity !== b.severity) return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1

  const firstA = a.ids[0] ?? ''
  const firstB = b.ids[0] ?? ''
  if (firstA !== firstB) return firstA < firstB ? -1 : 1

  const idsA = a.ids.join(',')
  const idsB = b.ids.join(',')
  if (idsA !== idsB) return idsA < idsB ? -1 : 1
  return 0
}
