# Questions

Answer inline under each **Answer:**. Free form — a sentence is enough, and "option B" is a complete answer. Push back on the framing when the question itself is wrong; that is worth more than picking one of my options.

Where I have a leaning I say so, with the reasoning. Disagreeing with it costs nothing.

---

## Round 1

Five questions. These are the ones where a wrong answer means rework rather than an edit.

---

### Q1 — How is an ADR identified?

The identifier is what `supersedes:` points at, so it has to stay stable for the life of the repository. Renaming a file later breaks every link into it.

| Option | Gain | Cost |
|---|---|---|
| **A. Sequential** — `0001-cookie-sessions.md` | Conventional. "ADR-7" works as shorthand in conversation. Reading order is decision order. | Two branches both create `0007` and git does not see a conflict — it just keeps both files. Happens constantly with parallel work and an agent that proposes ADRs. |
| **B. Date-prefixed** — `2026-08-08-cookie-sessions.md` | Collisions are near-impossible. Sorts chronologically for free. The date is visible without opening the file. | No short handle. Same-day duplicates still possible. |
| **C. Sequential number assigned at merge** | Best of both. | Needs tooling in the merge path, and the number does not exist while the PR is open — so nothing can link to it yet. |

**My leaning: B.** The identifier's job here is to be a stable link target, not to be pretty. Filename collisions are worse than line conflicts because git resolves them by silently keeping both. And an agent proposing ADRs makes parallel creation the normal case, not the exception.

**Answer:** B

---

### Q2 — What does supersedence mean, exactly?

Two sub-questions that shape the data model.

**a) Is it transitive?** ADR-003 supersedes ADR-001. Later ADR-007 supersedes ADR-003. What does ADR-001 now say — "superseded by 003", or "superseded, current answer is 007"?

- Pointing only at the direct successor keeps every file immutable after one edit, but reading the current answer means walking a chain.
- Rewriting the whole chain to point at the newest keeps reading cheap, but edits old files repeatedly — which sits badly with "an ADR is a record of an act".

**b) Can it be partial?** "We changed the database but the reasoning about consistency still holds." Does an ADR supersede another wholly, or can it supersede a part?

**My leaning: transitive by reading, not by rewriting — and no partial supersedence.** An ADR points only at its direct successor and is never touched again; following the chain is the reader's job (and cheap for an agent). Partial supersedence is where ADR systems rot: it turns every decision into a diff against another decision, and nobody can state the current position without assembling fragments. If only part changed, the new ADR restates what still holds. Costs a little duplication, buys a document that stands alone.

**Answer:** I accept the nomination.

---

### Q3 — When is an ADR born, and who writes the first draft?

Four moments, not mutually exclusive. The question is which is the **default** and which is the **net**.

| Moment | Gain | Cost |
|---|---|---|
| **A. Mid-session, the agent interrupts** when it detects a decision | The "why" is hot — you just said it | Interrupting flow is exactly what gets a tool uninstalled |
| **B. At session end, via consolidation** | Batched, no interruption, uses the loop that exists | The "why" is cold; you may not remember the alternative you rejected two hours ago |
| **C. At TDD merge** | Natural gate, everyone still remembers, the debate is right there | Only covers planned work — misses every ad-hoc decision |
| **D. Explicit `lumem adr new`** | Full control | Only fires when you already noticed, and not noticing is the actual problem |

**My leaning: C as the default gate for planned work, B as the net for everything else, D always available, A rejected.**

With one constraint I feel strongly about: **consolidation proposes, it never writes an ADR.** It cannot know the alternatives you weighed — only what you did. An ADR it invents will read authoritative and be missing the only part that mattered.

Which raises the real sub-question: **where does a proposal live while it waits for you?** A draft file in `docs/adr/drafts/`? A line in the next session's injected block ("3 decisions from yesterday have no ADR")? A prompt at the next `lumem doctor`? A proposal nobody sees is the same as no proposal.

**Answer:** I accept the nomination.

---

### Q4 — What reaches the generated index?

The index lives in a managed block in `AGENTS.md` and is injected every session, so it is on the context budget. At 200 ADRs, listing every title is no longer an index — it is the problem the index was meant to solve.

