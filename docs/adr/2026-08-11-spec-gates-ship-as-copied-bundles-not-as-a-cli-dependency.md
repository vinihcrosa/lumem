---
title: Spec gates ship as copied bundles, not as a CLI dependency
date: 2026-08-11
area: spec-driven
summary: The spec gates run from a bundle copied into each repo, so no project depends on a globally installed lumem being present at a matching version.
feature: 002-spec-driven
---
## Context

The spec-driven pipeline needs checks that cannot be forgotten — an unanswered question, an unclosed assumption, a design a reader can interpret two ways, a case owned by no task. Both reference systems studied before this feature reached the same conclusion independently and shipped Python scripts inside their skill directories.

lumem was the first of the three with a CLI already installed, already versioned by a lockfile, already covered by its test suite. Reusing it looked obvious.

The constraint that made it a fork: **lumem is installed per repository, and repositories drift to different versions.** A gate that calls `lumem spec lint` is a gate that depends on the binary being present *and* on its version matching what the skill expects, in every project, forever.

## Decision

The gates ship as `dist/lumem-spec.mjs`, built by `tsup` under the same zero-dependency contract as the hook bundle, and **copied** — never symlinked — into each project at `.lumem/bin/lumem-spec.mjs`.

The skills invoke it by path:

```bash
node .lumem/bin/lumem-spec.mjs lint docs/features/<slug> --phase tdd
```

Where no code-execution tool exists, the skills perform the same checks by reading the artifact, and say once that they are in a degraded mode.

## Alternatives considered

### CLI subcommands — `lumem spec lint`, `lumem spec next`

- **What it was:** three subcommands beside `memory lint` and `adr lint`, sharing the existing argument parsing, `--json` conventions and test suite.
- **In favour:** one runtime, one test suite, one version. Nothing new to build, ship or hash.
- **Against:** the skill now depends on the CLI being installed and version-compatible. A skill copied into a repo without lumem degrades to prose silently.
- **Why it lost:** version skew across repositories, in the author's words — "às vezes um repo tá com uma versão e outro em outra versão, aí começa a dar problema". A gate that is sometimes absent is worse than a gate that is always there, because nobody notices which repo lost it.

### Python scripts in the skill directories

- **What it was:** what both reference systems do. Stdlib-only, hand-written, no build step, readable as source in the target repo.
- **In favour:** self-contained, matches the prior art, and imports nothing from lumem so nothing must stay in sync at build time.
- **Against:** it removes the CLI dependency by adding an interpreter dependency. `python3` on macOS is a stub that requires the Xcode Command Line Tools; Windows usually has none. Every check that already exists in TypeScript — the frontmatter parser, ADR lint, the memory file format — would get a second implementation.
- **Why it lost:** it is the same class of problem as the CLI dependency, arrived at from the other side, on the platform combination where the interpreter is least reliably present. Node ≥ 20 is already required by the CLI *and* by the hooks.

## Consequences

### Good

- Nothing external, nothing global: the version is frozen per repository at install time by the copy.
- Every rule exists once. The bundle imports `core/*`, so ADR lint and frontmatter parsing have one implementation each.
- The installer needed one line — `BUNDLE_FILES` gained an entry — and copy-not-symlink, `contentHash`, drift detection and harness-agnostic uninstall came with it.
- Proven from a clean consumer install with `PATH=/nonexistent`: `spec bundle next exits 0 with no lumem on PATH`.

### Bad

- A build step stands between the source and the artifact, so what lands in a project is generated rather than readable.
- The artifact id is `hook-bundle:lumem-spec`. The kind means "a copied `.mjs` under `.lumem/bin`", but its name says hook, which is now slightly wrong for what it holds.
- Every project carries its own copy, so a fix reaches a repository only when someone runs `lumem sync` there.

### Risks

- **A stale copy silently disagrees with the current rules.** Mitigation: `sync` reports drift and `doctor` surfaces it; the lockfile records the hash that was installed.
- **The purity contract can be broken by an innocent import.** Mitigation: the assertion that already guards the hook bundle guards this one, and fails the build the moment a non-builtin specifier appears.
