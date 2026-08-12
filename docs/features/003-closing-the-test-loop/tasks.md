# Tasks — 003 Closing the test loop

**Derived from:** `tdd.md`, `tests.md`
**Status:** draft, awaiting review

Eight tasks, 73 cases. Sized by 002's `tdd.md` §3.4: fewer and larger, split only at a contract boundary, a disjoint-file boundary, or a domain boundary.

**The graph table owns topology; each body owns its own state.** The checkbox lives in the body, so marking a task done touches only that task.

**Every body carries a `Gate:` line** — the mechanism this feature introduces, used by the feature that introduces it. The closing verdict uses the project default.

## Resolved before the bodies were written

`tdd.md` §1 lists one new module, `src/spec/verify.ts`. `tests.md` names three test files — `verify.test.ts`, `fingerprint.test.ts`, `implemented.test.ts` — and this repository colocates a test with its module.

Under the precedence ladder, the contract artifact wins for the fact it owns: **where a case lives.** So there are three modules, not one, and that is why T2, T3 and T5 are separate rather than a single slice.

## Graph

| # | Title | Domain | Complexity | Depends on | Cases |
|---|---|---|---|---|---|
| T1 | The `verification` config block | source | low | — | UT-61…UT-65 |
| T2 | Tree fingerprint | source | medium | T1 | UT-05…UT-14 |
| T3 | Implemented cases | source | medium | T1 | UT-15…UT-24 |
| T4 | Verdict record and the `Gate:` line | source | medium | — | UT-25…UT-31 |
| T5 | Project root, verdict state, command precedence | source | high | T2, T4 | UT-01…UT-04, UT-32…UT-42 |
| T6 | `lint`: `tasks` extended, `verdict` added | source | high | T3, T5 | UT-43…UT-54 |
| T7 | `next` with an optional `VerificationState` | source | medium | T5 | UT-56…UT-60 |
| T8 | Bundle surface and the acceptance test | source | high | T6, T7 | IT-01…IT-09 |

```
T1 ──┬── T2 ──┐
     └── T3 ──┼── T5 ── T6 ──┐
T4 ───────────┘        └ T7 ──┴── T8
```

T1 and T4 are roots and can run in either order. The critical path is T1 → T2 → T5 → T6 → T8, five deep.

**Complexity rates regression risk.** T5 is `high` because the order of the five states is the logic deciding whether a `PASS` counts; T6 because a wrong gate blocks authoring; T8 because it carries the acceptance criterion for the whole slice.

---

## T1 — The `verification` config block

- [x] T1 — The `verification` config block
- **Gate:** vitest run src/core/config

### Overview

`VerificationConfig` and its defaults, in the schema, in the type, and in `normalize`. Every later task depends on this type existing.

### Requirements

1. `verification` MUST be optional. A config written before this slice MUST parse unchanged (invariant 4).
2. The block MUST be `.strict()` like every sibling, so an unknown key inside it is a schema error.
3. `normalize()` MUST carry the block through a write, and MUST omit the key entirely when it is absent — never `null`, never an empty object.
4. Defaults MUST be exported constants, not literals inlined at a call site, so the `tdd.md` §2 table has exactly one implementation.
5. A configured list MUST replace the corresponding default (invariant 5). Merging is a defect, not a nicety.
6. `defaultConfig()` MUST NOT invent a `command`. A project with no gate is `unverifiable`, and pretending otherwise is the failure this feature exists to close.

### Subtasks

- [ ] `VerificationConfig` type and `DEFAULT_VERIFICATION` constants
- [ ] Optional strict schema block
- [ ] `normalize()` round-trip, including the absent case
- [ ] Set `verification.command` in this repository's own `.lumem/lumem.config.json`

### Files

Modify `src/core/config.ts`, `src/core/config.test.ts`, and this repo's `.lumem/lumem.config.json`.

### Tests

UT-61…UT-65. UT-64 and UT-65 are the ones that matter: `writeConfig` normalises through an explicit destructure, so a field that parses and is missing from `normalize` is silently dropped on the next write. That is a real trap in this file, not a hypothetical.

### Success criteria

Every case passes. `readConfig` on this repo's existing config still succeeds before the `command` is added, and after.

### Completion notes

**Done 2026-08-11.** `src/core/verification.ts` (new), `src/core/config.ts`, `src/core/config.test.ts`, and this repo's `.lumem/lumem.config.json`; 6 assertions covering UT-61…UT-65.

