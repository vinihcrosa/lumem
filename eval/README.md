# Consolidation prompt eval

`assets/skills/lumem-consolidate/SKILL.md` is the product. If `project.md` fills up
with obvious or wrong lines, the prompt is bad — and no unit test can tell you,
because the model is non-deterministic and `expect(patch).toEqual(...)` is
meaningless against it.

This harness makes the prompt improvable: it runs the **real** prompt through the
**real** code path (`runConsolidation`, `force: true`, `dryRun: true`) against
eight hand-written sessions, k times each, and scores what came back. Change the
prompt, re-run, compare the numbers.

## Run it

```sh
npm run eval -- --mock          # replays canned answers: no network, no tokens
npm run eval                    # real: spawns the harness CLI once per fixture per run
npm run eval -- --help
```

`--mock` is the mode for developing the harness. `--mock` never proves anything
about the prompt — it replays answers that were written by hand. Only a real run
measures the prompt.

Useful flags: `--runs <k>` (default 3), `--fixture <name>` (repeatable or
comma-separated), `--harness <id>` (default `claude-code`), `--baseline <file>`,
`--update-baseline`, `--results-dir <dir>`, `--no-results`, `--json`.

Exit codes: `0` everything held, `1` a hard gate failed / an expectation failed /
a baseline hard gate regressed, `2` bad usage.

Every run writes `eval/results/<ISO>.json` with the full per-run detail, including
each patch. That directory is gitignored.

## Why it is not in CI

A real run spends tokens and needs the network, and its numbers move run to run.
Wiring that to a pull request would either burn money on every push or teach
everyone to ignore a flaky red. Run it deliberately, when you touched the prompt.

The harness's own tests (`eval/*.test.ts`) do run in the normal suite. They are
mock-only and can never reach the network: `runEval` throws if real mode is
requested while `VITEST` is set.

## The metrics

| Metric | What it is | Reading it |
|---|---|---|
| `schemaValid` | share of runs where `parsePatch` returned a patch | **Hard gate: must be 100%.** Below that, the model is emitting prose or unknown keys and the patch is dropped silently in production. |
| `secretLeak` | share of runs where `scanSecrets` flagged an emitted body | **Hard gate: must be 0%.** The write path would refuse it anyway; a prompt that produces credentials at all is broken. |
| `emptyPatchRate` | share of runs returning `add`/`replace`/`remove` all empty | Target depends on the fixture. `trivial-session` and `repo-duplication-bait` want 100%; the rest want 0%. A run that produced no patch counts as non-empty — it is a failure, not restraint. |
| `addCount` | mean `add` entries per run | Checked against the fixture's `minAdds`/`maxAdds`. Creeping upward across fixtures is the classic prompt regression. |
| `expectationsMet` | share of (run × assertion) pairs that held | The headline soft score. Every failed assertion is printed under the table with its detail. |
| `variance` | `verdictAgreement` (share of runs on the majority side of empty/non-empty) and `addSpread` (max − min adds) | Low agreement means the prompt is not deciding, the sampler is. A prompt that is right 2 times in 3 is not a prompt you can ship. |

A fixture is `PASS` only when both hard gates held **and** every assertion held on
every run.

## Reading a regression

1. **Hard gate red** → stop. Look at the printed failure, then at the offending
   run's `patch` in `eval/results/<ISO>.json`. A `schemaValid` drop is usually a
   prompt edit that weakened "emit the patch object and nothing else". A
   `secretLeak` is always the secrets section.
2. **`expectationsMet` down, hard gates green** → read the failure lines under
   the table. They name the fixture, the run, the assertion and what was found:
   `repo-duplication-bait run 1 mustNotContain: found tsup`.
3. **`emptyPatchRate` down on `trivial-session`** → the prompt lost its
   calibration. This is the single most important number in the table: the
   dominant failure mode is writing something to look useful.
4. **`verdictAgreement` down, everything else flat** → the prompt got ambiguous
   rather than wrong. Re-run with a bigger `--runs` before believing it.

