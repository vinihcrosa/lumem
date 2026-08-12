# Retrospective — 003 Closing the test loop

Third run of the process, and the first authored **through the installed skills** rather than by following the artifacts by hand. 002's retrospective named that as the thing it could not prove about itself.

---

## 1. The loop is closed, and it caught its own origin

```
002 --phase tasks    exit 3   unimplemented-case: IT-18, IT-19
002 --phase verdict  exit 3   verdict-stale
003 --phase tasks    exit 0
003 --phase verdict  exit 0   after the verdict was earned
```

The first line is the measurement that produced this feature, reported by the feature, against history unaltered.

Demonstrated live at close, in this order:

| Action | `lint --phase verdict` |
|---|---|
| verdict recorded with the real fingerprint | exit 0 |
| one line appended to `src/spec/verify.ts` | **exit 3, stale** — and `next` returned to `verify` |
| that line reverted | exit 0 |
| a paragraph appended to `tasks.md`, which *holds* the verdict | exit 0 |

The last row is D7 working rather than a convenience: the verdict lives in a document, and a fingerprint covering documents would be invalidated by the act of recording it.

## 2. Questions: zero of four, and the round should probably not have been asked

| Round | Effect |
|---|---|
| Q1 tier · Q2 run-vs-freshness · Q3 what "implemented" means · Q4 where the gate lives | all `accepted` |

Cumulative across three features: **twenty-seven questions, five moved the design** — 001 three of thirteen, 002 two of ten, 003 zero of four.

002 flagged the suspicion; 003 confirms it. **Four leanings, four acceptances, and every one of them was already argued in the question itself.** The value in this round was in the *framing* — Q2 and Q3 each named a cost that decided the answer before the author read it — and framing does not require a question.

**Change for 004:** state the leanings with their costs as a *proposal*, ask only where a wrong answer forces a rewrite, and expect a round of one or two. The stop criterion already allows this; the skill's "at most five per round" reads as permission to ask five.

Worth keeping in view: the one thing that stopped this round early was a question that turned out to be **derivable** — the fingerprint could not cover the file recording the verdict, because writing the verdict would void it. Deriving it took a paragraph; asking it would have taken a turn.

## 3. What the implementation found that the design did not

Eight tasks, and **six of them changed something the design had stated**:

| Task | The design said | What was true |
|---|---|---|
| T1 | `verification` lives in `core/config.ts` | It belongs where every other default lives — the module owning the concept. And a pre-existing type annotation was wrong the moment a field had a default |
| T2 | exclusion is a path prefix | A prefix is anchored at the root, so `src/node_modules` walked straight through. A bare name has to match any segment |
| T3 | *the line contains the id* | Written thinking in JavaScript. `func TestUT01` and `def test_ut01` cannot contain a hyphen, and both runners were in the shipped defaults |
| T6 | one `no-tests-recognised` | "No pattern matched" and "no test files exist" are different facts, and folding them accused the patterns of a fault that was not theirs |
| T6 | a task's gate satisfies the verdict | It must not: the verdict is the feature's closing claim and is broad by definition |
| T8 | read the config through `core/config` | That pulls zod into a zero-dependency bundle — 26 KB to 162 KB, caught on the first build |

002 measured one contract conflict per task and concluded the concreteness gate catches missing *tokens* and not missing *sections*. 003 sharpens that: **the gate cannot catch a statement that is concrete and wrong.** Every row above was pinned precisely in the design. Precision made them findable; it did not make them right.

## 4. The finding that costs the most later

The acceptance test failed reporting **zero** unimplemented cases. Its own title — `it('IT-08 reports IT-18 and IT-19 as unimplemented…')` — matched a test pattern and contained both ids, so **the test asserting they were missing declared them implemented.**

Two facts, both now in `tdd.md` §13:

- **A test about an id must not be named with it** unless it implements it.
- **Ids are unique per feature; the search is repository-wide.** 002's `IT-08` and 003's `IT-08` are different cases that satisfy each other. Pollution can only ever *hide* an unimplemented case, never invent one — which is exactly why it is quiet, and why the trigger to qualify ids by feature is written down rather than acted on now.

## 5. A false claim, committed

T6's first commit stated that `npm run verify` passed. It had not: two `tsc` errors. The notes were written from the test run alone, before the check output was read.

It is in the record rather than amended away, because of what it is: **the failure `lumem-verify` exists to prevent, committed by the feature that exists to make it detectable.** What caught it was reading the output rather than the exit of one step — step 3 of the gate the skill spells out, skipped by the person who wrote the skill.

The mechanism this slice shipped would not have caught it either. A fingerprint proves *which tree* a claim describes; it proves nothing about whether the claim is true. That gap is the discrimination pass, still deferred, and this is the first evidence with a real incident behind it.

## 6. Running through the skills

It worked, and the two places it bit were both places the skill was right and I was slow:

- **`lumem-tasks` says present the graph before writing the bodies.** Doing so cost one message and would have saved eight bodies had the shape been rejected.
- **`lumem-prd` says research before questions.** Seven facts came out of the codebase, and one of them — `config.gate` already being taken — would otherwise have been discovered in T1 as a naming collision after the design was written.

What the skills did **not** do is any of the judgment. Every one of the six findings in §3 came from writing the code, not from the prompt telling me to look. The skills route attention; they do not supply it.

## 7. Changes before 004

1. **Ask fewer questions.** State leanings with costs as a proposal; ask only where a wrong answer forces a rewrite. Three features of falling ratio is enough evidence.
2. **Add a `Gate:` line to every task body from the start.** 003's bodies have them and nothing yet reads them; T6 decided they do not apply to the closing verdict, so their only consumer is the execution loop. Either wire that consumer or cut the line.
3. **The discrimination pass now has an incident.** §5 is the first case of a claim that was false while every mechanism reported green. Its trigger — *a shipped feature passes verification and still breaks* — has not fired, but the class is no longer hypothetical.
4. **Watch for a feature whose cases are reported implemented and nobody wrote them.** That is the cross-feature id collision surfacing, and the fix costs a rename of every case already written.
