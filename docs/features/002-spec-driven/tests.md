# Test contract — 002 Spec-driven core

**Derived from:** `tdd.md` §1–§10
**Status:** draft, awaiting review

The canonical numbered case list. `tasks.md` assigns every id below to exactly one task; `lint --phase tasks` fails on an orphan or a duplicate.

**Levels.** `UT-` unit, colocated as `src/**/*.test.ts`. `IT-` integration, in `test/`, spawning real processes. lumem has no separate e2e tier — `test/packaging.test.ts` drives the packed tarball and is the outermost level that exists.

**Case-writing rule.** Every case names the exact input, the condition, and the expected result. "Tests the happy path" is not a case.

---

## A. `readFeature` — tolerant parse

`src/spec/feature.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-01 | frontmatter with `slug`, `tier: full`, `created` | `SpecFeature` carries all three; `warnings` empty |
| UT-02 | frontmatter without `tier` | no throw; `tier` absent; one warning naming the missing key |
| UT-03 | `tier: huge` | one warning; `tier` treated as absent, not coerced |
| UT-04 | `slug: 003-other` inside directory `002-spec-driven` | one warning; the directory name wins as the identifier |
| UT-05 | frontmatter with no closing `---` | no throw; `warnings` non-empty; body-derived fields still parsed |
| UT-06 | `**Answer:** B` under `### Q6` in round 2 | question `Q6`, `round: 2`, `answered: true` |
| UT-07 | `**Answer:**` with nothing after it | `answered: false` |
| UT-08 | `**Effect:** rejected-framing`, then `**Effect:** nonsense` | first parses; second yields `effect: undefined` plus one warning |
| UT-09 | `- [x] T1 …` and `- [ ] T2 …` | `T1.done true`, `T2.done false` |
| UT-10 | task row with no dependency cell | `dependsOn: []`, not `undefined` |
| UT-11 | task listing `UT-04, IT-02` | `testIds: ['UT-04','IT-02']` |
| UT-12 | `tests.md` declaring ids across several tables | `feature.testIds` holds every id, deduplicated |
| UT-13 | `decisions.md` with and without a `Cut, and why` heading | `has.cutSection` true then false |
| UT-14 | `tdd.md`, `tests.md`, `tasks.md` all absent | their `has` flags false; **no warning** — absence is valid |
| UT-15 | directory that does not exist | returns a feature with every `has` false and one warning; never throws |

## B. `nextAction` — phase derivation

`src/spec/next.test.ts`. Order matters: first match wins.

| ID | Input / condition | Expected |
|---|---|---|
| UT-16 | directory absent | `phase=context action=create-context` |
| UT-17 | only `context.md` present | `phase=scope action=settle-size` |
| UT-18 | `decisions.md` present, frontmatter has no `tier` | `phase=scope action=settle-size` |
| UT-19 | Q3 and Q7 both unanswered | `action=await-answers target=Q3` — the first, not the last |
| UT-20 | every question answered, Q4 has no `**Effect:**` | `action=score-round` |
| UT-21 | all scored, no `Cut, and why` | `phase=prune action=prune` |
| UT-22 | `tier: light`, `tdd.md` absent, prune done | never yields `write-tdd`; proceeds to execute or verify |
| UT-23 | `tier: design`, `tdd.md` absent | `phase=design action=write-tdd` |
| UT-24 | `tier: design`, `tdd.md` present, `tests.md` absent | `phase=design action=write-tests` |
| UT-25 | `tier: full`, `tests.md` present, `tasks.md` absent | `phase=tasks action=write-tasks` |
| UT-26 | T1 done, T2 and T3 ready | `action=execute-task target=T2` — lowest ready id |
| UT-27 | every task done, no verdict recorded | `phase=verify action=verify` |
| UT-28 | verdict recorded and passing | `phase=done action=done` |
| UT-29 | an unanswered question **and** a missing `tdd.md` | `await-answers` wins; ordering is not incidental |
| UT-30 | `tier: light`, prune done, no tasks, verdict passing | `phase=done action=done` |
| UT-65 | every question answered and scored, `prd.md` absent | `phase=requirements action=write-prd` |

