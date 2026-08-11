# Questions

Answer inline under each **Answer:**. Free form — a sentence is enough, and "option B" is a complete answer. Push back on the framing when the question itself is wrong; that is worth more than picking one of my options. In 001 the single highest-value answer was a rejected framing.

Where I have a leaning I say so, with the reasoning. Disagreeing with it costs nothing.

Scope is already settled in `decisions.md` D1 — that was 001's biggest process error and it is not repeated here.

---

## Round 1

Five questions. These are the ones where a wrong answer means rework rather than an edit.

---

### Q1 — What enforces the gates, and what knows which phase we are in?

Both references reached the same conclusion independently: a check the model can forget is a check that silently stops running. Compozy ships Python under `.agents/skills/cy-*/scripts/` (`check-prd-implementation-leak.py`, `check-techspec-markers.py`, `detect-phase.py`); tlc ships Python under its own `scripts/` (`validate_spec.py`, `validate_tasks.py`, `validate_state.py`, `check_commit.py`, `lessons.py`).

lumem is the first of the three with a CLI already installed, versioned by a lockfile, and covered by 1128 tests.

| Option | Gain | Cost |
|---|---|---|
| **A. Bundled scripts inside the skill directories** | Self-contained: the skill works even where the CLI is absent. Matches both references. | Introduces a second runtime. lumem is Node ≥ 20 with zero native deps, and `install` would have to ship and mark executable a Python tree that lumem's own suite does not cover. It also duplicates what the CLI already does — `memory lint` and `adr lint` are the same shape of check. |
| **B. CLI subcommands** — `lumem spec lint`, `lumem spec next`, `lumem spec status` | One runtime, one test suite, one version. Inherits what already exists: `--json` on every read command, `--dry-run` on every write, drift detection, the lockfile, and `doctor` reporting the mode. | The skill now depends on the CLI being installed *and* version-compatible. A skill copied into a repo without lumem degrades to prose. |
| **C. Prose checks inside `SKILL.md`** | Nothing to install, nothing to version. | Exactly the drift both references built scripts to stop. |

**My leaning: B, with C as a declared degraded fallback.** This is already lumem's doctrine — when a harness lacks a capability the feature changes mechanism instead of disappearing, and `doctor` names the mode you are in. The CLI is the mechanism lumem has that neither reference had; not using it means shipping a second runtime to do a job the first one already does. Compozy's real insight to keep is not "Python" — it is that the phase detector is **read-only and reads filesystem truth**, so a stale state file can never strand you.

**Answer:**eu gosto da A e C, eu não gosto da B, é criar uma dependencia da cli na maquina dos clientes, eu prefiro tere o problema de gerenciar scripts python no repo do lumem do que ficar dependendo de cli rodar ou não e na versão certa, as vezes um repo ta com um versão e outro em outra versão,a ai começca a dar problema.
**Effect:** rejected-framing

---

### Q2 — Does the pipeline adapt its depth to the size of the change?

Compozy always runs the full ceremony, and defends it: *"'Simple' features are where unexamined business assumptions cause the most rework."* tlc auto-sizes into Small / Medium / Large / Complex and skips Design and Tasks when the change does not need them, with a safety valve — if Execute lists more than five inline steps, stop, the phase was wrongly skipped.

| Option | Gain | Cost |
|---|---|---|
| **A. Always the full pipeline** | Nothing can be under-sized. One path to build and test. | Ceremony on a two-line change. The predictable outcome is that the process gets routed around for small work, which is most work — and a process people skip teaches nothing. |
| **B. Auto-sized, agent decides per phase** | Pays only for what the change needs. | The agent has a standing incentive to under-size, and it re-decides at every phase boundary, so the depth can drift mid-feature. |
| **C. Sized once at the scope phase, agent proposes and the user confirms, recorded in the artifact** | The sizing is a decision with an owner and an audit trail, reversible in one place. No per-phase drift. | One more thing to settle at scope time. |

**My leaning: C, with tlc's safety valve armed regardless.** The valve is the part that makes sizing safe: it converts "I skipped Tasks" from a silent judgment into a check that fires when the skip was wrong. Sizing per phase (B) is where drift enters; sizing once, out loud, and recording it keeps it honest. And a recorded size is a fact the prune phase can be measured against.