Evidence: `npm run verify` — 149 files checked, `tsc --noEmit` silent, **1510 tests passed** across 60 files. The real config read back through the real parser:

```
error   : none
command : npm run verify
suffixes: [ '.test.ts' ]
excl doc: true
```

**The type does not live where the design said.** `tdd.md` §1 puts `verification` in `core/config.ts`. It is in **`src/core/verification.ts`**, because `core/config.ts` already follows a rule this repo states out loud — *every default comes from the module that owns the concept* (budgets from `memory/limits`, gating from `consolidate/gate`). Putting it in `spec/` instead would have inverted the layering, since config cannot depend on spec.

**A pre-existing annotation was wrong, and a default exposed it.** `lumemConfigSchema` was typed `z.ZodType<LumemConfig>`, which pins the input type equal to the output type. That held only while no field had a default; the moment `fingerprintInclude` got one, a valid *input* stopped being shaped like a `LumemConfig` and `tsc` refused the whole schema. Widened to `z.ZodType<LumemConfig, z.ZodTypeDef, unknown>`, which is what it always was — the thing parses JSON off disk.

**`defaultConfig` deliberately writes no `verification` block.** A new project has no gate, so every verdict in it is `unverifiable` until someone names a command. Inventing `npm run verify` as a default would have been the same class of assumption this feature exists to remove, and UT-65 asserts the absence.

The block for this repository was added by hand rather than by a migration: one key in one file, and a migration path for an optional field nobody has yet is machinery with no user.

---

## T2 — Tree fingerprint

- [x] T2 — Tree fingerprint
- **Gate:** vitest run src/spec/fingerprint

### Overview

`src/spec/fingerprint.ts`: walk the included prefixes, hash each covered file, and hash the sorted manifest.

### Requirements

1. The manifest MUST be `<relative-posix-path> <sha256>` per line, **sorted by path**. `readdirSync` order is undefined and a fingerprint that depends on it is not a fingerprint.
2. Exclusion MUST be checked before inclusion, so an excluded prefix nested inside an included one is skipped (UT-10).
3. A covered file that cannot be read MUST set `incomplete: true` and MUST NOT abort the walk (invariant 3).
4. An empty result MUST be `hash: ''`, `fileCount: 0` — not the hash of an empty string, which would be indistinguishable from a real tree that happens to hash to it.
5. MUST import nothing external. This module reaches the bundle.
6. MUST NOT read anything outside `projectDir`.

### Subtasks

- [ ] Recursive walk with prefix inclusion and exclusion
- [ ] Per-file hashing through the existing `sha256`
- [ ] Sorted manifest, then the manifest hash
- [ ] `incomplete` on an unreadable file

### Files

Create `src/spec/fingerprint.ts`, `src/spec/fingerprint.test.ts`.

### Tests

UT-05…UT-14. UT-13 and UT-14 are the pair that matters: one pins that order does not leak in, the other that a path is bound to its own content — the bug where hashes are concatenated without their paths passes every other case.

### Success criteria

Every case passes. Hashing this repository twice produces the same value, and touching one byte under `src/` changes it while touching `docs/` does not.

### Completion notes

**Done 2026-08-11.** `src/spec/fingerprint.ts`, `src/spec/fingerprint.test.ts`; 14 assertions covering UT-05…UT-14.

Evidence: `npm run verify` — 149 files checked, `tsc --noEmit` silent, **1524 tests passed**. Against this repository:

```
hash    : b0de76df6f1a04cacabaa433c34c3f441fee3b15e3d1d16f6be116476037d38d
files   : 138 | incomplete: false
stable  : true
docs op : true
```

138 files, not the ~1,300 the design guessed — `node_modules` and `dist` are the bulk of a repo, and excluding them leaves a fingerprint cheap enough that the cost paragraph in `tdd.md` §3 overstates it by an order of magnitude.

**Exclusion needed two forms, and the case found it.** The design called these prefixes, and a prefix is anchored at the project root — so `node_modules` excluded the top-level one and `src/node_modules` walked straight through. UT-09 caught it on the first run.

Resolved by giving the list two readings: an entry **containing `/` stays anchored** (`src/spec` excludes exactly that subtree, which is what UT-10 asserts), and a **bare name matches any path segment at any depth**. That is how everyone reads "exclude node_modules", and the alternative — listing every nesting — would make the default list a guess about someone else's directory layout.

