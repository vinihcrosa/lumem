# Test contract — 003 Closing the test loop

**Derived from:** `tdd.md` §2–§9
**Status:** draft, awaiting review

The canonical numbered case list. `tasks.md` assigns every id below to exactly one task; `lint --phase tasks` fails on an orphan or a duplicate — and, once this slice ships, on a case no test names.

**Levels.** `UT-` unit, colocated as `src/**/*.test.ts`. `IT-` integration, in `test/`, spawning the bundle as a real process.

**Case-writing rule.** Every case names the exact input, the condition, and the expected result.

**Note on ids in test names.** This feature's own cases must satisfy the check it builds: each id below appears in the name of the test that covers it. The slice is its own first user.

---

## A. `findProjectDir`

`src/spec/verify.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-01 | a feature dir two levels under a directory holding `.lumem/` | that directory |
| UT-02 | a feature dir with `.lumem/` in the feature dir itself | the feature dir |
| UT-03 | a temp tree with no `.lumem/` anywhere above | `undefined`, no throw, no walk past the filesystem root |
| UT-04 | a path that does not exist | `undefined` |

## B. `computeFingerprint`

`src/spec/fingerprint.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-05 | the same unchanged tree, hashed twice | identical `hash`, identical `fileCount` |
| UT-06 | one byte changed in a covered file | a different `hash` |
| UT-07 | a file added under `docs/` (excluded) | `hash` unchanged |
| UT-08 | a file added under an included prefix | `hash` changes and `fileCount` grows by one |
| UT-09 | `node_modules/x.ts` inside an included `src` prefix | not covered; `fileCount` excludes it |
| UT-10 | an excluded prefix nested inside an included one | exclusion wins, checked before inclusion |
| UT-11 | a covered file whose read fails | `incomplete: true`, and the hash is still produced |
| UT-12 | include list matching nothing | `hash: ''`, `fileCount: 0`, `incomplete: false` |
| UT-13 | the same files, created in a different order | identical hash — the manifest is sorted, not readdir-ordered |
| UT-14 | two files whose contents are swapped between them | a different hash — the manifest pairs a path with its own content |

## C. `implementedCases`

`src/spec/implemented.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-15 | `it('UT-01 does a thing', …)` in a searched file, id `UT-01` | implemented |
| UT-16 | `// UT-01: a note` and no `it(` on that line | **not** implemented — this is the IT-18 case |
| UT-17 | `test("IT-03 …")` with the default patterns | implemented |
| UT-18 | `func TestIT03(t *testing.T)` with id `IT-03` in the name | implemented |
| UT-19 | a file under `src` without a `.test.ts` suffix, containing `it('UT-01 …')` | not searched, so not implemented |
| UT-20 | a test file outside every `testInclude` prefix | not searched |
| UT-21 | a configured pattern set of `["\\bspec\\s*\\("]` and a file using `it(` | not implemented — the configured set replaced the default |
| UT-22 | no line in any searched file matches any pattern | `patternHits: 0` |
| UT-23 | one matching line naming three ids | all three implemented |
| UT-24 | ids declared but no searched file exists at all | `patternHits: 0`, `implemented` empty |

## D. Verdict parsing

`src/spec/feature.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-25 | a Verdict block with `Result: PASS`, `Command` and `Fingerprint: <hex>` | all three fields parsed; `result: 'pass'`; the file count in the line is prose and is not parsed |
| UT-26 | `Result: fail` in lowercase | `result: 'fail'` |
| UT-27 | a 002-era block with only `Result` and `Evidence` | parses; `command` and `fingerprint` absent |
| UT-28 | a fingerprint recorded as `4f9c1a…` with the ellipsis | parsed verbatim; it will not match a computed hash, which is the point |
| UT-29 | two Verdict blocks disagreeing on `Result` | one warning; the last read wins, as 002 already does |
| UT-30 | a task body carrying `- **Gate:** vitest run src/spec` | `TaskRecord.gate` holds the command |
| UT-31 | a task body with no Gate line | `gate` absent, not empty string |

## E. `verdictState` and `gateCommand`

`src/spec/verify.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-32 | no verdict at all | `absent` |
| UT-33 | a verdict, no command from task or config | `unverifiable` |
| UT-34 | `pass`, command known, fingerprint matches | `fresh` |
| UT-35 | `pass`, command known, fingerprint differs | `stale` |
| UT-36 | `pass`, command known, fingerprint absent | `stale` |
| UT-37 | `pass`, command known, matching fingerprint, `incomplete: true` | `stale` |
| UT-38 | `fail`, command known, fingerprint matches | `failing` |
| UT-39 | `fail`, command known, fingerprint differs | `stale` — the failure describes a tree that no longer exists |
| UT-40 | a task gate and a config command both present | the task's wins |
| UT-41 | only a config command | the config's is used |
| UT-42 | neither | `undefined`, never a fabricated default |

## F. `lint --phase tasks`, extended

