---
slug: 002-spec-driven
tier: full
created: 2026-08-11
---
# Decisions taken before the interrogation

Settled so they are not re-litigated, and so the questions in `questions.md` can assume them.

Anything here can still be reopened, but it costs a deliberate reversal, not a drift.

## D1 — Scope: the full pipeline, requirements through verification

The slice covers seven phases and, provisionally, seven skills:

```
Scope → Requirements → Prune → Design (TDD) → Tasks → Execute → Verify
```

| Skill | Owns |
|---|---|
| `lumem-spec-preflight` | loads memory, ADRs, rules and prior-phase artifacts; runs the post-draft checks. Never authors |
| `lumem-prd` | the requirements artifact and the ADRs the requirements produce |
| `lumem-tdd` | the design artifact and its test contract |
| `lumem-tasks` | the task graph and the per-task files |
| `lumem-execute-task` | one task end to end, against the resolved contract |
| `lumem-verify` | the evidence gate: no completion claim without fresh evidence |
| `lumem-loop` | phase detection and resumption across sessions |

Chosen over stopping at Tasks (which would break the PRD/TDD/Tasks separation the author values) and over stopping at TDD. The known risk: execution and verification are the half where lumem has the least usage evidence and where the harness already competes. `questions.md` Q3 decides how much of the driving lumem actually does.

## D2 — Naming: the design artifact is a TDD

Technical Design Document. Never "techspec" — that is Compozy's name for it, and `001/tdd.md` already established the term here. The collision with "Test-Driven Development" is known and accepted; disambiguate in prose when both appear rather than renaming.

## D3 — ADRs stay global, with the producing feature named in frontmatter

`docs/adr/` remains the only location. A fifth known frontmatter field, `feature:`, optionally names the slice that produced the decision:

```yaml
---
title: Session cookies over JWT
date: 2026-08-11
area: auth
feature: 002-spec-driven
summary: Auth uses session cookies because revocation must be immediate.
supersedes: 2026-07-02-jwt-sessions.md
---
```

Rejected: Compozy's per-feature `adrs/` directory, because a decision outlives the slice that produced it and a reader looking for "how is auth decided" should not have to guess which feature folder to open. Also rejected: a two-stage draft promoted from the feature folder to `docs/adr/` on approval — it buys the "not real until approved" semantics at the cost of two locations and a drift window.

Consequences: `adr lint` gains one informational check (`feature:` naming a directory that does not exist), and the field is optional, so every existing ADR stays valid.

## D4 — Compozy and tlc-spec-driven are references, never dependencies

No file is imported, vendored, or ported. Mechanisms are re-derived in lumem's own terms and the source is cited in `context.md` and in ADR "Alternatives considered". Both are also coupled to their stacks — Compozy to Go, `task_runs`, `config.toml`; tlc to EARS plus bundled Python — and lumem is stack-agnostic by design.

## D5 — Spec artifacts live in `docs/features/<NNN>-<slug>/`

The location 001 already uses. Committed on purpose, reviewable in a PR, adjacent to `docs/adr/`. Sequential numbering is kept despite the collision risk that made ADR ids date-prefixed in 001: features are created deliberately and rarely, ADRs are proposed by an agent and often.

## D6 — The process this feature defines is the one `001/retrospective.md` derived

Not Compozy's, not tlc's. The retrospective's phase order and question rules are the specification's starting point, and the three findings neither reference has are load-bearing:

- **Scope is resolved first**, before any other question.
- **Pruning is a mandatory phase**, not an optional cleanup. It asks nothing new.
- **Which questions changed the design is tracked**, because it is the only feedback loop that improves the question set.

Plus the two stop triggers, either sufficient: no remaining question whose answer would change the design, or a concern repeated across rounds.

## D7 — Precedence and the core/module split carry over from 001

Unchanged from `001/decisions.md` D4 and D5. A module ships rules, procedures, templates, lenses and prompt fragments — never facts or decisions. Precedence stays:

```
core rule  <  module rule  <  project docs  <  project memory  <  explicit correction
```

How much of the design-concreteness requirement is core and how much is a module's is settled in D11.

---

The decisions below were settled by Round 1 of `questions.md`.

## D8 — Gates and phase detection ship as bundled scripts, never as a CLI dependency

Settled in Round 1 Q1, against my leaning. The skill carries its own executable checks; a machine with no code-execution tool falls back to performing the same checks by reading the artifact.

**The reason, in the author's words:** depending on the CLI means depending on it being installed *and* on the version being right, and repos drift to different versions — "aí começa a dar problema". Managing scripts inside the lumem repo is the cheaper problem.