**One export was cut before it shipped.** A `manifestPath` helper existed for a caller that did not turn out to need it. An unused export is a promise nobody asked for.

Two cases beyond the contract's letter, because the boundary logic invited them: a sibling named `srcextra` is not covered by the prefix `src`, and a top-level file named exactly by a prefix (`package.json`) is. Both are one-line traps in `startsWith`-shaped code.

---

## T3 — Implemented cases

- [x] T3 — Implemented cases
- **Gate:** vitest run src/spec/implemented

### Overview

`src/spec/implemented.ts`: which declared ids are named by a test, and how many lines matched a pattern at all.

### Requirements

1. A case counts as implemented only when **one line both matches a pattern and contains the id** (invariant 7). Two conditions, one line.
2. Only files under a `testInclude` prefix **and** ending in a `testSuffixes` suffix MUST be searched.
3. `patternHits` MUST count lines matching any pattern, so a caller can tell "no tests here" from "no cases here".
4. A configured pattern set MUST replace the default (invariant 5).
5. An invalid regex in the configured set MUST NOT throw. It is skipped, and the caller is told.
6. MUST import nothing external.

### Subtasks

- [ ] Walk the searched files
- [ ] Compile the patterns once, tolerantly
- [ ] Per-line matching, id containment, `patternHits`
- [ ] Return the implemented set

### Files

Create `src/spec/implemented.ts`, `src/spec/implemented.test.ts`.

### Tests

UT-15…UT-24. **UT-16 is the reason this feature exists**: a comment naming a case is not an implementation. If that case ever passes wrongly, the slice has lost its point.

### Success criteria

Every case passes. Run against this repository, 002's declared cases resolve as measured: 83 implemented, IT-18 and IT-19 not.

### Completion notes

**Done 2026-08-11.** `src/spec/implemented.ts`, `src/spec/implemented.test.ts`, plus `src/spec/walk.ts` extracted from T2; 16 assertions covering UT-15…UT-24.

Evidence: `npm run verify` — 154 files checked, `tsc --noEmit` silent, **1540 tests passed** across 62 files. The measurement that produced this feature, now asserted by the code the feature produced:

```
85 ids declared in 002's contract
missing → ['IT-18', 'IT-19']
patternHits > 1000
```

**The walk was extracted rather than copied.** T2 owned three subtle predicates — a boundary-aware prefix, a two-form exclusion, and "is this directory worth entering" — and this task needed all three. Two implementations would have drifted on the first change to either, which is the class of defect the spec gates exist to catch. `src/spec/walk.ts` now holds them; `fingerprint.ts` imports them and its 14 cases pass unchanged.

**The matching rule was wrong in the design, and UT-18 failed twice before it was right.**

The rule as written — *the line contains the id* — was written by someone thinking in JavaScript, where a test name is a string and `UT-01` appears verbatim. The default pattern set it ships alongside includes `func Test` and `def test_`, and **a hyphen is illegal in an identifier in both.** So the check advertised two languages it could never match in.

First fix: accept the punctuation-free form, `UT01`. UT-18 then passed and the pytest case failed, because Python lowercases by convention — `def test_ut01_parses`. Second fix: match case-insensitively.

Neither failure was a bad fixture. Both were the contract being honest about languages the rule had not thought about, and the cost of finding them here rather than in a user's Go repository is two minutes.

**One sharp edge recorded rather than fixed.** Substring containment means `UT-011` satisfies `UT-01`. Unreachable with two-digit ids, and a boundary-aware search would need to know what characters may follow an id in an arbitrary language. Named in a case so the next person meets it as a decision rather than as a surprise.

---

## T4 — Verdict record and the `Gate:` line

- [x] T4 — Verdict record and the `Gate:` line
- **Gate:** vitest run src/spec/feature

### Overview

`SpecFeature.verdict` becomes a record carrying the command and the fingerprint; `TaskRecord` gains `gate`.

### Requirements

