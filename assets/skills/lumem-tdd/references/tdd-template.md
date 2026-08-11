# tdd.md template

Sections in this order. Omit one only when it genuinely does not apply, and say why rather than leaving a gap.

Language: English. Active voice, definite statements. Reference `prd.md` by section name instead of restating business context.

---

## Header

```markdown
# TDD — <NNN> <Feature name>

**Status:** draft, awaiting review
**Depends on:** `context.md`, `decisions.md` (D1–Dn), `questions.md` (rounds 1–n)
```

## Summary

One or two paragraphs: the approach, the main trade-off, and what this slice exists to learn. If the slice is deliberately small, say what was deferred and why here rather than burying it at the end.

## Layout

What exists on disk or in the system after this ships. A tree, then a table naming what writes each thing and when it exists:

```markdown
| File | Written by | Exists when |
|---|---|---|
```

## Components and boundaries

Each component's responsibility, and the boundaries between them — which one may depend on which. Name the new ones explicitly.

If a component could plausibly live in two places, say which and why. That sentence prevents an argument in review.

## Interfaces

**Fenced blocks in the project's own language.** Every signature final:

````markdown
```ts
export interface NextAction {
  phase: SpecPhase
  action: string
  target?: string
}

export function nextAction(f: SpecFeature): NextAction
```
````

A method described in prose is a method two implementers will shape differently. Paste it.

## Data

Every new field with its name, type and purpose:

```markdown
| Field | Required | Type | Rule |
|---|---|---|---|
| tier | yes | `light \| design \| full` | The recorded size; changes only upward |
```

An empty type cell is a gate failure. When a value could be stored two ways — a typed column or a blob, a file or a field — state which and why; that decision is where drift starts.

## Behaviour

The rules, as a table or an ordered list, in the terms the interfaces just established. Where order matters, say that the order is part of the contract, and say it next to the list rather than in a note at the end.

## Failure and edge behaviour

What happens when input is malformed, absent, or hostile. Exit codes, error shapes, what degrades and what refuses.

This is the section most often thin, and the one most often needed.

## Invariants

**A numbered list.** Not prose, not bullets — numbered, so a review comment can say "invariant 4" and everyone knows what it means.

```markdown
1. Phase is always derived from the filesystem, never stored.
2. No skill edits an ADR after it is written.
```

An invariant that cannot be cited by number does not get cited.

## Acceptance criteria

Numbered, grouped, each one checkable. This is what the test contract derives from, so vagueness here becomes untestable cases there.

Include a non-regression group: what must keep working that this feature has no business touching.

## Success criterion

What this slice exists to learn, stated so it can come back false. Usually not testable in CI — measured over real use, with a stated horizon.

Name the honest failure mode too. A criterion that cannot fail is a wish.

## Deferred, with triggers

```markdown
| Deferred | Revisit when |
|---|---|
| A driver for unattended runs | Contracts plus `next` prove insufficient on a real multi-day feature |
```

**Every row needs a trigger.** "Later" is not a trigger; it is how a deferred list becomes a wish list nobody reads.

## Open, deliberately

The things you know are unresolved, and chose to ship unresolved. Recording them here is what separates a known gap from an oversight — and it is where the next feature's questions come from.