| Option | Gain | Cost |
|---|---|---|
| **A. Every ADR title** | Nothing is hidden | Grows without bound; the budget problem returns one level up |
| **B. Only current (non-superseded)** | Bounded by how many live decisions exist, which is naturally stable | A superseded ADR is only reachable by walking back from its successor |
| **C. Current, grouped by area** | Same bound, plus the agent can skip whole areas | Needs an "area" on each ADR — one more field to get wrong |
| **D. Current, from the last N months** | Hard bound | An old decision that is still in force silently disappears from view, which is worse than the disease |

**My leaning: C.** The bound is right and the grouping is what makes it navigable rather than merely short. The area can start as free text and tighten later.

Underneath this sits a question I cannot answer for you: **is the index expected to be enough on its own, or is it a table of contents the agent is expected to follow?** If the agent never drills in, the index has to carry more; if it reliably drills in, the index can be very thin. My guess is it drills in when the index makes it obvious there is something relevant — which argues for one line of *what the decision was*, not just its title.

**Answer:** Acho que da pra só a pasta, e o agente decide o que ver la dentro, da pra usar o front matter dos arquivos para ter uma idéia geral, e se o agente precisar da informaçào ele le a ADR inteira.

---

### Q5 — Where do ADRs live, and what happens to a feature folder afterwards?

**a)** An ADR born out of feature 001 — does it live in `docs/features/001-.../` or in `docs/adr/`?

**My leaning: always `docs/adr/`.** By D7 what makes something an ADR is precisely that it crosses features. Filing it under one contradicts what it is, and the next feature would never find it. The feature folder links to it instead.

**b)** What happens to `docs/features/001-.../` after the feature ships? It holds `context.md`, `decisions.md`, `questions.md`, the TDD, and the tasks.

- Kept forever: it is a record of acts, like an ADR — and the interrogation transcript is the richest "why" the repository will ever hold.
- Archived or pruned: it is scaffolding, and 80 stale feature folders make the tree unreadable.

**My leaning: kept, but out of the index.** The reasoning inside is exactly the knowledge that cannot be reconstructed, so deleting it destroys the most expensive thing here. But it is historical, so it earns no space in the injected context — reachable by search, not by listing.

**Answer:** aceito o que vc indicou.

---

## Round 2

**What round 1 settled:** date-prefixed ids (Q1); supersedence is a chain followed by reading, never partial (Q2); TDD merge is the gate, consolidation is the net, consolidation proposes and never writes (Q3); ADRs live in `docs/adr/` and feature folders are kept but stay out of the injected context (Q5).

**What your Q4 answer changed.** I had assumed a generated index in `AGENTS.md`. You removed it: point at the folder, let the agent list it, use frontmatter for the overview, read the whole ADR only when it matters.

That is a real simplification — an index that is never written can never drift, and it costs nothing at session start. But it moves the entire discovery burden onto two things that now have to carry it: **the frontmatter**, and **the agent deciding to look at all**. Q6 and Q7 are about exactly that.

One question from round 1 also came back unanswered: where an ADR proposal waits for you (Q8). It was a sub-question under Q3 with no leaning attached, so "accept" did not cover it.

---

### Q6 — What is in the frontmatter?

It now carries the whole overview. The test it has to pass: **can the agent decide "is this ADR relevant to what I am about to do" without opening the body?**

A minimum that clearly works:

```yaml
---
title: Session cookies over JWT
date: 2026-08-08
status: current            # or superseded
area: auth                 # for skipping whole groups
---
```

Three things I am unsure about, each with a real cost:

**a) A one-line summary of the decision, separate from the title?** A title like "Session cookies over JWT" already says a lot; "Boundary rules" says nothing. A `summary:` line makes every ADR self-describing at a glance, at the cost of a field that can drift away from the body.

**b) `supersedes` / `superseded_by` both in frontmatter?** `supersedes` has to be there — it is the link. But its inverse is what a reader needs when they land on an old ADR from a search. Storing both means writing to the old file when a successor appears, which bends "an ADR is a record of an act" — though only in metadata, never in the body. The alternative is deriving the inverse by scanning, which means it does not exist until something scans.

