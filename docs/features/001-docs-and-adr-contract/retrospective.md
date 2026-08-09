# Retrospective — the interrogation itself

Feature 001 was the guinea pig for lumem's own spec-driven process. This is what the run showed, written while it is fresh, as direct input to designing the skill.

**Sample size is one.** One feature, one person, one domain. Everything here is directional.

---

## The measurement

The rule set before starting: *a question that changed nothing is a question the future skill should not ask.* Scoring all thirteen against it:

| Question | Outcome | Changed the design? |
|---|---|---|
| Q1 identity | picked my leaning (B) | no — real fork, pre-resolved |
| Q2 supersedence | accepted | no — but **prevented** a future mistake |
| Q3 birth moment | accepted | no |
| Q4 index | **rejected my leaning** | **yes — and cascaded** |
| Q5 location | accepted | no |
| Q6 frontmatter | accepted | no — but only existed because of Q4 |
| Q7 discovery | accepted, with a concern | no — the **concern** mattered, not the answer |
| Q8 proposal parking | accepted | no |
| Q9 rule ids | **not understood, then moot** | **negative** |
| Q10 scope | **ADR only** | **yes — retroactively killed Q9** |
| Q11 index weight | accepted, concern repeated | no |
| Q12 lint gates | accepted, concern repeated | no |
| Q13 the cut | accepted | **yes — removed a third** |

**Three of thirteen changed the design.** Two of those three were about *removing* rather than deciding.

That ratio is the most useful thing this run produced.

---

## What worked

**Stating a leaning with its reasoning.** Eight of thirteen answers were some form of "accept". That is not laziness — the reasoning was there to disagree with, and the one time it was wrong (Q4) the disagreement came immediately. A question with no leaning attached costs the answerer far more effort, and Q3's sub-question proves it: it had no leaning, and it was the one question that came back unanswered.

**Concrete options with a cost column.** Not "how should ADRs be identified" but three named options with what each buys and what each costs. Answering became picking, and picking is cheap.

**Explicitly inviting a rejection of the framing.** The header said pushing back on the question is worth more than picking an option. Q4 — the highest-value answer in the run — was exactly that: the question assumed a generated index, and the answer removed the index.

**Rounds that depend on prior answers.** Q6 and Q7 only existed because Q4 removed the index. Asking them in round 1 would have been noise; asking them after made them the two most load-bearing questions of round 2.

**Noticing what went unanswered.** Q3 carried a sub-question with no leaning. The "accept" did not cover it. Catching that and re-asking it as Q8 is cheap and would have been silently lost otherwise.

---

## What failed

**Scope was asked at question 10 instead of question 1.** This is the single biggest process error. Q10 narrowed the slice to ADRs only — which retroactively made Q9 irrelevant and would have reshaped Q6, Q7 and Q8 had it come first. Roughly four questions were asked against a scope that had not been fixed.

**Q9 was asked without re-establishing its world.** It asked how a human discovers a module rule id, in a system where modules do not exist. The answer was "I don't think I understood, explain better" — a fair response to a question that assumed a mental model the reader had no reason to hold. **A question about a hypothetical system needs its scenario rebuilt in the question itself.**

**Three rounds accumulated with no pruning.** Every round added; none subtracted. The design grew to fit 200 ADRs while the folder held zero — the exact trap flagged out loud two conversations earlier, walked into anyway. It took the reader saying it twice to stop.

---

## The strongest signal was not an answer

Across Q7, Q11 and Q12 the reader wrote, in three different ways: *"my concern is it getting heavy"*, *"more complex than I imagined"*, *"my concern about complexity remains"*.

Those are not answers. They are meta-comments about the design's trajectory, and they were more informative than any answer in the run. The round that acted on them — Q13, which asked nothing new and cut a third of the surface — was the most valuable round.

**A concern repeated across rounds should be a hard trigger to stop adding and start cutting.**

---

## What this implies for the skill

**Phase order.** Scope first, always. Something close to:

1. **Context** — what this is, why now, what it depends on. No questions yet.
2. **Scope** — what is in this slice and what is explicitly a later one. One question, answered before anything else.
3. **Load-bearing questions** — only those whose wrong answer means rework rather than an edit. Rounds, each built on the last.
4. **Prune** — mandatory, not optional. Ask nothing new. Audit what accumulated against what the slice exists to learn.
5. **TDD** — formats, acceptance criteria, deferred list with triggers.

**Question quality rules, from what actually worked:**

- Always carry a leaning, and the reasoning behind it
- Concrete options with a cost column; never an open "what do you want"
- Invite rejection of the framing, in the header and in the questions
- One question per fork; do not bundle
- A question about something that does not exist yet must rebuild its scenario
- Cap the round — five questions was near the limit; more reads as a form

**Stop criterion.** Not "the checklist is covered". Two triggers, either sufficient:

- No remaining question whose answer would change the design
- A concern repeated across rounds — stop and prune instead

**Track which questions changed the design.** This is the only feedback loop that improves the question set. A skill that never learns which of its questions were dead weight will keep asking them.

---

## Two refinements that came from writing the TDD, not the questions

Worth noting because it argues the TDD phase is not just transcription:

- **`status` became derived** rather than stored. Nothing in the interrogation raised it; writing the field table exposed that storing it would require editing an existing ADR, which contradicts D1. Deriving it removed a field, a write path, and a drift risk.
- **`dangling-chain` became `supersedes-cycle`.** With derived status, the failure named in the questions cannot occur. Enumerating acceptance criteria surfaced the failure the design can actually suffer.

**Formalising a design finds problems that discussing it does not.** The TDD phase should be expected to change the design, not merely record it.

---

## Cost note

The interrogation is expensive-model work: it needs the whole design held in mind at once and depends on noticing what is *absent*. The TDD likewise. Implementation from a TDD with acceptance criteria is not — which is the split the process was designed around, and this run supports it.
