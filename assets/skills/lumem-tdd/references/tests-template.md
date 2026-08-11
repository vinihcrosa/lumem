# tests.md template

The canonical numbered list of cases. `lumem-tasks` assigns every id here to exactly one task, and the gate fails on an orphan or a duplicate — so this file is a contract, not a wish list.

---

## Header

```markdown
# Test contract — <NNN> <Feature name>

**Derived from:** `tdd.md` §…
**Status:** draft, awaiting review
```

State the levels and where they live in this project, so a reader knows what `IT-` means here:

```markdown
**Levels.** `UT-` unit, colocated. `IT-` integration, spawning real processes.
```

Use the levels the project already has. Inventing a tier nobody runs adds ceremony and no coverage.

## The case-writing rule

**Every case names the exact input, the condition, and the expected result.**

| Not a case | A case |
|---|---|
| Tests the happy path | A field row with an empty type cell yields `field-without-type`, severity gate |
| Verifies error handling | An unterminated frontmatter fence yields a warning naming the file and does not throw |
| Checks the parser works | `UT-01…UT-03` in a Cases cell expands to those three ids, in that order |

A case you cannot fail on purpose is not a case.

## Shape

One table per component, ids sequential across the whole file:

```markdown
## A. `readFeature` — tolerant parse

`src/spec/feature.test.ts`

| ID | Input / condition | Expected |
|---|---|---|
| UT-01 | frontmatter with slug, tier and created | all three parsed; `warnings` empty |
| UT-02 | frontmatter without `tier` | no throw; tier absent; one warning naming the key |
```

Naming the test file next to the table is what makes the contract auditable later — a case with no home is a case nobody wrote.

## What to derive from where

- **Per component and per interface** in the design: one case for the ordinary path, one per error path it declares.
- **Per boundary** between components: one case exercising the contract between them, not each side separately.
- **Per journey** a user takes end to end.
- **Per invariant** in the design that can be broken by input rather than only by a code change.
- **Per failure row** in the design's failure section. Those are the cases most often missing and most often needed.

Density should be proportional to the behaviours the design names. One or two cases against a dozen behaviours is not a contract; it is a gesture.

## Coverage matrix

Close the file by mapping the design's acceptance criteria to case ids:

```markdown
| Criterion | Cases |
|---|---|
| 1 an absent directory yields create-context | UT-16, UT-17 |
```

Then state the count, and name the thinnest row — the first place to add a case when the feature grows.

## What is deliberately not covered

Say so explicitly, with the reason and what stands in its place.

Prompt text is the usual example: a test that greps a `SKILL.md` for a phrase locks the wording without checking the behaviour. What can be asserted is that it ships, installs and uninstalls. Whether it works is answered by use, not in CI.

An honest exclusion is worth more than a case that asserts nothing.

## Shaped for what comes later

An adversarial pass — injecting faults into a copy and confirming the cases kill them — is deferred, not abandoned. Keep each case's expected result specific enough that a mutation would break it. A case asserting "returns something" survives every mutation and proves nothing.
