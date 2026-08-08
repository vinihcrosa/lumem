import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_FILE_BUDGETS } from './limits'
import { type LintFinding, type LintKind, lintMemory } from './lint'
import type { Fact, MemoryFile, MemoryScope, MemoryType } from './store'
import { parseMemoryFacts } from './store'

/** Every test pins `now`, so ages never depend on the day the suite runs. */
const NOW = new Date('2026-08-07T12:00:00Z')

const PROJECT_FILE = '/fixtures/project/memory/project.md'
const CORRECTION_FILE = '/fixtures/project/memory/correction.md'
const PREFERENCE_FILE = '/fixtures/global/memory/preference.md'

/** One fact in the exact on-disk format, provenance comment included. */
function bullet(date: string, body: string, conf: Fact['conf'] = 'high', src = 'sess_a1'): string {
  const [first, ...rest] = body.split('\n')
  return [
    `- [${date}] ${first ?? ''}`,
    ...rest.map((line) => `  ${line}`),
    `  <!-- src:${src} conf:${conf} -->`,
    '',
  ].join('\n')
}

/** Hand-written on-disk content parsed by the real parser, so ids are real ids. */
function fileOf(
  meta: { path: string; type: MemoryType; scope: MemoryScope },
  ...parts: string[]
): MemoryFile {
  const { facts, warnings } = parseMemoryFacts(parts.join(''), {
    type: meta.type,
    scope: meta.scope,
  })
  return { path: meta.path, type: meta.type, scope: meta.scope, facts, warnings }
}

function projectFile(...parts: string[]): MemoryFile {
  return fileOf({ path: PROJECT_FILE, type: 'project', scope: 'project' }, ...parts)
}

function correctionFile(...parts: string[]): MemoryFile {
  return fileOf({ path: CORRECTION_FILE, type: 'correction', scope: 'project' }, ...parts)
}

function preferenceFile(...parts: string[]): MemoryFile {
  return fileOf({ path: PREFERENCE_FILE, type: 'preference', scope: 'global' }, ...parts)
}

function only(findings: LintFinding[], kind: LintKind): LintFinding[] {
  return findings.filter((finding) => finding.kind === kind)
}

function idsOf(file: MemoryFile): string[] {
  return file.facts.map((fact) => fact.id)
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-lint-'))
}

const RECENT = '2026-08-01'

describe('lintMemory / near-duplicate', () => {
  it('flags two paraphrases of the same fact in the same file', () => {
    const file = projectFile(
      bullet(RECENT, 'the CLI uses commander for argument parsing'),
      bullet(RECENT, 'the CLI uses commander to parse arguments'),
    )
    const findings = only(lintMemory([file], { now: NOW }), 'near-duplicate')

    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('warn')
    expect(findings[0]?.file).toBe(PROJECT_FILE)
    expect(findings[0]?.factIds.slice().sort()).toEqual(idsOf(file).slice().sort())
    expect(findings[0]?.message).toMatch(/redundant/)
    expect(findings[0]?.detail).toContain('the CLI uses commander to parse arguments')
  })

  it('does not flag two unrelated facts', () => {
    const file = projectFile(
      bullet(RECENT, 'deploy runs on GitHub Actions'),
      bullet(RECENT, 'the CLI uses commander for argument parsing'),
    )
    expect(lintMemory([file], { now: NOW })).toEqual([])
  })

  it('never pairs facts that live in different files', () => {
    const project = projectFile(bullet(RECENT, 'the CLI uses commander for argument parsing'))
    const correction = correctionFile(bullet(RECENT, 'the CLI uses commander to parse arguments'))
    expect(lintMemory([project, correction], { now: NOW })).toEqual([])
  })
})

