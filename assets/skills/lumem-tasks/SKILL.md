---
name: lumem-tasks
description: Breaks a design into few, large, independently implementable tasks and assigns every case in the test contract to exactly one of them. Use when a design and its test contract exist and the work needs a graph. Do not use for requirements (lumem-prd), design (lumem-tdd), or executing a task (lumem-execute-task).
---

# lumem-tasks

Turn `tdd.md` and `tests.md` into a graph a fresh agent can pick up one node at a time.

Produces `tasks.md`: a graph table, then one body per task.

## Sizing — fewer and larger

There is no driver behind this. **Every task is a fresh agent that re-reads the artifacts and rebuilds its model of the system before its first edit.** That ramp-up is the expensive part, and many small tasks pay it repeatedly and throw the accumulated reasoning away at each boundary.

1. Default to **fewer, larger** tasks. A task is a vertical slice — implementation, wiring, and its assigned cases — delivered in one run.
2. Split only at a real boundary:
   - **Contract:** something must exist before its consumers can build on it.
   - **Disjoint files:** two slices touch different files and could run in parallel.
   - **Domain:** different deliverables — source, prompt assets, documentation.
3. **File count is never a reason to split.** A task spanning twenty files is healthy when they form one coherent slice.
4. Cases live in the task that implements the behaviour they verify. **Never a task that only writes tests.**

A typical feature lands at three to nine tasks. Twelve usually means slices that belong together.

## The graph

The table owns topology; each body owns its own state. One place to read the graph, one task touched when marking one done.

```markdown
| # | Title | Domain | Complexity | Depends on | Cases |
|---|---|---|---|---|---|
| T1 | Types and tolerant parse | source | medium | — | UT-01…UT-15 |
| T2 | Phase derivation | source | medium | T1 | UT-16…UT-30, UT-65 |
```

- `Depends on` is `—` or a comma-separated list. **An edge means the dependency must finish first**, and nothing else.
- `Cases` takes ids and ranges: `UT-01…UT-15`, `UT-04, IT-02`. A range is inclusive and single-prefix.
- **Complexity rates regression risk, not size**, and is never a reason to split: `low` (well-trodden), `medium` (new interfaces), `high` (new subsystem or concurrency), `critical` (cross-cutting, broad blast radius).
- No cycles. No dependency on a task that is not in the table.

## Each body

Read `references/task-template.md`. Every body carries: what the slice delivers, numbered requirements in MUST terms, subtasks describing *what* rather than *how*, the files it touches, its assigned case ids, and its success criteria.

The checkbox is the state:

```markdown
## T1 — Types and tolerant parse

- [ ] T1 — Types and tolerant parse
```

## Assignment is a gate

**Every id in `tests.md` belongs to exactly one task.** No orphans, no duplicates.

```bash
node .lumem/bin/lumem-spec.mjs lint docs/features/<slug> --phase tasks
```

If a case fits no task, **the breakdown is missing a slice** — fix the graph rather than dropping the case. If a case fits two, the boundary between them is wrong.

A task owning no cases is reported at severity info, not as a gate. That is correct for prompt assets and documentation, where the deliverable is reviewed rather than asserted — but say out loud that it is deliberate, in the body's own Tests section. An unexplained one is a slice nobody will verify.

## Present before generating

Show the breakdown — title, complexity, dependency chains, case counts — and get it approved before writing the bodies. A rejected graph after nine bodies are written wastes all nine.

## Handing off

Confirm the path and point at `lumem-execute-task`. The next action always comes from the same place:

```bash
node .lumem/bin/lumem-spec.mjs next docs/features/<slug>
```
