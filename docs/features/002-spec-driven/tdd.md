# TDD — 002 Spec-driven core

**Status:** draft, awaiting review
**Depends on:** `context.md`, `decisions.md` (D1–D17 plus `Cut, and why`), `questions.md` (rounds 1–2, stopped)

## Summary

Six skills and one bundled script that carry a feature from idea to verified code through named artifacts, with the questions asked before anything is written, the decisions recorded as ADRs, and every gate enforced by something that cannot forget.

Two properties separate this from the two systems it was measured against: **pruning is a phase, not a virtue**, and **every question records whether it changed the design**. Both come from 001's retrospective, which measured the cost of not having them.

---

## 1. Layout

```
docs/features/<NNN>-<slug>/
  context.md      what this is, why now, what it depends on. No questions.
  decisions.md    settled decisions, the size, and `Cut, and why`
  questions.md    rounds, each question carrying its effect
  prd.md          requirements
  tdd.md          design
  tests.md        test contract — the canonical numbered case list
  tasks.md        task graph and task bodies
```

Feature 001 predates this and has no `prd.md`; it is not retrofitted.

| File | Written by | Exists when |
|---|---|---|
| `context.md` | `lumem-prd`, before any question | always |
| `decisions.md` | every skill appends; nothing rewrites | always |
| `questions.md` | `lumem-prd` and `lumem-tdd` | always (may hold one round) |
| `prd.md` | `lumem-prd` | always |
| `tdd.md` | `lumem-tdd` | tier `design` or `full` |
| `tests.md` | `lumem-tdd` | tier `design` or `full` |
| `tasks.md` | `lumem-tasks` | tier `full` |

**Artifacts are created lazily.** An empty `tdd.md` claims a phase ran when it did not; absence is the correct state for a phase the tier skipped.

### 1.1 `decisions.md` frontmatter

The only machine-read frontmatter in the feature. It carries what cannot be derived from the filesystem:

```yaml
---
slug: 002-spec-driven
tier: full
created: 2026-08-11
---
```

| Field | Required | Type | Rule |
|---|---|---|---|
| `slug` | yes | string | Matches the directory name. The identifier |
| `tier` | yes | `light \| design \| full` | The recorded size (D9). Changed only by a promotion, never by a demotion |
| `created` | yes | `YYYY-MM-DD` | First write |

Phase is **never** stored. It is derived from filesystem truth (§5), so a stale file can never strand the run.

---

## 2. Sizing

Three tiers, because only two phases are genuinely optional.

| Tier | Requirements | TDD | Tests contract | Task graph | Execute | Verify |
|---|---|---|---|---|---|---|
| `light` | yes | — | — | — | yes | yes |
| `design` | yes | yes | yes | — | yes | yes |
| `full` | yes | yes | yes | yes | yes | yes |

- The size is proposed by the agent at the scope phase, confirmed by the author, and written to frontmatter. It is never re-derived per phase.
- **Ties round up** (D9). The valve below only ever fires for under-sizing, so a tie broken downward is broken toward the failure the valve exists to catch.

### 2.1 Safety valve

1. Execute always begins by listing the atomic steps inline, whatever the tier.
2. If that listing exceeds **five** steps, or any step depends on another, stop.
3. On stopping, promote one tier, write the artifact the promoted tier requires, and append the promotion to `decisions.md`.
4. A promotion is recorded with the step count that triggered it. An automatic **demotion never happens** — shrinking the tier is an author decision.

---

## 3. The six skills

| Skill | Reads | Writes | Hard gate |
|---|---|---|---|
| `lumem-spec-preflight` | the injected block's truncation account, then only what the block did not carry; `docs/adr/`; prior-phase artifacts | nothing | Never authors. Runs `spec lint` after a draft, before the author is asked to approve |
| `lumem-prd` | `context.md`; codebase; memory; ADRs | `context.md`, `prd.md`, `decisions.md`, `questions.md`, ADRs | Research before questions. Questions before writing. Prune before handing off |
| `lumem-tdd` | `prd.md`; codebase | `tdd.md`, `tests.md`, `questions.md`, ADRs | Explore before designing. Concreteness gate (§6) before handing off. Prune before handing off |
| `lumem-tasks` | `prd.md`, `tdd.md`, `tests.md` | `tasks.md` | Every case ID in `tests.md` assigned to exactly one task |
| `lumem-execute-task` | one task plus the whole artifact set | source, `tasks.md` checkboxes | Never asks a question. Resolves conflicts by the precedence ladder (§7) and records the pick |
| `lumem-verify` | the claim, the artifacts, the tree | `tasks.md`, a verdict | No completion claim without fresh evidence. Claim scope binds verification scope |

