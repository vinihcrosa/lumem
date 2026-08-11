# Retrospective — 002 Spec-driven core

Written at close, while it is fresh, as direct input to the next feature and to the skills this one shipped.

**Sample size is one feature.** Everything here is directional. 001's retrospective is the only other data point, and it is quoted where the two agree or disagree.

---

## 1. The process was run out of order, by the process that defines it

`prd.md` was written **after** `tdd.md`, and after T1 had already started. The pipeline this feature specifies says requirements, then design.

It happened for an honest reason — 002 is the slice that defines what a PRD is, so there was no template to write one against until the design existed — and the gap was only noticed because T1's parser reported `has.prd: false` and nothing in the derivation table cared. That produced the `write-prd` row and UT-65.

But the ordering violation is the finding, not the missing row. **A process whose own first run skips a phase has not yet been tested on the phase it skipped.** The requirements phase, as specified — research, scope first, question rounds, prune — has been run once, in 001, by hand. It has never been run through the skills that now exist.

This is the single most important thing 003 will test.

## 2. Questions: two of ten moved the design

| Round | Question | Effect |
|---|---|---|
| 1 | Q1 what enforces the gates | **rejected-framing** |
| 1 | Q2 sizing | **changed** |
| 1 | Q3 driver vs contracts | accepted |
| 1 | Q4 concreteness in core | accepted |
| 1 | Q5 verification independence | accepted |
| 2 | Q6 script runtime | accepted |
| 2 | Q7 prune mechanics | accepted |
| 2 | Q8 requirement notation | accepted |
| 2 | Q9 effectiveness tracking | accepted |
| 2 | Q10 preflight loading | accepted |

001 scored three of thirteen. 002 scored two of ten. **The ratio is holding at about a fifth**, which was the target, and both features agree on the more interesting pattern: the answers that move a design tend to *remove* something. Q1 removed a dependency. Q2 removed the freedom to break a sizing tie downward.

**Round 2 produced zero design changes through an answer** — five acceptances. Q6 did move the design, but by naming a cost inside the question rather than by anything the author said. Two readings, and they matter differently:

- The optimistic one: round 1 resolved the real forks, and round 2 was confirmation. The stop criterion fired correctly.
- The skeptical one: **round 2 should not have been asked.** Five questions to confirm five leanings is a round that cost attention and returned framing. If 003's round 2 also scores zero, the rule should become "stop after one round unless a rejected framing forces a second".

The data cannot yet distinguish them. One more feature can.

## 3. The gates: one false positive out of two findings

Run against 002's own artifacts, the finished gates reported exactly two things:

| Finding | Verdict |
|---|---|
| `vague-risky-criterion` on `prd.md` SPEC-16 | **false positive.** A requirement *about* failure paths, always-on, correctly carrying no pattern keyword |
| `task-without-tests` on T8 | true positive, and already declared acceptable in T8's own body |

A 50% false-positive rate on the first real run. The fix — requiring a prose-stated *condition* before the pattern rule fires — is in and covered, and after it the gates report zero findings on `prd.md` and `tdd.md`.

**The lesson is about where the calibration data comes from.** The fixtures could not find this: every fixture I wrote for the rule was a genuine risky criterion, because that is what the rule is *for*. Only a real document contained a sentence that talks about failure without being triggered by one. **A keyword heuristic must be calibrated against prose nobody wrote for it.**

## 4. Nine contract conflicts in nine tasks

Every task hit at least one place where the design under-specified something, and had to resolve it and record the resolution:

| Task | What the design did not say |
|---|---|
| T1 | whether `tier` may be absent; where task state lives; what the range notation means |
| T2 | what a verdict looks like on disk, or where it lives |
| T3 | which finding type to reuse; that lint phases are a smaller vocabulary than pipeline phases |
| T4 | what "unreadable directory" means, given an absent one is normal |
| T5 | the artifact id, once `hook-bundle` turned out to generalise |
| T8 | that the installer shipped only `SKILL.md`, making `references/` unreachable |
| T9 | that Codex installs skills under `.agents`, not `.codex` |

**One decision per task, in a design that passes its own concreteness gate.** That is the honest measure of what the gate buys: it eliminates the ambiguities that are *visible as missing tokens* — an untyped field, a described-not-pasted signature — and it cannot see the ones that are missing sections. Nobody notices the absent paragraph.

Two implications for the skills:

- The completion-notes mechanism is not bookkeeping. It is where those nine resolutions are recorded, and without it each one would be re-derived differently by the next task. `lumem-tasks`'s task-body reference now says so explicitly.
- The design phase should expect this rate. A TDD that produces zero conflicts across nine tasks is more likely to be vague than complete.

## 5. What found the defects

Ordered by how much they cost to run:

| Mechanism | Found |
|---|---|
| The type checker | a two-argument `toBe` produced by a careless scripted edit |
| A test case | `expandCaseIds` returning ranges before singles, against its own documented contract |
| **Running against real artifacts** | the missing `write-prd` row; the SPEC-16 false positive; Codex's real skills path |
| **The packaging gate** | `PATH=/nonexistent` hiding `node` itself, so the new step exited 127 |
| Writing the design down | `tier` cannot be non-optional; the effect field duplicated the scored table; task sizing had no doctrine; invariant 9 contradicted §6.1 |

The middle row is the one worth institutionalising. **Three of the seven defects were only visible when the code was pointed at documents nobody wrote for it**, and two of those three were in the design rather than in the code.

001 concluded that "formalising a design finds problems that discussing it does not". 002 adds the next step: **running a tool against real artifacts finds problems that formalising does not.**

## 6. The prune cut something both times

