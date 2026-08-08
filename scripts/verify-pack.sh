#!/bin/sh
# T47 — packaging gate (OPS-03, NFR-4, NFR-6).
#
# Proves that `npx lumem` works from a clean machine, by doing exactly what npm
# would do and nothing else:
#
#   1. `npm pack` the real repo (prepack rebuilds dist/, so the tarball always
#      carries fresh bundles).
#   2. Assert the tarball CONTAINS everything the install path reads at runtime
#      — the three bundles, the adapter descriptors, the assets — and OMITS
#      everything else (sources, tests, specs, scripts).
#   3. Install that tarball into a throwaway directory and drive the installed
#      binary end to end under an isolated HOME: doctor -> init -> memory add ->
#      memory list -> install, then pipe a payload into the hook bundle that
#      `install` copied into the project.
#
# The last step is the one that matters: it is the only check that fails when a
# file is missing from `files`, because a missing descriptor or asset only ever
# surfaces as a runtime error in a consumer's project, never in this repo where
# the dev layout resolves every path anyway.
#
# Usage: sh scripts/verify-pack.sh   (or `npm run verify:pack`)

set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

WORK=$(mktemp -d "${TMPDIR:-/tmp}/lumem-verify-pack.XXXXXX")
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

FAILURES=0

say() { printf '%s\n' "$*"; }
head2() { printf '\n== %s\n' "$*"; }
ok() { printf '  ok    %s\n' "$*"; }
bad() {
  printf '  FAIL  %s\n' "$*"
  FAILURES=$((FAILURES + 1))
}

say "verify-pack: packaging gate for lumem"
say "repo:  $REPO_ROOT"
say "work:  $WORK"

# ---------------------------------------------------------------------------
# 1. pack
# ---------------------------------------------------------------------------

head2 "npm pack"

PACK_DIR="$WORK/pack"
mkdir -p "$PACK_DIR"

# prepack runs `npm run build`, whose output lands on stdout next to the JSON;
# the tarball name is read back from the (empty, freshly made) destination dir
# whenever that noise makes the JSON unparseable.
if ! (cd "$REPO_ROOT" && npm pack --json --pack-destination "$PACK_DIR") \
  >"$WORK/pack.out" 2>"$WORK/pack.err"; then
  say "npm pack failed:"
  cat "$WORK/pack.err" >&2
  cat "$WORK/pack.out" >&2
  exit 1
fi

TARBALL=""
if PACKED=$(node -e '
  const fs = require("node:fs")
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n")
  // The build noise shares stdout with the report; npm pretty-prints the JSON,
  // so the last line that is exactly "[" is where the array starts.
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === "[") { start = i; break }
  }
  if (start < 0) throw new Error("no JSON array in npm pack output")
  const entry = JSON.parse(lines.slice(start).join("\n"))[0]
  if (!entry || typeof entry.filename !== "string") throw new Error("no filename in npm pack JSON")
  process.stdout.write(entry.filename)
' "$WORK/pack.out" 2>/dev/null); then
  if [ -f "$PACK_DIR/$PACKED" ]; then
    TARBALL="$PACK_DIR/$PACKED"
    ok "npm pack --json reported $PACKED"
  fi
fi

if [ -z "$TARBALL" ]; then
  TARBALL=$(find "$PACK_DIR" -name '*.tgz' -type f | head -n 1)
  if [ -n "$TARBALL" ]; then
    ok "tarball recovered from the pack destination: $(basename "$TARBALL")"
  fi
fi

if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  bad "npm pack produced no tarball"
  say ""
  say "RESULT: FAIL ($FAILURES failed check(s))"
  exit 1
fi

say "tarball: $TARBALL ($(wc -c <"$TARBALL" | tr -d ' ') bytes)"

# The tarball is only trustworthy if prepack rebuilt the bundles it carries.
if grep -q 'prepack' "$WORK/pack.out" "$WORK/pack.err"; then
  ok "prepack ran, so the bundles in the tarball are freshly built"
else
  bad "prepack did not run — the tarball may carry stale bundles"
fi

# ---------------------------------------------------------------------------
# 2. contents
# ---------------------------------------------------------------------------

