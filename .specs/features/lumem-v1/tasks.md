# lumem V1 — Tasks

**Design**: [design.md](design.md) · **Spec**: [spec.md](spec.md) · **Testing**: [../../codebase/TESTING.md](../../codebase/TESTING.md)
**Status**: Done — 48/48 tasks, M0–M5 complete

**Conventions:**
- Tools (all tasks): built-in file tools + Bash. MCP: NONE. Skills: NONE. Exceptions noted on the task.
- 1 commit per task, Conventional Commits, scope = module (`feat(harness): …`).
- `[P]` = parallelizable with its siblings in the same phase (deps satisfied + tests parallel-safe per TESTING.md).
- Every task: green suite, test count only grows.
- Gate commands: see TESTING.md (quick / full / build / bench).

---

## Execution Plan

### Phase 0 — M0 Skeleton (exit: `lumem doctor` identifies both harnesses)

```
T1 ──┬→ T2 ──┬────────────→ T5 ─┐
     └→ T3 ──┼→ T4 [P] ─────────┼→ T7
             ├→ T5 [P] (w/ T2) ─┤
             └→ T6 [P] ─────────┘
```

### Phase 1 — M1 Installer (exit: install→uninstall with no residue, byte-identical round-trip)

```
T1 ─→ T8 [P]
T2 ─┬→ T9 [P] ──┐
    ├→ T10 [P] ─┤
    ├→ T11 [P]* ┼→ T13 ─→ T14 ─┐
    └→ T12 [P] ─┘              ├→ T16 ─┬→ T17 [P]
T5,T6,T12 ──────→ T15 ─────────┘       ├→ T18 [P]
                                       └→ T19 [P] (w/ T12)
* T11 also depends on T8
```

### Phase 2 — M2 Manual memory (exit: the agent reads and uses the injected memory)

```
T2 ─→ T20 ─→ T21 ─┬→ T22 [P] ─┬→ T24 [P]   T26 ─→ T27 (w/ T8)
                  └→ T23 [P]  ├→ T25 [P]
                              └→ T26
```

### Phase 3 — M3 Capture (exit: signals in the journal, zero broken sessions)

```
T2 ──→ T28 [P] ──┐
T2 ──→ T29 [P] ─┬┤
T20 ─→ T30 [P]  ├┼→ T32 ─┬→ T34
       T29 → T31┘│       │
T26 ─────────────┘       │
T14,T16,T28 ─→ T33 [P] ──┘
```

### Phase 4 — M4 Consolidation (exit: useful facts appear on their own)

```
T23,T29 ─→ T35 [P] ─┐
T2 ──────→ T36 [P] ─┤
T21 ─────→ T37 [P] ─┼→ T39 ─┬→ T40 (w/ T32)
T8 ──────→ T38 [P] ─┘       ├→ T41 [P]
T8 ──────→ T43 [P]          └→ T42 [P] (w/ T23)
```

### Phase 5 — M5 Hardening (exit: ready for a public repo)

```
T32,T40 ─→ T44 [P]
T41 ─────→ T45 [P]     T44,T45,T46,T47 ─→ T48
T2 ──────→ T46 [P]
T1,T41 ──→ T47 [P]
```

---

## Task Breakdown

## Phase 0 — M0

