# 001 — Docs and ADR contract

**Status:** in discussion
**Started:** 2026-08-08

## What this is

The first slice of `docs/`: a contract for durable project documentation that is navigated on demand rather than injected wholesale, with ADRs as its first real artifact.

It is deliberately not the whole `docs/` vision. It is the piece everything else waits on — modules ship ADR templates, the module-disagreement mechanism *is* an ADR, promoting a hidden pattern ends in an ADR, and spec-driven writes TDDs next to them.

## Why this one first

- **It has genuine ambiguity.** Numbering, supersedence semantics, when an ADR is born, what reaches the injected context — none of these have obvious answers, which is what makes it worth interrogating.
- **Everything else depends on it.** No other piece of the framework proceeds cleanly until documents have a home and a shape.
- **It is bounded.** Format, generated index, supersedence rules, lint extension. Not an open-ended platform.
- **The machinery already exists and is tested.** Managed blocks for the generated index, the manifest for installing templates, `lumem memory lint` for the checks.
- **The result is felt within a week.** Either `docs/adr/` holds things worth reading, or it does not.

## The wider frame this sits in

lumem is a framework for working with AI on code — opinionated on purpose, built for one team rather than for a market. Memory is the piece that exists today; documentation is the piece being defined here. A core (memory, documentation, spec-driven, ADRs) plus stackable modules (`backend`, then `backend-dotnet`) that ship rules, procedures and lenses for a domain.

## The problem being solved

Documentation rots. Not because writing is hard — because **nobody notices the document should exist**. The agent watching the session is uniquely placed to notice: it sees decisions being made, patterns repeating, and prose drifting away from the code it describes.

So the target is not "generate documentation". It is:

1. Regenerate what is derivable, so it cannot rot.
2. Draft what is observable, for a human to confirm.
3. **Notice what is missing and ask** — the part no generator can do, and the only path to knowledge that exists solely in someone's head.

## Meta: this folder is also an experiment

This feature is the guinea pig for lumem's own spec-driven process. The interrogation happens by hand, in `questions.md`, before anything is written. Afterwards the useful part gets distilled into a skill.

The measurement that matters: **which questions actually changed the design.** A question that changed nothing is a question the future skill should not ask.
