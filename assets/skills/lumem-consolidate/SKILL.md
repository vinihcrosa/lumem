---
name: lumem-consolidate
description: Turns one raw session journal plus the current memory files into a JSON patch of durable memory facts. Runs headless at session end on a cheap model; the only valid output is the patch object — no prose, no explanation, no commentary.
---

# lumem-consolidate

A coding session just ended. You get its raw journal and the memory that already exists. You decide what — if anything — is worth keeping.

You are not summarizing the session. You are deciding what a *different* agent, three weeks from now, would be worse off not knowing. Almost everything that happens in a session fails that bar.

**Emit the patch object and nothing else.** No preamble, no reasoning, no closing note. Plain JSON is preferred; one fenced `json` block is tolerated. Anything else risks the whole patch being discarded.

## Input

You receive two blocks.

### 1. The session journal — JSONL, one signal per line

These are the only signal kinds that exist:

```jsonl
{"t":"session","ts":"2026-08-07T14:02:11Z","ev":"start","harness":"claude-code","sessionId":"a1b2c3","cwd":"/repo"}
{"t":"file","ts":"2026-08-07T14:09:40Z","path":"src/api/auth.ts","tool":"Edit"}
{"t":"cmd","ts":"2026-08-07T14:20:55Z","cmd":"npm run test:e2e","exit":1}
{"t":"recovery","ts":"2026-08-07T14:24:12Z","failed":"npm run test:e2e","passed":"docker compose up -d && npm run test:e2e"}
{"t":"correction","ts":"2026-08-07T14:11:03Z","marker":"actually","prompt":"actually no, don't use JWT here"}
{"t":"memory-op","ts":"2026-08-07T14:16:22Z","op":"add","factId":"66a2ae90"}
```

| Signal | How to read it |
|---|---|
| `session` | Session boundary. Bookkeeping — never a fact. |
| `file` | A file was touched by a tool. Evidence, never a fact. |
| `cmd` | A command ran, with its exit code. Evidence. |
| `recovery` | A command failed, then a variant of it passed. The richest signal there is: it usually names a repo pitfall someone will hit again. |
| `correction` | A user prompt tripped a correction heuristic. `marker` is only the string that matched — a *maybe*, not a verdict. Read `prompt` and judge for yourself. |
| `memory-op` | The agent already wrote (or forgot) a fact during the session. Do not write it again. |

Prompts arrive flattened, truncated at ~500 characters, and pre-redacted. `[REDACTED:env-secret]` means a secret was stripped — never try to reconstruct it, never quote around it.

### 2. The current memory — one fact per line, 8-hex id first

```text
3808e284  [2026-06-02]  (project/project)     conf:low     Auth is undecided: JWT and session cookies are both on the table.
93f1729c  [2026-05-18]  (project/project)     conf:high    The project is written in TypeScript and bundles with tsup.
66a2ae90  [2026-08-07]  (project/project)     conf:high    Config parsing is deliberately tolerant: a malformed .lumem/lumem.config.json falls back to defaults instead of erroring, because a broken config must never block a session.
3e74ddd6  [2026-04-11]  (preference/global)   conf:medium  Writes commit subjects in the imperative and without emoji; expects the same in generated commits.
```

Every `targetId` you emit must be an id **copied from this block**. An invented id, or anything that is not exactly those 8 hex characters, makes the entry vanish silently.

## Output — the exact schema

All three arrays are always present, even when empty. No other keys anywhere: one unknown key invalidates the **entire patch**, not just the offending entry.

```json
{
  "version": 1,
  "add": [
    { "type": "project", "scope": "project", "body": "one falsifiable fact, with its reason", "conf": "high" }
  ],
  "replace": [
    { "targetId": "3808e284", "body": "the full replacement body, standing on its own", "conf": "high" }
  ],
  "remove": [
    { "targetId": "93f1729c", "reason": "short reason it is going away" }
  ]
}
```

| Field | Allowed values |
|---|---|
| `version` | the number `1`, always |
| `add[].type` | `"project"` \| `"preference"` \| `"correction"` |
| `add[].scope` | `"project"` \| `"global"` — constrained by `type`, see the table below |
| `add[].body` | non-empty string; one fact, stated plainly, reason included |
| `add[].conf` | `"low"` \| `"medium"` \| `"high"` |
| `replace[].targetId` | id of an existing fact, copied from the current-memory block |
| `replace[].body` | non-empty string; the complete new body |
| `replace[].conf` | `"low"` \| `"medium"` \| `"high"` |
| `remove[].targetId` | id of an existing fact, copied from the current-memory block |
| `remove[].reason` | string, short: `"superseded by the cookie decision"` |

### Legal type/scope combinations

An entry whose combination is not in this table is **discarded silently** — no error, no retry, the fact is simply lost. Check every `add` against it.

| `type` | legal `scope` | lands in |
|---|---|---|
| `project` | `project` | `<repo>/.lumem/memory/project.md` |
| `preference` | `global` | `~/.lumem/memory/preference.md` |
| `correction` | `project` or `global` | `<repo>/.lumem/memory/correction.md` or `~/.lumem/memory/correction.md` |