**Answer:** C, mas sempre pecar pra cima
**Effect:** changed

---

### Q3 — Does lumem drive execution, or hand the next action to whoever is driving?

D1 bought Execute and Verify. This is the question of how much machinery comes with them.

| Option | Gain | Cost |
|---|---|---|
| **A. A full driver** — Compozy's shape: state machine, one atomic commit per task, self-healing recovery loop, runs unattended for hours | Unattended shipping of a whole task graph. | The largest single piece of work in the slice, and the most harness-coupled: commit behavior, worktrees and subagents differ per harness. It also cuts against design rule 1 — a driver that mis-detects a phase *acts*, where a broken hook merely does nothing. lumem has no evidence yet of long unattended runs. |
| **B. Contracts plus a next-action detector** — `lumem spec next` prints exactly one action from filesystem truth; the harness or the user runs it; each task still carries its execution and verification contract | Resumable across sessions with no daemon and no state machine to trust. Fail-open by construction: the worst failure is printing the wrong next action, which you ignore. Identical on both harnesses. | No unattended multi-hour run in this slice. |
| **C. B now, driver later as an opt-in module** | Keeps the door open without paying for it now. | The module system does not exist yet, so "later" is unscheduled. |

**My leaning: B, stated as C.** The contract is the part with durable value — a task file that pins what to build and what proves it is done is useful under any driver, including a human. The driver is the part most likely to be obsoleted by the harness itself within a release or two.

**Answer:** ok
**Effect:** accepted

---

### Q4 — How much of the design-concreteness requirement belongs to the core?

The strongest single finding in either reference is Compozy's L-012: two design documents from the same week, one with interface signatures pasted as code and invariants enumerated, the other describing the same mechanics in prose. The first shipped in one review round; the second generated rounds. The diagnosis: *"prose-only descriptions produce N implementations, where N is the number of agents that read the spec."*

Their enforcement is six markers, and every one is Go-shaped (`\`\`\`go` blocks, SQLite columns, side-table-vs-JSON). lumem is stack-agnostic.

| Option | Gain | Cost |
|---|---|---|
| **A. Core ships a generic concreteness gate; modules add language-specific markers** | Every project gets the requirement that matters — pin tokens the implementer cannot reinterpret: signatures in the project's own language, each new field with name and type, states enumerated, invariants as a numbered list. A module then sharpens it for its stack. | A generic gate is harder to check mechanically than grepping for a Go fence. Some of it stays judgment. |
| **B. Core ships nothing; all markers come from modules** | No wrong opinions baked into the core. | A project with no module installed gets prose-only design documents — precisely the failure L-012 documents. The core would ship the pipeline and omit the one thing proven to make it work. |
| **C. Core detects the language and ships marker sets per language** | Works out of the box everywhere, with no module needed. | The core starts knowing about languages, which contradicts D7 and 001's D4, and it grows without bound — one more language, one more marker set, forever. |

**My leaning: A.** The transferable finding is *concreteness*, not *Go*. A gate that asks "can two competent implementers read this and build different shapes?" is stack-agnostic and mechanically checkable in its structural half: does every new field have a type, is there at least one signature block, are invariants numbered.

**Answer:** ok
**Effect:** accepted

---

### Q5 — Who verifies, and against what?

tlc's position is the sharpest thing in it: the Verifier is a **fresh** agent, always runs, is never prompted for, and re-derives coverage independently — *author ≠ verifier* — because the mental model that produced the gap is exactly what needs checking. Compozy's `cy-final-verify` is a gate the same agent must pass through: *"NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE"*, with claim scope bound to verification scope.

| Option | Gain | Cost |
|---|---|---|
| **A. Always a separate verifying agent; inline verification refused** | The strongest signal available. | Requires harness subagent support. Claude Code has it; Codex support is unverified. A hard requirement a harness cannot meet means the feature disappears there rather than degrading. |
| **B. Same-agent evidence gate only** | Works everywhere, requires no capability at all. | The author grades their own work. Evidence still has to be produced and shown, which is most of the value — but the blind spot that caused the gap also judges whether it is closed. |
| **C. Capability-graded: the evidence gate always, an independent verifier where the descriptor declares subagents, `doctor` naming the mode** | The pattern lumem already ships for injection and consolidation. Nobody gets nothing; some get more. | Two verification qualities exist in the wild, so a gap caught on one machine may not surface on another. `doctor` has to make that visible or it becomes a silent difference. |

