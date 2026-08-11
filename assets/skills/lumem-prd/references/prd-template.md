# prd.md template

Fill every section. The rules are per section, and they are the point — a filled-in shape with the rules ignored passes no gate worth passing.

Language: English. Active voice, definite statements, every sentence earning its place.

---

## Problem

Two or three sentences. What breaks today, who feels it, why now.

Not a restatement of the feature name. If the problem reads as "we do not have X", the problem has not been found yet.

## Goals

Observable outcomes, not metrics:

- what a user can do after this ships that they could not before
- what the system guarantees or refuses once it exists
- what stops being manual, or stops being possible

No KPIs, no timelines, no rollout phases. Nothing downstream consumes them.

## Non-Goals

What the author decided against, and why. Bulleted or a two-column table.

**This records decisions, never size management.** A capability the author wants stays in scope no matter how large the document grows. Scope removed for weight belongs in `Cut, and why` in `decisions.md`, which is a different fact.

## Users

Who this is for, and what each of them needs from it. Include the secondary personas — the operator, the reviewer, the agent that has to run the thing at 3am.

## Requirements

Numbered, with stable ids, grouped by area:

```markdown
| ID | Requirement |
|---|---|
| AUTH-01 | A session SHALL be revocable within one request of the revocation. |
```

Rules:

- One obligation per row. Two behaviours in one row cannot be verified separately.
- Concrete values, not adjectives: a status, a bound, a message, a limit.
- **A requirement covering a failure path, a state transition, or concurrency takes a pattern:** `IF <condition> THEN …`, `WHEN <trigger> …`, `WHILE <state> …`, `WHERE <feature present> …`. Those are the three dimensions where prose reliably hides the requirement, and the gate checks them.
- Everywhere else, prose is fine. An always-on invariant reads better without ceremony.
- Never "gracefully", "quickly", "properly", "appropriately". They describe how well, not what — and the gate rejects them in any dimension.

## Business rules

The domain rules the implementation must enforce, stated precisely: invariants that always hold, permission and visibility rules, lifecycle and state transitions, calculations and limits with their exact values.

## Assumptions and open questions

```markdown
| Assumption | Chosen default | Rationale | Confirmed? |
|---|---|---|---|
| One author per slice | No locking | It has never happened | y |
```

**Every ambiguity is resolved with the author or recorded here with the default you chose and why.** A row with an empty default or an empty rationale is a gate failure — the point is that nothing proceeds unmarked.

Close the section explicitly: `**Open questions:** none — all resolved or logged above.`

## Architecture Decision Records

One line per ADR this phase produced:

```markdown
- [Session cookies over JWT](../../adr/2026-08-11-session-cookies-over-jwt.md) — revocation must be immediate.
```

If the list is empty, either the feature genuinely decided nothing hard to reverse, or a decision is going unrecorded. Check which.

## Success criteria

How the author will know it worked, in behavioural terms. Include the honest failure mode: the thing that, if it happens, means this feature was a bad idea.

---

## What never appears here

Frameworks, storage engines, wire protocols, auth standards, file formats, HTTP status numbers, table and column names, tool names.

The exception is a feature that is *about* one of those — a PRD for a file format names the format, because the format is the product. State the exception in the body rather than leaving a reader to wonder.