Read it the other way round when you are unsure which type to use:

- Something true about **this repo** — architecture, a convention, a decision and its reason, a pitfall → `project` / `project`.
- Something true about **this developer** everywhere — style, tone, tolerances → `preference` / `global`.
- Something the user **explicitly corrected the agent about** → `correction`, scoped `project` when it only applies here, `global` when it would apply in any repo.

### How each operation behaves

- **`add`** — dropped if the type/scope pair is illegal, or if a fact with an identical body already exists. Do not re-add what the current-memory block already contains.
- **`replace`** — remove + add, inside the file the target already lives in. It cannot move a fact between files or change its type; for that, `remove` the old one and `add` the new one. The old body is gone afterwards, so the new body must stand alone.
- **`remove`** — dropped if the id is unknown.
- Provenance (date, session, confidence) is attached by the tool. Never write it into `body`.

### Confidence

- `high` — the user said it in so many words, or a command demonstrably failed and then passed.
- `medium` — this session clearly implies it, once.
- `low` — you would not bet on it. Prefer writing nothing over writing `low`.

## Worked example

Journal (deliberately eventful — three corrections and a recovery in one sitting; most sessions look nothing like this):

```jsonl
{"t":"session","ts":"2026-08-07T14:02:11Z","ev":"start","harness":"claude-code","sessionId":"a1b2c3","cwd":"/repo"}
{"t":"file","ts":"2026-08-07T14:09:40Z","path":"src/api/auth.ts","tool":"Edit"}
{"t":"correction","ts":"2026-08-07T14:11:03Z","marker":"actually","prompt":"actually no, JWT doesn't work here — revocation has to take effect immediately. use a session cookie"}
{"t":"memory-op","ts":"2026-08-07T14:16:22Z","op":"add","factId":"66a2ae90"}
{"t":"cmd","ts":"2026-08-07T14:20:55Z","cmd":"npm run test:e2e","exit":1}
{"t":"recovery","ts":"2026-08-07T14:24:12Z","failed":"npm run test:e2e","passed":"docker compose up -d && npm run test:e2e"}
{"t":"file","ts":"2026-08-07T14:31:02Z","path":"src/api/session.ts","tool":"Write"}
{"t":"cmd","ts":"2026-08-07T14:33:18Z","cmd":"npm run test:e2e","exit":0}
{"t":"correction","ts":"2026-08-07T14:37:20Z","marker":"never","prompt":"never hand-edit src/adapters/*.json to make a test pass, that's release data — fix the test"}
{"t":"correction","ts":"2026-08-07T14:39:02Z","marker":"no, do","prompt":"no, do show me the diff before asking me to approve. i don't read a description of a change without the patch"}
{"t":"session","ts":"2026-08-07T14:41:00Z","ev":"end","harness":"claude-code","sessionId":"a1b2c3","cwd":"/repo"}
```

Current memory: the four-line block shown under **Input** above.

Correct patch:

```json
{
  "version": 1,
  "add": [
    {
      "type": "project",
      "scope": "project",
      "body": "`npm run test:e2e` fails with a misleading connection timeout unless `docker compose up -d` ran first; the suite does not start its own containers.",
      "conf": "high"
    },
    {
      "type": "correction",
      "scope": "project",
      "body": "Told never to hand-edit src/adapters/*.json to make a test pass — adapter descriptors are release data; fix the test instead.",
      "conf": "high"
    },
    {
      "type": "preference",
      "scope": "global",
      "body": "Wants to see the actual diff before being asked to approve a change; a prose summary of the change is not enough.",
      "conf": "medium"
    }
  ],
  "replace": [
    {
      "targetId": "3808e284",
      "body": "Auth uses a session cookie, not JWT: revocation has to take effect immediately and a stateless token cannot do that without a blocklist.",
      "conf": "high"
    }
  ],
  "remove": [
    { "targetId": "93f1729c", "reason": "duplicates the repo: package.json and tsup.config.ts already say this" }
  ]
}
```

Why that patch, and — more importantly — what it left out:

- The `recovery` line became the one durable `project` fact from the whole session. Nothing in the repo tells you the e2e suite needs a running daemon; the failure it produces points at the wrong thing.
- The first `correction` contradicted `3808e284`, so it was **replaced**, not stacked. Two facts about auth pointing in different directions is worse than one stale fact.
- The second `correction` is about the agent's behaviour in this repo → `correction` / `project`. The third is about how this developer wants to be worked with anywhere → `preference` / `global`, `medium` because it was said once.
- `93f1729c` was removed: `package.json` answers it.
- `66a2ae90` was written by the agent mid-session (see the `memory-op` line) and is already in memory — not re-added.
- The `file` and `cmd` signals produced **no facts at all**. "Edited src/api/auth.ts and made the e2e suite pass" is session narration, not memory. `git log` covers it.

## The four anti-junk rules

This is the part that decides whether the memory file is worth reading or gets deleted in review.

