# 003 — Closing the test loop

**Status:** shipped 2026-08-11
**Started:** 2026-08-11

## What this is

The property 002 shipped without: **a declared case that is not implemented, or not passing, must not be able to reach `phase=done`.**

Today the pipeline audits *ownership* of a case and then trusts everything after it. This slice makes the loop from a declared case to a passing test observable, and refuses a completion claim that cannot be backed.

## Why now

002's own suite, measured at its close:

```
cases declared in tests.md      : 85
cases named by an it()          : 83
cases named by nothing          :  2   (IT-18, IT-19)
it() blocks in the whole suite  : 1306
it() blocks carrying a case id  : 132  (10%)
```

IT-18 and IT-19 *were* implemented — one as a comment inside an existing assertion, one as a step in a shell script. The convention that links the other 83 exists because it was typed, not because anything requires it. **Nothing in lumem noticed**, and the feature closed with a `PASS` verdict.

The consequence, exactly: a task can be ticked done with every case assigned and no test written, and the pipeline answers `phase=done`.

It ranks above everything else on 002's list for one reason. Every other weakness there degrades **visibly** — a vague requirement produces a worse artifact you can read, a prose design produces implementations that diverge in review. This one degrades **silently, toward a false PASS.** It is the failure class `lumem-verify` exists to prevent, and the framework does not hold itself to it.

## What the research already settled

Answered from the codebase, so they are not questions:

- **`orphan-test-id` proves a case has an owner, not an implementation.** `lintSpec` reads only the feature directory; `readFeature` never looks outside it. Reaching the codebase is a new capability for that module, not a parameter of an existing one.
- **There is no canonical link from a case id to a test.** The id-in-test-name convention covers 10% of the suite and is enforced by nothing.
- **`lumem.config.json` has nowhere to name a project command.** Its schema holds `version`, `budgets`, `gate` (consolidation gating), `consolidation`, `harnesses`, `heuristics`. Nothing about how this project runs its tests. A config-declared suite command is a schema change; a task-declared gate is not.
- **This project's gate is `npm run verify`** — `biome check && tsc --noEmit`, then `vitest run`, then the build. Any design that needs "the gate command" has one to name here, and cannot assume every project does.
- **Spawning a command from lumem code is established, with a known hazard.** `core/consolidate/run.ts` runs the headless CLI through `spawnSync` and captures output **into a file rather than a pipe**, because with a pipe `spawnSync` stays blocked while any grandchild holds the inherited stdout fd — the same bug `probeVersion` hit and paid for once. Anything here that runs a test command inherits that constraint.
- **The gates must stay in the copied bundle, not the CLI.** Settled by ADR `2026-08-11-spec-gates-ship-as-copied-bundles-not-as-a-cli-dependency`. The bundle imports only node builtins, and `node:child_process` is one, so running a command does not break its purity contract.
- **The discrimination pass has a deferral trigger that has not fired.** 002 D12 deferred it until "a shipped feature passes verification and still breaks". Nothing has. Pulling it in now would pre-empt its own trigger — which is a scope question, not a research finding, and it is the fork below.

## What this depends on

- `tests.md` as the canonical numbered contract — 002 shipped it and it is unchanged.
- `lint --phase tasks`, which already gates ownership and is where a "declared but unimplemented" check would live.
- The verdict block in `tasks.md`, which is currently a typed line nothing validates.
- The task body template, which today asks for success criteria in prose and names no command.

## What this is deliberately not

- **Not a test framework, and not an opinion about one.** lumem is stack-agnostic; it cannot know what a suite is. Whatever this slice builds, the project names its own command and lumem observes the result.
- **Not a coverage tool.** Coverage measures lines; this measures whether the cases the spec declared exist and pass. A project at 100% coverage can still have a declared case nobody wrote.
- **Not a rewrite of `tests.md`.** The contract shape is right; what is missing is everything downstream of it.

## Meta

003 is the first feature to be authored **through the installed skills** rather than by following the artifacts by hand. 002's retrospective named that as the thing it could not prove about itself, and its subject is the pipeline's weakest property — so a failure of the process here shows up twice, which is the point.
