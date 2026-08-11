# Task body template

One per task, under a `## T<n> — <title>` heading in `tasks.md`.

---

```markdown
## T3 — The three phase lints

- [ ] T3 — The three phase lints

### Overview

What slice of the system this delivers, and why it is one slice, in two or three
sentences. If a reader cannot tell from this what the task is for, the boundary
is probably wrong.

### Requirements

1. MUST reuse the finding shape `core/adr` already uses; a second shape is a defect.
2. MUST implement exactly the checks the design lists and no others.
3. MUST NOT auto-fix. A finding reports; the author decides.

Numbered, in MUST / MUST NOT / SHOULD terms. These are what the implementer is
held to, so each one has to be checkable by reading the diff.

Include the prohibitions. "MUST NOT introduce a new artifact kind if the existing
one generalises" prevented a parallel code path in this very feature.

### Subtasks

- [ ] Risky-dimension detection and the concrete-value test
- [ ] Severity assignment per the design's tables

WHAT, not HOW. One per coherent unit of work — five to twelve for a real task.

### Files

Create `src/spec/lint.ts`, `src/spec/lint-prd.test.ts`. Modify `tsup.config.ts`.

Name them. A task that discovers its own file list mid-run rediscovers it every
time it is resumed.

### Tests

UT-31…UT-54. Name the two or three that matter most and why — that sentence is
what stops a later reader from deleting the case that was load-bearing.

When a task carries no cases, say so here **with the reason**, and expect the
gate to report it at severity info. An unexplained empty Tests section is a slice
nobody will verify.

### Success criteria

Every case above passes. `tsc --noEmit` and the linter clean. Plus whatever is
specific to this slice — a real command run against real input, not a feeling.
```

---

## Completion notes

Added when the task is done, in the same body. This is the part that pays off months later, so it is not a formality.

What belongs in it:

- **The evidence**, quoted. Real command output, real counts, real exit codes. "Tests pass" is not evidence; `1498 tests passed across 60 files` is.
- **Every contract conflict resolved**, and which reading won. The next task inherits that interpretation and will otherwise re-derive it differently.
- **Anything done outside the declared files**, and why it was unavoidable.
- **Defects the process caught**, in the order it caught them — the case that failed, the artifact that flagged, the gate that fired. This is the record that tells you whether the gates earn their cost.
- **Follow-ups**, named as such, so they are visible rather than implied.

What does not belong: a narrative of the session, a list of every file read, or an apology for a mistake already fixed. Record the finding, not the feelings.