### 1. Do not duplicate the repo

If it is in the code, the README, the git log or a spec, it is not memory. Memory holds what would otherwise be lost.

- **BAD** — `"The project is written in TypeScript and bundles with tsup."` `package.json` says so.
- **BAD** — `"src/api/session.ts creates and validates session cookies."` Opening the file says so.
- **GOOD** — `"Auth uses a session cookie, not JWT: revocation has to take effect immediately and a stateless token cannot do that without a blocklist."` The choice is in the code; the *reason* is not, and without it the next agent proposes JWT again.

Test: would `grep`, the README, or `git log` answer this? Then drop it.

### 2. Facts must be falsifiable

A fact a future session could prove wrong is a fact. Anything else is decoration.

- **BAD** — `"The user prefers clean, maintainable code."` Nobody prefers the opposite; it predicts nothing.
- **BAD** — `"The team values testing."`
- **GOOD** — `"Rejects comments that restate the function name; wants comments only where the reasoning is not obvious from the code."`
- **GOOD** — `"Rejects any dependency added just to avoid ~20 lines of code."`

Test: can you imagine the evidence that would show this fact is false? If not, do not write it.

### 3. No speculation

Only what this session actually shows. Every fact must trace back to a journal line you could point at.

- **BAD** — `"The team is likely moving toward a monorepo."` Nobody said that.
- **BAD** — `"The e2e suite seems flaky."` It failed once, for a known reason, and the reason is the fact.
- **BAD** — `"The user is probably under time pressure."`
- **GOOD** — "npm run test:e2e fails with a misleading connection timeout unless `docker compose up -d` ran first" — journal line: the `recovery` signal.

A `correction` marker is a hint that the heuristic fired, not proof the user corrected anything. `"sempre que"` / `"always"` matches plenty of ordinary sentences. Read the prompt; if it is not actually a correction, write nothing.

### 4. Prefer removing to accumulating

Consolidation is allowed to delete. A patch that only removes is a good patch.

- **BAD** — adding `"Auth uses a session cookie"` while `"Auth is undecided: JWT and session cookies are both on the table"` stays in the file. The next agent reads both and trusts neither.
- **GOOD** — `replace` the stale fact with the settled one, in one operation.

Also remove, whenever you see them in the current-memory block:

- facts the code has since absorbed (the pitfall got fixed; the convention is now enforced by a linter),
- the same fact worded twice,
- facts that fail rules 1–3 and were written by an earlier, less careful pass.

## Compaction

The input may flag a file as being over its soft limit (`compact: project`, `compact: project, correction`, …). For each flagged file, go further than usual — the goal is fewer lines, not a tidier version of the same lines:

**Preserve:**

- active risks and pitfalls that can still bite,
- decisions **together with their reasons** — a decision without its reason is worth almost nothing,
- recent corrections.

**Cut:**

- repetition — merge several narrow facts into one that covers them, and `replace` the survivor rather than adding a fifth,
- anything the code, tests or tooling has since absorbed,
- stale specifics: dead file paths, one-off pitfalls from a build that no longer exists,
- anything failing rules 1–3.

Compaction is expressed in the same patch: `replace` for merged facts, `remove` for the rest. When a file is flagged, a patch with an empty `add` and a long `remove` is exactly right.

## Secrets — hard rule

Never emit an API key, token, password, connection string, private key or `.env` value, in any field, **even if it appears verbatim in the journal**. No exceptions, no partial values, no "example" values, no reconstruction of a `[REDACTED:...]` span.

Naming a credential is fine; carrying its value is not.

- **BAD** — `"The e2e suite needs STRIPE_KEY=sk_live_4eC39H... exported."`
- **GOOD** — `"The e2e suite needs STRIPE_KEY exported; without it the failure is a 401 that reads like a routing bug."`

An entry that trips the secret scanner is discarded, and a memory file that already contains one blocks its whole write. Do not test the scanner.

## Calibration — err toward writing nothing

Writing nothing is a success, not a failure. Most sessions are unremarkable: files were edited, commands were run, nothing was *learned*. The correct answer for those is the empty patch, and it is the single most common correct answer:

```json
{"version":1,"add":[],"replace":[],"remove":[]}
```

The rate to aim for is **5–15 facts per week** in an actively developed repo — **not per session**. A session that yields more than two or three new facts is almost certainly producing session narration.

Before each `add`, ask: would a competent agent starting fresh next month be worse off without this line? "It might help" is a no. Only "yes, otherwise it repeats this mistake" is a yes.

If the journal has no `correction` and no `recovery` signal, the odds that this session produced durable memory are low. Look hard for a reason to write nothing, and take it if you find one.

## Before you answer

1. Every `targetId` was copied from the current-memory block, never invented.
2. Every `add` uses a legal type/scope pair.
3. Every fact survives all four anti-junk rules.
4. No secrets, no provenance, no dates inside `body`.
5. Contradictions were replaced, not stacked.
6. `version`, `add`, `replace` and `remove` are all present; nothing else is.
7. Your output is the JSON object and nothing else.
