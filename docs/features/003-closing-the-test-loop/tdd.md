# TDD — 003 Closing the test loop

**Status:** draft, awaiting review
**Depends on:** `context.md`, `decisions.md` (D1–D8 plus `Cut, and why`), `questions.md` (round 1, stopped)

## Summary

Three additions, no new runtime: a check that a declared case names a test, a fingerprint of the inputs a gate reads, and a verdict that carries both the command and that fingerprint so staleness is observable.

lumem never executes the gate (D3). It reads files and hashes them, which is why the bundle stays read-only and why nothing here can damage a tree.

**What this slice exists to learn:** whether a gate built on a naming convention survives contact with a second language. The convention is proven for 83 of 85 cases in this repository and nowhere else.

## 0. What exploration changed before a line was written

Three facts from the codebase, each of which moved the design:

1. **`config.gate` is already taken.** It holds consolidation gating — `minSignals`, `minDurationMin`, `minHoursBetween`, `lockTtlMin`. The verification settings cannot be called `gate`, so they are `verification`.
2. **Every config object is `.strict()`**, and `readConfig` turns an unknown key into an error rather than ignoring it. So `verification` must be **optional**: a project whose config predates this slice has to keep parsing. It also means a config written by a newer lumem fails hard on an older one — stated here so it is a known consequence rather than a surprise.
3. **`writeConfig` normalises through an explicit destructure.** A field that parses but is missing from `normalize()` is silently dropped the next time anything writes the config. Adding a key means touching both, and there is a case for exactly that.

## 1. Layout

No new artifacts. Three files gain content, one module is new.

| File | Change |
|---|---|
| `src/spec/verify.ts` | new: fingerprint, project-root discovery, verdict freshness |
| `src/spec/feature.ts` | the verdict record gains a command and a fingerprint |
| `src/spec/lint.ts` | `unimplemented-case` at `--phase tasks`; a new `--phase verdict` |
| `src/spec/next.ts` | an optional second argument, so staleness can reach the advice |
| `src/core/config.ts` | an optional `verification` block, in the schema and in `normalize` |

## 2. Configuration

```ts
export interface VerificationConfig {
  /** Default gate command. Absent means no verdict in this project can be verified. */
  command?: string
  /** Path prefixes, relative to the project root, whose files the fingerprint covers. */
  fingerprintInclude: string[]
  /** Path prefixes skipped while walking, checked before include. */
  fingerprintExclude: string[]
  /** Path prefixes searched for tests. */
  testInclude: string[]
  /** Filename suffixes that make a file a test file. */
  testSuffixes: string[]
  /** Regex sources; a line matching one of these introduces a test name. */
  testPatterns: string[]
}
```

| Field | Required | Type | Rule |
|---|---|---|---|
| `command` | no | string | The project's default gate. Absent is legal and makes every verdict unverifiable |
| `fingerprintInclude` | yes | `string[]` | Default `["src", "test", "scripts", "assets", "package.json", "package-lock.json", "tsconfig.json"]` |
| `fingerprintExclude` | yes | `string[]` | Default `["node_modules", "dist", ".git", ".lumem", "docs"]` — `docs` is excluded by D7, not by taste |
| `testInclude` | yes | `string[]` | Default `["src", "test"]` |
| `testSuffixes` | yes | `string[]` | Default `[".test.ts"]` |
| `testPatterns` | yes | `string[]` | Default `["\\bit\\s*\\(", "\\btest\\s*\\(", "\\bfunc\\s+Test", "\\bdef\\s+test_"]` |

**Prefixes, not globs.** lumem has no glob engine and will not gain one for this: a prefix list plus a suffix list answers every question this slice asks, and a glob matcher is a dependency or a parser. Stated so nobody adds `*` support believing it was an oversight.

**A configured list replaces the default** (LOOP-04). Merging would make it impossible to *remove* a default, which is the whole reason a project would configure it.

## 3. Fingerprint

```ts
export interface Fingerprint {
  /** sha256 over the file manifest. '' when nothing was covered. */
  hash: string
  fileCount: number
  /** A covered file existed and could not be read. Never fresh (LOOP-14). */
  incomplete: boolean
}

export function computeFingerprint(projectDir: string, cfg: VerificationConfig): Fingerprint
```

The manifest is one line per covered file, sorted by path, then hashed:

```
<relative-posix-path> <sha256-of-contents>\n
```

Sorting is explicit because `readdirSync` order is not defined — the same trap `core/adr/store.ts` documents.

**Walk order:** a directory is skipped when its relative path starts with any `fingerprintExclude` prefix. Exclusion is checked first, so `src` being included never drags in `src/node_modules`.

**Cost.** This repository covers roughly 1,300 files. Hashing them is the price of one `verdict` check, paid on demand — never on the hook path, which is why `budget.ts` and the injection path are untouched by this slice.