describe('lintMemory / contradiction', () => {
  it('flags an overlapping pair with opposite polarity and names the newer fact', () => {
    const file = projectFile(
      bullet('2026-06-01', 'auth uses cookies'),
      bullet('2026-07-01', 'auth does not use cookies, JWT instead'),
    )
    const findings = only(lintMemory([file], { now: NOW }), 'contradiction')

    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('warn')
    expect(findings[0]?.factIds.slice().sort()).toEqual(idsOf(file).slice().sort())
    // the newer fact usually supersedes: both its id and its date are named
    expect(findings[0]?.message).toContain(file.facts[1]?.id ?? '')
    expect(findings[0]?.message).toContain('2026-07-01')
    // a candidate, never a verdict
    expect(findings[0]?.message).toMatch(/candidate|review|verify/)
    expect(findings[0]?.detail).toContain('auth uses cookies')
    expect(findings[0]?.detail).toContain('auth does not use cookies, JWT instead')
    // the pair is reported once, as a contradiction and not also as a duplicate
    expect(only(lintMemory([file], { now: NOW }), 'near-duplicate')).toEqual([])
  })

  it('reports only a near-duplicate for the same pair without the negation', () => {
    const file = projectFile(
      bullet('2026-06-01', 'auth uses cookies'),
      bullet('2026-07-01', 'auth uses cookies and JWT'),
    )
    const findings = lintMemory([file], { now: NOW })

    expect(only(findings, 'contradiction')).toEqual([])
    expect(only(findings, 'near-duplicate')).toHaveLength(1)
  })

  it('does not flag a pair where both sides are negated', () => {
    const file = projectFile(
      bullet('2026-06-01', 'auth does not use cookies'),
      bullet('2026-07-01', 'auth no longer uses cookies'),
    )
    const findings = lintMemory([file], { now: NOW })

    expect(only(findings, 'contradiction')).toEqual([])
    expect(only(findings, 'near-duplicate')).toHaveLength(1)
  })
})

describe('lintMemory / stale', () => {
  it('flags a fact older than the default threshold with its age in days', () => {
    const file = projectFile(bullet('2026-01-01', 'deploy runs on GitHub Actions'))
    const findings = only(lintMemory([file], { now: NOW }), 'stale')

    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('info')
    expect(findings[0]?.factIds).toEqual(idsOf(file))
    expect(findings[0]?.message).toContain('218 days')
  })

  it('does not flag a recent fact', () => {
    const file = projectFile(bullet(RECENT, 'deploy runs on GitHub Actions'))
    expect(only(lintMemory([file], { now: NOW }), 'stale')).toEqual([])
  })

  it('honours a custom staleDays', () => {
    const file = projectFile(bullet(RECENT, 'deploy runs on GitHub Actions'))
    const findings = only(lintMemory([file], { now: NOW, staleDays: 3 }), 'stale')

    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('6 days')
  })

  it('never flags a fact dated in the future', () => {
    const file = projectFile(bullet('2027-01-01', 'deploy runs on GitHub Actions'))
    expect(only(lintMemory([file], { now: NOW }), 'stale')).toEqual([])
  })
})

describe('lintMemory / dead-reference', () => {
  function project(): string {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'kept.ts'), 'export {}\n')
    return dir
  }

  it('flags a project fact naming a file that no longer exists', () => {
    const projectDir = project()
    const file = projectFile(bullet(RECENT, 'the entry point lives in src/gone.ts'))
    const findings = only(lintMemory([file], { now: NOW, projectDir }), 'dead-reference')

    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('warn')
    expect(findings[0]?.factIds).toEqual(idsOf(file))
    expect(findings[0]?.message).toContain('src/gone.ts')
    expect(findings[0]?.detail).toContain('src/gone.ts')
  })

  it('flags a backticked path, the common case', () => {
    const projectDir = project()
    const file = projectFile(bullet(RECENT, 'see `src/gone.ts` for the entry point'))
    expect(only(lintMemory([file], { now: NOW, projectDir }), 'dead-reference')).toHaveLength(1)
  })

  it('does not flag a path that still exists', () => {
    const projectDir = project()
    const file = projectFile(bullet(RECENT, 'the entry point lives in src/kept.ts'))
    expect(only(lintMemory([file], { now: NOW, projectDir }), 'dead-reference')).toEqual([])
  })

  it('never flags URLs or tokens containing a space', () => {
    const projectDir = project()
    const file = projectFile(
      bullet(RECENT, 'the changelog lives at https://example.com/src/gone.ts'),
      bullet(RECENT, 'run `npm run build -- src/gone.ts` before shipping'),
    )
    expect(only(lintMemory([file], { now: NOW, projectDir }), 'dead-reference')).toEqual([])
  })

  it('never checks global-scope facts', () => {
    const projectDir = project()
    const file = preferenceFile(bullet(RECENT, 'always open src/gone.ts first'))
    expect(only(lintMemory([file], { now: NOW, projectDir }), 'dead-reference')).toEqual([])
  })

  it('skips the check entirely when no projectDir is given', () => {
    const file = projectFile(bullet(RECENT, 'the entry point lives in src/gone.ts'))
    expect(only(lintMemory([file], { now: NOW }), 'dead-reference')).toEqual([])
  })
})

