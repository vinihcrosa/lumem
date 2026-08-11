---
slug: 003-closing-the-test-loop
tier: full
created: 2026-08-11
---
# Decisions taken before the interrogation

Settled so they are not re-litigated. Reopening any of them costs a deliberate reversal, not a drift.

## D1 — Scope: declared → implemented → ran → on this tree

The slice closes four links and stops there:

1. A case declared in `tests.md` is **owned** by exactly one task — 002 already gates this.
2. A declared case is **implemented** — new.
3. The gate for that work **ran** — new.
4. The run **matches the tree being claimed** — new.

The fifth link, proving the cases *can* fail, stays out (D6).

## D2 — Tier `full`

Confirmed at the scope phase. The slice touches `lint.ts`, the task-body template, the verdict format, a fingerprint mechanism and two shipped skills, and carries cases of its own. An inline step list exceeds five immediately, which is the safety valve firing before the work starts.

## D3 — lumem checks freshness; it does not run the gate

The agent runs the declared gate and records its output together with a fingerprint of the tree. lumem recomputes the fingerprint and **refuses a verdict that does not match**.

Recorded as an ADR, because the obvious choice is the other one. Two reasons:

- **The measured failure is forgetfulness, not lying.** 002 closed with two unimplemented cases and a `PASS` verdict — nobody lied, nothing looked.
- **A gate that only reads cannot damage a tree; a gate that executes can.** Design rule 1 says the memory layer breaking must never break your work. Surrendering the bundle's read-only property to prevent deliberate forgery pays a structural cost against a threat we do not have — and an agent willing to forge a fingerprint would equally forge the command output that executing would produce.

## D4 — A case counts as implemented when its id appears in the name of a test

lumem carries a small, configurable set of test-declaration patterns and looks for a declared id inside one.

Recorded as an ADR: it puts a little stack knowledge into a stack-agnostic core, which is a real cost, and it is chosen anyway because it is **the only option that would have caught IT-18 and IT-19**. Searching for the id anywhere inside a configured glob is the pure alternative, and it passes both of the cases that motivated this feature — a gate that passes the exact thing it was built for is not a gate.

## D5 — The config declares the default gate; a task may override it

How this project verifies itself is a project fact, stated once. A task needing something narrower says so in its body, and the task wins.

Both halves are already required by what `lumem-verify` says today: a per-task claim is narrow by design, while the closing claim is broad. A design that can express only one of them cannot describe what already happens.

## D6 — The discrimination pass stays deferred

002 D12 deferred it with a trigger: *a shipped feature passes verification and still breaks.* Nothing has. Pulling it in now would pre-empt its own trigger, and it needs a scratch worktree that can leave a dirty tree — against design rule 1.

The trigger stands unchanged. `tests.md` was already shaped to accept the pass without a rewrite.

## D7 — The fingerprint covers what the gate reads, never what records the verdict

Derived rather than asked, because the alternatives refute themselves.

**The verdict lives in the file whose state it certifies.** Writing `- **Result:** PASS` into `tasks.md` changes `tasks.md`; if the fingerprint covered it, recording a verdict would invalidate that verdict in the same keystroke, permanently.

So the fingerprint covers the inputs a gate actually consumes — source, configuration, lockfiles — and excludes `docs/`. Two consequences worth stating before someone rediscovers them:

- Editing a spec artifact does **not** invalidate a verdict. Correct: a rewritten sentence in a design document does not change what the tests do.
- Editing source **does** invalidate it, including a comment. Accepted: over-invalidation costs a re-run, under-invalidation costs a false PASS, and those are not symmetric.

## D8 — References remain references

Unchanged from 002 D4. Compozy and tlc-spec-driven are cited as evaluated prior art; no file is imported, vendored or ported. This slice takes one mechanism from the second — *the task declares its gate command* — and re-derives it in lumem's terms.

---

# Cut, and why

The mandatory prune, run at the close of the requirements phase. It asked nothing new; it audited what the phase accumulated against what the slice exists to deliver.

| Cut | Was | Why it went |
|---|---|---|
| **LOOP-13** | "a failing verdict keeps the next action at verification" | Already shipped. `next.ts` has the rule and UT-27 asserts it. Listing it as a requirement of this slice invites someone to build it twice |
| **LOOP-16** | "no verdict means verify, and the exit status stays 0" | Same — shipped in 002, asserted by UT-27 and IT-02 |
| **LOOP-17** | "every new check exits 3 / 1 / 0" | Not a requirement, an inherited convention. `memory lint`, `adr lint` and `lint --phase` already establish it; restating it makes the slice look larger than it is |

Three of seventeen requirements were restatements of behaviour 002 already ships and tests. They now sit in an **Inherited from 002** note in `prd.md`, which keeps the fact and drops the claim.

## Kept under pressure, with the reason recorded

- **LOOP-05, the "no tests recognised at all" case.** It looks like a special case and it is the difference between one useful failure and eighty-five false alarms. It is also the mitigation the sibling ADR names under Risks, so cutting it would leave that risk unanswered.
- **LOOP-07, the per-task gate override.** Pressed on whether the config default alone would do. It would not: `lumem-verify` already distinguishes a narrow per-task claim from the broad closing one, and without the override a task can only ever cite the whole project gate — which makes every task pay the full cost and makes the narrow claim unexpressible.
- **The configurable pattern set.** The purity cost is real and recorded in the ADR. It stays because a fixed set would make the check useless on the first language nobody anticipated, and the config key is the only thing standing between that and a project turning the check off.