## 4. Project root

```ts
/** The nearest ancestor of `featureDir` that holds a `.lumem` directory. */
export function findProjectDir(featureDir: string): string | undefined
```

Walk up from the feature directory until a `.lumem/` is found, stopping at the filesystem root.

Not `process.cwd()`: the bundle is invoked as `node .lumem/bin/lumem-spec.mjs lint docs/features/x`, and while that is normally run from the root, nothing enforces it. Deriving the root from the argument makes the answer independent of where the command was typed.

**No `.lumem` found** is not a crash — it is a finding, because a feature directory outside a lumem project has no config and no gate to check.

## 5. The verdict

```markdown
## Verdict

- **Result:** PASS
- **Command:** npm run verify
- **Fingerprint:** 4f9c1a…  (1284 files)
- **Evidence:** 60 files, 1504 tests, 0 failed
```

```ts
export interface VerdictRecord {
  result: 'pass' | 'fail'
  /** The command the author says produced this. Absent in a verdict written before this slice. */
  command?: string
  /** Full sha256 as recorded. Absent in an older verdict. */
  fingerprint?: string
}
```

| Field | Required | Type | Rule |
|---|---|---|---|
| `result` | yes | `pass \| fail` | Case-insensitive `PASS` or `FAIL`, as 002 already parses |
| `command` | no | string | Everything after `- **Command:**`, trimmed |
| `fingerprint` | no | string | Hex; a truncated display form (`4f9c1a…`) is **not** accepted — the full hash is recorded and the display is the author's business |

The `(1284 files)` in the example is prose for a human. It is **not** parsed — see `Cut, and why` in `decisions.md`.

`SpecFeature.verdict` changes from `'pass' | 'fail' | undefined` to `VerdictRecord | undefined`. That is a breaking change to a type 002 shipped, and it is the reason `next.ts` is in the file list.

### 5.1 States

A verdict is in exactly one of these, and nothing else:

| State | When |
|---|---|
| `absent` | no `## Verdict` section, or no `Result` line |
| `unverifiable` | no command available — neither the task nor the config declares one (LOOP-08) |
| `stale` | the recorded fingerprint is missing, differs from the computed one, or the computation was incomplete |
| `failing` | `result` is `fail` |
| `fresh` | `result` is `pass`, a command is known, and the fingerprint matches |

```ts
export type VerdictState = 'absent' | 'unverifiable' | 'stale' | 'failing' | 'fresh'

export function verdictState(
  verdict: VerdictRecord | undefined,
  command: string | undefined,
  computed: Fingerprint,
): VerdictState
```

Order matters and is asserted: `absent` before `unverifiable` before `stale` before `failing`. A failing verdict on a stale tree is reported as **stale**, because the failure it records is about a tree that no longer exists.

## 6. The gate command

```ts
/** The task's own gate when it declares one, else the project default. */
export function gateCommand(task: TaskRecord | undefined, cfg: VerificationConfig | undefined): string | undefined
```

A task declares one with a line in its body:

```markdown
- **Gate:** vitest run src/spec
```

`TaskRecord` gains `gate?: string`. Precedence is task, then config, then undefined — and undefined is `unverifiable`, never "assume it passed".

## 7. Checks

### 7.1 `--phase tasks` gains one

| Check | Fires when | Severity |
|---|---|---|
| `unimplemented-case` | a case declared in `tests.md` is named by no test | gate |
| `no-tests-recognised` | no line in any searched file matched any pattern | gate, and it **replaces** every `unimplemented-case` for that run (LOOP-05) |

The replacement matters: a wrong pattern set would otherwise report all 85 cases as missing, which is a wall of noise that hides its own cause. One finding that says "no tests were recognised at all" names the real problem.

```ts
/** Case ids named by a test, found by walking `testInclude` for `testSuffixes`. */
export function implementedCases(
  projectDir: string,
  cfg: VerificationConfig,
  ids: readonly string[],
): { implemented: Set<string>; patternHits: number }
```

A case is implemented when some line **matches a pattern and contains the id**. Both conditions, on the same line. That is what makes a comment mentioning an id insufficient, which is what makes this catch IT-18.

### 7.2 A new `--phase verdict`

| Check | Fires when | Severity |
|---|---|---|
| `verdict-absent` | no verdict recorded | gate |
| `verdict-unverifiable` | no command is known | gate |
| `verdict-stale` | fingerprint missing, mismatched, or incomplete | gate |
| `verdict-failing` | the recorded result is `fail` | gate |
| `no-lumem-project` | no `.lumem/` above the feature directory | gate |

Kept out of `--phase tasks` on purpose: the two answer different questions at different moments, and folding them together makes the graph gate start failing for reasons that have nothing to do with the graph.