`lumem-loop` was cut — see `decisions.md` `Cut, and why`. What remained is the script in §5.

### 3.1 Question mechanics

Applies to `lumem-prd` and `lumem-tdd` alike:

1. Anything the codebase, memory or an ADR answers is **never** a question.
2. One fork per question. Lead with a leaning and its reasoning.
3. Concrete options with a cost column. Never an open "what do you want".
4. The header invites rejection of the framing — in 001 that produced the single most valuable answer in the run.
5. A question about something that does not exist yet rebuilds its scenario inside the question.
6. **Round capped at five. Total uncapped.** The count is an output of the decision tree; the round is a limit on how much a human is asked to hold at once.
7. Stop on either trigger: no remaining fork whose answer would change the design, or a concern repeated across rounds.

### 3.2 Question record

Every question carries one field, filled when answered (D16):

```markdown
**Answer:** B — bundle over interpreter.
**Effect:** rejected-framing
```

| Value | Means |
|---|---|
| `changed` | the answer moved the design |
| `accepted` | the leaning stood |
| `rejected-framing` | the question itself was wrong; worth more than a pick |
| `not-understood` | the question assumed a model the reader had no reason to hold |

**The field is authoritative; the round's scored table is a view generated from it** by `spec lint --json`. Writing the table by hand creates a second place that can disagree with the fields — found by applying this design to 002's own `questions.md`, which had the table and no fields.

`not-understood` is a defect in the question, recorded as such. A round closes with the table plus the cumulative ratio across the feature.

### 3.4 Task sizing

`lumem-tasks` has no driver behind it (D10), so every task is a fresh agent run that re-reads the artifacts and rebuilds its model of the system before the first edit. That ramp-up is the expensive part, and many small tasks pay it repeatedly and throw the reasoning away at each boundary.

1. Default to **fewer, larger** tasks. A task is a vertical slice — implementation, wiring and its assigned cases — delivered in one run.
2. Split only at a real boundary: a **contract** another task needs first, **disjoint files** that could run in parallel, or a different **domain** (source vs prompt assets vs docs).
3. File count is never a reason to split. One coherent slice spanning many files is healthy.
4. Cases live in the task that implements the behavior they verify. Never a task that only writes tests.

---

## 4. Prune

A closing step of `lumem-prd` and of `lumem-tdd`, plus a trigger (D14).

- **Always:** before handing off, audit what the phase accumulated against what the slice exists to deliver.
- **Trigger:** a concern repeated across rounds, or growth between rounds with no recorded cut, forces a prune *before* anything else is added. It must be able to fire mid-round.
- **It asks nothing new.** A prune that introduces a question is not a prune.

Output goes to `decisions.md`:

```markdown
# Cut, and why

| Cut | Was | Why it went |

## Kept under pressure, with the reason recorded
```

`Cut` and Non-Goals stay separate: **Non-Goals is what the author decided against; `Cut` is what the process removed for weight.** Collapsing them destroys the only evidence that pruning does anything. The `Kept under pressure` half is not decoration — a prune that only ever cuts is as untrustworthy as one that never does.

---

## 5. The bundled script

### 5.1 Packaging

A fourth `tsup` entry beside `cli`, `lumem-hook` and `lumem-runner`:

```ts
{
  entry: { 'lumem-spec': 'src/spec/main.ts' },
  format: 'esm', platform: 'node', target: 'node20',
  noExternal: [/.*/], outExtension: () => ({ js: '.mjs' }),
}
```

- Copied — never symlinked — to `.lumem/bin/lumem-spec.mjs`, tracked in the lockfile as `spec-bundle:lumem-spec` with `mode: "copy"`, exactly like the hook bundle. A symlink into the npx cache dangles when the cache is pruned; that bug is already paid for once.
- Zero external imports, so the same purity assertion that guards `src/hooks/main.test.ts` guards this path.
- Imports `core/*`, so ADR lint, frontmatter parsing and the memory file format exist **once**. This is the whole reason the bundle beats a hand-written interpreter script.
- Requires no runtime beyond the Node ≥ 20 that lumem already requires for the CLI and the hooks.