### T1: Repository scaffold ✅
**What**: `package.json` (ESM, `engines.node>=20`, `bin: {lumem}`), tsconfig, biome, vitest, tsup multi-entry (`cli`, `lumem-hook`, `lumem-runner`), `check`/`verify`/`build`/`bench:hook` scripts; check availability of the name `lumem` on the npm registry and record the result in STATE.md (open decision #1).
**Where**: root; empty `src/` skeleton
**Depends on**: None · **Reuses**: — · **Requirement**: OPS-04, OPS-03 (partial)
**Done when**:
- [ ] `npm run build` produces the 3 bundles from stub entrypoints
- [ ] `npm run verify` green (0 tests is acceptable only in this task)
- [ ] The `npm view lumem` result recorded in STATE.md
**Tests**: none (infra) · **Gate**: build + full
**Verify**: `node dist/cli.js --version` prints the version.
**Commit**: `chore: scaffold TS/ESM, multi-entry build and gates`

### T2: core/shared — fsx, log ✅
**What**: `fsx.ts` (`atomicWrite` tmp+rename, `expandHome`, `sha256`, `readJsonSafe`), `log.ts` (structured JSONL append to `local/lumem.log`; rotation = stub with the interface ready).
**Where**: `src/core/shared/{fsx,log}.ts` + tests
**Depends on**: T1 · **Reuses**: node builtins · **Requirement**: OPS-09 (partial)
**Done when**:
- [ ] `atomicWrite` survives a simulated crash (an orphaned tmp does not corrupt the destination)
- [ ] Quick gate passes
**Tests**: unit · **Gate**: quick
**Commit**: `feat(shared): atomic fsx and structured log`

### T3: AdapterDescriptor schema + loader [P] ✅
**What**: complete zod schema (design §Data Models) + `loadDescriptors(dir)`; an invalid descriptor → an error naming the field, harness excluded.
**Where**: `src/adapters/schema.ts`, `src/core/harness/load.ts` + tests
**Depends on**: T1 · **Reuses**: — · **Requirement**: HARN-02
**Done when**:
- [ ] An invalid fixture is rejected with the field path in the error; a valid one loads typed
- [ ] Quick gate passes
**Tests**: unit · **Gate**: quick
**Commit**: `feat(harness): zod schema and descriptor loader`

### T4: claude-code.json and codex.json descriptors [P] ✅
**What**: both descriptors with the verified facts (design §0/§Data Models): Codex skills in `.agents/skills`, hooks in `.codex/hooks.json`, minVersions 2.1.224/0.147.0, `injection[]`, `headless`.
**Where**: `src/adapters/{claude-code,codex}.json` + validation test
**Depends on**: T3 · **Reuses**: T3's schema · **Requirement**: HARN-01
**Done when**:
- [ ] Both pass the schema in a test; snapshot of the critical fields
**Tests**: unit (via schema) · **Gate**: quick
**Commit**: `feat(adapters): verified claude-code and codex descriptors`

### T5: Detection engine [P] ✅
**What**: `detect(descriptor)` — `dir`/`bin`/`file` rules, version probe via `versionArgs`; never throws for a missing harness.
**Where**: `src/core/harness/detect.ts` + tests (fixtures in tmp, fake PATH)
**Depends on**: T2, T3 · **Reuses**: fsx · **Requirement**: HARN-01
**Done when**:
- [ ] Detects by dir and by bin; absent → `detected:false` without an error; version parsed
**Tests**: unit · **Gate**: quick
**Commit**: `feat(harness): declarative dir/bin/file detection`

### T6: OperatingMode resolution [P] ✅
**What**: `resolveMode(descriptor, detection)` — capabilities → `grade` (`full|degraded|skill-only|unavailable`) + declared `fallbacks`; version < minimum ⇒ explicit degrade.
**Where**: `src/core/harness/mode.ts` + tests
**Depends on**: T3 · **Reuses**: — · **Requirement**: HARN-03
**Done when**:
- [ ] Case matrix: full, no sessionStart→injection fallback, no hooks→skill-only, old version→warning
**Tests**: unit · **Gate**: quick
**Commit**: `feat(harness): operating mode with declared degradation`

### T7: CLI skeleton + doctor + status ✅
**What**: commander program, global `--json`/`--dry-run` flags, exit codes (0/1/3); `lumem doctor` (harnesses, versions, capabilities, mode, fallbacks) and `lumem status` (a clean "nothing installed").
**Where**: `src/cli/{index,doctor,status}.ts` + integration tests
**Depends on**: T4, T5, T6 · **Reuses**: harness engine · **Requirement**: CLI-05, CLI-06, CLI-11, HARN-04
**Done when**:
- [ ] In a fake home with both harnesses: doctor lists both; with no harness: "not detected", exit 0
- [ ] `--json` stable on both commands
- [ ] **M0 exit**: doctor correct against the machine's real harnesses (manual verification recorded)
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): doctor and status with operating modes`

## Phase 1 — M1

### T8: Stub assets [P] ✅
**What**: initial `assets/`: `skills/lumem-memory/SKILL.md` and `skills/lumem-consolidate/SKILL.md` (valid frontmatter + minimal body), `agents/lumem-consolidator.md`, `harness/*/hooks.tmpl.json` (eventMap events calling `lumem-hook.mjs`).
**Where**: `assets/**`
**Depends on**: T1 · **Reuses**: the descriptors' eventMap · **Requirement**: MEM-07, CONS-03/04, CONS-06 (stubs)
**Done when**:
- [ ] Frontmatter compatible with both harnesses (name+description); JSON templates parseable
**Tests**: none (data; validated by T11/T33) · **Gate**: build
**Commit**: `feat(assets): initial skills, agent and hook templates`

### T9: Managed blocks [P] ✅
**What**: `upsertManagedBlock`/`removeManagedBlock` with `<!-- lumem:start/end -->` markers; creates the file if absent; outside content untouched byte for byte; respects `maxBytes` by truncating by priority.
**Where**: `src/core/install/managed-block.ts` + golden tests
**Depends on**: T2 · **Reuses**: fsx · **Requirement**: INST-05
**Done when**:
- [ ] Goldens: no block, with block, content before/after, removal restores, maxBytes truncates with a warning
**Tests**: unit · **Gate**: quick
**Commit**: `feat(install): managed blocks with markers`

### T10: Timestamped backup [P] ✅
**What**: `backupOnce(path)` → `.lumem/local/backups/<ts>/<relpath>`; idempotent (the 1st backup wins).
**Where**: `src/core/install/backup.ts` + tests
**Depends on**: T2 · **Reuses**: fsx · **Requirement**: INST-06
**Done when**:
- [ ] A second backup of the same file does not overwrite the first
**Tests**: unit · **Gate**: quick
**Commit**: `feat(install): single timestamped backup`

### T11: Manifest [P] ✅
**What**: build the manifest from `assets/` + `dist/` (id, kind, version, sha256 hash, dest per harness/scope).
**Where**: `src/core/install/manifest.ts` + tests
**Depends on**: T2, T8 · **Reuses**: fsx.sha256 · **Requirement**: INST-01
**Done when**:
- [ ] Deterministic manifest (same input ⇒ same hashes); covers skill/agent/hook-config
**Tests**: unit · **Gate**: quick
**Commit**: `feat(install): artifact manifest with hashes`

### T12: Lockfile + drift [P] ✅
**What**: read/write `lumem-lock.json`; `detectDrift(lock, disk)` by hash.
**Where**: `src/core/install/lockfile.ts` + tests
**Depends on**: T2 · **Reuses**: fsx · **Requirement**: INST-02, INST-04
**Done when**:
- [ ] Drift detected when a managed file is edited; a missing file = drift of kind `missing`
**Tests**: unit · **Gate**: quick
**Commit**: `feat(install): lockfile and drift detection`

### T13: Pure planner ✅
**What**: `plan(manifest, lock, modes, opts)` — diff of desired × lock × disk ⇒ a list of actions (`create|update|skip|conflict`); zero write I/O; this is what `--dry-run` prints.
**Where**: `src/core/install/plan.ts` + tests
**Depends on**: T11, T12 · **Reuses**: manifest, lockfile · **Requirement**: INST-03
**Done when**:
- [ ] Already-installed state ⇒ empty plan (idempotency proven in the plan); drift ⇒ `conflict`, never `update` without force
**Tests**: unit · **Gate**: quick
**Commit**: `feat(install): pure idempotent planner`

### T14: Apply ✅
**What**: executes the plan: symlink/`--copy`, managed blocks, backups, updates the lockfile per action; a failure midway leaves the lockfile consistent with what was applied.
**Where**: `src/core/install/apply.ts` + integration tests (fake homes)
**Depends on**: T9, T10, T13 · **Reuses**: T9/T10/T13 · **Requirement**: INST-07, OPS-06 (partial)
**Done when**:
- [ ] `apply(plan)` 2× ⇒ zero actions the second time; copy and symlink modes covered
**Tests**: integration · **Gate**: full
**Commit**: `feat(install): transactional apply with lockfile`

### T15: `lumem init` ✅
**What**: detects harnesses, interactive selection (or `--yes`), creates `.lumem/` (`memory/`, `local/`, `lumem.config.json` with the design defaults, `.gitignore` covering `local/`), empty lockfile.
**Where**: `src/cli/init.ts` + integration tests
**Depends on**: T5, T6, T12 · **Reuses**: detect/mode/lockfile · **Requirement**: CLI-01, MEM-06
**Done when**:
- [ ] New repo: structure created; re-run: no-op; `.lumem/local/` gitignored
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): init with automatic config and gitignore`

### T16: `lumem install` ✅
**What**: `install [--harness <id>] [--global] [--copy] [--dry-run]` — plan+apply on the selected harnesses; the Codex post-install step prints the `/hooks` instruction.
**Where**: `src/cli/install.ts` + integration tests
**Depends on**: T14, T15 · **Reuses**: plan/apply · **Requirement**: CLI-02, INST-08, CLI-10, INST-09 (message)
**Done when**:
- [ ] `--dry-run` prints the diff and writes nothing (asserts the fs is intact); N identical runs; global scope goes to the fake home
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): idempotent install with dry-run`

### T17: `lumem uninstall` [P] ✅
**What**: removes the lockfile's artifacts, restores managed blocks, preserves memory; `--purge` deletes `.lumem/` with a confirmation.
**Where**: `src/cli/uninstall.ts` + round-trip test
**Depends on**: T16 · **Reuses**: removeManagedBlock, lockfile · **Requirement**: CLI-04, OPS-06
**Done when**:
- [ ] **Round-trip**: a repo with the user's `CLAUDE.md`/`AGENTS.md` → install → uninstall ⇒ byte-identical outside `.lumem/` (P1.2 Independent Test)
- [ ] Without `--purge`, `memory/` survives
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): reversible uninstall with explicit purge`

### T18: `lumem sync` [P] ✅
**What**: reconciles disk × manifest × lock; updates whatever changed version; drift ⇒ warns and requires `--force`; exit 3 on drift.
**Where**: `src/cli/sync.ts` + integration tests
**Depends on**: T16 · **Reuses**: plan/apply/drift · **Requirement**: CLI-03, INST-04
**Done when**:
- [ ] File edited by the user: sync warns, does not touch it; `--force` overwrites with a backup
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): sync with drift protection`

### T19: Extended doctor [P] ✅
**What**: doctor also reports: lock×disk drift, version < minimum, Codex hooks installed → `/hooks` trust reminder, last consolidation failure (reads the log).
**Where**: `src/cli/doctor.ts` (modified) + tests
**Depends on**: T12, T16 · **Reuses**: drift, mode · **Requirement**: INST-09, HARN-04
**Done when**:
- [ ] Each condition gets its own section in the report; exit 3 on drift/incompatibility
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): doctor with drift, versions and trust`

## Phase 2 — M2

### T20: Secret scanner ✅
**What**: `scanSecrets(text)` — regexes (AKIA, PEM, JWT, `KEY=` with high entropy ≥20 chars, common tokens) + Shannon entropy; positive/negative corpus.
**Where**: `src/core/shared/secrets.ts` + tests
**Depends on**: T2 · **Reuses**: — · **Requirement**: MEM-05
**Done when**:
- [ ] Corpus: ≥12 positives detected, ≥12 negatives clean (normal code, commit hashes, UUIDs do not flag)
**Tests**: unit · **Gate**: quick
**Commit**: `feat(shared): secret scanner with regex+entropy`

### T21: Memory store ✅
**What**: fact parse/serialize (exactly the PRD §5.3 format), tolerant parser (a malformed entry is skipped+logged), derived id `sha256[0:8]`, atomic `writeStore` as the **choke point** with `scanSecrets` (refusal = typed error).
**Where**: `src/core/memory/store.ts` + golden tests
**Depends on**: T20 · **Reuses**: fsx, secrets · **Requirement**: MEM-01, MEM-02, MEM-05
**Done when**:
- [ ] Goldens round-trip parse→serialize byte-identical; malformed does not crash; a write with a secret throws `SecretRefusal`
**Tests**: unit · **Gate**: quick
**Commit**: `feat(memory): store with provenance and scrub on write`

### T22: Injection budget [P] ✅
**What**: `buildInjection(stores, budgetBytes)` — priority recent corrections → project → preference; truncates whole entries; never exceeds the ceiling.
**Where**: `src/core/memory/budget.ts` + tests
**Depends on**: T21 · **Reuses**: store · **Requirement**: MEM-03
**Done when**:
- [ ] Property test: for any store, output ≤ budget; priority order asserted
**Tests**: unit · **Gate**: quick
**Commit**: `feat(memory): injection with budget and priority`

### T23: Soft limits + state.json [P] ✅
**What**: `checkSoftLimits(store, config)` ⇒ `CompactionFlag[]` persisted in `local/state.json`; reading/writing `LocalState`.
**Where**: `src/core/memory/limits.ts` + tests
**Depends on**: T21 · **Reuses**: fsx · **Requirement**: MEM-04 (flags)
**Done when**:
- [ ] Line AND byte limits per type; the flag persists and deduplicates
**Tests**: unit · **Gate**: quick
**Commit**: `feat(memory): soft limits and compaction flags`

### T24: `lumem memory list|show|search` [P] ✅
**What**: human-readable output (derived ids shown) + `--json`; search = case-insensitive substring over the body.
**Where**: `src/cli/memory-read.ts` + integration tests
**Depends on**: T21, T22 · **Reuses**: store · **Requirement**: CLI-07, CLI-11
**Done when**:
- [ ] Displayed ids work as an argument to show; global+project scopes merged with the origin marked
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): memory list/show/search`

### T25: `lumem memory add|edit|forget` [P] ✅
**What**: manual writing (add with `--type/--scope/--conf`, src=`manual`), edit opens `$EDITOR` or accepts `--body`, forget by id; everything goes through the choke point (a secret is refused with a clear message).
**Where**: `src/cli/memory-write.ts` + integration tests
**Depends on**: T21 · **Reuses**: store · **Requirement**: CLI-08
**Done when**:
- [ ] Add writes the exact PRD format; forget removes by id; a secret is refused with exit 1 and a reason
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): memory add/edit/forget with scrub`

### T26: `lumem memory context` ✅
**What**: a command (hidden from the main help) that prints the injection block — the single source used by the skill (M2) and by the inject hook (M3).
**Where**: `src/cli/memory-context.ts` + tests
**Depends on**: T22 · **Reuses**: buildInjection · **Requirement**: MEM-03
**Done when**:
- [ ] Output ≤ the config budget; empty ⇒ empty string, exit 0 (never an error)
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): memory context for injection`

### T27: Final lumem-memory skill ✅
**What**: the real SKILL.md: the read/write contract during a session, the injection instruction for degraded mode ("run `lumem memory context` and read it before acting"), explicit write triggers.
**Where**: `assets/skills/lumem-memory/SKILL.md`
**Depends on**: T8, T26 · **Reuses**: — · **Requirement**: MEM-07
**Done when**:
- [ ] Frontmatter valid on both harnesses; **M2 exit**: a real Claude Code session uses the injected memory (manual verification recorded in STATE)
**Tests**: none (data) · **Gate**: build
**Commit**: `feat(assets): complete lumem-memory skill`

## Phase 3 — M3

### T28: Fail-open hook entrypoint [P] ✅
**What**: `hooks/main.ts` → the `lumem-hook.mjs` bundle: dispatch on argv `<harnessId> <event>`, full try/catch wrapper + deadline (`inject` 2000ms / capture 100ms) + unconditional `exit 0`; manual stdin parsing; bundle test for **zero external imports**.
**Where**: `src/hooks/main.ts` + tests + build assertion
**Depends on**: T2 · **Reuses**: fsx (builtins-only) · **Requirement**: OPS-01, OPS-05
**Done when**:
- [ ] A handler that throws/hangs ⇒ exit 0 within deadline+margin; grep the bundle: no external `require`/`import`
**Tests**: unit + chaos-lite · **Gate**: quick + build
**Commit**: `feat(hooks): single bundled fail-open entrypoint`

### T29: Session journal [P] ✅
**What**: `appendSignal(sessionsDir, sessionId, signal)` — JSONL `O_APPEND`, `<iso>.jsonl` naming, the design's `Signal` types.
**Where**: `src/core/capture/journal.ts` + tests
**Depends on**: T2 · **Reuses**: fsx · **Requirement**: CAP-01
**Done when**:
- [ ] Concurrent appends do not corrupt lines (test with N writers)
**Tests**: unit · **Gate**: quick
**Commit**: `feat(capture): append-only JSONL journal`

### T30: Correction heuristics + redaction [P] ✅
**What**: `classifyPrompt(text, markers)` (markers from the config) and `redact(text, maxLen=500)` with secret scrubbing before writing to the journal.
**Where**: `src/core/capture/heuristics.ts` + tests
**Depends on**: T20 · **Reuses**: secrets · **Requirement**: CAP-02, CAP-03
**Done when**:
- [ ] Marks "na verdade…"/"nunca…"; does NOT write to durable memory (only returns a signal); a prompt with a token is redacted
**Tests**: unit · **Gate**: quick
**Commit**: `feat(capture): correction heuristic that only marks`

### T31: Recovery detection ✅
**What**: `detectRecovery(journalPath, newCmd)` — bounded tail of the session's own journal; a previous failure + a success now ⇒ a `recovery` signal.
**Where**: `src/core/capture/recovery.ts` + tests
**Depends on**: T29 · **Reuses**: journal · **Requirement**: CAP-02
**Done when**:
- [ ] The fail→pass scenario is detected; pass→pass is not; the tail is bounded (does not read the whole file)
**Tests**: unit · **Gate**: quick
**Commit**: `feat(capture): recovered-command signal`

### T32: Hook event handlers ✅
**What**: `inject` (reuses the `memory context` logic — a direct core import, not a subprocess), `capture-prompt`, `capture-tool`, `end` (writes the `session end` signal; the runner spawn lands in T40); project resolution `CLAUDE_PROJECT_DIR` → the payload's `cwd`; a `cwd` without `.lumem/` ⇒ discarded with a log.
**Where**: `src/hooks/handlers/*.ts` + integration tests (fake stdin)
**Depends on**: T26, T28, T29, T30, T31 · **Reuses**: budget, journal, heuristics · **Requirement**: CAP-01..03, CONS-06 (partial)
**Done when**:
- [ ] Each event with a real payload from both harnesses (fixtures) produces the expected signal/stdout; an orphaned cwd is discarded
**Tests**: integration · **Gate**: full
**Commit**: `feat(hooks): handlers inject/capture/end`

### T33: Per-harness hook installation [P] ✅
**What**: final templates + install wiring: Claude Code = managed block in `.claude/settings.json` (merge-json); Codex = `.codex/hooks.json` (own-file; a block if pre-existing); commands point at the absolute bundle.
**Where**: `assets/harness/*/hooks.tmpl.json`, `src/core/install/hooks-config.ts` + tests
**Depends on**: T14, T16, T28 · **Reuses**: managed-block, apply · **Requirement**: CONS-06, INST-05
**Done when**:
- [ ] Install into fake homes registers hooks in the right formats; a user settings.json with their own hooks is preserved; uninstall removes only the lumem block
**Tests**: integration · **Gate**: full
**Commit**: `feat(install): hook registration on both harnesses`

### T34: Latency bench (sequential — bench is not parallel-safe) ✅
**What**: `npm run bench:hook` — 100 real executions of `node dist/lumem-hook.mjs codex capture-prompt < fixture`, p95 reported; fails if ≥ 150ms; a CI step.
**Where**: `scripts/bench-hook.mjs`
**Depends on**: T32 · **Reuses**: the bundle · **Requirement**: CAP-04
**Done when**:
- [ ] p95 < 150ms on the dev machine recorded; **M3 exit** checklist: signals appear in a real journal on both harnesses (manual verification in STATE)
**Tests**: bench · **Gate**: bench
**Commit**: `test(hooks): p95 latency bench`

## Phase 4 — M4

### T35: Consolidation gate [P] ✅
**What**: `checkGate(state, journalPath, config)` — 4 conditions (≥N signals, ≥N min, ≥N h since the last one, no lock); cheap (counts lines, reads timestamps).
**Where**: `src/core/consolidate/gate.ts` + tests
**Depends on**: T23, T29 · **Reuses**: state, journal · **Requirement**: CONS-01
**Done when**:
- [ ] 4 conditions × pass/fail matrix; the refusal reason is in the result
**Tests**: unit · **Gate**: quick
**Commit**: `feat(consolidate): 4-condition gate`

### T36: Lock with TTL [P] ✅
**What**: `acquireLock(localDir, ttlMin=30)` — `O_CREAT|O_EXCL` with `{pid, startedAt}`; stale (> TTL) removed and re-acquired; `releaseLock`.
**Where**: `src/core/consolidate/lock.ts` + tests (contention with 2 processes)
**Depends on**: T2 · **Reuses**: fsx · **Requirement**: CONS-05
**Done when**:
- [ ] 2 concurrent acquisitions ⇒ exactly 1 wins; a stale lock is re-acquirable
**Tests**: unit · **Gate**: quick
**Commit**: `feat(consolidate): O_EXCL lock with stale TTL`

### T37: Patch — schema + atomic application [P] ✅
**What**: zod schema `ConsolidationPatch`; `applyPatch(patch, stores)` — an invalid/secret-carrying entry is dropped individually + logged; a structural failure ⇒ nothing changes; writing goes through the store's choke point.
**Where**: `src/core/consolidate/patch.ts` + tests (valid/invalid/secret/contradiction fixtures)
**Depends on**: T21 · **Reuses**: store (T21) · **Requirement**: CONS-03, MEM-05, MEM-02
**Done when**:
- [ ] add/replace/remove apply with provenance; an unparseable patch ⇒ memory byte-identical
**Tests**: unit · **Gate**: quick
**Commit**: `feat(consolidate): validated patch with atomic application`

### T38: Final lumem-consolidate skill [P] ✅
**What**: the complete prompt: PRD §5.4 anti-junk rules, the patch's JSON schema embedded with examples, compaction instruction when flags are present.
**Where**: `assets/skills/lumem-consolidate/SKILL.md`
**Depends on**: T8 · **Reuses**: T37's schema (copied as text) · **Requirement**: CONS-03
**Done when**:
- [ ] The schema in the prompt == the zod schema (a test comparing the prompt's example against the real zod)
**Tests**: unit (the prompt's example validates) · **Gate**: quick
**Commit**: `feat(assets): consolidation prompt with anti-junk rules`

### T39: Detached runner ✅
**What**: `runner/main.ts` → `lumem-runner.mjs`: re-checks the gate, the lock, assembles the prompt (skill + journal + current memory), invokes the descriptor's `headless` (command+modelFlag+defaultModel; runtime `auto` = the session's harness), parses, `applyPatch`, updates `state.json`, logs, releases the lock.
**Where**: `src/runner/main.ts` + integration tests (LLM = a mock script on the PATH)
**Depends on**: T4, T35, T36, T37, T38 · **Reuses**: everything from the phase · **Requirement**: CONS-02, CONS-04
**Done when**:
- [ ] The mock returns a valid patch ⇒ memory updated; the mock exits ≠0/returns invalid JSON ⇒ memory intact, lock released, logged
**Tests**: integration · **Gate**: full
**Commit**: `feat(runner): detached headless consolidation`

### T40: SessionEnd → runner spawn ✅
**What**: the `end` handler gains: a cheap gate pre-check ⇒ `spawn(execPath, [runner], {detached, stdio:'ignore'}).unref()`; the hook returns immediately.
**Where**: `src/hooks/handlers/end.ts` (modified) + test
**Depends on**: T32, T39 · **Reuses**: gate, runner · **Requirement**: CONS-02
**Done when**:
- [ ] The hook exits in < the deadline with the runner alive (the test observes a pidfile/side effect); a failed gate ⇒ no spawn
**Tests**: integration · **Gate**: full
**Commit**: `feat(hooks): detached consolidation trigger`

### T41: `lumem memory consolidate` [P] ✅
**What**: the manual command: `--force` (skips the gate, not the lock), `--dry-run` (prints the patch without applying — it does run the LLM, warns about the cost).
**Where**: `src/cli/memory-consolidate.ts` + tests (mock LLM)
**Depends on**: T39 · **Reuses**: runner core · **Requirement**: CLI-09, CLI-10
**Done when**:
- [ ] `--force` consolidates with a failed gate; `--dry-run` leaves memory intact and shows the patch
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): manual consolidation with force and dry-run`