describe('lintMemory / low-confidence', () => {
  it('flags a fact written with conf low', () => {
    const file = projectFile(bullet(RECENT, 'deploy runs on GitHub Actions', 'low'))
    const findings = only(lintMemory([file], { now: NOW }), 'low-confidence')

    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('info')
    expect(findings[0]?.factIds).toEqual(idsOf(file))
  })

  it('does not flag medium or high confidence facts', () => {
    const file = projectFile(
      bullet(RECENT, 'deploy runs on GitHub Actions', 'medium'),
      bullet(RECENT, 'the CLI uses commander for argument parsing', 'high'),
    )
    expect(only(lintMemory([file], { now: NOW }), 'low-confidence')).toEqual([])
  })
})

describe('lintMemory / over-budget', () => {
  /** Distinct word sets per fact, so only the budget check can fire. */
  function filler(count: number): string[] {
    return Array.from({ length: count }, (_unused, i) =>
      bullet(RECENT, `alpha${i} beta${i} gamma${i} delta${i}`),
    )
  }

  it('flags a file that exceeds its type budget, naming lines and bytes', () => {
    // Two on-disk lines per fact, so one fact per budgeted line is always over.
    const file = preferenceFile(...filler(DEFAULT_FILE_BUDGETS.preference.lines))
    const findings = only(lintMemory([file], { now: NOW }), 'over-budget')

    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('warn')
    expect(findings[0]?.factIds).toEqual([])
    expect(findings[0]?.file).toBe(PREFERENCE_FILE)
    expect(findings[0]?.message).toContain(String(DEFAULT_FILE_BUDGETS.preference.lines))
    expect(findings[0]?.message).toMatch(/consolidation/)
  })

  it('does not flag a file inside its budget', () => {
    const file = preferenceFile(...filler(3))
    expect(lintMemory([file], { now: NOW })).toEqual([])
  })

  it('honours custom budgets', () => {
    const file = preferenceFile(...filler(3))
    const budgets = {
      ...DEFAULT_FILE_BUDGETS,
      preference: { lines: 1, bytes: 1 },
    }
    expect(only(lintMemory([file], { now: NOW, budgets }), 'over-budget')).toHaveLength(1)
  })
})

describe('lintMemory / malformed', () => {
  it('surfaces parser warnings while the good facts in the same file still parse', () => {
    const file = projectFile(
      '- [ontem] fact with a broken date\n  <!-- src:sess_x conf:high -->\n',
      bullet(RECENT, 'deploy runs on GitHub Actions'),
    )
    const findings = only(lintMemory([file], { now: NOW }), 'malformed')

    expect(file.facts).toHaveLength(1)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('info')
    expect(findings[0]?.factIds).toEqual([])
    expect(findings[0]?.message).toContain("malformed date 'ontem'")
  })

  it('reports nothing for a clean file', () => {
    const file = projectFile(bullet(RECENT, 'deploy runs on GitHub Actions'))
    expect(only(lintMemory([file], { now: NOW }), 'malformed')).toEqual([])
  })
})