> UT-65 is out of sequence on purpose. The `write-prd` row was missing from `tdd.md` §5.4 and was found during T1, by running the parser against this feature's own directory — `has.prd` came back false and nothing in the derivation table noticed. Renumbering eighty-odd assigned ids to close a gap costs more than a non-contiguous id.

## C. `lintSpec --phase prd`

`src/spec/lint-prd.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-31 | empty `**Answer:**` while `prd.md` exists | `unanswered-question`, severity gate |
| UT-32 | empty `**Answer:**`, no `prd.md` yet | zero findings — the question is simply still open |
| UT-33 | Assumptions row with an empty default cell | `unclosed-ambiguity`, gate |
| UT-34 | Assumptions row with a default and an empty rationale | `unclosed-ambiguity`, gate |
| UT-35 | failure-path criterion reading "handles the error gracefully" | `vague-risky-criterion`, gate |
| UT-36 | failure-path criterion reading "returns 409 and leaves the row unchanged" | zero findings |
| UT-37 | concurrency criterion with no bound or ordering guarantee | `vague-risky-criterion` |
| UT-38 | ordinary prose criterion outside the three risky dimensions | zero findings — notation is not required there |
| UT-39 | answered question with no `**Effect:**` | `unscored-question`, severity info |
| UT-40 | a complete, closed `prd.md` | zero findings |

## D. `lintSpec --phase tdd`

`src/spec/lint-tdd.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-41 | field table row whose Type cell is empty | `field-without-type`, gate |
| UT-42 | every field row carrying a type | zero findings |
| UT-43 | no fenced block containing a declaration | `no-signature-block`, gate |
| UT-44 | a fenced block declaring an interface | zero findings |
| UT-45 | `## Invariants` followed by a bulleted list | `invariants-not-ordered`, gate |
| UT-46 | `## Invariants` followed by `1.`, `2.`, `3.` | zero findings |
| UT-47 | Deferred table row with an empty trigger cell | `no-deferred-triggers`, info |
| UT-48 | one gate finding and one info finding together | both returned, severities distinguishable |

## E. `lintSpec --phase tasks`

`src/spec/lint-tasks.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-49 | `UT-07` declared in `tests.md`, assigned to no task | `orphan-test-id`, gate |
| UT-50 | `IT-03` assigned to T2 and T5 | `duplicate-test-id`, gate |
| UT-51 | T1 → T2 → T1 | `dependency-cycle`, gate; the walk terminates rather than looping |
| UT-52 | T3 depending on `T9`, absent from the graph | `unknown-dependency`, gate |
| UT-53 | a task carrying no case ids | `task-without-tests`, info |
| UT-54 | a graph where every id is assigned once and deps resolve | zero findings |

## F. Bundle surface

`test/spec-bundle.test.ts`, spawning `.lumem/bin/lumem-spec.mjs` as a real process.

| ID | Input / condition | Expected |
|---|---|---|
| IT-01 | `next <dir>` on a well-formed feature | stdout is exactly one line matching `^phase=\S+ action=\S+( target=\S+)?$` |
| IT-02 | same | exit 0 |
| IT-03 | `next` on a path that cannot be read | exit 1, message names the path |
| IT-04 | `next --json` | emits a `NextAction` object; fields match the plain-text line |
| IT-05 | `lint --phase tdd` on an artifact with one gate finding | exit 3 |
| IT-06 | `lint --phase tdd` on a clean artifact | exit 0, no output on stderr |
| IT-07 | `lint --phase nonsense` | exit 1 |
| IT-08 | `lint --json` | finding list with `kind`, `severity`, `file`, `message` — same shape `memory lint` emits |
| IT-09 | run from a repo where `lumem` is not on `PATH` | behaves identically; no CLI is consulted |
| IT-10 | one artifact with malformed frontmatter among several | the others are still checked; the malformed one yields a finding |

## G. Purity and build

| ID | Where | Input / condition | Expected |
|---|---|---|---|
| UT-55 | `src/spec/main.test.ts` | the bundle entry's import graph | no external import reaches it; the assertion fails if one is added |
| IT-11 | `test/packaging.test.ts` | after `npm run build` | `dist/lumem-spec.mjs` exists and runs under `node` |

## H. Install integration

`src/cli/install.test.ts` and `test/packaging.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| IT-12 | `lumem install` in a clean repo | `.lumem/bin/lumem-spec.mjs` exists, **copied** not symlinked |
| IT-13 | same | lockfile gains `spec-bundle:lumem-spec` with `mode: "copy"` and a `contentHash` |
| IT-14 | `install` run twice | second run produces byte-identical state |
| IT-15 | edit the copied bundle, then `sync` | drift reported; the file is not overwritten |
| IT-16 | `sync --force` after the same edit | overwritten, and a timestamped backup exists under `.lumem/local/backups/` |
| IT-17 | `uninstall` | the bundle is gone; `.lumem/memory/` survives |
| IT-18 | `status` | lists the spec bundle with its version |
| IT-19 | packed tarball installed into a clean directory | ships the bundle, and `next` runs end to end from there |
| IT-20 | `install` with the six new skills in the manifest | each lands in the Claude Code and Codex skill locations, and `uninstall` removes exactly those |

