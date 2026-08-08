# TESTING — lumem

The project's testing contract (greenfield; derived from the strategy approved in design.md §Testing Strategy). Created in the Tasks phase; the npm scripts are born in T1.

## Test Coverage Matrix

| Code layer | Required type | Note |
|---|---|---|
| `src/core/**` (harness, install, memory, capture, consolidate, shared) | **unit** | vitest + `mkdtemp` fixtures; golden files for the fact parser and managed blocks |
| `src/cli/**` (commands) | **integration** | Runs the command against temp dirs (fake homes); asserts filesystem + `--json` stdout |
| `src/hooks/main.ts` (entrypoint) | **unit + chaos** | Chaos = exception, timeout, malformed stdin, full disk → always exit 0 |
| `src/runner/main.ts` | **integration** | LLM mocked by a fixture script on the PATH; never calls a real LLM in tests |
| `src/adapters/*.json` (descriptors) | **unit** (via schema) | Test validates each descriptor against the zod schema |
| `assets/**` (SKILL.md, agent, templates) | **none** | Data; validated indirectly by the install/manifest tests |
| Hook latency (NFR-2) | **bench** | Dedicated script; asserts p95 < 150 ms; runs as a separate CI step |

## Gate Check Commands

| Gate | Command | When |
|---|---|---|
| **quick** | `npm run check && npx vitest run <path-to-the-task-tests>` | End of every unit task |
| **full** | `npm run verify` (= `biome check . && tsc --noEmit && vitest run && npm run build`) | End of an integration task / last task of each phase |
| **build** | `npm run build` (tsup: `cli.js`, `lumem-hook.mjs`, `lumem-runner.mjs`) | Tasks that only touch build/packaging |
| **bench** | `npm run bench:hook` | T34 and CI (isolated step) |

`npm run check` = `biome check . && tsc --noEmit`.

## Parallelism Assessment

| Type | Parallel-Safe | Why |
|---|---|---|
| unit | **Yes** | Each test creates its own `mkdtemp`; zero global state |
| integration | **Yes** | Core functions take explicit base dirs; the CLI e2e runs in a child process with its own env — never mutates the worker's global `process.env` |
| chaos | **Yes** | Same isolation as unit |
| bench | **No** | Timing-sensitive; runs sequentially in a dedicated CI step |

## Rules

- Tests are co-located with the task that creates the code — never a separate test task.
- The total test count only grows; the suite is always green before the task's commit.
- A real LLM never runs in tests; the runner is tested with an executable mock fixture on the PATH.