describe('lintMemory / contract', () => {
  it('returns no findings for empty input', () => {
    expect(lintMemory([], { now: NOW })).toEqual([])
    expect(lintMemory([projectFile()], { now: NOW })).toEqual([])
  })

  it('sorts findings by kind, then file, then first fact id', () => {
    const project = projectFile(
      bullet('2026-01-01', 'auth uses cookies', 'low'),
      bullet('2026-02-01', 'auth does not use cookies, JWT instead'),
      bullet('2026-01-05', 'the CLI uses commander for argument parsing'),
      bullet('2026-01-06', 'the CLI uses commander to parse arguments'),
    )
    const correction = correctionFile(bullet('2026-01-01', 'never commit straight to main', 'low'))
    const findings = lintMemory([project, correction], { now: NOW })

    const key = (finding: LintFinding): string =>
      [finding.kind, finding.file, finding.factIds[0] ?? ''].join(' ')
    expect(findings.map(key)).toEqual(findings.map(key).slice().sort())
    expect(new Set(findings.map((f) => f.kind))).toEqual(
      new Set<LintKind>(['contradiction', 'near-duplicate', 'stale', 'low-confidence']),
    )
  })

  it('is deterministic across calls', () => {
    const files = [
      projectFile(
        bullet('2026-01-01', 'auth uses cookies', 'low'),
        bullet('2026-02-01', 'auth does not use cookies, JWT instead'),
      ),
    ]
    expect(lintMemory(files, { now: NOW })).toEqual(lintMemory(files, { now: NOW }))
  })

  it('never mutates the files it is given', () => {
    const file = projectFile(bullet('2026-01-01', 'auth uses cookies', 'low'))
    const snapshot = JSON.stringify(file)
    lintMemory([file], { now: NOW, projectDir: tmpDir() })
    expect(JSON.stringify(file)).toBe(snapshot)
  })

  it('does not throw on degenerate facts', () => {
    const file: MemoryFile = {
      path: PROJECT_FILE,
      type: 'project',
      scope: 'project',
      facts: [
        {
          id: 'aaaaaaaa',
          date: 'not-a-date',
          body: '',
          src: 'unknown',
          conf: 'low',
          type: 'project',
          scope: 'project',
        },
        {
          id: 'bbbbbbbb',
          date: '2026-13-45',
          body: '   ',
          src: 'unknown',
          conf: 'high',
          type: 'project',
          scope: 'project',
        },
      ],
      warnings: [],
    }
    expect(() =>
      lintMemory([file], { now: new Date(Number.NaN), projectDir: '/nope' }),
    ).not.toThrow()
  })
})

describe('contradiction — real-world phrasing, not just the toy case', () => {
  // The pair that motivated lowering the contradiction floor: it scores 0.57,
  // which a single 0.6 threshold silently dropped. Consolidation paraphrases,
  // so memory never looks like the minimal example.
  const realPair = projectFile(
    bullet(
      '2026-08-01',
      'Auth uses session cookies, not JWT, because revocation had to be immediate.',
    ),
    bullet('2026-10-02', 'Auth does not use session cookies; it uses JWT instead now.'),
  )

  it('surfaces a paraphrased conflicting pair for review', () => {
    // Both bodies negate ("not JWT" / "does not use"), so there is no polarity
    // flip to detect and the label lands on near-duplicate. What matters is
    // that the pair reaches a human at all: the message says one may supersede
    // the other either way. Naming which one is the consolidation model's job.
    const findings = lintMemory([realPair], { now: NOW }).filter(
      (f) => f.kind === 'contradiction' || f.kind === 'near-duplicate',
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.factIds.sort()).toEqual(idsOf(realPair).sort())
  })

  it('labels a pair as contradiction when exactly one side negates', () => {
    const file = projectFile(
      bullet('2026-08-01', 'Auth uses session cookies for immediate revocation.'),
      bullet('2026-10-02', 'Auth does not use session cookies for revocation anymore.'),
    )
    const findings = only(lintMemory([file], { now: NOW }), 'contradiction')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain(file.facts[1]?.id ?? 'MISSING')
  })

  it('does not flag unrelated facts even though one of them negates', () => {
    const file = projectFile(
      bullet('2026-08-01', 'The build runs with tsup and outputs three bundles.'),
      bullet(
        '2026-08-02',
        'Deploy does not happen on push; it runs on a git tag via GitHub Actions.',
      ),
    )
    expect(lintMemory([file], { now: NOW }).filter((f) => f.kind === 'contradiction')).toEqual([])
  })

  it('keeps near-duplicate strict — a paraphrase without a polarity flip is not a contradiction', () => {
    const file = projectFile(
      bullet('2026-08-01', 'Auth uses session cookies because revocation had to be immediate.'),
      bullet('2026-08-02', 'Auth uses session cookies for immediate revocation.'),
    )
    const findings = lintMemory([file], { now: NOW })
    expect(only(findings, 'contradiction')).toEqual([])
    expect(only(findings, 'near-duplicate').length).toBeGreaterThan(0)
  })

  it('a negating pair below the contradiction floor stays quiet', () => {
    const file = projectFile(
      bullet('2026-08-01', 'Auth uses session cookies for immediate revocation of access.'),
      bullet(
        '2026-08-02',
        'The CI bench does not gate on p95 latency; it only reports the number.',
      ),
    )
    expect(only(lintMemory([file], { now: NOW }), 'contradiction')).toEqual([])
  })
})
