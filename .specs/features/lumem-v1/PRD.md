# PRD — `lumem` V1

> **Name.** `lumem` — the binary, the `.lumem/` directory and the namespace of the managed blocks. npm package under its own scope (see §13.1).

**Status:** Draft
**Author:** —
**Date:** 2026-08-07

---

## 1. Summary

`lumem` is a memory and self-learning layer for coding agents, shipped as a Node/TypeScript CLI. It attaches to existing harnesses (Claude Code, Codex) through **skills, hooks and agents**, without replacing the agent runtime.

The goal: the agent accumulates durable knowledge about the project and about the dev's preferences **without anyone having to ask**, and uses that knowledge in the sessions that follow.

**What it is not:** a pipeline orchestrator, a skill store, a server, a SaaS product. It is an installer plus a memory contract.

---

## 2. Problem

Every agent session starts from zero. What gets lost between sessions:

- **Decisions and the reasoning behind them.** "We don't use an ORM here because X." The agent proposes an ORM again the following week.
- **User corrections.** You correct the same code pattern five times. None of it persists.
- **Dead ends.** The agent tries an approach, finds out it doesn't work, and tries it again in another session.
- **Personal preferences.** Commit style, tolerance for comments, how you like it to answer you.

Current solutions fail in two opposite directions:

- Hand-written `CLAUDE.md` / `AGENTS.md` — they work, but they demand manual discipline and age badly.
- The tools that solve this ship bolted to an entire orchestrator (Compozy, workflow harnesses). You adopt the memory together with a pipeline you may not want.

**The gap:** there is no thin, portable, harness-agnostic memory layer.

---

## 3. Target audience

| Phase | User | Need |
|---|---|---|
| V1 (internal) | Author + small team | Standardize conventions across repos; stop re-explaining context |
| Post-V1 (public) | Solo dev using 1–2 CLI agents | Memory without adopting an orchestrator |

V1 optimizes for the first. Decisions that block the second should be avoided, but they don't have to be solved now.

---

## 4. Design principles

Order matters: on conflict, the one above wins.

1. **Fail-open.** If the memory layer breaks, the agent keeps working normally. A hook that hangs is worse than no memory at all.
2. **Markdown is the database.** No SQLite, no vector DB, no daemon in V1. Files that are readable, versionable, hand-editable, inspectable with `cat`.
3. **Capture is cheap, consolidation is expensive.** Recording a signal is an append to a file, deterministic, no LLM. Turning a signal into a durable fact uses an LLM and is *gated*.
4. **Context is a budget, not a warehouse.** Memory that grows without limit makes the agent worse. Every injected piece of content has a hard ceiling.
5. **An adapter is data, not code.** Supporting a new harness = adding a declarative descriptor, not writing a `switch`.
6. **Never overwrite what belongs to the user.** Shared files get a delimited managed block, never a full rewrite.
7. **Local-first.** Nothing leaves the machine. Zero network at runtime.

---

## 5. Memory model

### 5.1 Types

Four types, each with its own rule for writing, retention and scope:

| Type | Content | Scope | Versioned? |
|---|---|---|---|
| `project` | Architecture, conventions, decisions and their why, repo traps | Project | Yes (committed) |
| `preference` | Dev preferences: style, tone, tolerances | Global | No |
| `correction` | Explicit user corrections to the agent — the self-learn signal | Project + global | Project yes |
| `session` | Raw journal of the current session; raw material for consolidation | Project | No (gitignored) |

### 5.2 On-disk layout

```
~/.lumem/                          # global scope
  memory/
    preference.md
    correction.md
  config.json

<repo>/.lumem/                     # project scope
  memory/
    project.md                     # committed
    correction.md                  # committed
  local/                           # gitignored
    sessions/2026-08-07T14-22-Z.jsonl
    state.json
  lumem.config.json                # committed
  .gitignore                       # generated automatically, ignores local/
```