Baseline comparison, when `eval/baseline.json` exists: a hard-gate loss against
the baseline is a `REGRESSION` and exits nonzero; soft drops (expectations beyond
5 points, empty-rate beyond 20 points, adds beyond 0.5) are `warning` lines and
do not fail. No baseline ships in the repo — record one from a **real** run with
`npm run eval -- --update-baseline`, because a mock baseline is all 100% and every
real run would "regress" against it.

## The fixtures

| Fixture | What it tests |
|---|---|
| `trivial-session` | Six signals of reading files and one green command. The calibration case: the right answer is the empty patch. |
| `explicit-correction` | The user rejects JWT and says why. One fact, carrying the reason — not just the decision. |
| `learned-trap` | A `recovery` signal: the e2e suite needs the compose stack up. One project fact naming the prerequisite. |
| `contradicts-existing` | Memory already holds "auth is undecided"; the session settles it. Must `replace` `3808e284`, not stack a second fact. |
| `repo-duplication-bait` | `package.json`, `tsup.config.ts`, two green builds. Everything learnable is in the repo — anti-junk rule 1. Empty patch. |
| `secret-in-prompt` | An AWS-key-shaped value and a `[REDACTED:env-secret]` span in the prompt, with a real lesson next to them. Name the variable, never the value. |
| `preference-signal` | A durable working preference. Must land as `preference`/`global`, not as a project fact. |
| `noisy-long-session` | 66 signals, two real lessons buried in churn. Volume must not produce volume. |

## Adding a fixture

1. `mkdir eval/fixtures/<name>` and write `journal.jsonl` — one `Signal` per line
   (see `src/core/capture/journal.ts`). Draw it from a session that actually
   happened; invented journals produce invented scores.
2. Optionally seed `memory/`. The file name decides where it lands:
   `project.md` → project scope, `correction.md` → project scope,
   `preference.md` → global scope, `global-correction.md` → global scope. Use the
   exact on-disk fact format (bullet + indented `<!-- src:… conf:… -->`).
3. Write `expect.json`:

```json
{
  "description": "what this session was, in one or two sentences",
  "expect": {
    "emptyPatch": false,
    "minAdds": 1,
    "maxAdds": 2,
    "mustReplaceId": "3808e284",
    "mustNotContain": ["tsup", "TypeScript"],
    "shouldMentionAny": ["docker", "compose"],
    "mustAddTypeScope": ["preference/global"],
    "noSecrets": true
  }
}
```

Every field is optional except that `noSecrets: true` is required — a test
enforces it. Text assertions are case-insensitive and run over `add[].body` and
`replace[].body`; the secret scan additionally covers `remove[].reason`.
`mustReplaceId` must name a fact the fixture actually seeded — a test recomputes
the id from `memory/` and fails if it drifts.

4. Add `eval/mock-responses/<name>.json` — the answer a good model would give.
   `responses` may hold patch objects (readable) or raw stdout strings (use these
   to exercise fenced or noisy output); run `i` replays entry `i % length`, so
   several entries give the variance metric something deterministic to chew on.
   Mock mode refuses to run a fixture with no response file.

5. `npx vitest run eval/` — the fixture tests validate every journal line, the
   `expect.json` schema, the seeded memory and the canned responses.

## How it works

`materializeFixture` builds a throwaway project in `os.tmpdir()`: config, the
journal under `.lumem/local/sessions/`, the seeded memory under
`.lumem/memory/` and `<home>/.lumem/memory/`. The adapters and the skill asset
come from the real repo, so the prompt under test is the shipped one, byte for
byte. `runConsolidation` then runs with `force: true` (waives the gate, never the
lock) and `dryRun: true` (parses the patch, writes no memory file). Both the
project dir and the home dir are inside the temp root, so nothing can reach the
real repo or the real home — a test asserts exactly that.

## Files

| File | What it holds |
|---|---|
| `cli.ts` | `npm run eval` entrypoint, three lines |
| `cli-main.ts` | flag parsing, the run/report/compare flow, exit codes |
| `run-eval.ts` | `runEval` — materialize, run, score, aggregate |
| `fixtures.ts` | loading, validating and materializing fixtures |
| `mock.ts` | canned-response loading and the replay `RunLlm` |
| `score.ts` | per-run scoring and per-fixture aggregation |
| `report.ts` | table rendering, results file, baseline build/compare |
| `types.ts` | the report shapes |
