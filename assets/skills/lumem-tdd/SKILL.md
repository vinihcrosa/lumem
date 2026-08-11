---
name: lumem-tdd
description: Turns requirements into a Technical Design Document concrete enough that two implementers build the same thing, plus the test contract that verifies it. Use when a PRD exists and the design is not yet settled. Do not use for requirements (lumem-prd), task breakdown (lumem-tasks), or writing implementation code.
---

# lumem-tdd

Translate `prd.md` into a design, and the design into a numbered contract of cases.

Produces `tdd.md` and `tests.md` under `docs/features/<NNN>-<slug>/`. Called TDD for Technical Design Document — the collision with Test-Driven Development is known and accepted.

## Three gates, in order

<gate>
**Explore before designing.** The existing architecture, the patterns already in use, the module that already does half of this. A design that ignores what is there produces an integration failure, not a merge conflict.

**Concreteness before handing off.** Prose produces one implementation per reader. See below.

**Prune before handing off.** The phase ends by auditing what it accumulated. It asks nothing new.
</gate>

## The one finding that matters most

Two design documents from the same week, in a real project: one pasted interface signatures and enumerated invariants, the other described the same mechanics in prose. The first shipped after **one** review round. The second generated several.

The diagnosis is worth memorising: **prose-only descriptions produce N implementations, where N is the number of agents that read the spec.** Reviewers then converge each of them toward the implicit intent, one round at a time. That convergence is the rework.

So the test for this artifact is not length or coverage. It is:

> Could two competent implementers read this and build different shapes?

While the answer is yes, the design is not ready — no matter how thorough it reads.

## What concrete means, in any language

The gate checks the structural half. The judgment is yours.

| Pin | Not |
|---|---|
| The signature, in the project's own language, in a fenced block | "the function accepts the config and returns the result" |
| Every new field with its name and type | "add a column for ownership" |
| The states, enumerated | "the usual lifecycle" |
| Invariants as a **numbered list**, so one can be cited by number | a paragraph about safety |
| The decision, when a thing could be stored two ways | "choose the appropriate shape" |

Language-specific markers belong to a module, not here. This gate is the stack-agnostic floor.

## Writing it

Read `references/tdd-template.md` and follow its sections. Then run the gate before showing anyone:

```bash
node .lumem/bin/lumem-spec.mjs lint docs/features/<slug> --phase tdd
```

Expect the design to change while you write it. Formalising finds problems that discussing does not — in feature 001, writing the field table turned a stored field into a derived one, which removed a write path and a drift risk that the whole interrogation had missed. **The design phase is not transcription.**

## Questions, if any are left

Round-cap five, no total cap, one fork per question, leaning plus cost column — the same protocol `lumem-prd` uses, and the same `**Effect:**` line on each answer.

Most forks should already be closed. The ones that survive to this phase are usually about component boundaries and where state lives. Anything the codebase answers is not a question.

Record a decision that clears all three tests — hard to reverse, surprising without context, a real trade-off — as an ADR, with `--feature <slug>`. **Even a simple feature usually has one:** the primary technical approach, and what it was chosen over.

## The test contract

Read `references/tests-template.md` and write `tests.md`.

It is the canonical numbered list, and `lumem-tasks` assigns every id in it to exactly one task. Derive cases from what the design pins: one per component and per error path, one per boundary between components, one per journey a user takes.

**Every case names the exact input, the condition, and the expected result.** "Tests the happy path" is not a case. Neither is "verifies the parser works".

Shape it so a mutation-testing pass could be added later without a rewrite — that is deferred, not abandoned.

## Prune

Audit what accumulated against what the slice exists to deliver. Ask nothing new. Cuts go to `Cut, and why` in `decisions.md`, with the `Kept under pressure` half naming what survived and why.

Two things worth cutting that this phase tends to produce: a state the invariants make unreachable, and a check that duplicates a mechanism elsewhere. Both were real cuts in feature 002's own design.

## Handing off

Confirm both paths, invite changes on the files, point at `lumem-tasks`.