### T42: Compaction via flags [P] ✅
**What**: the runner includes the files carrying a `CompactionFlag` in the prompt + the compaction instruction; after applying it clears the flags; the result respects the soft limits.
**Where**: `src/runner/main.ts` (modified), `src/core/consolidate/patch.ts` (if needed) + tests
**Depends on**: T23, T39 · **Reuses**: limits, runner · **Requirement**: MEM-04
**Done when**:
- [ ] An over-the-limit fixture + a compacting mock ⇒ the file returns within the limit, with decisions/risks preserved in the fixture
**Tests**: integration · **Gate**: full
**Commit**: `feat(consolidate): compaction triggered by soft limit`

### T43: Final lumem-consolidator agent [P] ✅
**What**: the headless agent definition (cheap model by default, minimal permissions, a reference to the consolidation skill) in both harnesses' formats.
**Where**: `assets/agents/lumem-consolidator.md`
**Depends on**: T8 · **Reuses**: — · **Requirement**: CONS-04
**Done when**:
- [ ] Installable by both harnesses; **M4 exit** manual checklist in STATE after real use
**Tests**: none (data) · **Gate**: build
**Commit**: `feat(assets): agent consolidator`

## Phase 5 — M5

### T44: Hook chaos suite [P] ✅
**What**: systematic injection: an exception in each handler, a timeout, malformed/empty/huge stdin, a full disk (mocked fs), a read-only journal ⇒ always exit 0 + a log; covers all 4 events.
**Where**: `test/chaos/hooks.test.ts`
**Depends on**: T32, T40 · **Reuses**: the real bundle · **Requirement**: OPS-01
**Done when**:
- [ ] Events × failures matrix 100% exit 0; no unintended stderr
**Tests**: chaos · **Gate**: full
**Commit**: `test(hooks): complete fail-open chaos`

