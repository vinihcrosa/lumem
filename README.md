# lumem

Memory for coding agents. Your agent learns what your project is and how you work, and remembers it in the next session.

It attaches to the agent you already use — Claude Code, Codex — through their own skills and hooks. It does not replace your agent, wrap it, or add a pipeline.

```bash
npx lumem init
npx lumem install
```

That is the whole setup. From then on the agent reads accumulated knowledge at session start and records new knowledge when the session ends.

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

**2. Capture — during the session.** `UserPromptSubmit` and `PostToolUse` hooks append raw signals to a session journal: files touched, a command that failed and later passed, a prompt that looks like a correction. Appends only — deterministic, no model call, p95 under 40 ms.

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

Every writing command takes `--dry-run` and shows the diff without touching anything. Every reading command takes `--json`.

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
