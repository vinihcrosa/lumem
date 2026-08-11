# PRD — 002 Spec-driven core

**Status:** draft, awaiting review
**Reads with:** `context.md` (why this slice), `decisions.md` (D1–D18), `questions.md` (rounds 1–2)

This states what the spec-driven core must do and for whom. How it does it is `tdd.md`. Written after the design, because the requirements phase produced `context.md`, `decisions.md` and `questions.md` instead of this file — 002 is the slice that defines what a PRD is, so it had none to write against. It exists now because the derivation table gained a `write-prd` row during T1 and this feature is the first thing that row detects.

## Problem

An agent asked to build something starts building. What it builds is one of the several things the request could have meant, and which one is decided by whatever the agent assumed while nobody was looking. The assumption is never recorded, so when it turns out wrong the work is redone and the reason it was wrong is lost with it.

Writing a specification is the industry answer. The failure mode is that the same agent writes the spec and the code in one breath, so the spec records nothing that was not already assumed — it documents the guess instead of replacing it.

## Goals

Observable outcomes, not metrics:

- A feature's requirements, design, cases and tasks exist as files a human can review in a pull request, and an agent can be pointed at them instead of at a chat log.
- Questions are asked before anything is written, and asking one the codebase could have answered becomes visible as a defect rather than a habit.
- Removing scope is a step in the process with an audit trail, not a virtue someone remembers to practise.
- A completion claim without evidence is refused by the process, not caught by a reviewer's suspicion.
- Every gate that can be checked mechanically is, so forgetting a step fails loudly instead of silently.

## Non-Goals

Decided against, not deferred for size:

| Excluded | Why |
|---|---|
| An unattended driver that ships a whole task graph | The harness competes here and will keep changing; a driver that mis-detects a phase *acts*, which is worse than doing nothing (D10) |
| Depending on the `lumem` CLI at author time | Version skew across repos, and a gate that needs a global binary is a gate that stops running (D8) |
| Language-specific design markers in the core | The core stays stack-agnostic; a module sharpens it (D11) |
| Mutation testing of the produced suite | Needs a scratch worktree and can leave a dirty tree (D12) |
| Importing anything from Compozy or tlc-spec-driven | Both are coupled to their stacks; mechanisms are re-derived, not vendored (D4) |

## Users

| Persona | Needs |
|---|---|
| **The author** — one developer working with an agent | To be asked good questions and few of them; to see what was decided and why, months later |
| **The implementing agent** — a fresh context per task | An unambiguous contract: what to build, what proves it, and which source wins when two disagree |
| **The reviewer** — anyone reading the PR | To judge the artifacts without replaying the conversation that produced them |

## Requirements

### Process

| ID | Requirement |
|---|---|
| SPEC-01 | The scope of a slice SHALL be settled before any other question is asked. |
| SPEC-02 | The size of a slice SHALL be proposed by the agent, confirmed by the author, and recorded; when two sizes are defensible the larger SHALL be recorded. |
| SPEC-03 | A question SHALL NOT be asked when the codebase, project memory or an ADR answers it. |
| SPEC-04 | A question SHALL carry a leaning with its reasoning, and concrete options with their costs. |
| SPEC-05 | A round SHALL contain at most five questions. The total number of questions SHALL NOT be capped. |
| SPEC-06 | Questioning SHALL stop when no remaining fork would change the design, or when a concern has been repeated across rounds. |
| SPEC-07 | Every answered question SHALL record what its answer did to the design. |
| SPEC-08 | Each authoring phase SHALL end by auditing what it accumulated, and SHALL record what it removed. |

### Artifacts

| ID | Requirement |
|---|---|
| SPEC-09 | Requirements, design, cases and tasks SHALL each be a file under the feature's directory, committed. |
| SPEC-10 | A file SHALL NOT be created for a phase that did not run. |
| SPEC-11 | Every case in the contract SHALL be owned by exactly one task. |
| SPEC-12 | A decision recorded as an ADR SHALL NOT be edited after it is written. |

### Gates

