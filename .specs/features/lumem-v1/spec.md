# lumem V1 — Specification

**Source:** [PRD.md](PRD.md) (Draft, 2026-08-07)
**Document scope:** all of V1 (milestones M0–M5). Stories organized by priority; each maps 1:1 to a roadmap milestone.
**ID vocabulary:** categories `HARN` (harness/adapters), `CLI` (commands), `INST` (installer), `MEM` (memory), `CAP` (capture), `CONS` (consolidation), `OPS` (non-functional).

## Problem Statement

Every coding-agent session starts from zero: decisions and their reasoning, user corrections, dead ends and personal preferences are lost between sessions. Today's alternatives either demand manual discipline (hand-written `CLAUDE.md`/`AGENTS.md`) or bolt memory to an entire orchestrator. What is missing is a thin, portable, harness-agnostic memory layer that captures durable knowledge automatically and re-injects it into the sessions that follow.

## Goals

- [ ] Clean install in a new repo in < 2 min, no manual editing
- [ ] **Zero** agent sessions broken by the tool (the most important acceptance criterion)
- [ ] 5–15 durable facts/week in an active repo (below = not capturing; above = noise)
- [ ] > 60% of facts survive a manual review without being deleted
- [ ] Noticeable reduction in context re-explanation reported by the team after 2 weeks

## Out of Scope

| Feature | Reason |
|---|---|
| Generating repo-specific skills (Hermes Agent-style) | V2; V1 validates only the memory |
| Harnesses beyond Claude Code and Codex | The adapter architecture prepares for it; V1 does not deliver it |
| Memory sync via server | Git is enough at this scale |
| Semantic search / embeddings | Grep over markdown is enough |
| Web UI, dashboard, marketplace | Outside the product thesis |
| Task orchestration / multi-agent | lumem is not an orchestrator |
| Hooks on Windows | The CLI works; hooks degrade to skill-only (OPS-08) |

## Assumed decisions (PRD §13 — defaults adopted, confirm with the author)

| # | Decision | Assumed default |
|---|---|---|
| 1 | npm name | Check `lumem` on the registry in M0; fallback `@<user>/lumem` with `"bin": {"lumem": ...}` |
| 2 | `project.md` committed by default? | **Yes** (PRD §5.2 default) |
| 3 | Consolidation runtime | The harness in use (`claude -p` / `codex exec`), cheap model by default, configurable in `lumem.config.json` |
| 4 | Two harnesses in the same repo | **Shared memory** (same project, same knowledge) |
| 5 | Minimum harness versions | Freeze in M0 while re-verifying the PRD §7.1 table; record in `lumem.config.json` |

Also recorded in [.specs/project/STATE.md](../../project/STATE.md). Changing any of them requires revising this spec.

---

## User Stories

### P1.1: Environment diagnosis (M0 — Skeleton) ⭐ MVP

**User Story**: As a dev, I want to run `npx lumem doctor` and see which harnesses exist on my machine, with which capabilities and in which operating mode, so I know what lumem can do before installing anything.

**Why P1**: It is the foundation of everything — declarative harness detection is the heart of principle 5 (an adapter is data). Without it, no other command knows where to operate. M0 exit criterion.

**Acceptance Criteria**:

1. WHEN `npx lumem doctor` runs on a machine with Claude Code and Codex installed THEN the system SHALL identify both via the descriptors' `detect` rules (`dir`, `bin`), listing each one's version, capabilities and operating mode
2. WHEN a harness is not present THEN the system SHALL report it as "not detected" and exit with code 0 (absence is not an error)
3. WHEN a capability is missing on the harness (e.g. no `SessionStart`) THEN `doctor` SHALL report the corresponding degraded mode and which fallback is active (PRD §7.3) — the user never discovers degraded mode by accident
4. WHEN Codex hooks are installed but not trusted THEN `doctor` SHALL point that out and instruct the user to run `/hooks`
5. WHEN `lumem status` runs before any installation THEN the system SHALL report "nothing installed" without an error
6. WHEN any read command receives `--json` THEN the system SHALL emit stable structured output
7. WHEN an adapter descriptor is invalid against the schema THEN the system SHALL reject it with a clear error naming the field, without crashing
8. WHEN a new harness is added as a valid JSON descriptor THEN `doctor` SHALL detect it with no change to `core/`