## I. Injection truncation account

`src/core/memory/budget.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-56 | budget forces 3 project facts and 1 correction out | block ends with `<!-- lumem:truncated project=3 correction=1 preference=0 -->`; counts match the omissions exactly |
| UT-57 | every fact fits | output byte-identical to the pre-feature block; **no comment** |
| UT-58 | only the docs section is dropped | no comment — `truncated` reports lost facts, and the docs section is a recoverable pointer |
| UT-59 | budget nearly exhausted | the comment itself is accounted for and the block never exceeds `injectionBytes` |

## J. ADR `feature:` field

`src/core/adr/format.test.ts` and `src/core/adr/lint.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-60 | frontmatter carrying `feature: 002-spec-driven` | parses as a known key; no "unknown key" warning |
| UT-61 | an ADR with no `feature:` | valid; serialization omits the key entirely |
| UT-62 | parse then serialize an ADR with `feature:` | round-trips, and field order is stable |
| UT-63 | `feature: 404-nope` with no such directory | `unknown-feature`, severity info |
| UT-64 | `unknown-feature` as the only finding | `adr lint` still exits 3 — any finding exits 3 |

---

## Not covered by tests, deliberately

The six skills are prompt text. Their content is reviewed, not asserted — a test that greps a `SKILL.md` for a phrase locks the wording without checking the behavior.

What *is* asserted: that each ships, installs to both harnesses, and uninstalls cleanly (IT-20). Whether the questioning works is answered by §12 of the TDD, over real use, not in CI.

---

## Coverage matrix — TDD §11 acceptance criteria

| Criterion | Cases |
|---|---|
| 1 feature with only `context.md` | UT-17 |
| — requirements phase has an artifact of its own | UT-65 |
| 2 `light` never asks for a TDD | UT-22, UT-30 |
| 3 promotion appends, no auto-demotion | UT-02, UT-03 (tier handling); promotion path IT-09 |
| 4 missing `tier` is a phase, not an error | UT-02, UT-18 |
| 5 empty answer names the question | UT-07, UT-19 |
| 6 answered but unscored | UT-08, UT-20 |
| 7 answer gate only once a later artifact exists | UT-31, UT-32 |
| 8 no `Cut` section yields prune | UT-13, UT-21 |
| 9 empty `Cut` section satisfies the gate | UT-13, UT-21 |
| 10 field without type | UT-41, UT-42 |
| 11 no signature block | UT-43, UT-44 |
| 12 invariants as bullets | UT-45, UT-46 |
| 13 orphan and duplicate ids | UT-49, UT-50 |
| 14 cycle terminates | UT-51 |
| 15 malformed artifact does not stop the rest | UT-05, IT-10 |
| 16 `--json` round-trips | IT-04, IT-08 |
| 17 copied bundle runs without the CLI | IT-09, IT-12 |
| 18 purity assertion | UT-55 |
| 19 install/sync/uninstall/status parity | IT-13 … IT-18 |
| 20 truncation comment and counts | UT-56 |
| 21 no comment when nothing dropped | UT-57, UT-58 |
| 22 `npm run verify` green | the suite as a whole |
| 23 repo with no `docs/features/` unchanged | UT-15, UT-16 |
| 24 hook latency unchanged | `npm run bench:hook` — this feature adds nothing to the hook path |

**85 cases: UT-01…UT-64, UT-65, IT-01…IT-20.** Every criterion maps to at least one; criterion 3's promotion path is the thinnest and is the first place to add a case if the tier logic grows.