| ID | Requirement |
|---|---|
| SPEC-13 | Every gate that can be decided mechanically SHALL be decided by a shipped executable, not by the agent remembering. |
| SPEC-14 | Gates SHALL run without any globally installed tool beyond the Node version lumem already requires. |
| SPEC-15 | A design SHALL be rejected while two competent implementers could read it and build different shapes; the structural half of that judgment SHALL be checked mechanically. |
| SPEC-16 | An acceptance criterion covering a failure path, a state transition, or concurrency SHALL name a concrete outcome. |

### Execution and verification

| ID | Requirement |
|---|---|
| SPEC-17 | WHEN sources disagree about what to build, the executing agent SHALL resolve the conflict by a fixed precedence order, record the choice, and continue without pausing. |
| SPEC-18 | IF a completion claim is made without verification evidence produced in the same turn, THEN the process SHALL refuse the claim. |
| SPEC-19 | The scope of verification SHALL be at least as broad as the scope of the claim it supports. |
| SPEC-20 | WHERE the harness provides independent agents, verification SHALL be performed by one that did not author the work; otherwise the evidence gate SHALL run alone, and the active mode SHALL be reported. |

### Failure behaviour

Stated in pattern form, per SPEC-16 — these are the criteria where prose hides the requirement:

| ID | Requirement |
|---|---|
| SPEC-21 | IF a spec artifact is malformed, THEN reading it SHALL yield a warning naming the file and SHALL NOT throw, and the remaining artifacts SHALL still be read. |
| SPEC-22 | IF a feature directory is absent or unreadable, THEN the next action SHALL be reported as `create-context` and the exit status SHALL be 0. |
| SPEC-23 | IF a gate finds anything, THEN its exit status SHALL be 3; IF the gate itself fails, THEN 1; otherwise 0. |
| SPEC-24 | WHILE a phase's artifact is missing, the next action SHALL name that artifact and SHALL NOT advance past it. |
| SPEC-25 | IF the recorded size is unrecognised or absent, THEN the phase SHALL be reported as `scope` and no size SHALL be assumed. |
| SPEC-26 | IF a task graph contains a cycle or names an unknown task, THEN the gate SHALL report it and the traversal SHALL terminate. |
| SPEC-27 | WHEN a task's inline step list exceeds five steps, the size SHALL be promoted one tier and the promotion SHALL be recorded; the size SHALL NOT be reduced automatically. |
| SPEC-28 | The recorded phase SHALL NOT exist: the current phase SHALL always be derived from the files present. |

## Business rules

- **A decision and a fact are different things.** An ADR records an act and is superseded, never edited. Memory states what is true now and is corrected or dropped. (001 D1)
- **Non-Goals and cuts are different things.** Non-Goals record what the author decided against; a cut records what the process removed for weight. Merging them destroys the evidence that pruning works.
- **Precedence, highest first:** an assigned case, a machine-checkable design constraint, a requirement in this file, an ADR, then anything informal. A task's paraphrase never outranks any of them.
- **The existing code is never the contract.** If the runtime cannot express what the resolved contract requires, the runtime changes or the gap is recorded — the deliverable is not quietly reshaped to fit.

## Assumptions and open questions

Nothing proceeds unmarked.

| Assumption | Chosen default | Rationale | Confirmed? |
|---|---|---|---|
| One developer, one repo at a time | No multi-author coordination, no locking | lumem is built for one team, and concurrent authoring of the same slice has never happened | y |
| Six skills is the right decomposition | One skill per artifact, plus a preflight that never authors | It is the boundary that stopped the wrong skill firing in the reference systems | y |
| The `light` tier will be used | Kept, with the doubt recorded | Cutting it makes a design document mandatory for a two-line change | n — revisit after three features |
| Process lessons belong in memory eventually | Deferred; a separate file when it lands | Project facts and lessons about the process compete for the same injection budget | n — revisit after the effect field survives three features |

**Open questions:** none — every fork raised in `questions.md` is resolved or listed above.

## Success criteria

- A feature can be carried from idea to verified code without the author re-explaining anything that is already in a file.
- The prune phase removes something on a feature where nobody had noticed accumulation.
- The effect field is still being filled honestly after three features — the failure mode is three features of `accepted` on every question, which means the field is decoration and should be enforced or removed.
- The ratio of questions that changed the design stays near a fifth. 001 scored 3 of 13; 002 scored 2 of 10.