### 5.2 Types

```ts
export type SpecTier = 'light' | 'design' | 'full'

export type SpecPhase =
  | 'context' | 'scope' | 'requirements' | 'prune'
  | 'design' | 'tasks' | 'execute' | 'verify' | 'done'

export type QuestionEffect = 'changed' | 'accepted' | 'rejected-framing' | 'not-understood'

export interface QuestionRecord {
  id: string                      // 'Q6'
  round: number
  answered: boolean
  effect?: QuestionEffect
}

export interface TaskRecord {
  id: string                      // 'T3'
  title: string
  done: boolean
  dependsOn: string[]             // task ids
  testIds: string[]               // ids owned by this task
}

export interface SpecFeature {
  slug: string
  dir: string
  /** Absent when no tier is recorded, or an unrecognised one is: absence is a phase, not an error. */
  tier?: SpecTier
  created: string                 // YYYY-MM-DD, '' when absent
  has: Record<'context' | 'prd' | 'tdd' | 'tests' | 'tasks' | 'cutSection', boolean>
  questions: QuestionRecord[]
  tasks: TaskRecord[]
  testIds: string[]               // every id declared in tests.md
  warnings: string[]              // tolerant-parse complaints, never thrown
}

export interface NextAction {
  phase: SpecPhase
  action: string                  // 'await-answers', 'execute-task', …
  target?: string                 // task id, question id, or file
}

export function readFeature(dir: string): SpecFeature
export function nextAction(f: SpecFeature): NextAction
export function lintSpec(f: SpecFeature, phase: SpecPhase): LintFinding[]
```

`LintFinding` is the existing shape from `core/memory/lint.ts` — kind, severity, file, message. One finding shape across memory, ADRs and specs.

Parsing is **tolerant**: `readFeature` never throws. Every complaint lands in `warnings` so lint reports it with the file in hand.

### 5.3 Commands

```
lumem-spec.mjs next <feature-dir> [--json]
lumem-spec.mjs lint <feature-dir> --phase <prd|tdd|tasks> [--json]
```

`next` is **read-only** and prints exactly one line:

```
phase=execute action=execute-task target=T3
```

**Exit codes.** `next`: `0` always, `1` only when the directory cannot be read — advice that fails open. `lint`: `0` no findings, `3` any finding, `1` the command itself failed. Same convention as `memory lint` and `adr lint`.

### 5.4 Phase derivation

Filesystem truth, in order. First match wins.

| Condition | Output |
|---|---|
| directory absent | `phase=context action=create-context` |
| `decisions.md` absent or has no `tier` | `phase=scope action=settle-size` |
| a `**Answer:**` is empty | `phase=requirements action=await-answers target=<Qid>` |
| a question has no `**Effect:**` | `phase=requirements action=score-round` |
| `prd.md` absent | `phase=requirements action=write-prd` |
| no `Cut, and why` section | `phase=prune action=prune` |
| tier ≠ `light` and `tdd.md` absent | `phase=design action=write-tdd` |
| tier ≠ `light` and `tests.md` absent | `phase=design action=write-tests` |
| tier = `full` and `tasks.md` absent | `phase=tasks action=write-tasks` |
| a task is unchecked and its `dependsOn` are all done | `phase=execute action=execute-task target=<Tid>` |
| every task done, no verdict recorded | `phase=verify action=verify` |
| verdict recorded and passing | `phase=done action=done` |

---

## 6. Checks

### 6.1 `--phase prd`

| Check | Fires when | Severity |
|---|---|---|
| `unanswered-question` | a `**Answer:**` is empty while a later-phase artifact exists | gate |
| `unclosed-ambiguity` | an Assumptions row has an empty default or an empty rationale | gate |
| `vague-risky-criterion` | a criterion under failure, state-transition or concurrency lacks the pattern shape or a concrete value | gate |
| `unscored-question` | a question has no `**Effect:**` | info |

**The notation requirement covers three dimensions only** (D15): failure and error paths, state transitions, concurrency. A criterion there must name the trigger or state and a concrete outcome — a status, a message, a bound — never "gracefully" or "quickly". The other six of tlc's nine dimensions survive as a **prompt-side sweep** with the mandatory `N/A because …` escape: nothing checks it, and its job is preventing omission, not vagueness.