### T45: Zero-network audit [P] ✅
**What**: a static test (grep for `http`/`fetch`/`net` outside install/sync) + a runtime one (runs doctor/status/memory/consolidate-mock with the DNS resolver blocked) proving NFR-3.
**Where**: `test/no-network.test.ts`
**Depends on**: T41 · **Reuses**: — · **Requirement**: OPS-02
**Done when**:
- [ ] All runtime commands pass with the network blocked
**Tests**: integration · **Gate**: full
**Commit**: `test: zero-network runtime audit`

### T46: Log rotation [P] ✅
**What**: implements real rotation in `log.ts` (max size + N files), replacing T2's stub.
**Where**: `src/core/shared/log.ts` (modified) + tests
**Depends on**: T2 · **Reuses**: fsx · **Requirement**: OPS-09
**Done when**:
- [ ] A log over the limit rotates; at most N old files
**Tests**: unit · **Gate**: quick
**Commit**: `feat(shared): log rotation`

### T47: Packaging + zero-install [P] ✅
**What**: `files` whitelist, `prepublishOnly`, bin permissions; validate `npm pack` + tarball installation + `npx` in a clean dir; publish the name per decision #1 (recorded in T1).
**Where**: `package.json`, `scripts/verify-pack.sh`
**Depends on**: T1, T41 · **Reuses**: — · **Requirement**: OPS-03
**Done when**:
- [ ] `npm pack` + tarball install in tmp: `lumem doctor` works; the tarball has no leftover or missing assets
**Tests**: integration (script) · **Gate**: build + script
**Commit**: `chore: packaging npx-ready`

