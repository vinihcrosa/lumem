# ADR body

`lumem adr new` seeds four headings. This is what to put under them, and it is more than the seed says.

The frontmatter is written for you — `title`, `date`, `area`, `summary`, plus `feature` when a slice produced the decision, plus `supersedes` when it replaces one. **There is no `status` field**: an ADR is superseded exactly when a newer one names it, so nothing ever edits a file after it is written.

---

## Context

What forced a decision. The constraint, not the history.

A reader who arrives in a year needs to know what was true that made this a fork at all. "We needed to choose a session strategy" is not a constraint. "Revocation had to take effect within one request, and we had no shared cache" is.

## Decision

What was decided, in the present tense, in one or two sentences. Specific enough that someone could tell whether the code still follows it.

## Alternatives considered

**This is the part that cannot be reconstructed later.** The decision is visible in the code; the roads not taken are visible nowhere.

One block per alternative:

```markdown
### JWT with a short expiry

- **What it was:** stateless tokens, 5-minute expiry, refresh on the client.
- **In favour:** no session store, no lookup on the hot path.
- **Against:** revocation waits for expiry; refresh logic on every client.
- **Why it lost:** the revocation requirement is the whole reason this decision exists.
```

"Why it lost" is not optional, and it is not the same as "Against". Against is the cost; why it lost is which cost was decisive.

If you cannot name a real alternative, this may not be an ADR. A choice with no alternatives records nothing beyond "we did the obvious thing".

## Consequences

Three parts, because they age differently:

```markdown
### Good

- Revocation is a delete, and takes effect on the next request.

### Bad

- Every authenticated request reads the session store.

### Risks

- The store becomes a single point of failure. Mitigation: it is already the
  database everything else depends on, so this adds no new failure domain.
```

**Bad and Risks are the sections that make an ADR worth reading.** An ADR with only the good parts is advocacy, and the next person to hit the cost will not know it was foreseen.

---

## When to write one

All three must hold:

1. **Hard to reverse.** Changing course later carries real cost.
2. **Surprising without context.** A future reader will look at the result and ask why.
3. **The product of a real trade-off.** There were genuine alternatives and one was chosen for stated reasons.

Miss any one and it is a line in `decisions.md`, not an ADR. An easily-reversed choice will simply be reversed; an unsurprising one nobody questions; a choice with no alternatives has nothing to record.

## Superseding

Never edit and never delete. Write a new ADR naming the old one:

```bash
lumem adr new "Session cookies with a rotating id" --area auth \
  --supersedes 2026-08-11-session-cookies-over-jwt.md --summary "…"
```

The newest ADR in a chain is the position that holds today. Following the chain is the reader's job, and it is cheap — which is why nothing writes back into the old file.

Restate what still holds rather than deferring to the superseded document. A decision that can only be understood as a diff against another decision is a decision nobody can state.
