---
name: lumem-memory
description: Durable project memory. Read it before proposing architecture or conventions; write to it when the user corrects you, states a preference, or settles a decision. Use when you need to know why the project is the way it is, or when something worth remembering just happened.
---

# lumem-memory

Memory that survives across sessions. Four kinds, each with its own scope:

| Type | Holds | Scope |
|---|---|---|
| `project` | Architecture, conventions, decisions **and their reasons**, repo pitfalls | this repo, committed |
| `correction` | Explicit corrections the user made to you | this repo, committed |
| `preference` | How this developer works: style, tone, tolerances | global, not committed |

## Reading

Run this before acting on anything architectural, and at the start of a session when no memory block was injected for you:

```bash
lumem memory context
```

It prints a budgeted block: corrections first, then project facts, then preferences. Treat it as established context about this repo — not as suggestions. If a fact contradicts what you were about to propose, the fact wins unless the user says otherwise.

## Architectural decisions

Memory holds what is true now. **Why it is that way lives in `docs/adr/`**, one file per decision, newest last.

Before proposing or changing architecture, list that folder and read the frontmatter of anything that looks relevant. Each file states its decision in the `title` and `summary`, so you can tell in one line whether it matters to you without opening the body.

A decision there outranks your instinct. If an ADR settled something and you are about to propose the opposite, say so explicitly and explain what changed — do not quietly contradict it.

An ADR is never deleted. When one is superseded, a newer ADR names it in `supersedes:`, and the newest one in the chain is the position that holds today.

Other reads:

```bash
lumem memory list                  # everything, with ids
lumem memory search "auth"         # substring search
lumem memory show <id>             # one fact with full provenance
```

## Writing

Write when something durable just happened — do not wait to be asked:

```bash
lumem memory add "<fact>" --type project
lumem memory add "<fact>" --type correction
lumem memory add "<fact>" --type preference
```

Write when:

- The user corrects you, especially the same way twice.
- A decision gets made and the reason matters later ("we dropped JWT because revocation had to be immediate").
- You hit a dead end worth not repeating ("the e2e suite needs the docker daemon up first; without it the failure is a misleading timeout").
- The user states how they want you to work.

## What does NOT belong in memory

This is what separates useful memory from noise:

- **Anything the repo already says.** If it is in the code, the README, the git log, or a spec, it is not memory. Memory holds what would otherwise be lost.
- **Anything unfalsifiable.** "The user prefers clean code" is noise. "The user rejects comments that restate the function name" is a fact.
- **Anything speculative.** Only what you actually observed this session.
- **Anything secret.** Keys, tokens, `.env` contents. Writes are scanned and refused, but do not rely on the scanner — do not try.

Prefer removing over accumulating. When a new fact contradicts an old one, replace it:

```bash
lumem memory forget <id>
```

## Notes

- Facts carry provenance (date, session, confidence) automatically. You do not write it.
- Project memory is committed, so it lands in review. Write facts a teammate would want to read.
- `--dry-run` on any write shows what would happen without touching disk.
