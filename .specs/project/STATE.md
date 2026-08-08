# STATE — lumem

## Decisions

- [2026-08-07] **Project memory committed by default.** Knowledge becomes a shared artifact reviewable in a PR. The session journal is never committed. (PRD §5.2)
- [2026-08-07] **Consolidation runs in a separate, detached process.** `SessionEnd` fires it and returns immediately; it never blocks shutdown. (PRD §6)
- [2026-08-07] **The correction heuristic only marks a signal.** Whether it becomes a fact is decided by consolidation (the LLM). Never a direct write to durable memory. (PRD §6)
- [2026-08-07] **`core/` is harness-agnostic.** Adapters are declarative descriptors in `src/adapters/*.json`; adding a harness = adding a file. (PRD §15)
- [2026-08-07] **V1 spec written from the PRD** with the PRD defaults assumed for the open decisions (see Open Decisions below and spec §Assumed decisions).
- [2026-08-07] **PRD §7.1 capability table re-verified** against official docs and source. Deltas recorded in design.md §0 — Codex: 11 stable hook events on by default (flag `hooks`; `codex_hooks` = deprecated alias), Windows supported, skills in `.agents/skills` (not `.codex/skills`), `SessionStart` injects context via stdout. The V1 descriptors use the verified facts.
- [2026-08-07] **Primary injection = hook stdout on both harnesses.** The fallback chain (`injection[]` in the descriptor) stays as data, for a future harness.
- [2026-08-07] **Codex hook config lives in `.codex/hooks.json`** (not `[hooks]` in `config.toml`) — avoids a TOML parser/writer in V1.
- [2026-08-07] **Windows V1 = skill-only by scope decision**, not by limitation (Codex supports hooks on Windows via `command_windows`). Shrinks the test matrix.
- [2026-08-07] **Hook bundle with zero deps** (not even zod; stdin validated by hand) for p95 < 150ms; zod stays in the CLI and in the detached runner.

## Open Decisions (PRD §13 — assumed with a default, confirm with the author)

1. ~~**npm name.**~~ **RESOLVED** [2026-08-07]: `npm view lumem` → 404, name is free. The package publishes as `lumem`.
2. **Project memory committed?** Assumed: **yes** (PRD default). Revert to gitignored+opt-in only if PRs get noisy.
3. **Consolidation runtime.** Assumed: the harness in use (`claude -p` / `codex exec`) with a cheap model by default, configurable in `lumem.config.json`. Avoids an extra credential; cost is held down by the gate.
4. **Two harnesses in the same repo.** Assumed: **shared memory** (same project, same knowledge). Segregate only if a real conflict shows up.
5. **Minimum Claude Code and Codex versions.** Frozen in the descriptors: Claude Code ≥ 2.1.224, Codex ≥ 0.147.0 — chosen because they were the stable release on the verification date, **not** because they are the oldest compatible version. Observed consequence in smoke: the author's machine runs Codex 0.144.6, so `doctor` exits 3 with an incompatibility warning (correct behavior by design, but noisy if 0.144.6 already supports what we use). **Pending:** find out which version made hooks stable and `.agents/skills` the skills directory; lower the minimum to that. Do not guess — verify against the `openai/codex` changelog.

## Blockers

(none — V1 complete)

## Current state (2026-08-08)

**48/48 tasks, M0–M5 complete**, plus the eval harness and dogfooding. 68 commits, 1128 tests across 46 files, `npm run verify` green on three consecutive runs. lumem is installed in this repo and running on itself.

Verified against the real binary, not only in tests:
- `doctor` identifies both installed harnesses with grade and fallbacks
- install → uninstall gives every user file back byte-identical, including a pre-existing `.claude/settings.json`
- end-to-end memory cycle through the installed bundle: prioritized injection, correction captured in the journal, secret refused with exit 1
- the packed tarball installs into a clean dir and runs the full CLI (`verify-pack.sh`)
- hook latency p95 33 ms (NFR-2 ceiling: 150 ms); 185 chaos invocations, all exit 0

### Integration bugs found by smoke/chaos (all with a regression test)

The pattern that kept repeating: each piece passed in isolation, the contract between them was wrong. They only showed up once the real path was exercised.

1. **The lockfile stored the source hash for a rendered artifact** → replan reported a permanent conflict, breaking FR-14. Fixed with `contentHash`.
2. **Same bug in `detectDrift`** (missed in the first fix) → `doctor` would exit 3 and `sync` would scream drift on every healthy project.
3. **Bundles symlinked into the npx cache** → the link dangles when the cache is pruned and the hook dies. Bundle and hook-config are now always copied.
4. **`parsePatch` choked on the harness envelope** (`claude -p --output-format json`) → consolidation with claude-code would never have worked.
5. **The user's `settings.json` was replaced wholesale** → it destroyed permissions/env/hooks. It now merges with a `__lumem__` marker, and uninstall unmerges while preserving post-install edits.
6. **`probeVersion` hung on the pipe** when a grandchild holds stdout (`codex --version` on a cold cache, ~43s). Capture now goes through a file.
7. **Build race between suites** (`tsup --clean` wiping `dist/` under parallel spawn) → broke `npm run verify`. `globalSetup` builds once.

