# Roadmap — lumem V1

Milestones from PRD §14. M0–M2 deliver internal value on their own (a conventions installer — the original pain).

| Milestone | Delivers | Exit criterion | Status |
|---|---|---|---|
| M0 — Skeleton | TS CLI, harness detection, `doctor`, `status` | `npx lumem doctor` correctly identifies both harnesses | ✅ Done |
| M1 — Installer | Manifest, lockfile, managed blocks, `install`/`uninstall`/`--dry-run` | Installs and uninstalls leaving no residue and touching no user content | ✅ Done |
| M2 — Manual memory | File format, `memory *` commands, injection via skill | Agent reads and uses memory; writing is still manual | ✅ Done |
| M3 — Capture | Signal hooks on both harnesses, session journal | Signals show up in the journal; zero broken sessions over a week of use | ✅ Done |
| M4 — Consolidation | Consolidation skill + agent, gate, compaction | Useful facts appear on their own after real use | ✅ Done |
| M5 — Hardening | Fail-open tested, secret scrub, docs, README | Ready to make the repository public | ✅ Done |

## Milestone → spec story mapping

| Milestone | Stories |
|---|---|
| M0 | P1.1 |
| M1 | P1.2 |
| M2 | P1.3 |
| M3 | P2.1 |
| M4 | P2.2 |
| M5 | P3.1 |

## Out of scope for V1 (anti-creep)

- Generating repo-specific skills (Hermes Agent-style behavior) — **V2**
- Harnesses beyond Claude Code and Codex
- Memory sync via server (git is enough)
- Semantic search / embeddings
- Web UI, dashboard, marketplace
- Task orchestration, multi-agent
- Hooks on Windows