1. `verdict` MUST change from `'pass' | 'fail' | undefined` to `VerdictRecord | undefined`. This breaks a type 002 shipped; the bundle is the only consumer.
2. `command` and `fingerprint` MUST be optional, so a 002-era verdict parses (UT-27).
3. A fingerprint MUST be recorded verbatim, including a human's ellipsis. Normalising it would hide the mistake it represents (UT-28).
4. Two disagreeing verdicts MUST warn and MUST let the last read win, exactly as 002 already does.
5. `TaskRecord.gate` MUST be absent rather than an empty string when no line is present.
6. Parsing MUST stay tolerant: no new throw path (invariant from 002).

### Subtasks

- [ ] `VerdictRecord` type; replace the `verdict` field
- [ ] Parse `Command` and `Fingerprint` lines
- [ ] Parse `- **Gate:**` into `TaskRecord.gate`
- [ ] Update 002's callers so the suite stays green

### Files

Modify `src/spec/feature.ts`, `src/spec/feature.test.ts`.

### Tests

UT-25…UT-31.

### Success criteria

Every case passes, **and every 002 case that touches `verdict` passes after the type change** — that is the non-regression this task owns.

### Completion notes

**Done 2026-08-11.** `src/spec/feature.ts`, `src/spec/feature.test.ts`, plus the one call site in `src/spec/next.ts` the type change reached; 9 assertions covering UT-25…UT-31.

Evidence: `npm run verify` — 154 files checked, `tsc --noEmit` silent, **1549 tests passed** across 62 files.

**The breaking type change cost exactly two lines.** `SpecFeature.verdict` went from `'pass' | 'fail'` to `VerdictRecord`, and `tsc` named both consumers immediately: a comparison in `next.ts` and a fixture in `next.test.ts`. Everything 002 asserted about verdicts passes unchanged.

**A `Gate:` line needed an owner, and the parser had no notion of one.** The graph table is read row by row and the checkbox lines are matched by the id they carry — but a `- **Gate:**` line carries no id, so it can only be attributed by position. The reader now tracks the task whose checkbox opened the body it is inside, and a Gate line outside any body is a warning rather than a silent loss.

**A second `Result` line starts a new record.** Without that, a command or fingerprint below the second verdict would attach to the first, producing a record that mixes two runs — worse than either. UT-29 asserts the replacement and the warning together.

The fingerprint is read as the **first whitespace-delimited token**, so `4f9c1a… (1284 files)` yields `4f9c1a…` and the count stays prose. That also means a truncated hash is kept verbatim: it will not match a computed one, and reporting that is the point rather than a bug to paper over.

---

## T5 — Project root, verdict state, command precedence

- [ ] T5 — Project root, verdict state, command precedence
- **Gate:** vitest run src/spec/verify

### Overview

`src/spec/verify.ts`: find the project, resolve which command applies, and decide which of five states a verdict is in.

### Requirements

1. `findProjectDir` MUST walk up from the feature directory to the nearest ancestor holding `.lumem/`, and MUST stop at the filesystem root without looping.
2. It MUST NOT consult `process.cwd()`. The answer cannot depend on where the command was typed.
3. `verdictState` MUST resolve in the documented order — `absent`, `unverifiable`, `stale`, `failing`, `fresh` — and **the order MUST be asserted**, because a failing verdict on a changed tree has to read as `stale` (UT-39).
4. An `incomplete` fingerprint MUST never yield `fresh` (invariant 3).
5. `gateCommand` MUST prefer the task, then the config, then `undefined`. It MUST NOT fabricate a default (invariant 9).
6. MUST be pure over its inputs apart from `findProjectDir`, which is the only filesystem reach in this module.

### Subtasks

- [ ] `findProjectDir` with a root-terminating walk
- [ ] `gateCommand` precedence
- [ ] `verdictState` as an ordered chain
- [ ] `VerificationState` assembly for callers

### Files

Create `src/spec/verify.ts`, `src/spec/verify.test.ts`.

### Tests

UT-01…UT-04, UT-32…UT-42.

### Success criteria

Every case passes. The state order is asserted explicitly, not implied by the case that happens to run first.

---

## T6 — `lint`: `tasks` extended, `verdict` added

- [ ] T6 — `lint`: `tasks` extended, `verdict` added
- **Gate:** vitest run src/spec

### Overview

Two checks in the existing tasks phase, five in a new verdict phase.

### Requirements

