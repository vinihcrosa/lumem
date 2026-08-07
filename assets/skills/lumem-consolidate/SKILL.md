---
name: lumem-consolidate
description: Consolidation prompt - turns a raw session journal into a patch of durable memory facts. Invoked headless by the lumem runner, not interactively.
---

# lumem-consolidate (stub — completed in T38)

Input: session journal (JSONL) + current memory files.
Output: a JSON patch `{ version: 1, add: [], replace: [], remove: [] }` — nothing else.

Anti-junk rules (final wording in T38): no repo duplication, facts must be falsifiable, no speculation, prefer removal over accumulation.