**Decision:** project memory is committed by default. It is what makes the tool useful for a team — the knowledge becomes a shared artifact reviewable in a PR. The session journal is never committed (noise + risk of leaking data).

**Accepted risk:** two devs consolidating on the same day produce a merge conflict in `project.md`. V1 mitigation: the file is structured as short, independent bullets that resolve conflicts trivially. Future mitigation: one file per fact.

### 5.3 Fact format

Every durable memory entry carries provenance:

```markdown
- [2026-08-07] Auth uses cookie sessions, not JWT. JWT was evaluated and
  dropped because of the immediate-revocation requirement.
  <!-- src:sess_a1b2 conf:high -->
```

Fields: date, body, originating session, confidence. Provenance is what makes auditing and expiring possible.

### 5.4 Anti-junk rules

This is the part that decides whether the product works or turns into noise. These are rules of the consolidation prompt, not of the code:

- **Don't duplicate the repo.** If it's in the code, the git log, the README or the spec, it doesn't go into memory. Memory holds what would otherwise be lost.
- **A fact has to be falsifiable.** "The user prefers clean code" is junk. "The user rejects comments that restate the function name" is a fact.
- **No speculation.** Only what was observed in this session.
- **Prefer removing to accumulating.** Consolidation is allowed to delete. A fact contradicted by new evidence is replaced, not stacked.

### 5.5 Budget and compaction

| File | Soft limit | Action when exceeded |
|---|---|---|
| `project.md` | 150 lines / 12 KB | Flagged for compaction on the next consolidation |
| `correction.md` | 100 lines / 8 KB | Same |
| `preference.md` | 60 lines / 4 KB | Same |
| Total context injection | 4 KB (configurable) | Truncated by priority |

Compaction preserves active risks, decisions and recent corrections; it cuts repetition and whatever the code has already absorbed.

---

## 6. Lifecycle

Three stages. Only the third costs tokens.

### Stage 1 — Injection (session start)

**Trigger:** the `SessionStart` hook where one exists; otherwise, an instruction in the skill.
**Action:** reads memory from the applicable scopes, assembles a block within budget, injects it as additional context.
**Cost:** a file read. No LLM.

### Stage 2 — Capture (during the session)

**Trigger:** the `UserPromptSubmit` and `PostToolUse` hooks, plus explicit writes via the skill.
**Action:** appends a raw signal to `local/sessions/<id>.jsonl`. Signals:

- files touched
- a command that failed and then passed (indicates a trap learned)
- a user prompt matching the correction heuristic ("na verdade", "não, faz", "sempre que", "nunca")
- an explicit call by the agent to the memory skill

**Cost:** an append. No LLM. It has to be fast — see NFR-2.

> **Known risk:** detecting a correction by string heuristic is fragile and produces false positives. In V1 the heuristic only *marks* the signal; whether it became a fact is decided by consolidation (which has an LLM). It never writes directly to durable memory.

### Stage 3 — Consolidation (session end, gated)

**Trigger:** the `SessionEnd` hook, or `lumem memory consolidate` by hand.
**Gate — runs only if all of these are true:**

- the session captured ≥ N signals (default 5)
- the session lasted ≥ N minutes (default 3)
- ≥ N hours have passed since the last consolidation in this project (default 6)
- there is no active consolidation lock for this project

**Action:** runs a consolidation prompt in a headless agent (`claude -p` / `codex exec`), passing the raw journal + the current memory. Gets back a patch: facts to add, to replace, to remove. Applies it.

**Cost:** one LLM call. The gate exists so that a 30-second session triggers nothing.

> **Decision:** consolidation runs in a separate, detached process. `SessionEnd` fires it and returns immediately. Blocking the user's session shutdown over memory violates principle 1.

---

## 7. Harness layer

### 7.1 The problem

Capability varies a lot between harnesses. Current survey:

| Capability | Claude Code | Codex |
|---|---|---|
| Hook events | 27+ | 5 (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`) |
| Hook types | command, prompt, agent, HTTP | command |
| Hook config | settings JSON | `hooks.json` or `[hooks]` in `config.toml` |
| Experimental flag | no | `[features] codex_hooks = true` (check on the target version) |
| Windows | yes | hooks disabled |
| Context in the hook | env vars (`CLAUDE_PROJECT_DIR`) + stdin | stdin JSON only; use the `cwd` field |
| Hook trust | — | the project must be trusted; the user runs `/hooks` to approve |
| Skills | `.claude/skills/` | `SKILL.md` with frontmatter; supports `scripts/`, `references/`, `assets/` |
| Project doc | `CLAUDE.md` | `AGENTS.md` (~32 KiB limit) |
| Home | `~/.claude` | `CODEX_HOME`, default `~/.codex` |

> This data has to be re-verified against the target versions before implementation; both tools move fast. Freeze the minimum supported version in `lumem.config.json`.

### 7.2 The solution: a declarative adapter

Each harness is a descriptor. Adding a harness = adding a file, not code.

```jsonc
{
  "id": "codex",
  "detect": [{ "type": "dir", "path": "~/.codex" }, { "type": "bin", "name": "codex" }],
  "paths": {
    "skills":  { "project": ".codex/skills",  "global": "~/.codex/skills" },
    "hooks":   { "project": ".codex/hooks.json" },
    "context": { "project": "AGENTS.md", "maxBytes": 32768 }
  },
  "capabilities": {
    "hooks.sessionStart": true,
    "hooks.sessionEnd": true,
    "hooks.postToolUse": true,
    "hooks.envVars": false,
    "hooks.requiresTrust": true,
    "hooks.featureFlag": "codex_hooks",
    "platform.windows": false
  },
  "contextInjection": "stdin",
  "eventMap": { "onStart": "SessionStart", "onEnd": "SessionEnd" }
}
```

### 7.3 Graceful degradation

If a capability is missing, the functionality doesn't disappear — it changes mechanism:

| Missing capability | Fallback |
|---|---|
| No `SessionStart` | Injection becomes an instruction in the skill ("read the memory before acting") |
| No `SessionEnd` | Consolidation becomes manual (`lumem memory consolidate`) + a cron suggestion |
| No hooks (Windows/Codex) | Skill-only mode: everything works, with less automatic capture |
| No env vars | Resolve the project from the `cwd` in the stdin payload |

`lumem doctor` reports which mode each harness is operating in. The user never finds out by accident that they are in degraded mode.

---

## 8. Functional requirements

### 8.1 CLI

| ID | Command | Description |
|---|---|---|
| FR-1 | `lumem init` | Detects harnesses, asks what to install, creates `.lumem/`, writes config and lockfile |
| FR-2 | `lumem install [--harness <id>] [--global]` | Installs skills, hooks and agents into the selected harnesses |
| FR-3 | `lumem sync` | Reconciles on-disk state with the manifest; updates whatever changed version |
| FR-4 | `lumem uninstall [--harness <id>]` | Removes everything it installed; restores managed blocks; does **not** delete memory without `--purge` |
| FR-5 | `lumem status` | Shows what is installed, where, which version, from which source |
| FR-6 | `lumem doctor` | Diagnoses: harness detected, capabilities, operating mode, untrusted hooks, drift between lockfile and disk |
| FR-7 | `lumem memory list\|show\|search <q>` | Human reading of memory |
| FR-8 | `lumem memory add\|edit\|forget <id>` | Manual writing and removal |
| FR-9 | `lumem memory consolidate [--force]` | Triggers consolidation by hand, skipping the gate with `--force` |
| FR-10 | `--dry-run` | Available on every command that writes. Shows the diff, applies nothing |
| FR-11 | `--json` | Structured output on every read command |

### 8.2 Installation

| ID | Requirement |
|---|---|
| FR-12 | The manifest declares every installable artifact (id, type, version, hash, destination) |
| FR-13 | The lockfile (`lumem-lock.json`) records what was installed, where, with which hash, and when |
| FR-14 | Installation is idempotent: running it N times produces the same state |
| FR-15 | Drift detection: if the user edited a managed file, `sync` warns and does not overwrite without `--force` |
| FR-16 | Shared files (`CLAUDE.md`, `AGENTS.md`, `hooks.json`) get a managed block with `<!-- lumem:start -->` / `<!-- lumem:end -->` markers; content outside the markers is never touched |
| FR-17 | A timestamped backup of every pre-existing file before the first write |
| FR-18 | Symlink mode (default) and `--copy` |
| FR-19 | Installation at project scope (default) or global (`--global`) |
| FR-20 | When installing hooks on Codex, the post-install step explicitly tells the user to run `/hooks` to trust them, and `doctor` checks whether they are still untrusted |

### 8.3 Memory

| ID | Requirement |
|---|---|
| FR-21 | Injects relevant memory at session start, respecting a configurable budget |
| FR-22 | Captures signals during the session with no LLM call |
| FR-23 | Consolidates signals into durable facts via an LLM, respecting the gate |
| FR-24 | Consolidation never blocks session shutdown |
| FR-25 | Every durable fact carries provenance (date, session, confidence) |
| FR-26 | Automatic compaction when a file exceeds its soft limit |
| FR-27 | Scans content before persisting and refuses to write apparent secrets (keys, tokens, `.env`) |
| FR-28 | `.lumem/local/` is added to `.gitignore` automatically |

### 8.4 Skills and agents delivered

| ID | Artifact | Function |
|---|---|---|
| FR-29 | skill `lumem-memory` | The memory read/write contract for the agent during the session |
| FR-30 | skill `lumem-consolidate` | Consolidation prompt: raw journal → fact patch. Includes the anti-junk rules from §5.4 |
| FR-31 | agent `lumem-consolidator` | Definition of the headless agent that runs consolidation, with a cheap runtime by default |
| FR-32 | hooks | Injection, capture and consolidation-trigger scripts, per harness |

---

## 9. Non-functional requirements

| ID | Requirement | Criterion |
|---|---|---|
| NFR-1 | **Fail-open** | Every hook catches exceptions, always exits with code 0, has a timeout. A failure becomes a log in `local/`, never a user-visible error nor a blocked session |
| NFR-2 | **Hook latency** | p95 < 150 ms for capture hooks. A slow hook makes the agent look broken |
| NFR-3 | **Zero network at runtime** | The CLI only touches the network in `install`/`sync` to fetch the package. Memory never leaves the machine |
| NFR-4 | **Zero-install** | `npx lumem init` works with no prior installation |
| NFR-5 | **Runtime** | Node ≥ 20, TypeScript, ESM. Zero native dependencies |
| NFR-6 | **Bundle** | The hook entrypoint is bundled into a single file, to minimize cold start. The hook **never** invokes `npx` |
| NFR-7 | **Reversibility** | `uninstall` restores the previous state of every file it touched |
| NFR-8 | **Privacy** | No telemetry in V1. If it ever exists, explicit opt-in |
| NFR-9 | **Portability** | macOS and Linux in V1. Windows: the CLI works, hooks degrade to skill-only |
| NFR-10 | **Observability** | Structured log in `.lumem/local/lumem.log`, with rotation |

---

## 10. Out of scope for V1

Recorded so it doesn't turn into creep:

- Generating repository-specific skills (the Hermes Agent-style behavior) — **V2**
- Harnesses beyond Claude Code and Codex — the adapter architecture prepares for it, V1 does not deliver it
- Syncing memory across machines or team members via a server (git is enough)
- Semantic search / embeddings — grep over markdown is enough at this scale
- Web UI, dashboard, marketplace
- Task orchestration, multi-agent execution
- Hook support on Windows

---

## 11. Success metrics

Internal use, V1. Targets deliberately low — this is validation, not growth.

| Metric | Target |
|---|---|
| Clean install in a new repo | < 2 min, no manual editing |
| Agent sessions broken by the tool | **zero** — the most important acceptance criterion |
| Durable facts per week in an active repo | 5–15 (below that it isn't capturing; above that it's noise) |
| Useful-fact rate | > 60% of entries survive a manual review without being deleted |
| Context re-explanation | Noticeable reduction reported by the team after 2 weeks |

The fourth metric is the one that matters. If you open `project.md` and most of it is obvious or wrong, the consolidation prompt is bad — and that is where the product lives.

---

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| A hook breaks the agent session | Fatal for adoption | NFR-1. Fault injection tested on every hook |
| Memory turns into noise and degrades the agent | Fatal for the value | Hard budget, compaction, anti-junk rules, easy manual review |
| Codex changes the hook format | Rework | The declarative adapter isolates it; freeze the minimum version; `doctor` detects incompatibility |
| Consolidation costs a lot in tokens | Friction | Aggressive gate, cheap runtime by default, `--dry-run` shows the cost |
| A secret leaks into a committed file | Serious | FR-27 + project memory goes through a PR before merging |
| Merge conflict in `project.md` | Annoying | Short independent bullets; future: one file per fact |
| False positive in correction detection | Noise | The heuristic only marks; the LLM decides; never a direct write |
| Node cold start in a hook | The agent feels slow | NFR-6; measure early; if it doesn't fit, evaluate a compiled binary |

---

## 13. Open decisions

They need an answer before or during implementation:

1. **Publishing on npm.** Name settled: `lumem`. Still to confirm whether `lumem` is free on the registry. If it isn't, publish as `@<user>/lumem` and declare `"bin": { "lumem": "./dist/cli.js" }` — the binary the user calls stays `lumem` regardless of the package name.
2. **Project memory committed by default?** The document assumes yes. If the team finds it noisy in PRs, the alternative is gitignored with opt-in — but then you lose the sharing, which is half the value for a team.
3. **Consolidation runtime.** Always the harness in use, or a fixed cheap model, configurable? Fixed is more predictable in cost; using the harness avoids configuring an extra credential.
4. **On what to do when both harnesses are installed in the same repo:** memory shared between them (likely — it's the same project) or segregated per harness?
5. **Minimum supported version** of Claude Code and Codex to freeze.

---

## 14. Milestones

| Milestone | Delivers | Exit criterion |
|---|---|---|
| M0 — Skeleton | TS CLI, harness detection, `doctor`, `status` | `npx lumem doctor` correctly identifies both harnesses |
| M1 — Installer | Manifest, lockfile, managed blocks, `install`/`uninstall`/`--dry-run` | Installs and uninstalls leaving no residue and touching no user content |
| M2 — Manual memory | File format, `memory *` commands, injection via skill | Agent reads and uses memory; writing is still manual |
| M3 — Capture | Signal hooks on both harnesses, session journal | Signals show up in the journal; zero broken sessions over a week of use |
| M4 — Consolidation | Consolidation skill + agent, gate, compaction | Useful facts appear on their own after real use |
| M5 — Hardening | Fail-open tested, secret scrub, docs, README | Ready to make the repository public |

M0–M2 deliver internal value on their own. If the project dies at M2, you still got a conventions installer — which was the original pain.

---

## 15. Appendix — sketch of the repository structure

```
src/
  cli/              # commands, parsing, output
  core/
    memory/         # format, reading, writing, compaction, budget
    capture/        # signal normalization, session journal
    consolidate/    # gate, trigger, patch application
    install/        # manifest, lockfile, managed blocks, backup
  adapters/
    claude-code.json
    codex.json
    schema.ts       # descriptor validation
  hooks/            # entrypoints bundled per event
assets/
  skills/
    lumem-memory/SKILL.md
    lumem-consolidate/SKILL.md
  agents/
    lumem-consolidator/
```

The boundary that matters: **`core/` does not know that Claude Code or Codex exist.** If it does, supporting a new harness stops being data and becomes code — and principle 5 dies.
