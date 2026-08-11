---
title: lumem checks that a verdict is fresh, it does not run the gate
date: 2026-08-11
area: spec-driven
summary: The agent runs the declared gate and records a tree fingerprint; lumem recomputes it and refuses a mismatch, so the bundle stays read-only.
feature: 003-closing-the-test-loop
---
## Context

Feature 002 shipped a pipeline whose verdict is a line someone types:

```markdown
- **Result:** PASS
- **Evidence:** npm run verify — 60 files, 1498 tests, 0 failed
```

Nothing checks that the command ran, that it ran against this tree, or that the numbers are real. Measured at 002's close: 85 cases declared, 83 named by a test, two implemented only as comments — and the feature closed `PASS` with nothing noticing.

So a verdict has to become something that can be refused. The question is who produces the run it cites.

The constraint that makes this a fork: **everything lumem ships into a project is currently read-only.** `next` and `lint` open files and nothing else. The hook bundle writes only to `.lumem/local/`. Nothing lumem installs has ever executed a command belonging to the project.

## Decision

The **agent** runs the declared gate. It records the output together with a fingerprint of the tree, which lumem prints on request. When a verdict is checked, lumem **recomputes the fingerprint and refuses a verdict that does not match**.

The fingerprint covers what a gate reads — source, configuration, lockfiles — and excludes `docs/`, because the verdict lives in a document and would otherwise invalidate itself as it was written.

## Alternatives considered

### lumem runs the gate itself

- **What it was:** the bundle spawns the declared command, captures its output, and writes the verdict from what it observed.
- **In favour:** the output is real by construction. Nothing to forget, nothing to forge, and no fingerprint mechanism needed at all.
- **Against:** a copied bundle gains permission to execute arbitrary project commands — a far larger blast radius than anything lumem does today, in a file that lands in every repo. It also inherits a hazard this repo has already paid for twice: with a pipe, `spawnSync` stays blocked while any grandchild holds the inherited stdout fd, so output must go through a temporary file (`core/consolidate/run.ts`, `probeVersion` in `core/harness/detect.ts`).
- **Why it lost:** design rule 1 — the memory layer breaking must never break your work. **A gate that only reads cannot damage a tree; a gate that executes can.** And the threat it defends against is not the one we measured: an agent willing to forge a fingerprint would equally forge command output, so executing buys no honesty it does not already assume.

### Both — execute when a command is declared, check freshness otherwise

- **What it was:** the strong mechanism where possible, the weak one as a fallback.
- **In favour:** widest coverage; a project that wants the stronger guarantee can have it.
- **Against:** two mechanisms for one property, and the weaker path becomes the default by omission — a project that never declares a command silently gets the lesser guarantee and no signal saying so.
- **Why it lost:** it surrenders the read-only property anyway, for a guarantee that applies only where someone opted in.

## Consequences

### Good

- The bundle stays strictly read-only. Hashing a file is a read, so nothing lumem installs can alter or break a project's tree.
- The failure that was actually measured — a stale or absent run, a verdict nobody earned — becomes detectable.
- No new hazard: no spawning, no pipes, no grandchild fds, no timeout policy.

### Bad

- **Forgeable by deliberate lying.** An agent that pastes a fingerprint it did not earn defeats the check, and lumem cannot tell.
- The agent has to ask lumem for the fingerprint and record it, so recording a verdict becomes two steps instead of one.

### Risks

- **The fingerprint's scope is a live judgment.** Too wide and every comment edit invalidates a verdict; too narrow and a real change slips through. Mitigation: it covers what a gate reads and excludes documents, and over-invalidation is the safe direction — a re-run costs minutes, a false PASS costs a release.
- **A project with no declared gate has nothing to be fresh about.** Mitigation: the config declares a default, so the absence is visible in one place rather than per task.