**My leaning: C.** Verifying independently is a capability, and lumem's whole adapter doctrine is that capabilities degrade into a weaker mechanism instead of removing the feature. The evidence gate is the floor and it is portable; independence is the ceiling and it is not.

**Sub-question, with a leaning so it does not get lost:** tlc also runs a **discrimination sensor** — it injects behavior-level faults into an isolated scratch copy and confirms the tests kill them; survivors become fix tasks. It is the only mechanism in either reference that measures whether the tests are worth anything. **My leaning: not in this slice.** It needs a scratch worktree, it can leave a dirty tree if it fails halfway, and design rule 1 says the memory layer breaking must never break your work. It belongs in the same later slice as the driver — but the test contract written now should be shaped so a sensor can be bolted on without rewriting it.

**Answer:** ok
**Effect:** accepted

---

## Round 1 — scored

The measurement 001 established: a question that changed nothing is a question the skill should not ask.

Both tables below are **derived from the `**Effect:**` field on each question** — the field is authoritative, the table is a view. `spec lint --json` regenerates it.

| Question | Outcome | Changed the design? |
|---|---|---|
| Q1 gates and phase detection | **rejected my leaning** — A + C, never B | **yes — and cascaded into three consequences** |
| Q2 sizing | accepted C, **added a bias** ("sempre pecar pra cima") | **partly — the bias is new and load-bearing** |
| Q3 driver vs contracts | accepted | no |
| Q4 concreteness in core | accepted | no |
| Q5 verification independence | accepted; sensor deferred as leaned | no |

**One of five changed the design, one refined it.** 001 scored three of thirteen. Both of the answers that moved anything did so by *removing* — Q1 removed a dependency, Q2 removed the freedom to break a sizing tie downward — which is the same pattern 001 found.

No concern has been repeated across rounds yet, so the prune trigger has not fired.

Everything settled here is recorded in `decisions.md` D8–D12, including Q1's three cascades.

---

## Round 2

Five questions. Q6 exists only because of Q1's answer; Q10 only because of Q4's.

---

### Q6 — What runtime do the bundled scripts use?

Q1 settled *that* the checks ship inside the skill. This is *what they are written in*, and it decides whether D8's duplication risk is real or avoided entirely.

| Option | Gain | Cost |
|---|---|---|
| **A. Python 3, stdlib-only, hand-written** — what both references do, and what you named | No build step. Readable in the target repo as plain source. Imports nothing from lumem, so nothing has to stay in sync at build time. | **Adds a runtime lumem does not currently need.** macOS ships a `python3` shim that requires Xcode Command Line Tools; Windows usually has none. It also forces a second implementation of checks that already exist in TypeScript — `core/adr/lint.ts`, the frontmatter parser and serializer, the memory file format — and two implementations of one rule drift. |
| **B. Node bundle, built by `tsup` from `src/`, copied into the repo at install exactly like the hook bundle** | **No new runtime at all**: Node ≥ 20 is already required by the CLI *and* by the hooks, which already run as a copied zero-dep bundle. The scripts import `core/*`, so every rule exists once. Already covered by the existing suite, and the purity assertions in `src/hooks/main.test.ts` already enforce zero-dep for exactly this path. Pinned per repo by the copy. | A build step. The artifact in the target repo is generated, so it reads as a bundle rather than as source. |
| **C. Both — Node when available, Python otherwise** | Widest possible reach. | Two implementations of every rule. It doubles precisely the drift D8 already names as the open risk. |

**My leaning: B, and I think it serves your stated reason better than A does.** Your objection to the CLI was depending on something being installed at the right version. A copied, self-contained bundle maximizes that property — nothing external, nothing global, version frozen per repo at install time. Python moves in the opposite direction: it removes the CLI dependency by adding an interpreter dependency, on the one platform combination where the interpreter is least reliably present. And the mechanism already exists here and is already tested — the hook bundle is this exact shape, and it exists because symlinking into the npx cache broke.

If you want plain readable source in the target repo rather than a bundle, that is a real preference and it points at A — say so and I will take the duplication problem as the price.