### T48: README + docs ✅
**What**: README (quickstart, memory model, degraded modes, uninstall), config and troubleshooting docs; **M5 exit**: publication checklist.
**Where**: `README.md`, `docs/`
**Depends on**: T44, T45, T46, T47 · **Reuses**: the specs · **Requirement**: P3.1 AC4
**Done when**:
- [ ] Quickstart runnable from scratch by an outsider; the sections cover the 4 topics
**Tests**: none · **Gate**: full (final general regression)
**Commit**: `docs: README and usage guide`

---

## Diagram-Definition Cross-Check

| Task | Depends on (body) | Diagram | Status |
|---|---|---|---|
| T1 | — | root | ✅ |
| T2 | T1 | T1→T2 | ✅ |
| T3 | T1 | T1→T3 | ✅ |
| T4 | T3 | T3→T4 | ✅ |
| T5 | T2, T3 | T2→T5, T3→T5 | ✅ |
| T6 | T3 | T3→T6 | ✅ |
| T7 | T4, T5, T6 | converge on T7 | ✅ |
| T8 | T1 | T1→T8 | ✅ |
| T9 | T2 | T2→T9 | ✅ |
| T10 | T2 | T2→T10 | ✅ |
| T11 | T2, T8 | T2→T11 (*T8 note) | ✅ |
| T12 | T2 | T2→T12 | ✅ |
| T13 | T11, T12 | T11,T12→T13 | ✅ |
| T14 | T9, T10, T13 | T9,T10,T13→T14 | ✅ |
| T15 | T5, T6, T12 | T5,T6,T12→T15 | ✅ |
| T16 | T14, T15 | T14,T15→T16 | ✅ |
| T17 | T16 | T16→T17 | ✅ |
| T18 | T16 | T16→T18 | ✅ |
| T19 | T12, T16 | T16→T19 (w/ T12) | ✅ |
| T20 | T2 | T2→T20 | ✅ |
| T21 | T20 | T20→T21 | ✅ |
| T22 | T21 | T21→T22 | ✅ |
| T23 | T21 | T21→T23 | ✅ |
| T24 | T21, T22 | T21,T22→T24 | ✅ |
| T25 | T21 | T21→T25 | ✅ |
| T26 | T22 | T22→T26 | ✅ |
| T27 | T8, T26 | T26→T27 (w/ T8) | ✅ |
| T28 | T2 | T2→T28 | ✅ |
| T29 | T2 | T2→T29 | ✅ |
| T30 | T20 | T20→T30 | ✅ |
| T31 | T29 | T29→T31 | ✅ |
| T32 | T26, T28, T29, T30, T31 | converge on T32 | ✅ |
| T33 | T14, T16, T28 | T14,T16,T28→T33 | ✅ |
| T34 | T32 | T32→T34 | ✅ |
| T35 | T23, T29 | T23,T29→T35 | ✅ |
| T36 | T2 | T2→T36 | ✅ |
| T37 | T21 | T21→T37 | ✅ |
| T38 | T8 | T8→T38 | ✅ |
| T39 | T4, T35, T36, T37, T38 | converge on T39 | ✅ |
| T40 | T32, T39 | T32,T39→T40 | ✅ |
| T41 | T39 | T39→T41 | ✅ |
| T42 | T23, T39 | T39→T42 (w/ T23) | ✅ |
| T43 | T8 | T8→T43 | ✅ |
| T44 | T32, T40 | T32,T40→T44 | ✅ |
| T45 | T41 | T41→T45 | ✅ |
| T46 | T2 | T2→T46 | ✅ |
| T47 | T1, T41 | T1,T41→T47 | ✅ |
| T48 | T44, T45, T46, T47 | converge on T48 | ✅ |

