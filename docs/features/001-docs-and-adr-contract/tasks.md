# Tasks — 001 Docs and ADR contract

**TDD:** [tdd.md](tdd.md) · **Decisions:** [decisions.md](decisions.md)

Each task is self-contained: what to build, the signatures, the tests, and the acceptance criteria from the TDD it discharges. Written to be implementable without re-reading the whole discussion.

## Conventions

- TypeScript ESM, Node ≥ 20, strict. Imports without `.js`. biome: single quotes, semicolons as needed, 2-space, lineWidth 100.
- Tests co-located, vitest, fixtures via `mkdtemp`. Tests belong to the task that creates the code — never a task of their own.
- One task, one commit. Conventional Commits.
- **`src/core/adr/**` must stay dependency-free** — no zod. T5 puts part of this on the hook path, and the bundle purity test in `src/hooks/main.test.ts` fails if anything external creeps in. Validation is hand-rolled, exactly as `core/capture` does it.
- Gate per task: `npm run check && npx vitest run <task paths>`. Last task of a phase: `npm run verify`.
- **Nobody edits `src/cli/index.ts` except T7.** Command modules export a `registerX` function.

## Execution plan

```
T1 (format) ──┬──→ T2 (store) ──→ T4 (lint) ──┐
              └──→ T3 (adr new) ──────────────┼──→ T7 (wire) ──→ T8 (smoke)
T5 (injection) ───────────────────────────────┤
T6 (skill text) ──────────────────────────────┘
```

T1, T5 and T6 have no dependency on each other and can run in parallel.

---

## T1 — ADR format: parse and serialize

**Where:** `src/core/adr/format.ts` + `format.test.ts`

**Why first:** every other task reads or writes this shape.

```ts
export interface Adr {
  /** Filename, e.g. `2026-08-08-cookie-sessions.md`. The identifier. */
  id: string
  title: string
  date: string            // YYYY-MM-DD
  area: string
  summary: string
  supersedes?: string     // an ADR id, or `<module>/<rule>`
  body: string            // everything after the frontmatter, verbatim
  warnings: string[]      // tolerant-parse complaints, never thrown
}

export function slugify(title: string): string
export function adrFilename(date: string, slug: string): string
export function parseAdr(id: string, content: string): Adr
export function serializeAdr(adr: Omit<Adr, 'id' | 'warnings'>): string
export const BODY_TEMPLATE: string
```

**Implementation notes**

- `slugify`: lowercase, non-alphanumerics → `-`, collapse runs, trim leading/trailing `-`, cap at 60 chars without cutting mid-word where avoidable. Empty result → `untitled`.
- `adrFilename(date, slug)` → `` `${date}-${slug}.md` ``.
- Frontmatter is between two `---` lines at the very start. **Hand-rolled key/value parsing, not a YAML library** — the five fields are flat strings. A line that is not `key: value` becomes a warning, not a throw.
- Values may be quoted; strip a single matching pair of `'` or `"`.
- Missing or empty required field (`title`, `date`, `area`, `summary`) → warning naming the field; the ADR is still returned so lint can report it. Never throw.
- No frontmatter at all → all fields empty, one warning, body is the whole content.
- `serializeAdr` emits fields in the fixed order title, date, area, summary, supersedes; omits absent `supersedes`; ends the file with a single newline.
- **Round-trip is the contract**: `parseAdr(id, serializeAdr(a))` returns `a`'s fields unchanged.
- `BODY_TEMPLATE` is the four headings from TDD §1.3.

**Tests**

- round-trip for a full ADR and for one without `supersedes`
- `slugify`: accents, punctuation, multiple spaces, a 200-char title, an emoji-only title
- each missing required field produces a warning naming it, and parsing still returns
- malformed frontmatter line → warning, other fields still parsed
- no frontmatter → one warning, body preserved verbatim
- quoted values unquoted; a value containing `:` survives (split on the first `:` only)
- body preserved byte-for-byte, including trailing blank lines

**Discharges:** AC1 (partly), AC6.

---

## T2 — ADR store: read the folder, derive status, walk chains

**Where:** `src/core/adr/store.ts` + `store.test.ts` · **Depends on:** T1

```ts
export interface AdrSet {
  adrs: Adr[]                        // sorted by id, which sorts by date
  byId: Map<string, Adr>
  /** id → the ADR that supersedes it, when one does. */
  supersededBy: Map<string, string>
}

export function readAdrs(docsDir: string): AdrSet   // docsDir is <repo>/docs
export function isSuperseded(set: AdrSet, id: string): boolean
export function currentOf(set: AdrSet, id: string): string
```

