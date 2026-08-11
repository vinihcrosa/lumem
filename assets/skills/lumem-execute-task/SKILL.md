---
name: lumem-execute-task
description: Executes one task from a feature's graph end to end — reads the whole artifact set, resolves contradictions by a fixed precedence order without pausing, implements, verifies, and records what it decided. Use when a task file names work to do. Do not use for authoring specs (lumem-prd, lumem-tdd, lumem-tasks) or for coding with no task behind it.
---

# lumem-execute-task

One task, start to finish, without asking a question.

## Which task

```bash
node .lumem/bin/lumem-spec.mjs next docs/features/<slug>
```

`phase=execute action=execute-task target=T4` names it. Nothing else selects a task — not the lowest number you remember, not the one you were working on last session.

## Read the whole set, not the task

**A task body is a paraphrase, and paraphrases drift.** Before the first edit, read every artifact in the feature directory: `prd.md`, `tdd.md`, `tests.md`, `decisions.md`, `context.md`, `questions.md`, and every ADR the feature produced.

The failure this prevents is specific and it has happened: a task implemented from its own body while the canonical definition of the deliverable sat unread in the same directory, then passed several review rounds that only ever checked engineering quality.

Read `decisions.md` in full. It holds what was already settled, including cuts — proposing something the prune removed is worse than proposing nothing.

## Never pause

This runs inside a loop. Pausing breaks it.

- **Never ask a question, present a menu, or wait for confirmation.**
- **Never stop because the sources disagree.** Resolve it, record the choice in one line, continue.
- Ambiguity is a decision to make, not a reason to halt.
- Work that is genuinely out of scope becomes a follow-up note, not a silent expansion.

The one exception: a **missing or unreadable file that the task depends on** is infrastructure, not ambiguity. Stop and report the exact path.

## When sources disagree

Highest wins. Record the pick; continue.

1. **An assigned case in `tests.md`** beats any paraphrase of the same fact in the task body.
2. **A machine-checkable constraint in `tdd.md`** — a type, an enumerated state, a numbered invariant — beats prose in the same file.
3. **A requirement in `prd.md`** beats design prose for facts the requirements own.
4. **An ADR** beats informal notes.
5. Among remaining ties, prefer the reading that satisfies the most assigned cases and stays implementable against the winning types.
6. **A task-body paraphrase never outranks any of them.** Implementing the paraphrase against a higher rung is the error.

**The existing code is never the contract.** If the runtime cannot express what the resolved contract requires, extend it within scope; if that is genuinely out of scope, implement the closest faithful thing and record the gap. Never reshape the deliverable to fit what the code happens to support today and call it done.

## Build the checklist first

Extract, and print before starting:

- every deliverable and success criterion from the body
- one line per assigned case id, implemented as `tests.md` specifies it — **the ids are the deliverable, not a suggestion**
- every conflict resolved in the step above, so the chosen reading stays visible while you work
- the concrete signal that proves the task is not finished yet

Then use it as a gate. Nothing moves to verification until every line is addressed.

## Verify before claiming

Use `lumem-verify`. It is not optional and not conditional on how confident you feel.

Check the finished work field by field against the artifacts — not against the task's paraphrase of them. **A mismatch against the resolved contract fails the task**: fix the work, then re-verify. Do not reinterpret the contract to match what you built.

## Record, then commit

In this order:

1. Fill in the body's **Completion notes**: evidence with real output, every conflict resolved and how, anything done outside the declared files, defects the process caught, follow-ups named as such.
2. Tick the subtasks that are genuinely done, and the task's own checkbox.
3. Commit — one commit per task, and never push.

Do not edit the graph table during ordinary completion. It owns topology, not status.

## The one thing worth repeating

The reason this skill reads six artifacts before touching a file is that **the cheapest bug to fix is the one you do not write.** Every minute spent finding out what was already decided is a review round you do not spend converging on it later.