### 6.2 `--phase tdd`

| Check | Fires when | Severity |
|---|---|---|
| `field-without-type` | a field table row has an empty type cell | gate |
| `no-signature-block` | no fenced code block contains a declaration | gate |
| `invariants-not-ordered` | an Invariants heading whose body is not an ordered list | gate |
| `no-deferred-triggers` | a Deferred table row has no revisit trigger | info |

This is the generic half of the concreteness gate (D11): stack-agnostic, structural, mechanically checkable. The judgment half — *can two competent implementers read this and build different shapes?* — stays with the author and the reviewer. Language-specific marker sets are a module's job.

### 6.3 `--phase tasks`

| Check | Fires when | Severity |
|---|---|---|
| `orphan-test-id` | an id in `tests.md` is assigned to no task | gate |
| `duplicate-test-id` | an id is assigned to more than one task | gate |
| `dependency-cycle` | following `dependsOn` returns to a task already seen | gate |
| `unknown-dependency` | `dependsOn` names a task not in the graph | gate |
| `task-without-tests` | a task carries no case ids | info |

---

## 7. Precedence when sources disagree

`lumem-execute-task` never pauses on a contradiction. It resolves by this ladder, records the pick in one line, and continues.

1. A case assigned in `tests.md` beats any paraphrase of the same fact in a task body.
2. A machine-checkable constraint in `tdd.md` — a type, an enumerated state, a numbered invariant — beats prose in the same file.
3. A business rule in `prd.md` beats `tdd.md` prose for facts the PRD owns.
4. An ADR beats informal notes.
5. Among remaining ties, prefer the reading that satisfies the most assigned cases and stays implementable against the winning types.
6. **A task-body paraphrase never overrides a higher rung.** Implementing the paraphrase against a higher-rung contract is the error.

The existing runtime shape is never the contract. If the code cannot express what the resolved contract requires, extend it within task scope, or implement the closest faithful thing and record the gap as a follow-up.

---

## 8. Verification

The floor, everywhere: **no completion claim without fresh evidence, and the verification scope must be at least as broad as the claim.** Running one test never supports "task complete".

| Harness declares subagents | Mode | What runs |
|---|---|---|
| yes | `independent` | a fresh agent re-derives coverage from the artifacts, not from the author's model, and writes the verdict |
| no | `evidence-only` | the author produces and shows evidence against each assigned case |

`doctor` names the mode, so the difference is never silent. Deferred: the discrimination sensor (D12) — `tests.md` must be shaped so it can be added without a rewrite.

---

## 9. Two changes outside the pipeline

### 9.1 The injected block accounts for its truncation

`InjectionResult.truncated` already exists as a boolean and is never emitted. D17 needs it visible, so when facts were dropped the block gains one machine-readable line:

```
<!-- lumem:truncated project=3 correction=1 preference=0 -->
```

- Same comment convention as the `<!-- src:… conf:… -->` trailer on every fact.
- Costs ~20 tokens and only appears when something was actually dropped.
- Preflight reads it and loads the remainder on demand, so the block stays the index and the budget holds end to end (001 D3).
- Without it, preflight either double-loads what injection already carried or guesses.

### 9.2 ADRs name the feature that produced them

`feature:` becomes a fifth known frontmatter key, optional (D3):

| Field | Required | Type | Rule |
|---|---|---|---|
| `feature` | no | string | The `docs/features/` directory name that produced the decision |

One informational lint check, `unknown-feature`: `feature` names a directory that does not exist. Never a gate — a feature folder can be renamed or archived without invalidating a recorded decision.

---

## 10. Invariants

1. Phase is always derived from the filesystem, never stored.
2. No skill edits an ADR after it is written.
3. `tier` changes only upward, only by a recorded promotion.
4. Every case id in `tests.md` belongs to exactly one task.
5. A cut is never silent: removed scope appears in `Cut, and why`.
6. `readFeature` never throws; every complaint becomes a warning.
7. The bundle is copied, never symlinked, and carries no external import.
8. `next` exits 0 on anything except an unreadable directory.
9. An unscored question is advice from `next` and never a lint gate — the process asks for the score, it does not fail the build over it.
10. Nothing in this feature writes to `.lumem/memory/`. Promotion of process lessons is deferred (D16).