**c) `tags` on top of `area`?** More retrieval surface for grep, or a field nobody maintains consistently.

**My leaning:** title, date, status, area, summary, supersedes — and yes, write `superseded_by` into the old file when a successor lands. Metadata is bookkeeping, and bookkeeping is exactly what the machine should do. No tags until something actually needs them.

**Answer:** concordo com vc

---

### Q7 — How does the agent know to look at all?

With no index in the injected block, nothing hints that `docs/adr/` has anything relevant. The agent looks only if it thinks to look — and the failure mode is silent: it proposes JWT, never having seen the ADR that rejected JWT, and nothing anywhere reports a problem.

| Option | Gain | Cost |
|---|---|---|
| **A. An imperative rule in the injected block** — "before proposing architecture, list `docs/adr/` and read what looks relevant" | Almost free. One line of context. Same shape as the memory skill's "read memory before acting" | Depends on the agent obeying a rule with no evidence attached. Cheap rules are cheap to ignore |
| **B. A command — `lumem docs index`** — digests every frontmatter into one deterministic listing | One tool call instead of N file reads. Cannot drift, since it is computed at read time. Costs context only when asked | Still needs A to tell the agent the command exists |
| **C. Both: the rule names the command** | The rule is concrete and one call away from an answer | Nothing meaningful |

**My leaning: C.** Your Q4 instinct was to compute rather than store, and I think it is right — but computed by a command, not by the agent reading sixty files. It keeps the zero-drift property and makes the cost one call.

The sharper version of the question: **is "read the ADRs" a rule the agent should follow always, or only when it is about to make an architectural claim?** Always is safe and wasteful. Only-when-relevant depends on the agent recognising the moment — which is the same judgement it already gets wrong when it proposes something the team rejected six months ago.

**Answer:** Eu tendo a concordar com vc, a minha preocupação é sobre ficar pasado.

---

### Q8 — Where does an ADR proposal wait for you?

From Q3: consolidation proposes, never writes. So a proposal exists in some in-between state. A proposal nobody sees is the same as no proposal.

| Option | Gain | Cost |
|---|---|---|
| **A. `docs/adr/drafts/`** — a real file, committable, editable | You edit prose in your editor, and the draft can go into a PR as-is | Drafts accumulate silently; nothing forces you to look. Also: does a draft get committed, or is it local? |
| **B. A line in the next session's injected block** — "2 decisions from yesterday have no ADR" | Impossible to miss; costs almost nothing | Nagging every session until you act is exactly how people learn to ignore a warning |
| **C. Surfaced by `lumem doctor`** | Fits an existing habit; already the place for "something needs your attention" | Only seen when you run it, which is rarely |
| **D. A question at the start of the next session** — the agent asks you directly | The "why" gets captured while you are already thinking about the project | Interrupts, which is what killed option A in Q3 |

**My leaning: A for the content plus B for the pointer, capped.** The draft is a real file so you can edit it like prose; the injected line is one sentence naming how many drafts wait, and stops mentioning any individual draft after a few sessions so it never becomes wallpaper.

The part I genuinely do not know: **should a draft be committed?** Committed means the team sees it and can finish it; uncommitted means half-thoughts do not pollute the repository. My instinct says `docs/adr/drafts/` is committed and being in `drafts/` is itself the signal that it is unfinished — but this is your team's tolerance, not mine.

**Answer:** Concordo

---

### Q9 — How does a human discover a module rule's id?

To write `supersedes: backend-dotnet/commands-mediatr` you have to know that id exists and how it is spelled. Nobody memorises rule ids.

| Option | Gain | Cost |
|---|---|---|
| **A. `lumem rules list`** — lists every active rule with id, source module and text | Explicit, greppable, works offline | Only helps if you know to run it |
| **B. Ids visible in the injected block** — each rule reaches the agent with its id attached | The agent can quote the id when it proposes an ADR — no lookup needed | Every rule costs a few more characters of context, every session |
| **C. The agent proposes the ADR with the id already filled in**, because it saw the rule it is overriding | Zero lookup for you | Only covers the case where the agent noticed the conflict |