1. `unimplemented-case` MUST be a gate, naming the case id.
2. `no-tests-recognised` MUST **replace** every `unimplemented-case` in that run (invariant 6). A wrong pattern set must produce one finding that names its own cause, not 85 that hide it.
3. `SpecLintPhase` MUST gain `verdict`; the CLI's accepted values MUST follow from the same list, not a second one.
4. `no-lumem-project` MUST be a gate in **both** phases. Without the root, `implementedCases` cannot run, and skipping it silently would make `unimplemented-case` pass vacuously — a false PASS, which is the failure this feature closes.
5. Findings MUST use the existing `SpecFinding` shape and sort gates first.
6. MUST NOT auto-fix anything.

### Subtasks

- [ ] Wire the project root and config into the tasks phase
- [ ] `unimplemented-case` and the `no-tests-recognised` replacement
- [ ] The `verdict` phase and its five checks
- [ ] `no-lumem-project` shared by both phases

### Files

Modify `src/spec/lint.ts`, `src/spec/lint-tasks.test.ts`. Create `src/spec/lint-verdict.test.ts`.

### Tests

UT-43…UT-54. UT-46 is the one worth naming: it asserts an **absence** — that the replacement leaves no `unimplemented-case` behind — and absences are what regressions restore.

### Success criteria

Every case passes. `lint --phase tasks` on 002 reports IT-18 and IT-19; on 003 it reports nothing once this feature's own tests exist.

---

## T7 — `next` with an optional `VerificationState`

- [ ] T7 — `next` with an optional `VerificationState`
- **Gate:** vitest run src/spec/next

### Overview

Staleness reaches the advice without becoming a requirement of it.

### Requirements

1. The second argument MUST be optional, and its absence MUST reproduce 002's behaviour exactly (invariant 8).
2. With a state present, anything other than `fresh` MUST yield `phase=verify action=verify`.
3. The task rules MUST still outrank verification: an unfinished graph yields `execute-task`, whatever the verdict says (UT-60).
4. `nextAction` MUST stay pure. Computing the state is the caller's job.
5. MUST NOT make `next` exit non-zero for a stale verdict. `next` is advice; `lint --phase verdict` is the gate.

### Subtasks

- [ ] Optional parameter and the `VerificationState` type import
- [ ] A rule for non-`fresh` states, placed after the task rules
- [ ] Assert 002's behaviour survives with no second argument

### Files

Modify `src/spec/next.ts`, `src/spec/next.test.ts`.

### Tests

UT-56…UT-60.

### Success criteria

Every case passes, and every 002 `next` case passes untouched.

---

## T8 — Bundle surface and the acceptance test

- [ ] T8 — Bundle surface and the acceptance test
- **Gate:** npm run verify

### Overview

`--phase verdict` reachable from the bundle, the verification state assembled for `next`, and the case that justifies the whole slice.

### Requirements

1. `lint --phase verdict` MUST be accepted by the CLI and MUST follow the 0 / 3 / 1 convention.
2. `next` MUST assemble the `VerificationState` — find the root, read the config, compute the fingerprint — and pass it in.
3. The bundle MUST still import nothing external. `node:crypto` is a builtin; the purity assertion MUST still pass.
4. The run MUST still work with `PATH=/nonexistent` (IT-06), because nothing is executed.
5. **IT-08 MUST assert exactly two findings against 002's real directory: IT-18 and IT-19.** Not "at least two", not "contains" — exactly, so a future over-eager check fails here.
6. MUST NOT modify 002's artifacts to make its own test pass. The acceptance test reads history as it is.

### Subtasks

- [ ] `verdict` in the CLI's phase list
- [ ] Assemble `VerificationState` in the `next` path
- [ ] Bundle cases for both commands
- [ ] The 002 regression test

### Files

Modify `src/spec/main.ts`, `src/spec/main.test.ts`, `test/spec-bundle.test.ts`. Create `test/spec-002-regression.test.ts`.

### Tests

IT-01…IT-09. **IT-08 is the acceptance test for the feature.**

### Success criteria

`npm run verify` green. `sh scripts/verify-pack.sh` green. IT-08 passes against `docs/features/002-spec-driven` unmodified.

---

## Assignment audit

- Every id in `tests.md` appears in exactly one task: UT-01…UT-54 and UT-56…UT-65 across T1–T7; IT-01…IT-09 in T8.
- 73 of 73 assigned. No orphans, no duplicates, no cycles.
- Every task owns cases, so no `task-without-tests` finding is expected — unlike 002, where T8 was prompt assets.