001's finding was that three rounds accumulated and none subtracted, and the round that cut a third was the most valuable. 002 made pruning mandatory, and it fired twice:

- **After round 2:** cut a whole skill (`lumem-loop`, left with no content once the driver was cut), a fourth sizing tier, six of nine notation-mandating dimensions, and deferred one mechanism.
- **After the design:** cut an unreachable state (`action=blocked`, forbidden by the invariants) and a duplicate mechanism (`missing-cut-section`, which the phase detector already covered).

**Both passes cut things I would not have noticed without looking for them**, which is the case for the phase existing. But note what each cut was: the first pass cut *scope*, the second cut *redundancy*. They are different audits, and the skills currently describe them as one step. 003 should watch whether the design-phase prune ever cuts scope, or only ever finds duplication.

The `Kept under pressure` half earned its place once: the `light` tier survived a second examination, with the reason recorded. Without that half, a reader cannot tell a thorough prune from a timid one.

## 7. What this feature did not prove

Stated plainly, because the completion notes are otherwise easy to read as more than they are:

- **The six skills have never been run.** This feature's own execution was me following the artifacts directly, not invoking `lumem-prd` or `lumem-execute-task`. Their prompts are reviewed, not exercised. IT-20 proves they install; nothing proves they work.
- **The requirements phase has not been run through its skill.** See §1.
- **The effect field has survived one feature, not three.** Nine of ten values are `accepted`, which is either honest or reflexive, and one feature cannot tell which. The success criterion in `tdd.md` §12 asks exactly this and is still open.
- **No independent verifier ran.** `doctor` reports `verification=independent` for Claude Code, but every verdict in this feature was written by the same agent that wrote the code. The evidence gate ran; the author ≠ verifier property did not.

## 7b. The test loop is open, and it fails toward false confidence

Raised by the author at close, measured rather than argued. The reference framework closes the loop from spec to test to pass; lumem closes spec to task and then trusts.

Measured against this feature's own suite:

```
casos declarados em tests.md      : 85
casos com um it() citando o id    : 83
casos sem nenhum it() citando o id: 2      (IT-18, IT-19)
it() na suíte inteira             : 1306
it() carregando um id de caso     : 132     (10%)
```

IT-18 and IT-19 **were** implemented — one as a comment inside an existing assertion, one as a step in `verify-pack.sh`. And the convention that links the other 83 exists because it was typed, not because anything requires it.

**Nothing in lumem noticed.** `lint --phase tasks` exited 3 today on an unrelated info finding. The consequence, stated exactly: **a task can be ticked done with every case assigned and no test written, and the pipeline answers `phase=done`.**

What lumem has, and it is not nothing: `tests.md` as a canonical numbered contract with a case-writing rule, and `orphan-test-id` / `duplicate-test-id` as **gates** — every declared case owned by exactly one task, which the reference framework has no equivalent of.

What it does not have:

| Missing | Consequence |
|---|---|
| A canonical link from a case id to a test | nothing can tell a declared case from an implemented one |
| A per-task gate command, declared and checked | "the tests pass" is an assertion, not an observation |
| A completion gate that refuses a verdict with no live evidence | the verdict is a typed line; nothing checks it is real or current |
| An independent verifier that actually runs | every verdict here was written by the agent that wrote the code |
| A discrimination pass proving the cases can fail | deferred in D12, and untested |

**Why this ranks above everything else in §8.** Every other weakness in this pipeline degrades *visibly*: a vague requirement produces a worse artifact you can read, a prose design produces implementations that diverge in review. This one degrades **silently and in the direction of false confidence** — the verdict says PASS. It is the failure class `lumem-verify` and design rule 1 exist to prevent, and the framework does not hold itself to it.

The asymmetry is worth naming because the two look identical in the artifact: `orphan-test-id` proves a case has an **owner**. Nothing proves it has an **implementation**.

**The portable route.** lumem is stack-agnostic, so "the test suite" is not a concept it can know. The reference framework's move is the one to copy: **the task declares its gate command**, and the verdict cites that command's output. The framework never learns what a test runner is; it requires the task to name one.

Cheapest first:

1. Make the id-to-test link canonical, then gate on `unimplemented-case` — declared ids compared against ids found in the suite. It would have caught IT-18 and IT-19 today.
2. A required `Gate:` line per task, checked structurally, and a verdict carrying a fingerprint of the tree so a stale PASS becomes detectable.
3. The discrimination pass. `tests.md` was already shaped to accept it without a rewrite.

**This is 003.** The author has chosen to build it through the pipeline itself, which also settles §1: the requirements phase finally runs through its own skill, on a feature whose subject is the pipeline's weakest property.

## 8. Changes to make before 003

0. **Close the test loop — §7b.** It is 003, and it outranks the rest of this list: it is the only item whose absence produces a false PASS rather than a visible weakness.
1. **Run 003's requirements phase through `lumem-prd`, from the first message.** Nothing else in this list matters as much, and 003 satisfies it by construction.
2. **Consider capping at one question round** unless a rejected framing forces a second. Decide after 003 scores its rounds, not before.
3. **Calibrate any new heuristic against prose that predates it.** Add a fixture drawn from an existing document, not written for the rule.
4. **Split the prune into its two audits** — scope after requirements, redundancy after design — if 003 confirms the design-phase pass only ever finds duplication.
5. **Use the independent verifier once**, so the graded mode is exercised rather than merely reported.
6. **Write the remaining ADRs, or stop pretending they are coming.** 002 recorded eighteen decisions in `decisions.md` and one ADR. Either the three-part test (hard to reverse, surprising, a real trade-off) genuinely excludes the other seventeen — plausible — or `decisions.md` is doing an ADR's job without an ADR's discipline. Decide which, and record the answer.
