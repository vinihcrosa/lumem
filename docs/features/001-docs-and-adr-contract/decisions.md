# Decisions taken during discussion

Settled before the interrogation started. Recorded here so they are not re-litigated — and so the questions in `questions.md` can assume them.

Anything here can still be reopened, but it costs a deliberate reversal, not a drift.

## D1 — Documentation is a record of acts; memory is a claim about the present

The axis that separates the two.

- **ADR**: *"on 2026-08-08 we decided X because Y."* Immutable. It was true then and stays true forever as a historical fact.
- **Memory**: *"auth uses session cookies."* A claim about **now**. When the code changes the claim becomes false and must be corrected or dropped.

This derives the ADR rules rather than imposing them: an ADR is never deleted because an act cannot un-happen. Memory has `remove` in the consolidation patch because a claim can become a lie.

It also explains why `stale` and `dead-reference` are memory checks. **Memory rots. An ADR is superseded.** Different deaths, different treatment.

## D2 — Four layers, each with its own lifecycle

| Layer | Nature | Changes by | Rots by | Example |
|---|---|---|---|---|
| **Generated reference** | derived from code | regeneration | impossible by construction | module map, call graph |
| **Decision (ADR)** | historical | accumulation only | being superseded | "cookies over JWT, for immediate revocation" |
| **Rule (convention)** | normative | editing | everyone quietly ignoring it | "commit scopes are these" |
| **Fact (memory)** | descriptive | correction and pruning | the code moving underneath | "the e2e suite needs docker compose first" |

## D3 — Injection is a view, not a storage tier

Today lumem's memory files and the injected block are 1:1, which is why the two concepts blur. They should not be. The `SessionStart` block is assembled *from* the layers:

- active **rules** (core + modules) — always
- **facts**, recent and high-confidence — budgeted
- an **index** of everything else — ADR titles, module map, available workflows

An ADR does not enter the context in full. Its title does. The agent navigates when it needs the body.

## D4 — A module ships rules, procedures and lenses. Never facts or decisions

Facts and decisions belong to a repository; nobody can package "you decided X". Rules, workflows, templates, capture lenses and prompt fragments are packageable.

```
modules/backend-dotnet/
  module.json     # id, requires: [backend]
  rules/          # normative — reaches the injected block
  skills/         # procedures: new-endpoint, document-api
  agents/         # with a model tier per phase
  templates/      # ADR shape, architecture.md sections for this domain
  signals/        # what capture should notice here
  prompt/         # what consolidation should look for and how to classify it
```

## D5 — Precedence

```
core rule  <  module rule  <  project docs  <  project memory  <  explicit correction
```

The same shape as the PRD's principle 1 ("on conflict, the one above wins"), applied to a second dimension. A module gives you opinions on day zero; memory corrects them when reality disagrees. Neither becomes a tyrant.

## D6 — Disagreeing with a module rule is an ADR

Without a mechanism, a rule the project rejects stays injected forever alongside the memory fact that contradicts it — burning context and creating ambiguity every session.

Rejecting a module's rule is an architectural decision, so it takes the form every architectural decision takes. The ADR declares the link:

```markdown
---
supersedes: backend-dotnet/commands-mediatr
---
```

The rule then drops out of injection through D5, and the reasoning is recorded where reasoning belongs. This requires module rules to carry **stable ids**.

Two lint checks fall out: an ADR pointing at a rule that no longer exists, and a module rule contradicted by memory with **no** ADR — the signal for "you disagree in practice but never decided".

## D7 — Architectural decision → ADR. Feature-scoped decision → stays in the TDD

- *"Use a relational database"* → ADR. It crosses the system.
- *"Build endpoint X this way"* → TDD. It dies with the feature.

**Promotion exists.** A feature-scoped decision copied by a second and third feature has become architecture without anyone deciding. The repetition is observable, so it can be surfaced: *"this pattern from TDD-005 has now been repeated in 3 features — promote to ADR?"*

## D8 — RFC is the PR carrying the TDD and its tasks

Document and state at once. Accepted means merged.

Consequence worth keeping: **RFC state is derivable from git**, so there is no status field to go stale — which is where RFC processes usually rot.

Cost worth naming: **the debate lives outside the repository.** The richest reasoning ends up in review comments, which no agent reads offline, `grep` never finds, and a platform migration erases. Merge is the natural moment to distil it — the decision is final and everyone still remembers why.

## D9 — graphify owns the derivable graphs

Dependency graphs and call graphs belong to [graphify](https://github.com/Graphify-Labs/graphify). `docs/` **points at** its output rather than duplicating it — the same instinct as "an adapter is data": do not rebuild, reference.

The module map is a different thing and complements it. graphify says *who calls whom*; the map says *what each part is responsible for*. The first is derivable, the second needs human intent.

---

# Settled by the interrogation

`questions.md`, rounds 1–4. Referenced by question number so the reasoning stays findable.

## D10 — ADRs are identified by date-prefixed filename *(Q1)*

`docs/adr/YYYY-MM-DD-slug.md`. The identifier's job is to be a stable link target, not to be pretty. Filename collisions are worse than line conflicts because git resolves them by silently keeping both files — and an agent that proposes ADRs makes parallel creation normal rather than exceptional.

## D11 — Supersedence is a chain, followed by reading, never partial *(Q2)*

An ADR names only its direct successor and is never edited again. Reading the current position means walking the chain, which is cheap for an agent. Partial supersedence is rejected: it turns every decision into a diff against another decision until nobody can state the current position without assembling fragments. When only part changed, the new ADR restates what still holds.

## D12 — Birth: TDD merge is the gate, consolidation is the net *(Q3)*

`lumem adr new` is always available. Consolidation may **propose** but never writes an ADR — it knows what was done, not what was weighed, and an invented ADR reads authoritative while missing the only part that mattered. Mid-session interruption is rejected outright.

## D13 — No generated index; the folder is the index *(Q4)*

Point the agent at `docs/adr/`, let it list the folder and read frontmatter for the overview, and open the body only when it matters. An index that is never written cannot drift. The cost is that frontmatter now carries the whole discovery burden, and the agent has to decide to look at all.

## D14 — Frontmatter carries the overview *(Q6)*

`title`, `date`, `area`, `summary`, `supersedes`. The test it has to pass: can the agent decide "is this relevant to what I am about to do" without opening the body?

**`status` is derived, not stored.** An ADR is superseded exactly when another ADR names it in `supersedes`. Computing it removes a field, removes the write-back to old files, and removes any chance of the two disagreeing — the same "compute rather than store" instinct behind D13.

## D15 — Discovery is a rule in the injected block *(Q7, Q11)*

Nothing hints that `docs/adr/` holds anything relevant, so the injected block carries an imperative line pointing at it. The rule costs roughly 45 tokens against a 4 KB budget; the expensive part is never the rule, it is whatever the agent then reads.

## D16 — Scope is ADRs only, and the design was cut back *(Q10, Q13)*

Three rounds accumulated a design sized for 200 ADRs in a folder holding zero — the same trap flagged when discussing Karpathy's `index.md`. Roughly a third of the surface was deferred with explicit triggers to revisit. Nothing cut was wrong; all of it was premature.

The slice keeps only what answers the question the slice exists to answer: **does the agent consult ADRs it was merely pointed at?**
