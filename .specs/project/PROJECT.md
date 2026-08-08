# lumem

## Vision

Memory and self-learning layer for coding agents, shipped as a Node/TypeScript CLI. It attaches to existing harnesses (Claude Code, Codex) through skills, hooks and agents — without replacing the agent runtime.

The agent accumulates durable knowledge about the project and about the dev's preferences **without anyone having to ask**, and uses that knowledge in the sessions that follow.

**What it is not:** a pipeline orchestrator, a skill store, a server, a SaaS product. It is an installer plus a memory contract.

## Problem

Every agent session starts from zero. What gets lost between sessions: decisions and the reasoning behind them, user corrections, dead ends already explored, personal preferences. Hand-written `CLAUDE.md`/`AGENTS.md` demand discipline and age badly; the tools that solve this ship bolted to entire orchestrators. There is no thin, portable, harness-agnostic memory layer.

## Audience

- **V1 (internal):** author + small team — standardize conventions across repos, stop re-explaining context.
- **Post-V1 (public):** solo dev with 1–2 CLI agents — memory without adopting an orchestrator.

## Design principles (order matters; on conflict, the one above wins)

1. **Fail-open.** Broken memory never breaks the agent.
2. **Markdown is the database.** No SQLite, vector DB or daemon in V1.
3. **Capture is cheap, consolidation is expensive.** Signal = deterministic append; durable fact = LLM gated.
4. **Context is a budget, not a warehouse.** Every injected piece of content has a hard ceiling.
5. **An adapter is data, not code.** New harness = new declarative descriptor.
6. **Never overwrite what belongs to the user.** Delimited managed blocks, never a full rewrite.
7. **Local-first.** Zero network at runtime.

## Non-negotiable architectural boundary

`core/` does not know that Claude Code or Codex exist. If it does, supporting a new harness becomes code and principle 5 dies.

## Documents

- Full PRD: [.specs/features/lumem-v1/PRD.md](../features/lumem-v1/PRD.md)
- V1 spec: [.specs/features/lumem-v1/spec.md](../features/lumem-v1/spec.md)
