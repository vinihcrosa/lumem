# lumem

[![CI](https://github.com/vinihcrosa/lumem/actions/workflows/ci.yml/badge.svg)](https://github.com/vinihcrosa/lumem/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@vinihcrosa/lumem.svg)](https://www.npmjs.com/package/@vinihcrosa/lumem)

Memory for coding agents. Your agent learns what your project is and how you work, and remembers it in the next session.

It attaches to the agent you already use — Claude Code, Codex — through their own skills and hooks. It does not replace your agent, wrap it, or add a pipeline.

```bash
npx @vinihcrosa/lumem init
npx @vinihcrosa/lumem install
```

Published under a scope because npm rejects the bare name `lumem` as too close to `mem`; the command it installs is still `lumem`. That is the whole setup. From then on the agent reads accumulated knowledge at session start and records new knowledge when the session ends.

---

## The problem

Every session starts from zero. What gets lost between them:

- **Decisions and their reasons.** "We don't use an ORM here because X." Next week the agent proposes an ORM again.
- **Your corrections.** You fix the same pattern five times and none of it sticks.
- **Dead ends.** The agent tries an approach, learns it doesn't work, and tries it again in a fresh session.
- **Your preferences.** Commit style, comment tolerance, how you want to be answered.

Hand-written `CLAUDE.md` / `AGENTS.md` files work, but only while someone keeps writing them, and they age badly. The tools that automate this ship an entire orchestrator with it.

lumem is the thin version: an installer and a memory contract, nothing else.

---

## How it works

Three stages. Only the last one costs tokens.

**1. Injection — session start.** A `SessionStart` hook reads your memory files and prints a block into the agent's context. File reads only, no model call. Hard budget (4 KB by default) so memory can never crowd out your actual work.

**2. Capture — during the session.** `UserPromptSubmit`, `PostToolUse` and `PostToolUseFailure` hooks append raw signals to a session journal: files touched, a command that failed and later passed, a prompt that looks like a correction. Appends only — deterministic, no model call, p95 under 40 ms.

The failure event matters more than it looks: Claude Code fires `PostToolUse` only when a call *succeeds*, so without subscribing to its counterpart a tool that never sees a failure can never notice a recovery — and a command that failed and then passed is the richest thing a session produces.

**3. Consolidation — session end, gated.** A `SessionEnd` hook spawns a detached process that asks a cheap model to turn the raw journal into durable facts. It only runs when the session was substantial: at least 5 signals, at least 3 minutes long, at least 6 hours since the last run, and no consolidation already in flight. A 30-second session never triggers a model call.

The hook that spawns it returns immediately. Ending your session never waits on memory.

---

## What memory looks like

Plain Markdown you can read, edit, and review in a pull request:

```markdown
- [2026-08-07] Auth uses session cookies, not JWT. JWT was evaluated and
  dropped because revocation had to take effect immediately.
  <!-- src:sess_a1b2 conf:high -->
```

```
<repo>/.lumem/
  memory/
    project.md          # architecture, conventions, decisions — committed
    correction.md       # what you corrected the agent about — committed
  local/                # gitignored: session journals, logs, backups
  lumem.config.json

~/.lumem/memory/
  preference.md         # how you work, across every repo
  correction.md
```

Project memory is committed on purpose. That is what makes it useful to a team — knowledge becomes a reviewable artifact instead of living in one person's session history. Session journals are never committed.

### What does not go in

This is the part that decides whether the tool helps or just adds noise. The consolidation prompt enforces:

- **No repeating the repo.** If it is in the code, the README, or the git log, it is not memory. Memory holds what would otherwise be lost.
- **Facts must be falsifiable.** "Prefers clean code" is noise. "Rejects comments that restate the function name" is a fact.
- **No speculation.** Only what the session actually showed.
- **Prefer removing to accumulating.** A fact contradicted by new evidence gets replaced, not stacked.

Every file has a soft limit. Past it, the next consolidation compacts: active risks, decisions with their reasons, and recent corrections survive; repetition and anything the code has since absorbed gets cut.

---

## Commands

| Command | What it does |
|---|---|
| `lumem init` | Create `.lumem/` with config, lockfile, and gitignore |
| `lumem install` | Install skills and hooks into your harnesses |
| `lumem sync` | Reconcile installed files with the manifest; report local drift |
| `lumem uninstall` | Remove everything it installed; memory survives without `--purge` |
| `lumem status` | What is installed, where, which version |
| `lumem doctor` | Detected harnesses, capabilities, operating mode, drift, version issues |
| `lumem memory list \| show \| search` | Read memory |
| `lumem memory add \| edit \| forget` | Write memory by hand |
| `lumem memory consolidate` | Run consolidation now |
| `lumem memory lint` | Flag contradictions, stale facts and dead references |
| `lumem adr new` | Record an architectural decision under `docs/adr/` |
| `lumem adr lint` | Check the supersedence chain for broken or circular links |

The spec-driven checks ship as a copied bundle rather than as CLI subcommands, so no repository depends on a globally installed lumem being present at a matching version:

| Command | What it does |
|---|---|
| `node .lumem/bin/lumem-spec.mjs next <feature-dir>` | Print the one next action, derived from the files on disk |
| `node .lumem/bin/lumem-spec.mjs lint <feature-dir> --phase prd\|tdd\|tasks\|verdict` | Run that phase's gates |

Both are read-only, take `--json`, and exit `0` clean, `3` on findings, `1` on their own failure.

Every writing command takes `--dry-run` and shows the diff without touching anything. Every reading command takes `--json`.

---

## Spec-driven

Memory is what the agent knows. **Spec-driven is how work gets done with it**: a feature moves from an idea to verified code through named files under `docs/features/<NNN>-<slug>/`, with the questions asked before anything is written.

Six skills, one per artifact, installed alongside the memory ones:

```
Scope → Requirements → Prune → TDD → Tasks → Execute → Verify
```

Three properties are the point, and each exists because its absence cost something measurable:

- **Research before questions.** Anything the codebase, memory or an ADR answers is never a question. A question you could have looked up spends the author's attention and teaches them you did not read.
- **Pruning is a phase, not a virtue.** Each authoring phase ends by auditing what it accumulated and recording what it removed, in a `Cut, and why` section kept separate from Non-Goals. The first feature run this way accumulated for three rounds and subtracted in none; the round that finally cut a third of the surface was the most valuable in the run.
- **Every question records what its answer did.** `changed`, `accepted`, `rejected-framing`, `not-understood`. It is the only feedback loop that improves the question set — across three features the ratio has run 3-of-13, 2-of-10, 0-of-4, and that trend is itself the finding.

### Claims have to be earned

A declared test case that nobody wrote, and a verdict nobody ran, both stop a feature closing:

- `tests.md` is a numbered contract; every case is owned by exactly one task, and a case that no test **names** is reported by id.
- A verdict records the command that produced it and a fingerprint of the tree it ran against. lumem recomputes the fingerprint and refuses one that no longer matches.
- **lumem never runs your gate.** It reads files and hashes them, so nothing it installs can alter or break your tree. The fingerprint covers what a gate reads and excludes `docs/` — otherwise writing the verdict would invalidate the verdict.

The pipeline was built through itself, and the first thing the finished checks did was catch two cases the previous feature had declared and never implemented.

## Decisions

Memory holds what is true now. **Why it is that way belongs in `docs/adr/`** — one Markdown file per architectural decision, navigated on demand rather than loaded into every session.

```bash
lumem adr new "Session cookies over JWT" --area auth \
  --summary "Auth uses session cookies because revocation must be immediate."
```

The rules are deliberately few:

- **An ADR is never deleted.** A decision that stops being current gets superseded, not erased — a record of an act cannot un-happen.
- **The newest in a chain wins.** A new ADR names the one it replaces in `supersedes:`; status is derived from that, so no tool ever edits a file after it is written.
- **The frontmatter is the index.** Title, date, area and a one-line summary let an agent judge relevance without opening the body. There is no generated index to drift.

`lumem adr lint` guards the one property everything rests on — the chain being readable. A `supersedes:` pointing at nothing, or a cycle, exits 3. Everything else it finds is informational.

Once ADRs exist, one line in the injected block tells the agent where they live. Whether that is enough — whether an agent reliably reads a decision it was merely pointed at — is the open question this design is waiting on real use to answer.

---

## Your files stay yours

- Shared files (`.claude/settings.json`, `CLAUDE.md`, `AGENTS.md`) are **merged**, never replaced. lumem's hook entries are tagged and appended next to yours; your permissions, env, and your own hooks are untouched.
- Anything that existed before lumem wrote to it gets a timestamped backup under `.lumem/local/backups/`.
- `uninstall` removes exactly lumem's entries and leaves the rest — including edits you made after installing.
- If you edited a file lumem manages, `sync` says so and refuses to overwrite it. `--force` overwrites, keeping a backup.
- Installing twice produces the same state as installing once.

---

## Design rules

In priority order. When they conflict, the higher one wins.

1. **Fail open.** If the memory layer breaks, your agent keeps working. Every hook catches everything, has a deadline, and exits 0. A hook that hangs is worse than no memory at all.
2. **Markdown is the database.** No SQLite, no vector store, no daemon. Readable, versionable, editable by hand.
3. **Capture is cheap, consolidation is expensive.** Recording a signal is an append. Turning signals into facts costs a model call and is gated.
4. **Context is a budget, not a warehouse.** Memory that grows without limit makes the agent worse.
5. **Adapters are data.** Supporting a new harness means adding a JSON descriptor, not writing a `switch`. `core/` does not know Claude Code or Codex exist.
6. **Never overwrite what is yours.**
7. **Local first.** Nothing leaves your machine. Zero network at runtime.

---

## Requirements and support

- Node ≥ 20. No native dependencies.
- macOS and Linux. On Windows the CLI works and hooks fall back to skill-only mode.
- Claude Code ≥ 2.1.224, Codex ≥ 0.147.0.

Codex requires you to trust hooks before they run: open `/hooks` in the harness after installing. `lumem doctor` reminds you if they are still untrusted.

If a harness lacks a capability, the feature changes mechanism instead of disappearing — no `SessionStart` means injection moves into the skill, no `SessionEnd` means consolidation becomes manual. `lumem doctor` always tells you which mode you are in, so you never find out by accident.

---

## Privacy

No telemetry. Memory never leaves your machine. The CLI touches the network only during `install` and `sync`, to fetch the package itself — verified by an audit that runs the runtime commands with networking blocked.

Content is scanned before it is persisted and writes are refused when they look like a key, token, or `.env` contents. Do not rely on the scanner as your only defense: project memory is committed, so it goes through review like any other file.

---

## Status

V1, used internally. Working, tested, not yet battle-hardened across many repos. The measure that matters: open `project.md` after two weeks — if most of it is obvious or wrong, the consolidation prompt needs work, and that is where the product lives.

## License

MIT
