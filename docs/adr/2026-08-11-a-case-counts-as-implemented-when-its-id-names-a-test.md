---
title: A case counts as implemented when its id names a test
date: 2026-08-11
area: spec-driven
summary: The gate looks for a declared case id inside a test name, accepting a little stack knowledge in the core because it is the only form that catches an unimplemented case.
feature: 003-closing-the-test-loop
---
## Context

`tests.md` declares numbered cases; `lint --phase tasks` gates on each one being **owned** by exactly one task. Nothing connects a case to code, so ownership and implementation look identical in the artifact and are entirely different facts.

The measurement that forced this, from 002's own suite:

```
cases declared in tests.md      : 85
cases named by an it()          : 83
cases named by nothing          :  2   (IT-18, IT-19)
it() blocks in the whole suite  : 1306
it() blocks carrying a case id  : 132  (10%)
```

Both unnamed cases were in fact implemented — IT-18 as a comment inside an existing assertion, IT-19 as a step in `verify-pack.sh`. The convention linking the other 83 exists because someone typed it.

The constraint: **lumem is stack-agnostic.** `core/` knows nothing about languages, and `lintSpec` reads only the feature directory. Any link to code is new capability, and any knowledge of test syntax is a new kind of knowledge for the core to hold.

## Decision

A declared case counts as implemented when **its id appears in the name of a test**. lumem carries a small set of test-declaration patterns — `it(`, `test(`, `func Test`, `def test_` — configurable per project, with the default documented as best-effort.

## Alternatives considered

### The id appears anywhere in a file matching a configured glob

- **What it was:** the project declares where its tests live; lumem searches those files for the id string and requires nothing about syntax.
- **In favour:** zero language knowledge, so the core stays pure and the rule cannot be wrong about a language nobody anticipated. Nothing to keep updated.
- **Against:** it accepts a mention, not an assertion.
- **Why it lost:** **it would have passed both cases that motivated this feature.** IT-18's id sits in a comment inside a test file; IT-19's in a comment in a shell script. A gate that passes the exact thing it was built to catch is not a gate — it is a report that a string exists somewhere.

### A registry file mapping each id to `file:line`

- **What it was:** the executing task records where it implemented each case; lumem reads the registry.
- **In favour:** precise, and entirely language-agnostic.
- **Against:** hand-kept bookkeeping, and a fourth artifact to maintain alongside the contract, the graph and the design.
- **Why it lost:** it converts "nobody wrote the test" into "nobody updated the registry" — the same class of forgetting this feature exists to fix, relocated. The reference framework wrote a script specifically to keep its own accounting out of human hands, and this would put it back.

## Consequences

### Good

- Catches the failure that was measured, which no other candidate does.
- Costs nothing to maintain: the link is a substring of a name someone was going to write anyway, and 83 of 85 cases in this repo already satisfy it.
- Greppable by a human with no tooling at all.

### Bad

- **The core gains stack knowledge**, which it has not had until now. The pattern set is a list of things lumem believes about other people's languages, and it will be incomplete.
- A test rename that drops the id silently un-implements a case. The gate then reports it, which is loud rather than silent — but it will read as a false alarm to whoever renamed.
- One case per test name is the natural reading, so a single test covering three cases has to name all three or look like it covers one.

### Risks

- **A language whose runner matches no pattern reports every case as unimplemented.** Mitigation: the pattern set is configurable, and the failure is loud and immediate rather than silent — a project sees it on the first run, not at release.
- **The convention could be satisfied cosmetically** by naming a test after a case it does not verify. Mitigation: none mechanical. The `Alternatives` of the sibling ADR apply — this design assumes forgetfulness, not deception.
