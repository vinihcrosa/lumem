---
name: lumem-memory
description: Read and write durable project memory during the session. Use when the user corrects you, states a preference, records a decision, or asks what the project memory knows.
---

# lumem-memory (stub — completed in T27)

Read memory before acting: run `lumem memory context` and treat its output as project context.

Write only durable, falsifiable facts: `lumem memory add --type <project|preference|correction> "<fact>"`.
