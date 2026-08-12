/**
 * How a project proves a claim: which command counts as its gate, which files a
 * fingerprint covers, and where tests live.
 *
 * Owned here rather than in `core/config.ts` for the reason every other default
 * is — the module that owns the concept owns its numbers (budgets in
 * `memory/limits`, consolidation gating in `consolidate/gate`). `core/spec`
 * consumes this; the dependency runs core → spec and never the other way.
 *
 * Dependency-free: `core/spec` reaches the bundled spec entry, where the purity
 * assertion fails the moment an external import appears.
 */

export interface VerificationConfig {
  /**
   * The project's default gate command. **Absent is legal** and means no verdict
   * in this project can be verified — never a reason to assume one passed.
   */
  command?: string
  /** Path prefixes, relative to the project root, whose files the fingerprint covers. */
  fingerprintInclude: string[]
  /** Path prefixes skipped while walking. Checked BEFORE include. */
  fingerprintExclude: string[]
  /** Path prefixes searched for tests. */
  testInclude: string[]
  /** Filename suffixes that make a file a test file. */
  testSuffixes: string[]
  /** Regex sources; a line matching one of these introduces a test name. */
  testPatterns: string[]
}

/**
 * The defaults from TDD 003 §2, in one place so the table has one implementation.
 *
 * `docs` is excluded because the verdict lives in a document: a fingerprint that
 * covered it would be invalidated by the act of recording the verdict it
 * certifies (003 D7). `assets` is *included* despite being prompt text, because
 * 002's IT-20 asserts the real asset tree — editing a SKILL.md can genuinely
 * break the suite.
 *
 * The patterns are a guess about other people's languages, covering vitest, jest,
 * Go and pytest. Being wrong for a fifth runner is expected; the config key is
 * the mitigation.
 */
export const DEFAULT_VERIFICATION: VerificationConfig = {
  fingerprintInclude: [
    'src',
    'test',
    'scripts',
    'assets',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
  ],
  fingerprintExclude: ['node_modules', 'dist', '.git', '.lumem', 'docs'],
  testInclude: ['src', 'test'],
  testSuffixes: ['.test.ts'],
  testPatterns: ['\\bit\\s*\\(', '\\btest\\s*\\(', '\\bfunc\\s+Test', '\\bdef\\s+test_'],
}

/** A fresh copy, so a caller mutating its own settings cannot alter the defaults. */
export function defaultVerification(): VerificationConfig {
  return {
    fingerprintInclude: [...DEFAULT_VERIFICATION.fingerprintInclude],
    fingerprintExclude: [...DEFAULT_VERIFICATION.fingerprintExclude],
    testInclude: [...DEFAULT_VERIFICATION.testInclude],
    testSuffixes: [...DEFAULT_VERIFICATION.testSuffixes],
    testPatterns: [...DEFAULT_VERIFICATION.testPatterns],
  }
}

/** Strings only, and only when every element is one. A malformed list falls back. */
function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') return fallback
    out.push(entry)
  }
  return out
}

/**
 * Read a `verification` block out of already-parsed config JSON, tolerantly.
 *
 * The zod schema in `core/config` is the real validator and stays the CLI's path.
 * This exists for the bundled spec entry, which must not import zod: pulling a
 * schema library into a copied `.mjs` to read six optional fields took the bundle
 * from 26 KB to 162 KB and broke its zero-dependency contract, which the purity
 * assertion caught on the first build.
 *
 * Tolerant on purpose, in the shape the hook already uses: anything malformed
 * falls back to the default for that field rather than failing the run. A gate
 * that refuses to work because one config key is the wrong type would be a worse
 * outcome than a gate that uses the default and says nothing.
 */
export function verificationFromJson(config: unknown): VerificationConfig | undefined {
  if (typeof config !== 'object' || config === null) return undefined
  const block = (config as Record<string, unknown>).verification
  if (typeof block !== 'object' || block === null) return undefined

  const raw = block as Record<string, unknown>
  const defaults = defaultVerification()
  const command = typeof raw.command === 'string' && raw.command !== '' ? raw.command : undefined

  return {
    ...(command !== undefined ? { command } : {}),
    fingerprintInclude: stringList(raw.fingerprintInclude, defaults.fingerprintInclude),
    fingerprintExclude: stringList(raw.fingerprintExclude, defaults.fingerprintExclude),
    testInclude: stringList(raw.testInclude, defaults.testInclude),
    testSuffixes: stringList(raw.testSuffixes, defaults.testSuffixes),
    testPatterns: stringList(raw.testPatterns, defaults.testPatterns),
  }
}