**Independent Test**: On a machine with both harnesses, `npx lumem doctor` lists both correctly; removing `~/.codex` from PATH/HOME makes Codex disappear from the report without an error.

---

### P1.2: Reversible installation (M1 — Installer) ⭐ MVP

**User Story**: As a dev, I want to install and uninstall lumem's skills, hooks and agents into my harnesses idempotently and reversibly, so I can adopt (or abandon) the tool with no risk to my files.

**Why P1**: Without a trustworthy installer there is no adoption. "Never overwrite what belongs to the user" (principle 6) is a precondition for trust. M1 exit criterion: installs and uninstalls with no residue and without touching user content.

**Acceptance Criteria**:

1. WHEN `lumem init` runs in a repo THEN the system SHALL detect harnesses, ask what to install, create `.lumem/` with `lumem.config.json`, `memory/`, `local/` and a `.gitignore` covering `local/`
2. WHEN `lumem install` runs N times in a row THEN the on-disk state after each run SHALL be identical (idempotency)
3. WHEN an artifact is installed THEN the manifest SHALL declare it (id, type, version, hash, destination) and the lockfile `lumem-lock.json` SHALL record what was installed, where, with which hash and when
4. WHEN the destination is a shared file (`CLAUDE.md`, `AGENTS.md`, `hooks.json`) THEN the system SHALL write only inside the `<!-- lumem:start -->` / `<!-- lumem:end -->` block and SHALL never touch content outside the markers
5. WHEN a pre-existing file is about to be modified for the first time THEN the system SHALL create a timestamped backup before the write
6. WHEN the user has edited a managed file (hash differs from the lockfile) and runs `sync` THEN the system SHALL warn about the drift and SHALL NOT overwrite without `--force`
7. WHEN `lumem uninstall` runs THEN the system SHALL remove everything it installed, restore the managed blocks to their previous state and SHALL preserve memory — deleting it requires an explicit `--purge`
8. WHEN any command that writes receives `--dry-run` THEN the system SHALL show the complete diff and SHALL NOT apply any write
9. WHEN the installation uses the default mode THEN artifacts SHALL be symlinks; with `--copy`, copies
10. WHEN `--global` is passed THEN the installation SHALL go to the harness's global scope (e.g. `~/.claude`, `~/.codex`); without the flag, project scope
11. WHEN hooks are installed on Codex THEN the post-install step SHALL explicitly instruct the user to run `/hooks` to trust them
12. WHEN the resulting AGENTS.md would exceed the harness limit (the descriptor's `maxBytes`, ~32 KiB on Codex) THEN the system SHALL truncate the managed block by priority and warn — never blow past the limit

**Independent Test**: `lumem init && lumem install` in a repo with a pre-existing `CLAUDE.md` containing user text; then `lumem uninstall`. The repo diff at the end = only `.lumem/` memory (if `--purge` was not used); user text byte-for-byte intact.

---

### P1.3: Manual memory with injection via skill (M2 — Manual memory) ⭐ MVP

**User Story**: As a dev, I want to write, list, search and delete facts by hand across the four memory types, and have that content injected at the start of the agent session within a budget, so the agent stops making me re-explain the project — even before automatic capture exists.

**Why P1**: It closes the minimum value loop: memory read and used by the agent. M0–M2 deliver internal value on their own (a conventions installer + manual memory). M2 exit criterion.

**Acceptance Criteria**:

1. WHEN `lumem memory add` writes a fact THEN the entry SHALL go to the file for the correct type/scope (PRD §5.1–5.2) and SHALL carry provenance: date, originating session (`manual` where applicable) and confidence
2. WHEN `lumem memory list|show|search <q>` runs THEN the system SHALL return human-readable output; with `--json`, structured output
3. WHEN `lumem memory forget <id>` runs THEN the entry SHALL be removed from the corresponding file
4. WHEN the agent session starts with the `SessionStart` hook available THEN the system SHALL assemble a block with memory from the applicable scopes (global + project) and inject it as additional context, with no LLM
5. WHEN the harness has no `SessionStart` THEN injection SHALL degrade to an instruction in the `lumem-memory` skill ("read the memory before acting")
6. WHEN the total memory content exceeds the injection budget (4 KB default, configurable) THEN the system SHALL truncate by priority, never blowing past the ceiling
7. WHEN the content to be persisted appears to contain a secret (key, token, `.env` content) THEN the system SHALL refuse the write and explain why
8. WHEN `.lumem/` is created THEN `local/` SHALL be gitignored automatically; `memory/project.md`, `memory/correction.md` and `lumem.config.json` SHALL be committable

**Independent Test**: Write 3 facts with `memory add`, open a Claude Code session in the repo and check that the agent cites the injected content; `memory search` finds the facts; an attempt to write a line with `AWS_SECRET_ACCESS_KEY=...` is refused.

---

### P2.1: Automatic signal capture (M3 — Capture)

**User Story**: As a dev, I want hooks to record raw session signals (files touched, commands that failed and then passed, prompts that look like corrections) into a local journal, with no LLM and without me noticing, so consolidation is fed real raw material.

**Why P2**: It is the "auto" in auto-learning, but it depends on P1.2 (hooks installed) and P1.3 (memory format). M3 exit criterion: signals in the journal, zero broken sessions in a week.

**Acceptance Criteria**:

1. WHEN a capture hook fires (`UserPromptSubmit`, `PostToolUse`) THEN the system SHALL append a raw signal to `local/sessions/<id>.jsonl` with no LLM call whatsoever
2. WHEN a command fails and then a variation of it passes THEN the system SHALL record a learned-trap signal
3. WHEN the user's prompt matches the correction heuristic ("na verdade", "não, faz", "sempre que", "nunca") THEN the system SHALL only **mark** the signal in the journal — it SHALL NOT write to durable memory (consolidation decides)
4. WHEN the agent invokes the `lumem-memory` skill explicitly THEN the write SHALL be recorded as a high-confidence signal
5. WHEN any hook throws an internal exception THEN the hook SHALL catch it, log it in `local/`, and exit with code 0 — the agent session carries on intact (fail-open)
6. WHEN capture hooks run THEN p95 latency SHALL be < 150 ms
7. WHEN the harness does not support hooks (Windows, Codex without the flag/trust) THEN the system SHALL operate in skill-only mode, capturing via the skill, and `doctor` SHALL report that mode
8. WHEN the hook receives context only via stdin (no env vars) THEN the system SHALL resolve the project from the payload's `cwd` field

**Independent Test**: A 10-minute session with edits and a command that fails and then passes; `cat .lumem/local/sessions/*.jsonl` shows the typed signals. Inject a deliberate exception into the hook: the agent session does not break and the failure shows up in `local/lumem.log`.

---

### P2.2: Gated consolidation (M4 — Consolidation)

**User Story**: As a dev, I want a headless agent to turn the raw journal into durable facts with provenance at the end of relevant sessions — adding, replacing and removing — so useful knowledge appears on its own, without becoming noise or burning tokens for nothing.

**Why P2**: It is where the product lives (key metric: >60% useful facts). It depends on P2.1 (journal) and P1.3 (memory format).

**Acceptance Criteria**:

1. WHEN `SessionEnd` fires and the gate is satisfied THEN the system SHALL start consolidation in a separate, detached process and return immediately — session shutdown SHALL never be blocked
2. WHEN any gate condition fails (signals < N, duration < N min, last consolidation < N h, active lock — defaults 5 / 3 min / 6 h) THEN the system SHALL NOT call an LLM
3. WHEN `lumem memory consolidate --force` runs THEN the system SHALL skip the gate (except the lock) and consolidate
4. WHEN consolidation runs THEN it SHALL use the `lumem-consolidator` headless agent (the harness in use, cheap runtime by default — assumed decision #3) with the prompt from the `lumem-consolidate` skill, including the anti-junk rules from PRD §5.4
5. WHEN the LLM returns the patch THEN the system SHALL apply additions, replacements and removals to the memory files; every added fact SHALL carry provenance (date, `src:sess_*`, `conf:*`)
6. WHEN a new fact contradicts an existing one THEN the existing one SHALL be replaced, not stacked
7. WHEN the patch contains an apparent secret THEN the system SHALL refuse to persist the affected entry and log the discard
8. WHEN a memory file exceeds its soft limit (PRD §5.5) THEN it SHALL be flagged and the next consolidation SHALL compact it: preserve active risks, decisions and recent corrections; cut repetition and whatever the code has already absorbed
9. WHEN a consolidation lock already exists for the project THEN the new attempt SHALL be skipped silently (log only)
10. WHEN the consolidation process fails or the patch is invalid/unparseable THEN durable memory SHALL stay intact (atomic application: all or nothing) and the failure SHALL go to the log
11. WHEN `consolidate --dry-run` runs THEN the system SHALL show the proposed patch without applying it

**Independent Test**: A real session with ≥5 signals and >3 min; close the session; within a few minutes `git diff .lumem/memory/project.md` shows new facts with provenance. A 30 s session: no LLM call happens (verifiable in the log).

---

### P3.1: Hardening (M5)

**User Story**: As a maintainer, I want fail-open proven by fault-injection tests, secret scrubbing validated, logs with rotation and complete docs, so I can make the repository public without embarrassment or risk.

**Why P3**: It adds no new capability — it raises the confidence in the existing ones to "public" level. It comes last because it hardens what M0–M4 built.

**Acceptance Criteria**:

1. WHEN the fault-injection suite runs against every hook (exception, timeout, full disk, malformed JSON on stdin) THEN no scenario SHALL break the agent session or exit with a code ≠ 0
2. WHEN runtime events occur THEN the system SHALL log structured output to `.lumem/local/lumem.log` with rotation
3. WHEN the CLI runs any command other than `install`/`sync` THEN no network access SHALL occur (verifiable in tests)
4. WHEN the repo is published THEN the README and docs SHALL cover installation, the memory model, degraded modes and uninstallation

**Independent Test**: Run the hook chaos suite in CI; audit network calls with the CLI in runtime mode; review the docs against the M5 checklist.

---

## Edge Cases

- WHEN both harnesses are installed in the same repo THEN project memory SHALL be shared between them (assumed decision #4) and the installation SHALL record artifacts per harness in the lockfile
- WHEN two devs consolidate on the same day and `project.md` conflicts on merge THEN the short, independent bullets SHALL keep the conflict trivial (risk accepted in PRD §5.2)
- WHEN two sessions end simultaneously in the same project THEN the lock SHALL guarantee at most one consolidation; the other is skipped
- WHEN `SessionEnd` does not exist on the harness THEN consolidation SHALL be manual (`lumem memory consolidate`) and the system SHALL suggest a cron
- WHEN the session journal is empty or absent THEN consolidation SHALL exit cleanly without calling an LLM
- WHEN `.lumem/` does not exist and a `memory *` command runs THEN the system SHALL point the user to run `lumem init` instead of creating implicit state
- WHEN a memory file contains malformed markdown or a corrupted provenance marker THEN reading SHALL degrade gracefully (skip the entry, log it) — never crash
- WHEN the hook runs in a repo that is not the configured project (unexpected cwd) THEN the signal SHALL be discarded with a log, not written into the wrong project
- WHEN the harness binary exists but its version is below the frozen minimum THEN `doctor` SHALL report the incompatibility and the operating mode SHALL degrade explicitly
- WHEN the user manually removes an installed artifact THEN `sync`/`doctor` SHALL report the drift between lockfile and disk
- WHEN the consolidation process is orphaned or exceeds its timeout THEN the lock SHALL expire (stale lock), allowing the next consolidation
- WHEN global memory (`~/.lumem`) does not exist but project memory does THEN injection SHALL work with the available scope alone

---

## Requirement Traceability

| Requirement ID | PRD | Story | Phase | Status |
|---|---|---|---|---|
| HARN-01 | §7.2 | P1.1 | Design | Verified |
| HARN-02 | §7.2 (schema) | P1.1 | Design | Verified |
| HARN-03 | §7.3 | P1.1 | Design | Verified |
| HARN-04 | FR-6, §7.3 | P1.1 | Design | Verified |
| CLI-01 | FR-1 | P1.2 | Design | Verified |
| CLI-02 | FR-2 | P1.2 | Design | Verified |
| CLI-03 | FR-3 | P1.2 | Design | Verified |
| CLI-04 | FR-4 | P1.2 | Design | Verified |
| CLI-05 | FR-5 | P1.1 | Design | Verified |
| CLI-06 | FR-6 | P1.1 | Design | Verified |
| CLI-07 | FR-7 | P1.3 | Design | Verified |
| CLI-08 | FR-8 | P1.3 | Design | Verified |
| CLI-09 | FR-9 | P2.2 | Design | Verified |
| CLI-10 | FR-10 | P1.2, P2.2 | Design | Verified |
| CLI-11 | FR-11 | P1.1, P1.3 | Design | Verified |
| INST-01 | FR-12 | P1.2 | Design | Verified |
| INST-02 | FR-13 | P1.2 | Design | Verified |
| INST-03 | FR-14 | P1.2 | Design | Verified |
| INST-04 | FR-15 | P1.2 | Design | Verified |
| INST-05 | FR-16 | P1.2 | Design | Verified |
| INST-06 | FR-17 | P1.2 | Design | Verified |
| INST-07 | FR-18 | P1.2 | Design | Verified |
| INST-08 | FR-19 | P1.2 | Design | Verified |
| INST-09 | FR-20 | P1.2 | Design | Verified |
| MEM-01 | §5.1–5.2 | P1.3 | Design | Verified |
| MEM-02 | FR-25, §5.3 | P1.3, P2.2 | Design | Verified |
| MEM-03 | FR-21, §5.5 | P1.3 | Design | Verified |
| MEM-04 | FR-26, §5.5 | P2.2 | Design | Verified |
| MEM-05 | FR-27 | P1.3, P2.2 | Design | Verified |
| MEM-06 | FR-28 | P1.3 | Design | Verified |
| MEM-07 | FR-29 | P1.3 | Design | Verified |
| CAP-01 | FR-22 | P2.1 | - | Verified |
| CAP-02 | §6 stage 2 | P2.1 | - | Verified |
| CAP-03 | §6 (heuristic only marks) | P2.1 | - | Verified |
| CAP-04 | NFR-2 | P2.1 | - | Verified |
| CONS-01 | FR-23, §6 gate | P2.2 | - | Verified |
| CONS-02 | FR-24 | P2.2 | - | Verified |
| CONS-03 | FR-30, §5.4 | P2.2 | - | Verified |
| CONS-04 | FR-31 | P2.2 | - | Verified |
| CONS-05 | §6 (lock) | P2.2 | - | Verified |
| CONS-06 | FR-32 | P2.1, P2.2 | - | Verified |
| OPS-01 | NFR-1 | P2.1, P3.1 | - | Verified |
| OPS-02 | NFR-3 | P3.1 | - | Verified |
| OPS-03 | NFR-4 | P1.1 | Design | Verified |
| OPS-04 | NFR-5 | P1.1 | Design | Verified |
| OPS-05 | NFR-6 | P2.1 | - | Verified |
| OPS-06 | NFR-7 | P1.2 | Design | Verified |
| OPS-07 | NFR-8 | P3.1 | - | Verified |
| OPS-08 | NFR-9 | P1.1, P2.1 | - | Verified |
| OPS-09 | NFR-10 | P3.1 | - | Verified |

**ID format:** `[CATEGORY]-[NUMBER]`. **Status:** Pending → In Design → In Tasks → Implementing → Verified.

**Coverage:** 50 requirements; 50 implemented and verified (T1–T48), 0 pending ✅; PRD coverage: FR-1..FR-32 and NFR-1..NFR-10 all mapped ✅

---

## Success Criteria

- [ ] `npx lumem doctor` correctly identifies both harnesses (M0 exit)
- [ ] Installs and uninstalls with no residue and without touching user content (M1 exit)
- [ ] The agent reads and uses the injected memory (M2 exit)
- [ ] Signals in the journal; zero broken sessions over a week of real use (M3 exit)
- [ ] Useful facts appear on their own after real use; >60% survive a manual review (M4 exit)
- [ ] Fault-injection suite green; zero network at runtime; docs ready for a public repo (M5 exit)
- [ ] Clean install in < 2 min; 5–15 durable facts/week in an active repo (PRD §11)