---

## 11. Acceptance criteria

**Layout and sizing**

1. A feature with only `context.md` yields `phase=scope action=settle-size`.
2. `tier: light` with `tdd.md` absent never yields `action=write-tdd`.
3. A promotion appends to `decisions.md` and changes frontmatter; no path demotes automatically.
4. Frontmatter missing `tier` is a `scope` phase, not an error.

**Questions**

5. An empty `**Answer:**` yields `action=await-answers` naming that question id.
6. An answered question with no `**Effect:**` yields `action=score-round`.
7. `lint --phase prd` gates on an empty answer once a later artifact exists, and stays silent before that.

**Prune**

8. A feature with no `Cut, and why` yields `phase=prune`.
9. `Cut, and why` present with zero rows satisfies the gate — an audit that found nothing is a valid audit, and the `Kept under pressure` half is where that shows.

**Checks**

10. A field table row with an empty type cell produces `field-without-type` and exit 3.
11. A TDD with no fenced declaration block produces `no-signature-block`.
12. An Invariants section written as bullets produces `invariants-not-ordered`.
13. A case id in `tests.md` assigned to no task produces `orphan-test-id`; assigned twice, `duplicate-test-id`.
14. T1 → T2 → T1 produces `dependency-cycle` and terminates rather than looping.
15. Malformed frontmatter in one artifact does not prevent the others from being checked.
16. `--json` round-trips for both commands.

**Bundle**

17. `.lumem/bin/lumem-spec.mjs` is copied, appears in the lockfile with `mode: "copy"`, and runs from a repo where the CLI is absent.
18. The purity assertion fails if an external import reaches the bundle.
19. `install`, `sync`, `uninstall` and `status` treat it exactly as they treat the hook bundle, including drift detection.

**Injection**

20. With facts dropped, the block ends with the truncation comment and the counts match what was omitted.
21. With nothing dropped, the block is byte-identical to today.

**Non-regression**

22. `npm run verify` stays green; the test count only grows.
23. A repository with no `docs/features/` behaves exactly as it does today.
24. Hook latency p95 is unchanged — this feature adds nothing to the hook path.

---

## 12. Success criterion — what this slice exists to learn

Not testable in CI. Measured over the next two or three features:

> **Does the prune phase cut anything on a feature where nobody noticed accumulation, and does the effect field survive three features without rotting?**

- The prune is the differentiator. If it only ever fires when the author already sensed bloat, it is ceremony around a judgment that was going to happen anyway.
- The effect field is the honest risk. Hand-kept accounting is exactly the failure mode tlc built a script to avoid; three features of `accepted` on every question means the field is being filled reflexively and should be either enforced or removed.

Secondary, and the reason the ratio is tracked at all: **10 questions across 002 produced 2 that moved the design; 001 produced 3 of 13.** If the ratio stays near a fifth, the question set is roughly right. If it collapses, the skill is asking to look thorough.

---

## 13. Deferred, with triggers

| Deferred | Revisit when |
|---|---|
| A driver: state machine, checkpoint commits, self-healing loop | Contracts plus `next` prove insufficient for a real multi-day feature |
| Discrimination sensor | A shipped feature passes verification and still breaks |
| Promotion of question-effectiveness into durable memory | The effect field survives three features (§12) |
| Language-specific concreteness markers | The module system exists |
| Per-task files instead of bodies inside `tasks.md` | A single `tasks.md` becomes unworkable; 001's 353 lines were not |
| Web/docs impact and QA tail sections | Something ships with a broken downstream surface |
| Cross-model peer review of the TDD | A TDD passes the concreteness gate and still produces rework |

---

## 14. Open, deliberately

- **Where the sweep lives.** The six unenforced dimensions are prompt text in `lumem-prd`. They are really a *rule*, and the rule layer arrives with modules. Hardcoded for now, moves later — the same trade 001 made with the docs pointer.
- **Whether `lumem-verify` needs its own artifact.** It writes a verdict; tlc writes a whole `validation.md`. This slice records the verdict in `tasks.md` and will regret it if the verdict needs history.
- **Whether `light` earns its existence.** If every real feature lands on `design` or `full`, the tier is a tier nobody picks, and the round-up bias guarantees it is picked even less often.