**My leaning: B plus C.** The id in the injected block is a handful of characters and it is what makes C possible at all — the agent cannot cite what it cannot see. A is worth having, but as a debugging tool rather than the main path.

**Answer:** Eu não sei se eu entendi bem essa parte, explica melhor.

---

### Q10 — What is in this slice, and what is a later one?

A scope question, and I think it decides how fast this becomes real.

The wider `docs/` vision includes: ADRs, the module map, `architecture.md`, `conventions/`, `workflows/`, TDDs, feature folders, and a pointer to graphify's output. That is a lot, and only ADRs have been designed.

| Option | Gain | Cost |
|---|---|---|
| **A. ADR only** — format, supersedence, drafts, discovery, lint. Everything else later | Shippable soon, and the answers to "does the agent actually look" arrive from real use | The tree grows one folder at a time, which may feel incoherent while it does |
| **B. ADR + the module map** — the two you named as most valuable | Covers "the agent should not have to hunt for who owns what" | The map is semi-observable and its own design problem: generated, authored, or proposed |
| **C. The whole `docs/` contract** — every document type, defined up front | One coherent structure, decided once | Weeks before anything is usable, designing conventions and workflows without a real case to test them against |

**My leaning: A.** The specific thing I want to learn from real use — whether the agent reliably consults ADRs it was merely pointed at — is answerable within days with ADRs alone, and it invalidates or confirms the design of everything else in `docs/`. Guessing that answer while designing five more document types multiplies the cost of being wrong.

**Answer:** agora é só ADR

---

## Round 3

Two questions. I think this is the last round before the TDD.

**On Q9 — it was my explanation that failed, and Q10 makes it moot anyway.**

What I was asking: once modules exist, a module like `backend-dotnet` ships a rule — say *"commands go through MediatR handlers"* — and that rule is injected into your agent every session. Your team does not work that way. By D6, switching it off means writing an ADR whose frontmatter points at the specific rule:

```yaml
supersedes: backend-dotnet/commands-mediatr
```

The question was: where does that string come from? You never wrote the module and have never seen its files. All you know is *"the agent keeps telling me to use MediatR."*

**Deferred.** Q10 scoped this slice to ADRs, and modules do not exist yet. The only thing it leaves behind for us now is a format constraint: `supersedes` must be able to point at **either** another ADR **or** a module rule id, so the field does not need redesigning later. That costs nothing today.

---

### Q11 — Making the index cheap enough to run every time

You agreed with C but flagged the weight, and the concern is right. Let me split it, because "heavy" means two different things here and only one of them is a real problem.

**The rule itself is not the cost.** The line that reaches the injected block is roughly:

> *Architectural decisions live in `docs/adr/`. Before proposing or changing architecture, run `lumem docs index` and read any ADR that looks relevant.*

That is about 45 tokens against a 4 KB budget — around 4%. Not worth optimising.

**The command output is the cost.** At 60 ADRs, one summary line each is ~5 KB. If the agent runs that on every session unconditionally, it has quietly undone the whole point of not having an index.

Which leaves the tension I raised at the end of Q7: *always run it* is safe and wasteful, *run it when relevant* is cheap and depends on judgement.

**What I would do instead: make the first call bounded regardless of how many ADRs exist.**

```
$ lumem docs index
auth        4 decisions   (latest 2026-08-08)
storage     2 decisions   (latest 2026-06-11)
build       7 decisions   (latest 2026-07-02)
→ lumem docs index --area auth
```

Ten lines whether you have 20 ADRs or 200. The agent can then drill into one area and read only those summaries. So "always run it" becomes affordable, and the judgement call moves to *which area*, which is a much easier judgement than *is this the kind of moment where I should check*.

**Answer:** Parece ok, eu tenho uma preocupação que é a complexidade, parece que ta ficando mais complexo do que eu imaginava.

---

### Q12 — Which ADR lint checks are gates, and does `lint` stay one command?

`lumem memory lint` exists and exits 3 on findings. The ADR checks I can see:

| Check | What it catches | Gate or info? |
|---|---|---|
| `broken-supersedes` | `supersedes:` points at an ADR (or rule) that does not exist | Broken link — a reader following the chain hits nothing |
| `dangling-chain` | An ADR marked `superseded` whose successor was deleted or never landed | The current position is unknowable |
| `missing-frontmatter` | No title, date, status or area | Invisible to discovery — the ADR effectively does not exist |
| `stale-draft` | A draft in `docs/adr/drafts/` untouched for N days | The proposal nobody acted on |
| `dead-reference` | An ADR naming a file that no longer exists | Already implemented for memory; same check, different corpus |
| `contradiction` | Two current ADRs in the same area that appear to disagree | Same fuzzy heuristic as memory — a candidate, never a verdict |

**Two things I want your call on.**

**a) Which of these fail CI?** My leaning: `broken-supersedes` and `dangling-chain` are gates — they are objectively broken, not matters of taste, and they make the chain unreadable, which is the one property the whole supersedence design rests on. Everything else is informational. `dead-reference` on an ADR is deliberately *not* a gate: an ADR is a record of an act, so naming a file that has since been deleted is often correct and historically accurate.

**b) One command or two?** `lumem lint` covering memory and docs together, or `lumem memory lint` and `lumem docs lint` separately? My leaning: keep the specific ones and add `lumem lint` as the one that runs both — one habit to form, and each surface still reachable on its own for CI.

**Answer:** nos dois casos eu concordo com vc, mas ainda fica aqui minha preocupação sobre a complexidade.

---

*After this round I believe we have enough to write the TDD: identity, supersedence, birth and drafts, frontmatter, discovery, scope, and the checks. Anything still fuzzy will be sharper as acceptance criteria than as more questions.*

---

## Round 4 — one question, and it is about cutting

You said "more complex than I imagined" twice. I think you are right, and the drift is mine.

Here is everything three rounds accumulated, for a folder that currently holds **zero** ADRs:

date-prefixed filenames · seven frontmatter fields · supersedence chains · three birth moments · a drafts folder · a capped injected pointer · `lumem docs index` with area grouping and drill-down · an injected rule · six lint checks · a `lumem lint` umbrella.

This is the same trap I warned about when we discussed Karpathy's `index.md`: **designing for volume that does not exist.** `lumem docs index` with grouping earns its keep at 60 ADRs. At five, `ls docs/adr/` and reading frontmatter is already cheap. Six lint checks matter when links break unnoticed; with five files you see it by eye. Drafts and their injected counter only matter once consolidation is proposing — and consolidation still has not run once in a live session.

Nothing above is wrong. It is all premature.

**What actually tests the hypothesis.** The thing worth learning from this slice is one question: *does the agent consult ADRs it was merely pointed at?* If the answer is no, most of the design above is wasted anyway.

The smallest thing that answers it:

| Keep | Why |
|---|---|
| `docs/adr/` with the frontmatter shape | Without it there is nothing to consult |
| Date-prefixed names, `supersedes` chain | Your rule: never deleted, newest wins. Cheap now, expensive to retrofit |
| A rule in the injected block naming the folder | This *is* the hypothesis under test |
| `lumem adr new` | Making one has to be trivial or none get made |
| Two lint checks — `broken-supersedes`, `dangling-chain` | The only failures that are invisible to a human reader |

| Defer until there is evidence | Trigger to revisit |
|---|---|
| `lumem docs index` and its grouping | When `ls` plus frontmatter stops being enough — you will feel it |
| Drafts folder and the injected counter | When consolidation actually runs live and proposes something |
| The other four lint checks | When a real one slips through |
| `lumem lint` umbrella | When there are three things to lint, not two |
| `superseded_by` written back | When a chain gets long enough to be annoying to walk |

That is roughly a third of the surface, and it still answers the question the slice exists to answer.

### Q13 — Does this cut go far enough, or should it go further?

Three responses are all reasonable: **take the cut as written**, **cut deeper** (say, drop `lumem adr new` too and just write the file by hand until that hurts), or **keep something I put in the defer column** because you know you will want it immediately.

**Answer:** acho que vc entendeu o que eu quis dizer, o corte que vc fez ta bom, vamos seguir com isso