head2 "tarball contents"

LISTING="$WORK/files.txt"
# npm tarballs root everything at `package/`; strip it and drop directory
# entries so the assertions below read as plain package-relative paths.
tar -tzf "$TARBALL" | sed 's|^package/||' | sed '/\/$/d' | sed '/^$/d' | sort >"$LISTING"

say "entries: $(wc -l <"$LISTING" | tr -d ' ')"
sed 's/^/    /' "$LISTING"

EXTRACT="$WORK/extract"
mkdir -p "$EXTRACT"
tar -xzf "$TARBALL" -C "$EXTRACT"
PKG="$EXTRACT/package"

head2 "required files present"

require_file() {
  if [ -f "$PKG/$1" ] && [ -s "$PKG/$1" ]; then
    ok "$1"
  else
    bad "$1 — missing from the tarball (or empty)"
  fi
}

require_file 'dist/cli.js'
require_file 'dist/lumem-hook.mjs'
require_file 'dist/lumem-runner.mjs'
require_file 'src/adapters/claude-code.json'
require_file 'src/adapters/codex.json'
require_file 'assets/skills/lumem-memory/SKILL.md'
require_file 'assets/skills/lumem-consolidate/SKILL.md'
require_file 'assets/agents/lumem-consolidator.md'
require_file 'assets/harness/claude-code/hooks.tmpl.json'
require_file 'assets/harness/codex/hooks.tmpl.json'
require_file 'package.json'

# README is T48's deliverable; assert it ships only once it exists.
if [ -f "$REPO_ROOT/README.md" ]; then
  require_file 'README.md'
else
  ok "README.md — not in the repo yet, skipped"
fi

head2 "excluded files absent"

refuse_pattern() {
  pattern="$1"
  label="$2"
  if hits=$(grep -E "$pattern" "$LISTING"); then
    bad "$label — tarball ships:"
    printf '%s\n' "$hits" | sed 's/^/          /'
  else
    ok "$label"
  fi
}

refuse_pattern '\.test\.ts$' 'no *.test.ts'
refuse_pattern '^src/cli/' 'no src/cli/**'
refuse_pattern '^src/core/' 'no src/core/**'
refuse_pattern '^\.specs/' 'no .specs/**'
refuse_pattern '(^|/)node_modules(/|$)' 'no node_modules'
refuse_pattern '^test/' 'no test/**'
refuse_pattern '^scripts/' 'no scripts/**'

# ---------------------------------------------------------------------------
# 3. install the tarball
# ---------------------------------------------------------------------------

head2 "install the tarball into a clean directory"

CONSUMER="$WORK/consumer"
mkdir -p "$CONSUMER"
# A package.json of its own stops npm from walking up and installing into a
# parent project by accident.
cat >"$CONSUMER/package.json" <<'JSON'
{
  "name": "lumem-pack-probe",
  "version": "1.0.0",
  "private": true
}
JSON

if ! (cd "$CONSUMER" && npm i "$TARBALL" --no-audit --no-fund --loglevel=error) \
  >"$WORK/install.out" 2>&1; then
  bad "npm i <tarball> failed"
  sed 's/^/          /' "$WORK/install.out"
  say ""
  say "RESULT: FAIL ($FAILURES failed check(s))"
  exit 1
fi
ok "npm i <tarball> succeeded"

BIN="$CONSUMER/node_modules/.bin/lumem"
if [ -x "$BIN" ]; then
  ok "bin/lumem is executable"
else
  bad "bin/lumem is missing or not executable at $BIN"
  say ""
  say "RESULT: FAIL ($FAILURES failed check(s))"
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. drive the installed binary end to end
# ---------------------------------------------------------------------------

head2 "end-to-end run of the installed binary (isolated HOME)"

FAKE_HOME="$WORK/home"
# A bare `~/.claude` is enough for the claude-code descriptor's `dir` rule, so
# the run exercises real detection instead of only the explicit --harness path.
mkdir -p "$FAKE_HOME/.claude"
PROJ="$WORK/project"
mkdir -p "$PROJ"

FACT='packaging verification fact'

