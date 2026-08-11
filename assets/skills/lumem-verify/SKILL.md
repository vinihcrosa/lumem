---
name: lumem-verify
description: Refuses a completion claim that has no fresh evidence behind it, and binds the scope of verification to the scope of the claim. Use before saying anything is done, fixed, passing or ready — and before a commit or a pull request. Do not use during planning or early exploration, where there is nothing to verify yet.
---

# lumem-verify

**Claiming work is done without verifying it is not efficiency. It is a false statement about the state of the tree.**

## The rule

> No completion claim without fresh verification evidence.

If the command has not been run in this turn, its result cannot be claimed. Not "it passed earlier", not "it should pass", not "the change is obviously safe".

## The gate

Before saying anything is done, fixed, working, passing, or ready:

1. **Name the command** that would prove the claim.
2. **Run it in full.** Not a subset, not from memory.
3. **Read the output.** Exit code. Failure count. Not the first green line.
4. **Compare it to the claim.** If it does not support the claim, state what is actually true, with the output.
5. **Only then** make the claim — with the evidence attached.

Skipping a step is not verifying. It is guessing with extra confidence.

## Scope binds

**The verification must be at least as broad as the claim.**

| Claim | Requires |
|---|---|
| this test passes | that test, run |
| the bug is fixed | the original symptom, reproduced then gone |
| the linter is clean | the linter, over everything |
| this task is complete | the project's full gate, plus the deliverable checked against the spec |
| ready to commit | the full gate |

Running one test never supports "task complete". Running the linter never supports "ready to commit". **If in doubt, run the full pipeline** — over-verifying costs minutes, under-verifying costs hours.

Inside a multi-task run, a per-task claim is narrow by design: "task implemented, affected suites green, full gate at close". Say exactly that, then run the full gate at the close.

## A green pipeline is not a met requirement

A passing build proves the code compiles, lints, and passes the tests that exist. It proves nothing about whether the thing asked for was built.

For "complete" or "requirements met", also check the deliverable **field by field against the canonical artifacts** — `tests.md`, `tdd.md`, `prd.md` — never against the task body's paraphrase of them.

## Two modes, and `doctor` names which one you are in

```bash
lumem doctor
```

- **`independent`** — the harness can spawn an agent that did not author the work. Use it. It re-derives coverage from the artifacts instead of inheriting the author's mental model, which is the thing being checked.
- **`evidence-only`** — no such facility. The gate above still runs in full. It is the floor, and it is portable.

The difference is visible on purpose: a gap caught on one machine may not surface on another, and that is worth knowing rather than discovering.

## Red flags in your own output

Any of these means stop and go back to step 1:

- "should", "probably", "seems to", "I believe"
- expressing satisfaction before running anything
- about to commit, push, or open a pull request with nothing run
- trusting another agent's report of its own success
- a partial run standing in for a full one
- "just this once"
- verifying against a paraphrase when the canonical artifact is right there

## When it fails

Report it plainly, with the output. A failing gate is information, not an embarrassment — and a failure reported honestly costs one turn, while a failure hidden costs the next person a day.

Never weaken, skip or delete a test to make a gate pass. That converts a known problem into an unknown one.

## Recording the verdict

At the close of a feature, write it into `tasks.md`:

```markdown
## Verdict

- **Result:** PASS
- **Evidence:** npm run verify — 60 files, 1498 tests, 0 failed
```

`PASS` or `FAIL`. **A `FAIL` is not terminal** — the next action returns to verification until the tree is fixed. Recording one is how the graph stays honest about where it actually is.