**Implementation notes**

- Reads `<docsDir>/adr/*.md`. Missing directory → empty set, no error.
- Ignores anything that is not `*.md`, and any subdirectory.
- **Status is derived** (D14): `supersededBy` is built by inverting every `supersedes` value that names a known ADR. A value containing `/` is a module rule id and is skipped here.
- `currentOf` walks `supersededBy` forward to the end of the chain. **It must terminate on a cycle** — track visited ids and return the last one seen rather than looping. T4 is what reports the cycle; the store must merely survive it.
- Never throws; unreadable file → an ADR with a warning.

**Tests**

- empty/missing folder → empty set
- three ADRs, one superseding another → `supersededBy` correct, `isSuperseded` correct for both
- `currentOf` across a chain of three
- `currentOf` on a cycle A→B→A terminates and does not hang (assert with a timeout)
- a `supersedes` naming a module rule (`backend-dotnet/x`) leaves nothing in `supersededBy`
- a `supersedes` naming a missing file leaves nothing in `supersededBy` (T4 reports it)
- non-`.md` files and subdirectories ignored
- ordering is by id

**Discharges:** groundwork for AC7, AC8.

---

## T3 — `lumem adr new`

**Where:** `src/cli/adr-new.ts` + `adr-new.test.ts` · **Depends on:** T1

```ts
export interface AdrNewOptions {
  area: string
  summary?: string
  supersedes?: string
  date?: string
  dryRun?: boolean
}
export interface AdrNewResult { ok: boolean; path?: string; message: string }
export function runAdrNew(ctx: CliContext, title: string, opts: AdrNewOptions): { result: AdrNewResult; exitCode: number }
export function renderAdrNew(result: AdrNewResult): string
export function registerAdrCommands(program: Command, buildContext: () => CliContext, emit): void
```

**Implementation notes**

