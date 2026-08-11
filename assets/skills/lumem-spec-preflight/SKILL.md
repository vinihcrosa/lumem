---
name: lumem-spec-preflight
description: Loads what a spec phase needs to know and checks the draft it produced. Use before lumem-prd, lumem-tdd or lumem-tasks writes anything, and again before asking the author to approve what they wrote. Do not use to author an artifact — it never writes one.
---

# lumem-spec-preflight

Two jobs, and neither of them is writing.

1. **Before** an authoring skill runs: load the context that phase needs, and no more.
2. **After** it produces a draft: run the gate for that phase, before the author is asked to approve anything.

**This skill never authors an artifact.** If you find yourself writing `prd.md`, you are in the wrong skill.

## Where you are

Ask, rather than guessing:

```bash
node .lumem/bin/lumem-spec.mjs next docs/features/<slug>
```

One line comes back, e.g. `phase=design action=write-tdd`. That is the phase. It is derived from the files on disk every time, so it is never stale, and there is no state file to reconcile.

If the bundle is missing, say so once and carry on by reading the artifacts yourself — degraded, and the author should know it.

## Loading, before the phase runs

**Read the injected memory block first.** It was already placed in your context at session start. If it ends with a line like

```
<!-- lumem:truncated project=3 correction=1 preference=0 -->
```

then that many facts did not fit. Only then read `.lumem/memory/` for the rest. Loading the whole tree when the block already carried it spends context twice for one set of facts.

Then, by phase:

| Phase | Read |
|---|---|
| any | `docs/adr/` — list it, read the frontmatter of anything adjacent. A decision there outranks your instinct |
| requirements | `context.md`; the codebase around the request |
| design | `prd.md`, `decisions.md`; the codebase's existing architecture |
| tasks | `prd.md`, `tdd.md`, `tests.md`, `decisions.md` |
| execute | every artifact in the feature directory, not only the task |

Read `decisions.md` before every phase after the first. It holds what was already settled, and re-litigating a settled decision is worse than asking nothing.

## Checking, after the draft exists

```bash
node .lumem/bin/lumem-spec.mjs lint docs/features/<slug> --phase <prd|tdd|tasks>
```

Exit 0 means nothing was found. Exit 3 means something was, and the output separates `gate` from `info`:

- **A gate is not negotiable.** Fix the artifact. Never ask the author to approve past one, and never argue with it in prose — if the gate is wrong, that is a change to the checker, made deliberately, not an exception granted in passing.
- **An info finding is a note.** Say it out loud, once, and let the author decide.

Exit 1 means the command itself failed — a bad `--phase`, an unreadable path. That is your mistake, not a finding.

Run the gate **before** presenting the draft. A gate that runs after approval has already failed at its job.

## What you are watching for that no gate can see

The checks are structural. These are not, and they matter more:

- **A question that the codebase, memory or an ADR already answers.** Every one of those spends the author's attention on something you could have looked up. This is the most common defect in a spec conversation.
- **A concern the author has now raised twice**, in different words, across rounds. That is not an answer — it is a signal to stop adding and start cutting. Trigger the prune.
- **Scope that grew while nobody was watching.** Compare the artifact against what the slice exists to deliver, not against what would be nice.

## Handing off

Say which phase you are in, what you loaded, and what the gate said. Then hand to the authoring skill and stop. Do not narrate the machinery further — the author judges the artifact, not the process.
