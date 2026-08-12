# PRD — 003 Closing the test loop

**Status:** implemented — verdict PASS, see `tasks.md`
**Reads with:** `context.md` (the measurement), `decisions.md` (D1–D8), `questions.md` (round 1, stopped)

## Problem

A completion claim in this pipeline is currently an assertion. The verdict is a line someone types, and nothing checks that the command it cites ran, that it ran against the tree being claimed, or that the cases the specification declared were ever written.

Measured at 002's close: two of eighty-five declared cases had no test, and the feature closed `PASS`. Nobody lied; nothing looked.

This is the only weakness in the pipeline that fails **toward** confidence. A vague requirement produces an artifact you can read and doubt; an unverified verdict produces a green line that ends the conversation.

## Goals

- A declared case that nobody implemented is reported, by name, before the feature can close.
- A verdict states which command produced it, and lumem can tell whether that run still describes the current tree.
- A task can claim something narrower than the whole project without the claim becoming dishonest.
- None of this requires lumem to execute anything belonging to the project.

## Non-Goals

| Excluded | Why |
|---|---|
| Proving the cases can fail (mutation, discrimination) | Its deferral trigger has not fired, and it needs a scratch worktree that can leave a dirty tree — D6 |
| Executing the gate from inside lumem | A gate that only reads cannot damage a tree; one that executes can — D3 |
| Coverage measurement | Coverage counts lines. This counts whether the declared cases exist and pass, which a project at full coverage can still fail |
| Defending against a deliberately forged verdict | The measured failure is forgetfulness. Deception needs a different mechanism and is not this slice |
| Changing the shape of `tests.md` | The contract is right; everything downstream of it was missing |

## Users

| Persona | Needs |
|---|---|
| **The author** | To be told, in one line, that a case has no test — before reading a `PASS` that is not true |
| **The implementing agent** | To know which command counts as its gate, without inferring it from the repository |
| **The reviewer** | To tell a verdict that was earned from one that was typed |

## Requirements

### Declared and implemented

| ID | Requirement |
|---|---|
| LOOP-01 | A case declared in the contract SHALL be reported when no test names it. |
| LOOP-02 | The report SHALL name the case id, so the author never has to diff two documents to find it. |
| LOOP-03 | A test SHALL be recognised by a configurable set of declaration patterns, with a documented default. |
| LOOP-04 | WHERE a project configures its own patterns, the configured set SHALL replace the default rather than extend it. |
| LOOP-05 | IF no pattern matches anything in the searched files, THEN the report SHALL say that no tests were recognised at all, rather than reporting every case as unimplemented. |

### The gate command

| ID | Requirement |
|---|---|
| LOOP-06 | The project SHALL be able to declare one default gate command in its configuration. |
| LOOP-07 | A task SHALL be able to declare a narrower gate command, which takes precedence over the default for that task. |
| LOOP-08 | IF neither a task nor the configuration declares a gate, THEN a verdict SHALL be reported as unverifiable and SHALL NOT count as passing. |

### The verdict

| ID | Requirement |
|---|---|
| LOOP-09 | A verdict SHALL record the command that produced it, its result, and a fingerprint of the tree it was produced against. |
| LOOP-10 | lumem SHALL recompute the fingerprint on demand and SHALL report a verdict whose fingerprint differs from the current tree as stale. |
| LOOP-11 | The fingerprint SHALL cover the inputs a gate reads — source, configuration, dependency lockfiles — and SHALL exclude the documents that record the verdict. |
| LOOP-12 | A stale or absent verdict SHALL NOT allow a feature to be reported as done. |

### Failure behaviour

| ID | Requirement |
|---|---|
| LOOP-14 | IF a file cannot be read while computing the fingerprint, THEN the fingerprint SHALL be reported as incomplete and the verdict SHALL be treated as stale. |
| LOOP-15 | IF the contract declares no cases at all, THEN nothing SHALL be reported as unimplemented. |

### Inherited from 002, not built here

Three behaviours belong to this problem and already ship, so they are not requirements of this slice. Named so nobody re-implements them:

- **A failing verdict returns to verification** — `next.ts` already has the rule, asserted by UT-27.
- **A feature with no verdict is at `verify`, and `next` still exits 0** — asserted by UT-27 and IT-02.
- **A check exits 3 on a finding, 1 on its own failure, 0 otherwise** — the convention `memory lint`, `adr lint` and `lint --phase` already follow.

The ids skip from LOOP-12 to LOOP-14 for the same reason 002's cases skip to UT-65: renumbering a traced list to close a gap costs more than the gap.

## Business rules

- **Ownership and implementation are different facts.** A case with an owner and no test satisfies the existing gate and violates LOOP-01. Neither check substitutes for the other.
- **Over-invalidation beats under-invalidation.** A fingerprint that flags a harmless edit costs a re-run; one that misses a real change costs a false pass. When the two conflict, flag.
- **A narrow claim is honest when it says it is narrow.** A task gate that runs one suite supports "this task is implemented and its lanes are green", never "the feature is done".
- **The verdict cannot certify the document it lives in.** Recording a verdict changes that document; a fingerprint covering it would invalidate the verdict in the act of writing it.

## Assumptions and open questions

| Assumption | Chosen default | Rationale | Confirmed? |
|---|---|---|---|
| One case is verified by one test | The gate requires the id in a test name; a test covering several cases names them all | The alternative is parsing what a test asserts, which needs real language knowledge | y |
| Source edits invalidate a verdict, including comment-only edits | Flag it as stale | Distinguishing a semantic change from a cosmetic one needs a parser per language | y |
| The default pattern set covers this project's runners | `it(`, `test(`, `func Test`, `def test_` | It covers vitest, jest, Go and pytest, which is what lumem and its likely first projects use | n — revisit the first time a project reports every case unimplemented |
| A project has one gate command worth naming | `npm run verify` here | Every project this framework has been used in has a single command that means "everything" | n — revisit if a monorepo needs one per package |

**Open questions:** none — every fork raised in `questions.md` is resolved, and the two assumptions above are marked unconfirmed with their revisit conditions.

## Architecture Decision Records

- [lumem checks that a verdict is fresh, it does not run the gate](../../adr/2026-08-11-lumem-checks-that-a-verdict-is-fresh-it-does-not-run-the.md) — a gate that only reads cannot damage a tree.
- [A case counts as implemented when its id names a test](../../adr/2026-08-11-a-case-counts-as-implemented-when-its-id-names-a-test.md) — the only form that catches an unimplemented case.

## Success criteria

- Re-running the finished checks against 002 reports IT-18 and IT-19 as unimplemented. **That is the acceptance test for the whole slice**: it is the exact failure that produced it, and it is already on disk.
- A verdict recorded before a source edit reads as stale afterwards, and a re-run clears it.
- The honest failure mode: if the pattern set turns out to be wrong often enough that projects disable the check, the mechanism is worse than the gap it closes. The signal to watch is anyone configuring the check off rather than configuring its patterns.