`[P]` tasks in the same phase: none depends on another `[P]` sibling (T5 depends on T2, which belongs to a phase earlier than its parallel execution with T4/T6 — T2 finishes before the parallel window opens). T34 has no `[P]` because the bench is not parallel-safe. ✅

## Test Co-location Validation

| Task | Layer | Matrix requires | Task says | Status |
|---|---|---|---|---|
| T1 | infra/build | none | none (build+full gate) | ✅ |
| T2 | core/shared | unit | unit | ✅ |
| T3 | core/harness + adapters | unit | unit | ✅ |
| T4 | adapters JSON | unit via schema | unit | ✅ |
| T5, T6 | core/harness | unit | unit | ✅ |
| T7 | cli | integration | integration | ✅ |
| T8 | assets | none | none | ✅ |
| T9–T13 | core/install | unit | unit | ✅ |
| T14 | core/install (real I/O) | unit→integration (broader) | integration | ✅ |
| T15–T19 | cli | integration | integration | ✅ |
| T20–T23 | core | unit | unit | ✅ |
| T24–T26 | cli | integration | integration | ✅ |
| T27 | assets | none | none | ✅ |
| T28 | hooks entry | unit+chaos | unit+chaos-lite (full chaos in T44) | ✅ |
| T29–T31 | core/capture | unit | unit | ✅ |
| T32 | hooks handlers | integration | integration | ✅ |
| T33 | core/install + assets | integration | integration | ✅ |
| T34 | bench | bench | bench | ✅ |
| T35–T37 | core/consolidate | unit | unit | ✅ |
| T38 | assets (w/ schema test) | none/unit | unit | ✅ |
| T39–T42 | runner + cli | integration | integration | ✅ |
| T43 | assets | none | none | ✅ |
| T44 | chaos | chaos | chaos | ✅ |
| T45 | audit | integration | integration | ✅ |
| T46 | core/shared | unit | unit | ✅ |
| T47 | packaging | script | integration script | ✅ |
| T48 | docs | none | none (+final full) | ✅ |

No test deferral: T28 has chaos-lite at creation time and T44 broadens it (it does not replace it — T28 already verifies exit 0 on its own). ✅

## Granularity Check

48 tasks; each one = 1 module/1 command/1 asset. ⚠️ cases evaluated: T7 (CLI skeleton + 2 commands — cohesive, it is the commander bootstrap), T32 (4 handlers — same directory, same stdin contract, cohesive), T39 (runner — 1 process, 1 flow). No ❌.