`src/spec/lint-tasks.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-43 | a declared case named by no test | `unimplemented-case`, gate, ids naming the case |
| UT-44 | every declared case named by a test | no `unimplemented-case` |
| UT-45 | no pattern matched anywhere | `no-tests-recognised`, gate |
| UT-46 | the same run as UT-45 | **zero** `unimplemented-case` findings — the one finding replaces them |
| UT-47 | ownership broken *and* a case unimplemented | both findings returned, gates first |
| UT-48 | no `.lumem/` above the feature | `no-lumem-project`, and no attempt to search for tests |

## G. `lint --phase verdict`

`src/spec/lint-verdict.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-49 | no verdict recorded | `verdict-absent`, gate |
| UT-50 | verdict present, no command anywhere | `verdict-unverifiable`, gate |
| UT-51 | fingerprint mismatched | `verdict-stale`, gate, message naming that the tree changed |
| UT-52 | `result: fail`, fingerprint matching | `verdict-failing`, gate |
| UT-53 | `pass`, command known, fingerprint matching | zero findings |
| UT-54 | no `.lumem/` above the feature | `no-lumem-project`, gate |

## H. `nextAction` with and without verification

`src/spec/next.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-56 | every task done, verdict `pass`, `VerificationState` state `fresh` | `phase=done action=done` |
| UT-57 | the same, state `stale` | `phase=verify action=verify` |
| UT-58 | the same, state `unverifiable` | `phase=verify action=verify` |
| UT-59 | the same, no `VerificationState` passed at all | `phase=done action=done` — 002's behaviour, unchanged |
| UT-60 | tasks unfinished and state `stale` | `execute-task` still wins; verification is not jumped to early |

## I. Config

`src/core/config.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-61 | a config with no `verification` block | parses; defaults apply |
| UT-62 | a `verification` block with only `command` | parses; the list fields take their defaults |
| UT-63 | an unknown key inside `verification` | a schema error naming the key |
| UT-64 | `writeConfig` then `readConfig` with a `verification` block | round-trips byte-identically |
| UT-65 | `writeConfig` on a config without `verification` | the key is absent from the output, not written as `null` |

## J. The bundle surface

`test/spec-bundle.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| IT-01 | `lint --phase verdict` on a feature with a fresh verdict | exit 0 |
| IT-02 | `lint --phase verdict` on a stale one | exit 3, and the finding names the case |
| IT-03 | `lint --phase tasks` on a feature with an unimplemented case | exit 3 |
| IT-04 | `--phase verdict --json` | the finding list in the shared shape |
| IT-05 | `next` on a feature whose verdict is stale | `phase=verify action=verify` on stdout, exit 0 |
| IT-06 | the whole run with `PATH=/nonexistent` | unchanged: nothing is executed, so nothing needs a PATH |
| IT-07 | a feature directory outside any lumem project | `no-lumem-project`, exit 3, message naming the path |

## K. The acceptance test

`test/spec-002-regression.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| IT-08 | the finished checks run against `docs/features/002-spec-driven` | exactly two `unimplemented-case` findings, for **IT-18 and IT-19**, and no others |
| IT-09 | the same run | no `no-tests-recognised` — the default patterns do match this repository |

**IT-08 is the acceptance test for the slice.** It is the failure that produced the feature, already on disk, and it is the one case that cannot be satisfied by a fixture.

---

## Not covered, deliberately

- **The fingerprint's cost.** Hashing ~1,300 files takes what it takes; it runs on demand and never on the hook path. A performance assertion here would encode a machine, not a requirement.
- **Deliberate forgery.** A pasted fingerprint defeats the check by design (D3). Asserting that would be asserting a known limitation.
- **Every runner in the default pattern set.** UT-17 and UT-18 cover two of the four. Go and pytest patterns are asserted as regexes, not by installing two more toolchains.

## Coverage matrix

| Criterion (`tdd.md` §10) | Cases |
|---|---|
| 1 stable hash | UT-05, UT-13 |
| 2 covered edit changes it, docs edit does not | UT-06, UT-07 |
| 3 exclusion inside inclusion | UT-09, UT-10 |
| 4 unreadable file | UT-11, UT-37 |
| 5 `fileCount` | UT-08, UT-12 |
| 6 empty include | UT-12 |
| 7 id in a test name | UT-15, UT-17, UT-18 |
| 8 comment is not enough | UT-16 |
| 9 unsearched files | UT-19, UT-20, UT-24 |
| 10 configured replaces default | UT-21 |
| 11 no patterns matched | UT-22, UT-45, UT-46 |
| **12 IT-18 and IT-19 reported** | **IT-08, IT-09** |
| 13 full verdict parses | UT-25, UT-26 |
| 14 002-era verdict is stale | UT-27, UT-36 |
| 15 state order | UT-32…UT-39 |
| 16 gate precedence | UT-30, UT-31, UT-40, UT-41, UT-42 |
| 17 config without the block | UT-61 |
| 18 round-trip | UT-64, UT-65 |
| 19 unknown key | UT-63 |
| 20 002's cases still pass | UT-59, and the suite as a whole |
| 21 `npm run verify` green | the suite as a whole |
| 22 hook latency unchanged | `npm run bench:hook` |

**73 cases: UT-01…UT-54, UT-56…UT-65, IT-01…IT-09.** UT-55 was cut by the design-phase prune; the ids are not renumbered, for the same reason 002's are not. Criterion 22 is the thinnest — it is a bench, not a case, and it stays that way because this slice touches nothing on the hook path.