## Decisions taken during execution (unprompted — revert if you disagree)

- **CLI output in English.** Reason: public npm package at M5. Isolated commit (`refactor(cli): saída do usuário toda em inglês`). Superseded on 2026-08-08 by a broader call from the author: English everywhere in the repo, industry standard, regardless of the language spoken in conversation. Specs and docs were translated; commits up to `9ab512a` remain in Portuguese in git history and were left alone — rewriting 62 commits buys nothing. Commit subjects quoted inside `tasks.md` are the translated plan text and no longer string-match `git log`.
- **CLI subagents never touch `src/cli/index.ts`**: they export `registerX(program)` and the orchestrator wires it up. Avoids conflicts between parallel agents.

## Real gaps before production use

- **Consolidation has now run against a real model** — see "First real eval run" below. What is still missing is the loop end to end *in a live session*: a `SessionEnd` hook firing the detached runner on a journal the agent produced by itself, rather than the eval harness driving it. lumem is installed in this repo, so that happens on its own; the thing to watch is whether facts show up unprompted and whether they survive review (>60%).
- The Codex minimum sits at 0.147.0 because it is the current release, not because it is the oldest compatible one — see open decision #5.

## Todos

- [x] Re-verify the §7.1 capability table against current Claude Code and Codex versions — done 2026-08-07, result in design.md §0
- [x] M0: check availability of the name `lumem` on the npm registry — done in T1: free (404)

## Lessons

- [2026-08-07] A harness capability table in a PRD ages within weeks (Codex: hooks went experimental→stable, skills moved directory). Harness facts belong in versioned descriptors + `doctor`, never in a doc alone.

## Deferred Ideas

- `SecretHit` should carry `length`/`end` on top of `index`. Without it, `redact` (T30) re-derives the secret's span from a format heuristic. It works and it is tested, but it is avoidable fragility on a security path — when touching `secrets.ts`, add the field and delete `spanEnd()`.

- One file per fact (merge-conflict mitigation for `project.md`) — post-V1
- Compiled binary if Node cold start does not meet NFR-2 — evaluate after measuring in M3

## Preferences

- Everything written in the repo is in English — code, comments, CLI output, specs, docs, commit messages. The author speaks Portuguese in conversation; that does not carry into the artifacts.

## First real eval run (2026-08-08)

`npm run eval` against the live model, 8 fixtures × 3 runs. Result: **7/8 pass**, schema 100%, secret leaks 0, hard gates clean.

What the prompt already gets right — and it is the hardest part:
- **Calibration.** `trivial-session` and `repo-duplication-bait` both returned an empty patch on all three runs. Writing nothing when there is nothing to write is the dominant failure mode of this kind of prompt, and it did not fail once.
- Corrections keep their reason; the `recovery` signal became a pitfall fact; the contradiction produced a `replace` rather than a second `add`; the 66-signal noisy session produced 2 facts, not 66.

The one failure, and why it is the prompt's fault:
- `preference-signal` run 0 emitted `correction/global` where the fixture requires `preference/global`. Runs 1 and 2 got it right — 1-in-3 variance.
- Two of the prompt's own type rules covered the same fact. A durable working habit that surfaced through a correction satisfies both "the user explicitly corrected the agent" and "true about this developer everywhere". The model was not guessing badly; the prompt had not decided.
- Fixed by a tiebreaker: the signal type does not decide the fact type. Ask what the fact *is*, not how you learned it. Three worked examples added.
- **Unverified.** Confirming the variance is gone needs another real run; mock replays fixed answers and cannot measure it.

Cost signal: the prompt is ~16.8 KB per call (measured, `promptBytes` in the results file).

## Releasing

Two workflows in `.github/workflows/`:

- **`ci.yml`** — every push to `main` and every PR. Lint + typecheck + tests on Node 20/22/24 (Linux) and 22 (macOS), one job that packs the tarball and drives the installed binary end to end, and a hook-latency bench. The bench runs with a relaxed budget (`BENCH_BUDGET_MS=400`): shared runners are slower and noisier than a laptop, so its job is catching a real regression, not re-measuring NFR-2. The number that counts is the local one (p95 ~33 ms).
- **`release.yml`** — publishes on a `v*` tag. Refuses to run if the tag disagrees with `package.json`, or if that version already exists on the registry. Publishes with `--provenance`.

To cut a release:

```bash
npm version patch      # or minor / major — bumps package.json and tags
git push --follow-tags
```

**One-time setup, and it can only be done by the repo owner:**

1. **Publish credentials.** Either (preferred) configure npm Trusted Publishing for `lumem` pointing at `vinihcrosa/lumem` + `release.yml`, which needs no long-lived token — or create an npm **Automation** token and add it as the `NPM_TOKEN` secret. The workflow works with either; with trusted publishing the `NODE_AUTH_TOKEN` line is simply unused.
2. **The repo must be public** for `--provenance` to work. On a private repo the publish step fails; drop the flag if it stays private.
3. The workflow references an `npm` environment. GitHub creates it on first use; add required reviewers there if a publish should need approval.

The eval harness is deliberately **not** in CI: it spends tokens and needs the network, which every other job is built to avoid.