This is stronger than it first looks, because lumem already learned the same lesson the hard way: bundles symlinked into the npx cache dangle when the cache is pruned, so the hook bundle is **always copied**. A copied script is pinned per repo by construction, which is exactly the property the CLI cannot offer.

### Cascades

- **`lumem spec next` does not exist.** Q3's next-action detector becomes a bundled read-only script reading filesystem truth, not a CLI subcommand. Q3's answer stands; only its mechanism moves.
- **The spec skills do not call `lumem adr new`.** They write the ADR file from the template they carry. The CLI command stays for human use.
- **Duplication is the open risk.** `core/adr/lint.ts`, `core/memory` and the frontmatter serializer already exist in TypeScript. A second implementation of any of them inside a script is a guaranteed drift source. Round 2 Q1 decides the packaging that avoids it.

## D9 — Sizing rounds up

Q2 answered C — sized once at the scope phase, proposed by the agent, confirmed by the user, recorded in the artifact — with an explicit bias: **when the size is ambiguous, take the larger tier.**

The bias is not decoration. The safety valve only ever fires for under-sizing, so a tie broken downward is a tie broken toward the failure the valve exists to catch. Over-sizing costs ceremony; under-sizing costs rework and only surfaces later.

## D10 — Contracts, not a driver

Q3 answered as leaned. Execute and Verify ship as contracts plus a read-only next-action detector. No state machine, no unattended multi-hour run, no self-healing recovery loop in this slice. A driver stays possible later as an opt-in module.

## D11 — The concreteness gate is generic in core; markers are a module's job

Q4 answered as leaned. Core asks the stack-agnostic question — can two competent implementers read this design and build different shapes? — and checks the structural half: every new field has a name and a type, at least one signature block exists in the project's own language, invariants are a numbered list. Language-specific marker sets belong to modules.

## D12 — Verification is capability-graded; the sensor is deferred

Q5 answered as leaned. The evidence gate is the floor and runs everywhere: no completion claim without fresh evidence, claim scope bound to verification scope. An independent verifier runs where the harness descriptor declares subagents, and `doctor` names which mode the repo is in.

The discrimination sensor — injecting behavior-level faults to prove the tests kill them — is out of this slice: it needs a scratch worktree and can leave a dirty tree if it fails halfway, against design rule 1. The test contract written now must be shaped so a sensor can be added later without rewriting it.

---

The decisions below were settled by Round 2.

## D13 — The bundled checks are Node bundles built from `src/`

Q6. Same mechanism as the hook bundle: built by `tsup`, zero external imports, **copied** into the target repo at install, pinned per repo by the copy. They import `core/*`, so every rule — ADR lint, frontmatter parse and serialize, memory file format — exists exactly once and the duplication D8 flagged never happens.

Python was named first and then reversed once the cost was stated: it removes the CLI dependency by adding an interpreter dependency, on the platform combination where the interpreter is least reliably present (`python3` on macOS is a stub requiring Xcode CLT; Windows usually has none). Node ≥ 20 is already a hard requirement for the CLI and for the hooks.

The purity constraint is not new either — `src/hooks/main.test.ts` already fails the moment an external import reaches the bundled path, and `src/core/adr/format.ts` is written to satisfy it. The spec scripts inherit that contract.

## D14 — Prune is a closing step with a mid-round trigger, and nothing is deleted silently

Q7. Requirements and Design each end by pruning what they accumulated, because the authoring context is already loaded and a separate skill would pay the ramp-up twice. On top of that, a repeated concern across rounds — or growth between rounds with no recorded cut — forces a prune before anything else is added, and that has to be able to fire mid-round.

Cut scope moves into an explicit `Cut, and why` section, kept separate from Non-Goals. **Non-Goals records what the author decided against; `Cut` records what the process removed for weight.** Collapsing them destroys the only way to tell whether pruning is doing anything.

## D15 — A fixed notation is required only where prose hides the requirement

Q8. Acceptance criteria covering **failure and error paths, state transitions, and concurrency** must take a pattern-shaped form with a concrete value — those are exactly the criteria where prose produces something unfalsifiable ("handles errors gracefully"). Everything else stays prose, closed by the ambiguity gate: every ambiguity resolved with the author, or recorded as an assumption with its chosen default and rationale.