- Command surface: `lumem adr new <title> --area <area> [--summary <text>] [--supersedes <file>] [--date <YYYY-MM-DD>] [--dry-run]`, plus global `--json`.
- Creates `<projectDir>/docs/adr/`, including parents, when absent.
- Collision: if the target exists, try `-2`, then `-3`, up to `-99`; beyond that, exit 1.
- `--summary` absent → `TODO: one sentence on what this decides` (T4's `todo-summary` then flags it).
- `--supersedes` validation: a value containing `/` is accepted unresolved; otherwise the file must exist under `docs/adr/`, else exit 1 and write nothing.
- `--date` must be `YYYY-MM-DD`, else exit 1. Default: today. The filename prefix always equals the frontmatter date.
- Empty or whitespace-only title → exit 1.
- Writes via `atomicWrite` from `core/shared/fsx`.
- **Does not require `.lumem/`** — ADRs are repository documents (TDD §2.1).
- `registerAdrCommands` registers the `adr` parent command and `new` under it, so T4 can attach `lint` to the same parent.

**Tests**

Integration style, `mkdtemp`, always injecting `ctx.env.HOME`.

- creates the file; frontmatter parses via T1 and carries all five fields
- collision yields `-2`, then `-3`
- unknown `--supersedes` → exit 1, nothing written
- module-rule `--supersedes` accepted and written through unresolved
- `--dry-run` prints the intended content, filesystem unchanged
- missing `--summary` seeds the `TODO:` line
- bad `--date`, empty title → exit 1
- works in a project with no `.lumem/`
- result is JSON round-trippable

**Discharges:** AC1, AC2, AC3, AC4, AC5.

---

## T4 — ADR lint

**Where:** `src/core/adr/lint.ts` + `lint.test.ts`, `src/cli/adr-lint.ts` + `adr-lint.test.ts` · **Depends on:** T2

```ts
export type AdrLintKind =
  | 'broken-supersedes' | 'supersedes-cycle'      // gates
  | 'missing-frontmatter' | 'date-mismatch' | 'todo-summary'   // informational

export interface AdrFinding {
  kind: AdrLintKind
  severity: 'gate' | 'info'
  ids: string[]
  message: string
}
export function lintAdrs(set: AdrSet): AdrFinding[]
```

**Implementation notes**

- `broken-supersedes`: `supersedes` names an id absent from `byId`. **Values containing `/` are skipped** — module rules are unresolvable in this slice (TDD §2.2).
- `supersedes-cycle`: reported once per cycle, listing its members in a stable order (start from the smallest id so the same cycle always renders identically).
- `missing-frontmatter`: reuses the warnings T1 already produced; no re-parsing.
- `date-mismatch`: the `date` field disagrees with the filename prefix.
- `todo-summary`: `summary` starts with `TODO:`.
- Sorted by (severity, kind, first id). Pure; never throws.
- CLI mirrors `memory lint`: exit `0` clean, `3` on **any** finding, `1` on command failure. `--json` emits the findings.
- The renderer groups by kind and marks gates distinctly from info, so a gate is not lost among five informational lines.

**Tests**

- `supersedes` naming a missing file → `broken-supersedes`, gate, exit 3
- A→B→A → `supersedes-cycle`, gate, and the check terminates
- A→B→C→A (three-member cycle) reported once, not three times
- module-rule `supersedes` produces no finding
- each informational check fires on its own fixture and does not fire on a clean one
- a clean set → no findings, exit 0
- one ADR with malformed frontmatter does not stop the others from being checked
- `--json` round-trips

**Discharges:** AC7, AC8, AC9, AC10, AC11, AC12.

---

## T5 — The injected docs rule

**Where:** `src/core/memory/budget.ts` (extend) + its test · **Depends on:** none

**The constraint that shapes this task:** this runs inside the hook bundle. Dependency-free, and the purity tests in `src/hooks/main.test.ts` must stay green.

```ts
export function buildInjection(
  files: MemoryFile[],
  budgetBytes: number,
  opts?: { docsDir?: string },
): InjectionResult
```

**Implementation notes**

- When `opts.docsDir` is given and `<docsDir>/adr/` contains at least one `*.md`, append a `## docs` section with the text from TDD §3.
- Existence check only — a `readdirSync` with an early exit. **Do not parse the ADRs**: this is the session-start path and the latency budget is the hook's, not the CLI's.
- The section is subject to the same budget and is **appended last**, so it is the first thing dropped under pressure (AC15).
- Absent or empty `docs/adr/` → output byte-identical to today (AC14).
- The caller (`src/hooks/handlers.ts`, `inject`) passes `docsDir` as `<projectDir>/docs`.

**Tests**

- with one ADR present, the block contains the docs line
- with `docs/adr/` absent, and again with it present but empty, the output is byte-identical to a run with no `docsDir` at all
- a tight budget drops the docs section before dropping any fact
- the byte ceiling still holds with the section present
- an unreadable `docs/` does not throw
- bundle purity: `npm run build` then the existing purity assertions still pass

**Discharges:** AC13, AC14, AC15.

---

## T6 — Skill text for skill-only mode

**Where:** `assets/skills/lumem-memory/SKILL.md` · **Depends on:** none

The same instruction has to reach the agent where no hook runs (TDD §3). Add a short section pointing at `docs/adr/` with the same wording as the injected rule, so the two cannot drift apart in meaning.

**Tests:** none (data). Gate: `npm run build`, and the existing frontmatter validation still passes.

---

## T7 — Wire the commands

**Where:** `src/cli/index.ts` · **Depends on:** T3, T4

Register `registerAdrCommands(program, buildContext, emit)` and attach `lint` to the same `adr` parent. **Orchestrator-only task** — it is the one file parallel work must not touch.

**Tests:** none of its own; T8 covers it end to end.

---

## T8 — End-to-end smoke against the built binary

**Where:** manual, recorded in this file · **Depends on:** T7

Not a unit test. Run the real binary in a temp project and confirm the slice behaves as a user would meet it:

```bash
lumem adr new "Session cookies over JWT" --area auth \
  --summary "Auth uses session cookies because revocation must be immediate."
lumem adr new "JWT for service tokens" --area auth --supersedes <the first file>
lumem adr lint                 # expect exit 0
# hand-edit a supersedes to a missing file
lumem adr lint                 # expect the gate and exit 3
lumem memory context           # expect the docs line
```

**Acceptance:** AC16 (`npm run verify` green, test count only grows) and AC17 (a repository with no `docs/` behaves exactly as before).

---

## Traceability

| AC | Task |
|---|---|
| 1, 2, 3, 4, 5 | T3 |
| 6 | T1 |
| 7, 8, 9, 10, 11, 12 | T4 |
| 13, 14, 15 | T5 |
| 16, 17 | T8 |

`docs/adr/` reading and status derivation (T2) discharge no AC directly; they are what T4 stands on.

## Deliberately not here

Everything in TDD §6. If a task starts growing toward `lumem docs index`, drafts, or the other lint checks, that is scope leaking back in — the triggers to revisit are written down and none of them has fired.