# Run the installed binary in the throwaway project under the throwaway HOME.
# stdout+stderr land in $WORK/cli.out; the exit code goes to $CLI_CODE.
CLI_CODE=0
run_cli() {
  set +e
  (cd "$PROJ" && HOME="$FAKE_HOME" "$BIN" "$@") >"$WORK/cli.out" 2>&1
  CLI_CODE=$?
  set -e
}

step() {
  label="$1"
  shift
  expected="$1"
  shift
  run_cli "$@"
  case " $expected " in
  *" $CLI_CODE "*)
    ok "$label (exit $CLI_CODE)"
    ;;
  *)
    bad "$label — exit $CLI_CODE, expected one of: $expected"
    sed 's/^/          /' "$WORK/cli.out"
    ;;
  esac
}

# `doctor` exits 3 on drift or an out-of-range harness version; both are honest
# reports about the machine, not packaging failures, so both count as a pass.
step 'doctor --json' '0 3' doctor --json
if node -e '
  const fs = require("node:fs")
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  if (!Array.isArray(report.harnesses)) throw new Error("no harnesses array")
  if (report.harnesses.length === 0) throw new Error("no harness descriptors were loaded")
' "$WORK/cli.out" 2>/dev/null; then
  ok 'doctor --json emitted a report with loaded descriptors'
else
  bad 'doctor --json did not emit a usable report — adapter descriptors are probably not packaged'
  sed 's/^/          /' "$WORK/cli.out"
fi

step 'init --harness claude-code' '0' init --harness claude-code
if [ -f "$PROJ/.lumem/lumem.config.json" ]; then
  ok '.lumem/lumem.config.json created'
else
  bad '.lumem/lumem.config.json was not created'
fi

step 'memory add' '0' memory add "$FACT" --type project
step 'memory list' '0' memory list
if grep -qF "$FACT" "$WORK/cli.out"; then
  ok 'memory list shows the fact just added'
else
  bad 'memory list did not show the fact just added'
  sed 's/^/          /' "$WORK/cli.out"
fi

step 'install --harness claude-code' '0' install --harness claude-code

HOOK="$PROJ/.lumem/bin/lumem-hook.mjs"
if [ -L "$HOOK" ]; then
  bad "$HOOK is a symlink — NFR-6 requires a real self-contained copy"
elif [ -f "$HOOK" ] && [ -s "$HOOK" ]; then
  ok '.lumem/bin/lumem-hook.mjs is a real, non-empty file (not a symlink)'
else
  bad '.lumem/bin/lumem-hook.mjs was not installed'
fi

# NFR-6: a hook must never shell out to npx — it has to run the copied bundle.
SETTINGS="$PROJ/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  if grep -q 'npx' "$SETTINGS"; then
    bad 'the generated hooks config invokes npx — NFR-6 forbids it'
    sed 's/^/          /' "$SETTINGS"
  else
    ok 'the generated hooks config never invokes npx'
  fi
else
  bad "$SETTINGS was not written by install"
fi

head2 "hook bundle accepts a payload"

if [ -f "$HOOK" ]; then
  set +e
  printf '{"cwd":"%s","session_id":"verify-pack"}' "$PROJ" |
    (cd "$PROJ" && HOME="$FAKE_HOME" node "$HOOK" claude-code inject) >"$WORK/hook.out" 2>&1
  HOOK_CODE=$?
  set -e
  if [ "$HOOK_CODE" -eq 0 ]; then
    ok "piping a payload into the hook bundle exits 0"
  else
    bad "the hook bundle exited $HOOK_CODE — it must always exit 0"
    sed 's/^/          /' "$WORK/hook.out"
  fi
  if grep -qF "$FACT" "$WORK/hook.out"; then
    ok 'the hook injected the memory written through the packaged CLI'
  else
    bad 'the hook injected nothing — the packaged install is not wired end to end'
    sed 's/^/          /' "$WORK/hook.out"
  fi
fi

# ---------------------------------------------------------------------------
# verdict
# ---------------------------------------------------------------------------

say ""
if [ "$FAILURES" -eq 0 ]; then
  say "RESULT: PASS — the tarball is npx-ready"
  exit 0
fi
say "RESULT: FAIL ($FAILURES failed check(s))"
exit 1
