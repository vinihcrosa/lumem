---
name: lumem-prd
description: Settles what a feature is for and what it must do, through research first and questions second, and records the decisions as ADRs. Use when starting a feature, or when requirements are vague enough that building would mean guessing. Do not use for technical design (lumem-tdd), task breakdown (lumem-tasks), or writing code.
---

# lumem-prd

Turn an idea into requirements the next phase can build against, and record what was decided so nobody re-litigates it.

Produces `context.md`, `prd.md`, `decisions.md`, `questions.md`, and an ADR for every decision worth keeping — all under `docs/features/<NNN>-<slug>/`.

## Three gates, in order

<gate>
**Research before questions.** Everything the codebase, `.lumem/memory/` or `docs/adr/` can answer is answered from there, before the first question. A question you could have looked up costs the author a turn and teaches them you did not read.

**Scope before anything else.** The first question settles what is in this slice and what is explicitly a later one. In feature 001 scope was asked tenth, and four questions had already been asked against a boundary that then moved.

**Prune before handing off.** The phase ends by auditing what it accumulated. It asks nothing new.
</gate>

## Phase 1 — Context

Write `context.md` before asking anything: what this is, why now, what it depends on, and what it is deliberately not. No questions in this phase.

Then propose the size, and get it confirmed:

| Tier | Runs |
|---|---|
| `light` | requirements, then execute and verify |
| `design` | adds the design document and its test contract |
| `full` | adds the task graph |

**When two tiers are defensible, take the larger.** The safety valve only ever fires for under-sizing. Record the confirmed tier in `decisions.md` frontmatter:

```yaml
---
slug: 003-example
tier: design
created: 2026-08-11
---
```

## Phase 2 — Questions

Read `references/question-protocol.md` and follow it. The short version:

- One fork per question. Lead with your leaning **and the reasoning behind it**, so there is something to disagree with.
- Concrete options with a cost column. Never an open "what do you want".
- Invite rejection of the framing. In 001 that produced the single most valuable answer of the run.
- A question about something that does not exist yet rebuilds its scenario inside the question.
- **At most five questions per round. No cap on the total.** The count is an output of the decision tree; the round is a limit on what a person holds at once.

Every question gets an `**Effect:**` line once answered — `changed`, `accepted`, `rejected-framing`, `not-understood`. Scoring the round is how the question set improves; skipping it is how it rots.

**Stop on either signal:** no remaining fork whose answer would change the design, or a concern repeated across rounds. The second means stop adding and start cutting.

## Phase 3 — Decide, then write

Choose the strongest direction yourself from the answers and the research. Then write the ADRs, then `prd.md`, then hand off. No approach menus, no draft-approval loops — the author reviews the files.

**An ADR for every decision that clears all three:** hard to reverse, surprising without context, and the product of a real trade-off. Miss one and it is not an ADR; it is a line in `decisions.md`.

```bash
lumem adr new "Session cookies over JWT" --area auth --feature 003-example \
  --summary "Auth uses session cookies because revocation must be immediate."
```

Then fill the body from `references/adr-template.md`. **The alternatives section is the part that cannot be reconstructed later** — everything else is recoverable from the code.

Write `prd.md` from `references/prd-template.md`. It carries the per-section rules.

## Phase 4 — Prune

Audit what the phase accumulated against what the slice exists to deliver. Ask nothing new.

Removed scope goes into a `Cut, and why` section in `decisions.md`, with a `Kept under pressure` half naming what survived and why. **Keep it separate from Non-Goals**: Non-Goals is what the author decided against, `Cut` is what the process removed for weight. A prune that only ever cuts is as untrustworthy as one that never does.

## Handing off

Confirm the paths, invite changes on the files, and point at `lumem-tdd`. Run the gate first:

```bash
node .lumem/bin/lumem-spec.mjs lint docs/features/<slug> --phase prd
```

## What belongs to someone else

**WHAT and WHY live here; HOW lives in the design.** When the request sounds technical, translate it: not "WebSockets or polling?" but "which events should reach the user?". Frameworks, storage engines, wire formats and status codes do not appear in `prd.md` — the gate flags the ones it can see, but the discipline is yours.