Rejected: notation everywhere (tlc's EARS), because the register fights the plain decided voice and a PRD written for LLM consumers does not need SHALL-speak throughout. Rejected: prose everywhere (Compozy), because then nothing structural is checkable.

## D16 — Question effectiveness is scored inline, and process lessons get their own file

Q9. Each question carries one field, filled when it is answered: `changed` / `accepted` / `rejected-framing` / `not-understood`. Scored at the moment of least friction, countable by a script, comparable across features.

Promotion into durable memory is deferred, but the shape has to allow it. When it lands, process lessons live in **their own file, not in `correction.md`** — project facts and lessons about how to run the process compete for the same injection budget, and the facts must win.

Note the divergence from tlc, which bans process lessons from its layer outright on the grounds that they "ship in a version bump". That is right for a skill authored elsewhere. lumem *is* the process, so the category has a legitimate home here.

## D17 — Preflight loads only what injection did not carry

Q10. The `SessionStart` block stays the index; preflight is the navigation. This finally gives 001's D3 a consumer, and it costs one concrete change to a shipped subsystem: **the injected block gains a machine-readable account of what it truncated**, so the skill can read the rest on demand instead of loading it twice.

That change is to memory injection, not to spec-driven, and it is named here so it is not discovered mid-implementation.

---

## D18 — The `**Effect:**` field is authoritative; the scored table is generated

Found by writing the TDD, not by discussing it: 002's own `questions.md` carried a hand-written scored table and no per-question field, so it would have failed the `unscored-question` check the same TDD defines. Two representations of one fact, and the hand-written one can disagree.

The field on each question is the record. The round table is a view, regenerated by `spec lint --json`. This is the second time formalizing a design has changed it — 001 saw the same thing when writing its field table turned `status` into a derived value.

---

# Cut, and why

## First pass — after Round 2 (D14)

It asked nothing new; it audited what the two rounds accumulated against what this slice exists to deliver.

| Cut | Was | Why it went |
|---|---|---|
| **`lumem-loop` as a skill** | one of the seven skills in D1 | D10 removed the driver. What remained was a read-only next-action detector — a script, plus a paragraph in preflight. A skill wrapping one script call is surface with no content. **D1's seven skills become six.** |
| **A fourth sizing tier** | tlc's Small / Medium / Large / Complex | Only two phases are genuinely optional — TDD and Tasks — so only three tiers can exist without inventing distinctions nobody will remember: no TDD and no task graph; TDD but no task graph; everything. A 4×7 matrix is a table that gets ignored, and D9's round-up bias plus the safety valve already cover the boundary cases. |
| **Six of the nine notation-mandating dimensions** | tlc's nine implicit-requirement dimensions, each demanding a criterion | D15 keeps the notation requirement on three. The other six survive as a **prompt-side sweep with the mandatory `N/A because …` escape** — no mechanism, no script check. The sweep is what prevents forgetting; the notation is what prevents vagueness. Only the second needs enforcement. |
| **Memory promotion of question-effectiveness** | Q9 option C | Deferred, not deleted: the inline field is the whole cost, and promotion needs a rule for what is worth promoting that this slice has no evidence to write. |

## Second pass — after the TDD (D14)

The design phase ends with its own prune. Two rows, both redundancy rather than weight:

| Cut | Was | Why it went |
|---|---|---|
| **`action=blocked`** | a row in the phase-derivation table, for a task whose dependency is unfinished | **Unreachable.** `dependency-cycle` and `unknown-dependency` are both gates, so the graph is a DAG with known nodes — and in a DAG the topologically-first unfinished task always has every dependency done. The row described a state the invariants forbid. |
| **`missing-cut-section`** | an informational check in `--phase prd` | The phase derivation already yields `phase=prune` when `Cut, and why` is absent. A lint check for the same fact is a second mechanism that can disagree with the first. |

## Kept under pressure, with the reason recorded

Pruning that only cuts is as untrustworthy as pruning that never does. These were examined and survived:

- **The `light` tier**, examined again in the second pass. Two tiers would be simpler, and the round-up bias means `light` gets chosen rarely — but cutting it makes a TDD mandatory for a two-line change, which is Compozy's always-full-ceremony position that D9 deliberately rejected. It stays, and §14 of the TDD keeps the doubt on the record.

- **`lumem-verify` as its own skill.** It has an independent trigger — *about to claim done* — which fires from inside the pipeline, from ad-hoc work, and from a human at a commit. That is the strongest reason a skill exists separately, and it is why Compozy keeps `cy-final-verify` apart while tlc folds verification into Execute.
- **A separate test contract alongside the TDD.** Two artifacts where one looks sufficient, but the assignment audit — every case ID appears in exactly one task, no orphans, no duplicates — needs a canonical numbered list to audit against. The TDD holds strategy; the contract holds cases. Without the split there is nothing to check coverage against.
- **The `feature:` ADR field.** One optional frontmatter field and one informational lint check. Cheap enough that the trail it preserves is worth more than the surface it adds.
- **The injected-block truncation account.** It touches a shipped subsystem, which is normally a prune target. It stays because D17 is inert without it, and because the block is currently silent about its own truncation — which is a defect independent of this feature.
