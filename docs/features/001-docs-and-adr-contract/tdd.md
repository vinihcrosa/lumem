# TDD — 001 Docs and ADR contract

**Status:** draft, awaiting review
**Depends on:** `context.md`, `decisions.md` (D1–D16), `questions.md` (rounds 1–4)

## Summary

Give architectural decisions a durable home in `docs/adr/`, make one trivial to create, tell the agent it exists, and catch the two link failures a human reader cannot see.

Scoped deliberately small (D16). The slice exists to answer one question from real use: **does the agent consult ADRs it was merely pointed at?** Everything not needed to answer that was deferred with a trigger.

---

## 1. On-disk format

### 1.1 Location and filename

```
docs/adr/YYYY-MM-DD-<slug>.md
```

- `slug` is kebab-case, derived from the title: lowercased, non-alphanumerics collapsed to `-`, trimmed, capped at 60 characters.
- The filename **is** the identifier. Renaming breaks every inbound `supersedes` link.
- Collision: when the exact filename exists, append `-2`, then `-3`, and so on.
- `docs/adr/` holds ADRs and nothing else. No subdirectories in this slice.

### 1.2 Frontmatter

YAML between `---` fences, first thing in the file.

```yaml
---
title: Session cookies over JWT
date: 2026-08-08
area: auth
summary: Auth uses session cookies because revocation has to take effect immediately.
supersedes: 2026-03-11-jwt-for-auth.md
---
```

| Field | Required | Type | Rule |
|---|---|---|---|
| `title` | yes | string | Non-empty. States the decision, not the topic — "Session cookies over JWT", not "Auth" |
| `date` | yes | `YYYY-MM-DD` | The date the decision was made. Matches the filename prefix |
| `area` | yes | string | Free text, kebab-case by convention. Groups decisions; starts loose and tightens with use |
| `summary` | yes | string | One sentence. The test: can a reader skip the body and still know whether this matters to them |
| `supersedes` | no | string | Filename of the ADR this replaces. Absent for an ADR that replaces nothing |

**`status` is not a field.** It is derived: an ADR is superseded exactly when some other ADR names it in `supersedes` (D14). Nothing writes back into an existing ADR, so a file is written once and never edited by tooling.

`supersedes` accepts a module rule id (`<module>/<rule>`) as well as an ADR filename, so D6 needs no format change later. This slice only resolves the ADR form; a value containing `/` is accepted and left unresolved.

### 1.3 Body

Markdown, free form after the frontmatter. `lumem adr new` seeds four headings, all of which may be edited or removed:

```markdown
## Context
What forced a decision. The constraint, not the history.

## Decision
What was decided, in the present tense.

## Alternatives considered
What else was on the table and why it lost. **This is the part that cannot be
reconstructed later** — the rest is recoverable from the code.

## Consequences
What this makes easy, and what it makes hard.
```

---

## 2. CLI

### 2.1 `lumem adr new`

```
lumem adr new <title> --area <area> [--summary <text>] [--supersedes <file>]
              [--date <YYYY-MM-DD>] [--dry-run] [--json]
```

| Behaviour | |
|---|---|
| Creates | `docs/adr/<date>-<slug>.md` with frontmatter and the seeded body |
| Prints | the path, so `$EDITOR $(lumem adr new ... --json \| jq -r .path)` works |
| `--date` | defaults to today; the filename prefix always matches the frontmatter |
| `--summary` | when absent, seeds a `TODO:` line — an ADR without a summary is invisible to discovery, so lint flags it |
| `--supersedes` | validated: the target must exist under `docs/adr/`, unless it contains `/` (a module rule id, unresolvable in this slice) |
| `--dry-run` | prints the file that would be written; writes nothing |
| Missing `docs/adr/` | created |
| Missing `.lumem/` | not required. ADRs are repository documents and do not depend on lumem being initialised |

**Exit codes:** `0` created · `1` invalid input (empty title, malformed date, unknown `--supersedes` target).

### 2.2 `lumem adr lint`

Two checks. Both are gates because both break the chain, and the chain being readable is the single property the whole supersedence design rests on (D11).

| Check | Fires when | Severity |
|---|---|---|
| `broken-supersedes` | `supersedes` names a file that does not exist under `docs/adr/`. Values containing `/` are skipped in this slice | gate |
| `supersedes-cycle` | Following `supersedes` from any ADR returns to an ADR already seen | gate |

Three more are reported as information, never as gates:

| Check | Fires when |
|---|---|
| `missing-frontmatter` | `title`, `date`, `area` or `summary` absent or empty |
| `date-mismatch` | The `date` field disagrees with the filename prefix |
| `todo-summary` | `summary` still starts with `TODO:` |

**Exit codes:** `0` no findings · `3` any finding (matching `doctor` and `memory lint`) · `1` the command itself failed.

`--json` emits the finding list. Output shape mirrors `memory lint`: kind, severity, file, message.

> **Note on a check deliberately absent.** `dead-reference` — an ADR naming a file that no longer exists — is *not* implemented here. In memory it signals rot; in an ADR it is usually correct, because an ADR records what was true when the decision was made (D1).

---

## 3. Discovery

When `docs/adr/` exists and holds at least one ADR, the injected block gains one line (D15):

```
## docs
Architectural decisions live in docs/adr/, newest last. Before proposing or
changing architecture, list that folder and read the frontmatter of anything
that looks relevant.
```

- Roughly 45 tokens, inside the existing injection budget — it is truncated by the same priority rules as everything else, and is the first thing dropped when the budget is tight.
- Absent entirely when `docs/adr/` is empty or missing, so a project not using ADRs pays nothing.
- The same text goes into the `lumem-memory` skill, so it still reaches the agent in skill-only mode where no hook runs.

---

## 4. Acceptance criteria

**Format**

1. Given a title and area, `lumem adr new` writes `docs/adr/<today>-<slug>.md` whose frontmatter parses and carries all five fields.
2. A title producing an existing filename yields `-2`; a third yields `-3`.
3. `--supersedes` naming a nonexistent ADR exits 1 and writes nothing.
4. `--supersedes` naming a module rule (`backend-dotnet/commands-mediatr`) is accepted and written through unresolved.
5. `--dry-run` prints the intended file and leaves the filesystem unchanged.
6. No command in this slice ever modifies an existing ADR.

**Lint**

7. An ADR whose `supersedes` names a missing file produces `broken-supersedes` and exit 3.
8. A → B → A produces `supersedes-cycle` and exit 3, and terminates rather than looping.
9. A well-formed set of ADRs produces no findings and exit 0.
10. Missing `summary`, a `TODO:` summary, and a date disagreeing with the filename each produce an informational finding; alone they still exit 3, since any finding exits 3.
11. Malformed YAML in one ADR does not prevent the others from being checked.
12. `--json` round-trips.

**Discovery**

13. With at least one ADR present, the injected block contains the docs line.
14. With `docs/adr/` absent or empty, the block is byte-identical to what it was before this feature.
15. The line is subject to the existing budget and is dropped first under pressure.

**Non-regression**

16. `npm run verify` stays green; the test count only grows.
17. A repository with no `docs/` directory behaves exactly as it does today.

---

## 5. Success criterion — the thing this slice exists to learn

Not testable in CI. Measured by use, over roughly two weeks of real sessions:

> **Does the agent read an ADR it was merely pointed at, before proposing something the ADR already settled?**

Observable evidence: an agent citing an ADR unprompted; or the opposite, an agent proposing something a current ADR rejects.

- If **yes**: the cheap pointer is enough, and `lumem docs index` stays deferred forever.
- If **no**: the design of everything else in `docs/` changes, because pointing is not sufficient and the injected block has to carry substance rather than a signpost.

This is the answer that determines whether the deferred list gets built as designed or gets redesigned.

---

## 6. Deferred, with triggers

| Deferred | Revisit when |
|---|---|
| `lumem docs index` with area grouping and drill-down | `ls docs/adr/` plus frontmatter stops being enough to find things |
| `docs/adr/drafts/` and the injected draft counter | Consolidation runs live and actually proposes something |
| `dead-reference`, `contradiction`, `stale-draft` checks | A real problem slips through unnoticed |
| `lumem lint` umbrella over memory and docs | There are three things to lint, not two |
| `superseded_by` written back into old ADRs | Walking a chain by hand becomes annoying |
| Module rule resolution in `supersedes` | Modules exist |
| `architecture.md`, `conventions/`, `workflows/`, module map, graphify pointer | This slice has answered its question |

---

## 7. Open, deliberately

- **Where the docs line lives structurally.** It is a rule (D2), but the rule layer arrives with modules. This slice hardcodes it into the injection builder and accepts that it moves later.
- **Promotion of a repeated TDD decision to an ADR** (D7) is designed but not built. It needs TDDs to exist first.