**Answer:** B. Accepted (blanket agreement on Round 2, 2026-08-11) — reverses the Python preference stated in Q1 once the interpreter-dependency cost was named.
**Effect:** accepted

---

### Q7 — How does the prune phase work, and what fires it?

Neither reference has this phase. 001 found it the hard way: three rounds accumulated, none subtracted, and the round that cut a third of the surface was the most valuable in the run.

| Option | Gain | Cost |
|---|---|---|
| **A. Its own phase and its own skill**, always between Requirements and Design | Impossible to skip. Visible in the pipeline. | A separate skill re-reads the whole artifact to audit it — the authoring skill already had all of that in context. Pays the ramp-up twice. |
| **B. A mandatory closing step inside the authoring skills** — Requirements and Design each end by pruning what they accumulated | The context is already loaded, so the audit is nearly free. Matches the evidence: 001's prune round asked nothing new, it only re-read what had piled up. | "Mandatory step inside a skill" is weaker than a phase — it is the kind of step that quietly stops running, which is the argument Q1 just settled in favor of executable checks. |
| **C. Trigger-fired from the question loop** — a concern repeated across rounds, or the artifact crossing a size threshold, forces a prune before anything else is added | Catches the real signal. In 001 the trigger was explicit: the same worry stated three different ways across three rounds. | A trigger alone never fires on a feature where nothing repeats, so accumulation still ships. |

**My leaning: B as the floor, C as an additional entry point, checked by the bundled script.** The always-on step is the one that catches ordinary accumulation; the repeated-concern trigger is what catches the case 001 actually suffered, and it has to be able to fire *mid-round*, not only at the end. The script's part is mechanical: did the artifact grow between rounds without a recorded cut?

**Sub-question, with a leaning so it does not go unanswered:** what does a prune *do* with what it cuts? **My leaning: nothing is deleted silently.** Cut scope moves into an explicit `Cut, and why` section, kept separate from Non-Goals — Non-Goals records what you decided against, `Cut` records what the process removed for weight. Different authors, different meanings; collapsing them loses the ability to tell whether pruning is working.

**Answer:** B as the floor, C as an additional trigger, `Cut, and why` kept separate from Non-Goals. Accepted.
**Effect:** accepted

---

### Q8 — Does requirement precision get a fixed notation?

tlc mandates **EARS**: every acceptance criterion resolves to exactly one of five patterns (ubiquitous / WHEN / WHILE / WHERE / IF), always contains SHALL, always uses a concrete value rather than "quickly" or "gracefully" — and a script rejects any criterion that matches no pattern. Compozy, the one whose PRDs you rated highest, uses **no notation at all**: prose business rules plus user stories with acceptance criteria.

| Option | Gain | Cost |
|---|---|---|
| **A. EARS everywhere** | Mechanically checkable. Failure states, state transitions and flag-gated behavior become first-class criteria instead of footnotes — the patterns exist precisely because WHEN/THEN alone hides them. | Reads like a standards document. A PRD written for LLM consumers may not need SHALL-speak, and the voice is the opposite of the "plain, decided" register both of us prefer. |
| **B. Prose, plus the closure gate only** — every ambiguity resolved or logged as an assumption with its default and rationale | Natural voice. And the gate is the part that actually closes ambiguity; the notation only makes the criterion checkable, not correct. | Nothing structural to check, so precision rests on judgment every single time — the condition Q1 just rejected for gates. |
| **C. Notation required only where it earns it** — unwanted-behavior, state-driven and concurrency criteria take the pattern; everything else stays prose | The check can demand a pattern-shaped criterion for each risky dimension without turning the whole document into a standard. | A rule with an exception is a rule someone will argue about at the boundary. |

**My leaning: C.** The risky dimensions are exactly where prose hides the requirement — "handles errors gracefully" is unfalsifiable, and it is always a failure-path criterion. Everywhere else the closure gate does the real work. This also keeps the two things you liked: Compozy's readable PRD voice, and a document a script can still fail.

**Answer:** C. Accepted.
**Effect:** accepted

---

### Q9 — How does question-effectiveness tracking avoid becoming dead bookkeeping?

