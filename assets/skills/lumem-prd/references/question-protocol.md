# Question protocol

How to run the conversation from an idea to a decided direction. Mechanics — one fork per question, a leaning with its reasoning, a cost column — are in `SKILL.md` and apply throughout.

## The measurement that shapes everything here

**A question that changed nothing is a question this skill should not ask.** Feature 001 scored thirteen questions against that rule: three changed the design, and two of the three did so by *removing* something. Feature 002 scored two of ten, one by rejecting the framing.

So the target is not thoroughness. It is finding the few forks whose wrong answer means rework rather than an edit.

## Build the tree before asking

Map the decisions the feature contains and which depend on which. Then ask the question that unblocks the most downstream decisions first.

Walk it branch by branch. A branch is done when it has a confirmed decision, or when it is explicitly parked as an assumption with the default you chose and why.

## Facts you look up; decisions you ask

Anything discoverable by reading — the codebase, the config, `.lumem/memory/`, `docs/adr/`, an existing feature next door — you resolve yourself. Questions are for what only the author knows: intent, priority, appetite for risk, what the product should do.

Every avoidable question spends attention you will want later for a real fork.

## Chase vagueness

"It depends" gets "on what?". "Probably" gets pinned. "Simple" gets "walk me through it".

A load-bearing branch left fuzzy does not stay fuzzy — it comes back as rework, after the artifact shipped.

## Rounds

- **At most five questions per round.** More reads as a form to fill in, and the answers get shorter as the list gets longer.
- Each round is built on the last. A question that only makes sense after Q4 is answered belongs in round two — asking it early is noise, asking it late is where it does its work.
- **Watch what went unanswered.** A sub-question buried inside a larger one gets skipped silently. Catching that and re-asking it costs one line.
- Score the round when it closes. The table is generated from the per-question `**Effect:**` fields; the fields are the record.

## The two stop signals

Either is sufficient.

1. **No remaining fork whose answer would change the design.** Another round after that is asking to look thorough.
2. **A concern repeated across rounds.** In 001 the author said "my concern is it getting heavy" three times, in three different ways, and the round that acted on it — cutting a third of the surface — was the most valuable in the run. A repeated concern is not an answer. It is a signal to stop adding.

## Question shapes that worked

**Leaning first, with the reasoning.** Eight of thirteen answers in 001 were some form of "accept" — not laziness: the reasoning was there to disagree with, and the once it was wrong the disagreement came immediately. A question with no leaning attached costs the answerer far more.

**Options with a cost column.**

```markdown
| Option | Gain | Cost |
|---|---|---|
| **A. Sequential ids** | Conventional; reading order is decision order | Two branches both create 0007 and git keeps both files silently |
| **B. Date-prefixed** | Collisions near-impossible; sorts chronologically | No short handle |
```

Answering becomes picking, and picking is cheap.

**An explicit invitation to reject the framing**, in the header and in the questions. The highest-value answer in 001 was not a pick: it was "this question assumes a generated index, and we should not have one".

**Rebuild the scenario for anything hypothetical.** 001 asked how a human discovers a module rule id, in a system where modules did not exist, and got back "I don't think I understood". A question about something that does not exist yet has to carry its world with it.

## Anti-patterns

- Bundling two forks into one question, so either answer is ambiguous.
- Asking what the code answers.
- A question with no leaning, which makes the author do your thinking.
- Asking for approval of a plan instead of a decision on a fork.
- Adding a round because the checklist is not covered. The checklist is not the stop condition.