## 8. Advice versus enforcement

`nextAction` gains an optional second argument:

```ts
export interface VerificationState {
  state: VerdictState
  command?: string
  computed: Fingerprint
}

export function nextAction(f: SpecFeature, v?: VerificationState): NextAction
```

- **With `v`:** anything other than `fresh` yields `phase=verify action=verify`.
- **Without `v`:** 002's behaviour exactly — a recorded `pass` reaches `done`. Every case 002 wrote keeps passing unchanged.

This is the division 002 already established: **`next` is advice and fails open; `lint` is the gate.** LOOP-12 is enforced by `--phase verdict` exiting 3, not by `next` refusing to speak.

## 9. Invariants

1. lumem never executes a project command. Hashing and reading only.
2. The fingerprint never covers `docs/`, so recording a verdict cannot invalidate it.
3. An unreadable covered file makes the fingerprint `incomplete`, and an incomplete fingerprint is never fresh.
4. `verification` is optional in the config; a config without it parses unchanged.
5. A configured list replaces the corresponding default; it never merges.
6. `no-tests-recognised` and `unimplemented-case` never appear in the same run.
7. A case is implemented only when one line both matches a pattern and contains the id.
8. `next` without a `VerificationState` behaves exactly as 002 shipped it.
9. Precedence for the gate command is task, then config, then unverifiable — never a default that assumes success.
10. Every check added here exits 3 on a finding, 1 on its own failure, 0 otherwise.

## 10. Acceptance criteria

**Fingerprint**

1. Two runs over an unchanged tree produce the same hash.
2. Editing one covered file changes the hash; editing a file under `docs/` does not.
3. A file under an excluded prefix is not covered, even when it sits inside an included one.
4. An unreadable covered file yields `incomplete: true` and a hash that is never treated as fresh.
5. `fileCount` equals the number of files in the manifest.
6. An include list matching nothing yields `hash: ''`, `fileCount: 0`.

**Implemented cases**

7. `it('UT-01 …')` marks `UT-01` implemented.
8. A comment line containing `UT-01` and no pattern does not.
9. A file outside `testInclude`, or without a `testSuffixes` suffix, is not searched.
10. A configured pattern set replaces the default rather than extending it.
11. When no line in any searched file matches any pattern, the run yields `no-tests-recognised` and no `unimplemented-case`.
12. Running the finished check against **002's own directory reports IT-18 and IT-19, and nothing else.**

**Verdict**

13. A `## Verdict` block with `Result`, `Command` and `Fingerprint` parses into all three.
14. A verdict written before this slice — `Result` and `Evidence` only — parses with `command` and `fingerprint` absent, and states `stale`.
15. The five states resolve in the documented order, including a failing verdict on a changed tree reporting `stale`.
16. A task's `- **Gate:**` line overrides the config command; with neither, the state is `unverifiable`.

**Config**

17. A config with no `verification` block parses, and the defaults apply.
18. A `verification` block survives a `writeConfig` round-trip.
19. An unknown key inside `verification` is a schema error, like every other block.

**Non-regression**

20. Every case 002 wrote still passes, `next` included.
21. `npm run verify` stays green; the test count only grows.
22. Hook latency is unchanged — nothing here touches the hook path.

## 11. Success criterion

Criterion 12 is the one that matters, and it is already on disk: **the exact failure that produced this feature, caught by the feature.**

Beyond that, what is being learned:

> Does a gate built on a naming convention survive a second language?

The convention holds for 83 of 85 cases here, in one language, with one runner. **The signal to watch is a project configuring the check off rather than configuring its patterns** — that would mean the mechanism costs more than the gap it closes.

## 12. Deferred, with triggers

| Deferred | Revisit when |
|---|---|
| The discrimination pass | A shipped feature passes verification and still breaks — unchanged from 002 D12 |
| Glob support in the include lists | A real project cannot express what it needs with prefixes and suffixes |
| Per-package gate commands | A monorepo needs more than one command that means "everything" |
| Parsing what a test asserts, rather than what it is named | A case is named by a test that does not verify it, and it costs something |
| Signing or otherwise making a fingerprint unforgeable | Deliberate forgery is observed, rather than assumed absent |

## 13. Open, deliberately

- **The default pattern set is a guess about other people's languages.** Four patterns covering vitest, jest, Go and pytest. It is wrong for a runner nobody here uses, and the config key is the whole mitigation.
- **`SpecFeature.verdict` changes type**, which would break an external consumer if one existed. None does; the bundle is the only caller.
- **A truncated fingerprint in a document read by a human** is a display convention nothing enforces. If someone records `4f9c1a…` as the value rather than as the display, the check reports `stale` forever and the message has to be clear enough to explain why.
