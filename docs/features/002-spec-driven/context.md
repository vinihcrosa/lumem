# 002 — Spec-driven core

**Status:** shipped 2026-08-11
**Started:** 2026-08-11

## What this is

The spec-driven pillar of lumem's core: the process that carries a feature from an idea to shipped code through named artifacts — requirements, design, tasks, execution, verification — with the questions asked before anything is written and the decisions recorded as ADRs.

Feature 001 delivered the place decisions live (`docs/adr/`). This feature delivers the process that produces them.

## Why this one now

- **The design input already exists.** Feature 001 was run by hand as the guinea pig for exactly this process, and `001/retrospective.md` measured which parts of it earned their cost. That measurement is the seed of this feature, and it goes stale as the memory of the run fades.
- **It is the pillar with the most external prior art.** Two working systems were read end to end before writing this (see below). Neither had to be invented from scratch, and neither fits as-is.
- **Everything after it depends on it.** Modules (`backend`, `backend-dotnet`) ship rules, templates and lenses *for* this process. Without the process there is nothing for a module to extend.

## The wider frame this sits in

lumem is a framework for working with AI on code — opinionated on purpose, built for one team rather than for a market. Memory shipped in V1. Documentation and ADRs shipped in 001. Spec-driven is the third core pillar, and the first one that produces work rather than describing it.

## The problem being solved

An agent that starts implementing before the requirements are pinned produces N implementations, where N is the number of agents that read the request. The industry answer is to write a spec; the failure mode is that the spec is written by the same agent that will implement it, in the same breath, so it records nothing that was not already assumed.

The target is therefore not "generate a spec". It is:

1. **Research before asking.** Anything the codebase, the memory or the ADRs can answer is never a question.
2. **Ask until the forks are resolved** — however many that takes — with the question shaped so answering is cheap.
3. **Pin concrete tokens, not prose.** A design the implementer can reinterpret is a design that will be reinterpreted.
4. **Verify against the spec, not against the implementation.** Evidence before claims.

## Prior art evaluated (references, not dependencies)

Both were read in full on 2026-08-11. Neither is imported, vendored, or ported — they are sources of mechanism, cited here so the reasoning behind this feature's shape is auditable.

| System | What it is | Read |
|---|---|---|
| **Compozy** `cy-*` skills | 14 skills, 7,228 lines, in `compozy/compozy` under `.agents/skills/`. PRD → TechSpec → Tasks → Execute → QA → Review, plus `docs/_memory/` (34 evidence-backed lessons, 11 standing directives, a spec-authoring playbook, a glossary) loaded by a preflight skill before any authoring. | full |
| **tlc-spec-driven** v3.3.0 | 3,822 lines. Specify → Design → Tasks → Execute, auto-sized by complexity, EARS acceptance criteria, deterministic Python validators, an always-on Verifier where author ≠ verifier, and a lessons layer gated on real verification signals. | full |

What each is strong at, and what neither has, is recorded in `decisions.md`. The short version: Compozy is strongest at research-before-questions, question shape, ADR content and design concreteness; tlc is strongest at auto-sizing, requirement precision, closure of ambiguity, and independent verification. Neither has a pruning step, neither resolves scope before asking anything else, and neither tracks which of its own questions changed the design — the three findings `001/retrospective.md` paid for.

## Meta: this folder runs the process it is defining

001 was the process's first run, executed by hand. 002 is its second, and the artifacts here are both the specification of the process and its own second data point.

The measurement carries over unchanged: **which questions actually changed the design.** A question that changed nothing is a question the skill should not ask. Round-by-round scoring goes in `retrospective.md` at the end, next to 001's three-of-thirteen.