001 named this the only feedback loop that improves the question set. Neither reference has it, and tlc is explicit about why it built a *script* for its lessons: hand-kept accounting is the failure mode the layer exists to avoid.

| Option | Gain | Cost |
|---|---|---|
| **A. Scored in a table at the end of each round** — what 001 did, by hand, in the retrospective | Zero mechanism. It is just a section. | It survives exactly as long as someone remembers to write it. 001 managed it once, while the run was hot. |
| **B. Scored inline on each question as it is answered** — one field per question: `changed` / `accepted` / `rejected-framing` / `not-understood` | Recorded at the moment of least friction, while the evidence is in front of you. A script can count it, and the counts are comparable across features. | Still hand-written. Nothing forces the field to be honest. |
| **C. Promoted into lumem memory** — durable facts about which *kinds* of question paid off, so the next feature's questioning is shaped by them | The only version where the tracking changes future behavior instead of documenting the past. It is also the thing lumem uniquely can do: it already has consolidation. | Needs a rule for what is worth promoting, or memory fills with process meta. tlc bans this category outright from its lessons layer. |

**My leaning: B now, shaped so it can grow into C.** Note where lumem differs from tlc: tlc refuses process lessons because for it they "ship in a version bump" — the skill is authored elsewhere. lumem *is* the process, so a lesson about how to ask has a legitimate home here. But it does not belong in `correction.md` next to project facts; it needs its own file, or the process meta will crowd out the facts that make injection worth its budget.

**Answer:** B now, its own file when it grows into C. Accepted.
**Effect:** accepted

---

### Q10 — What does preflight load, given the session already injected memory?

Compozy's preflight loads a playbook, standing directives, a glossary, phase-mapped lessons, `CLAUDE.md` sections, prior-phase artifacts, every ADR and the analysis notes — per authoring run, unbudgeted. lumem already injects a prioritized, 4 KB-budgeted block at session start, and 001's D3 settled that **injection is a view, not a storage tier**.

| Option | Gain | Cost |
|---|---|---|
| **A. Preflight loads everything relevant to the phase, independent of the session block** | Simple. The skill is self-sufficient and correct in isolation. | Duplicates the injected block, so the same facts sit in context twice — and the budget injection carefully respected gets blown by the skill that runs right after it. |
| **B. Preflight loads only what the block did not carry** | The budget holds end to end, and 001's D3 finally pays off: the block is the index, preflight is the navigation. | The block has to say what it truncated in a form the skill can read, so injection gains a machine-readable tail. |
| **C. Injection stands down while a spec phase is active** | No duplication at all. | Session start cannot know a spec phase is about to begin. It would have to guess, and guessing wrong means starting a session with no memory. |

**My leaning: B.** It is the design 001 already committed to and has not yet had a consumer for. The cost is one concrete addition — the injected block ends with what it dropped and where to find it — and that same addition is what makes the block honest about its own truncation, which it currently is not.

**Answer:** B. Accepted, including the injected block gaining a machine-readable account of what it truncated.
**Effect:** accepted

---

## Round 2 — scored

| Question | Outcome | Changed the design? |
|---|---|---|
| Q6 script runtime | `accepted` — the leaning stood, reversing the Python preference from Q1 | no, by the field's definition: the reversal came from the question naming a cost, not from the answer |
| Q7 prune mechanics | accepted | no |
| Q8 requirement notation | accepted | no |
| Q9 effectiveness tracking | accepted | no |
| Q10 preflight loading | accepted | no |

**Zero of five changed the design through an answer.** Q6 moved it, but the movement came from naming a cost inside the question — the round's value was in the framing, not in the reply.

Cumulative across both rounds: **ten questions, two moved the design, one of those was a rejected framing.** 001 scored three of thirteen with two of the three being removals. The pattern is holding, and it says the same thing twice: the questions that pay are the ones that take something away.

## Stop

Both of 001's stop triggers are now satisfied, and either alone was sufficient:

- **No remaining fork whose answer would change the design.** Round 2 produced five acceptances; a Round 3 built on that would be asking to look thorough.
- No concern was repeated across rounds, so the design was never on the runaway trajectory 001's prune round had to correct — but pruning is mandatory regardless, and it ran. Its cuts are in `decisions.md` under `Cut, and why`.

Next: the TDD.
