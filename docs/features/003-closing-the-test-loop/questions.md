# Questions

Answer inline under each **Answer:**. "Option B" is a complete answer. **Pushing back on the framing is worth more than picking an option** — in 001 that produced the highest-value answer of the run, and in 002 it produced the only one that changed anything.

Where I have a leaning I say so, with the reasoning. Disagreeing costs nothing.

Scope is already settled: **declared → implemented → ran → on this tree.** The discrimination pass stays deferred, its D12 trigger not having fired.

---

## Round 1

Four questions. These are the ones whose wrong answer means rework rather than an edit.

---

### Q1 — Tier

Mechanical, but it gets confirmed rather than assumed (D9).

The slice touches `lint.ts` (a new check and possibly a new phase), the task-body template, the verdict format, a fingerprint mechanism, and two shipped skills — and it needs cases of its own. An inline step list would exceed five steps immediately, which is the safety valve firing.

**My leaning: `full`.** Ties round up, and this is not a tie.

**Answer:** full.
**Effect:** accepted

---

### Q2 — Does lumem run the gate, or check that a recorded run is fresh?

The load-bearing fork of the whole slice. Scope B says the verdict must cite "a run that matches this tree" — this decides who produces the run.

| Option | Gain | Cost |
|---|---|---|
| **A. lumem runs it.** The bundle spawns the declared command and captures its output | The output is real by construction. Nothing to forge and nothing to forget | **The bundle stops being read-only.** Today `next` and `lint` only read files; this gives a copied bundle permission to execute arbitrary project commands, which is a far larger blast radius than anything lumem does now. It also inherits a hazard already paid for twice in this repo: with a pipe, `spawnSync` blocks while any grandchild holds the inherited stdout fd, so output has to go to a file |
| **B. lumem checks freshness.** The agent runs the gate and records the output plus a fingerprint of the tree; lumem recomputes the fingerprint and refuses a verdict that does not match | The bundle stays strictly read-only — hashing files is a read. Catches the failure that was actually measured: a stale or absent run, not a fabricated one | Forgeable by deliberate lying. An agent that pastes a fingerprint it did not earn defeats it |
| **C. Both.** Run it when a command is declared; fall back to freshness checking otherwise | Widest coverage | Two mechanisms for one property, and the weaker one becomes the path of least resistance |

**My leaning: B.** Two reasons, and the second matters more than the first.

The measured failure was **forgetfulness** — 002 closed with two cases nobody implemented and a PASS verdict, not because anyone lied but because nothing looked. B closes exactly that.

And design rule 1 says the memory layer breaking must never break your work. **A gate that only reads cannot damage a tree; a gate that executes can.** Trading the read-only property of the bundle to prevent deliberate forgery is paying a structural cost for a threat that is not the one we have. If an agent will forge a fingerprint, it will also forge the test output that A produces.

**Answer:** B — check freshness, keep the bundle read-only.
**Effect:** accepted

---

### Q3 — What makes a case "implemented"?

Something has to link `UT-07` in the contract to code that verifies it. lumem is stack-agnostic, so this is the question where that constraint bites hardest.

| Option | Gain | Cost |
|---|---|---|
| **A. The id appears in the name of a test.** lumem carries a small pattern set — `it(`, `test(`, `func Test`, `def test_` — and looks for a declared id inside one | It is what 002 did by hand for 83 of 85 cases, so the convention is already proven readable. And it is the only option that **would have caught IT-18 and IT-19** | lumem now knows something about test syntax, which is stack knowledge in a stack-agnostic core. The pattern set has to be configurable, and it will be wrong for a language nobody thought of |
| **B. The id appears anywhere in a file matching a configured glob** | Zero language knowledge. The glob is the project's own statement of where tests live, and nothing can rot | **It would have passed both cases that motivated this feature.** IT-18's id is a comment inside a test file; IT-19's is a comment in a shell script. A gate that passes the exact thing it was built for is not a gate |
| **C. A registry file mapping id → `file:line`, maintained by the executing task** | Language-agnostic and precise | Hand-kept bookkeeping, which is the rot the reference framework wrote a script to avoid. It also adds a fourth artifact to maintain |

**My leaning: A**, with the pattern set configurable and its default documented as best-effort.

B is the tempting one and the measurement kills it. C moves the problem to a file someone has to remember to update, which is the failure we are already fixing.

The honest cost of A is worth stating plainly: **the core gains a little stack knowledge.** I would rather have a gate that works today for the runners we use, with a config key for the rest, than a pure one that cannot catch what we measured.

**Answer:** A — the id names a test.
**Effect:** accepted

---

### Q4 — Where does the gate command live?

Scope B requires each task's verdict to cite a command. This decides where that command is written.

| Option | Gain | Cost |
|---|---|---|
| **A. A `Gate:` line in every task body** | No schema change. A task can declare a narrower gate than the project's, which is what makes a per-task claim honest | Repeated in every task, and drifts between them. Nine tasks means nine chances to write it differently |
| **B. One command in `lumem.config.json`** | Stated once, correct everywhere | A schema change. And every task's gate becomes the whole project gate — slow on a nine-task feature, and it makes a narrow per-task claim impossible to express |
| **C. The config declares the default; a task may override it** | Both facts live where they belong: how this project verifies itself is a project fact, and a task needing something narrower says so | Two places to look, and a reader has to know the precedence |

**My leaning: C.** 002's own verification section already needed both halves — it says a per-task claim is narrow by design while the workstream claim is broad. A design that can only express one of those cannot describe what already happens.

**Answer:** C — config default, task override.
**Effect:** accepted

---

## Round 1 — scored

Generated from the `**Effect:**` field on each question; the field is the record.

| Question | Outcome | Changed the design? |
|---|---|---|
| Q1 tier | accepted | no |
| Q2 run vs check freshness | accepted | no |
| Q3 what "implemented" means | accepted | no |
| Q4 where the gate command lives | accepted | no |

**Zero of four.** Cumulative across three features: **twenty-seven questions, five moved the design** — 001 three of thirteen, 002 two of ten, 003 zero of four.

The ratio is falling, and there are two readings. The generous one: the questions are better targeted, because 001 and 002 already settled the shape and this slice inherits it. The uncomfortable one: **a round of four acceptances is a round that did not need to be asked**, and 002's retrospective raised exactly this suspicion about its own round 2.

The next feature decides it, and the test is cheap: if 004's first round also scores zero, the rule becomes "state the leanings and invite correction; ask only what a wrong answer would force a rewrite of".

## Stop

No round 2. Both triggers were checked:

- **No remaining fork whose answer would change the design.** One candidate survived Q2 — what the fingerprint covers — and it turned out to have a derivable answer rather than a preference: the verdict lives in the file whose state it certifies, so a fingerprint covering documents would invalidate the verdict as it was written. The alternatives refute themselves, so it is recorded as D7 with the reasoning, not asked.
- No concern was repeated, so the prune trigger did not fire mid-round. The prune ran anyway, as a phase.

This is the first round in three features to stop **because** a question turned out to be derivable rather than because the list ran out.
