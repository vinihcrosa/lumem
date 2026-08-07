# STATE — lumem

## Decisions

- [2026-08-07] **Memória de projeto commitada por padrão.** Conhecimento vira artefato compartilhado revisável em PR. Diário de sessão nunca commitado. (PRD §5.2)
- [2026-08-07] **Consolidação em processo separado e desanexado.** `SessionEnd` dispara e retorna imediatamente; nunca bloqueia encerramento. (PRD §6)
- [2026-08-07] **Heurística de correção só marca sinal.** Quem decide se vira fato é a consolidação (LLM). Nunca escrita direta em memória durável. (PRD §6)
- [2026-08-07] **`core/` agnóstico de harness.** Adapters são descritores declarativos em `src/adapters/*.json`; adicionar harness = adicionar arquivo. (PRD §15)
- [2026-08-07] **Spec V1 criada a partir do PRD** com defaults do PRD assumidos para as decisões em aberto (ver Open Decisions abaixo e spec §Decisões assumidas).
- [2026-08-07] **Tabela de capacidades do PRD §7.1 reverificada** contra docs oficiais e fonte. Deltas registrados em design.md §0 — Codex: 11 eventos de hook estáveis ligados por default (flag `hooks`; `codex_hooks` = alias deprecated), Windows suportado, skills em `.agents/skills` (não `.codex/skills`), SessionStart injeta contexto via stdout. Descritores V1 usam os fatos verificados.
- [2026-08-07] **Injeção primária = hook-stdout nos dois harnesses.** Cadeia de fallback (`injection[]` no descritor) mantida como dado para harness futuro.
- [2026-08-07] **Hook config no Codex via `.codex/hooks.json`** (não `[hooks]` em `config.toml`) — evita parser/writer TOML na V1.
- [2026-08-07] **Windows V1 = skill-only por decisão de escopo**, não por limitação (Codex suporta hooks no Windows via `command_windows`). Reduz matriz de teste.
- [2026-08-07] **Hook bundle com zero deps** (nem zod; validação manual de stdin) para p95 < 150ms; zod fica no CLI e no runner desanexado.

## Open Decisions (PRD §13 — assumidos com default, confirmar com o autor)

1. ~~**Nome npm.**~~ **RESOLVIDA** [2026-08-07]: `npm view lumem` → 404, nome livre. Pacote publica como `lumem`.
2. **Memória de projeto commitada?** Assumido: **sim** (default do PRD). Reverter para gitignored+opt-in só se PRs ficarem ruidosos.
3. **Runtime da consolidação.** Assumido: harness em uso (`claude -p` / `codex exec`) com modelo barato por padrão, configurável em `lumem.config.json`. Evita credencial extra; custo controlado pelo gate.
4. **Dois harnesses no mesmo repo.** Assumido: **memória compartilhada** (mesmo projeto, mesmo conhecimento). Segregação só se surgir conflito real.
5. **Versões mínimas de Claude Code e Codex.** Proposta concreta do design (2026-08-07): **Claude Code ≥ 2.1.224, Codex ≥ 0.147.0** (versões estáveis na data da verificação). Confirmar e gravar em `lumem.config.json` no M0.

## Blockers

- [2026-08-07] Limite de sessão do Claude atingido durante a fase Execute (reset 20h America/Sao_Paulo). Agents de T14, T22, T23, T37 morreram no meio; arquivos RED órfãos removidos, repo verde (246 testes). Retomar relançando essas 4 tasks.

## Handoff de execução (para retomar)

**Concluídas e commitadas (16):** T1–T7 (M0 completo ✅ — doctor real identifica os 2 harnesses), T8–T13, T20, T21.
**Próximas (deps satisfeitas):** T14 (apply), T22 (budget), T23 (limits), T37 (patch) — relançar; depois T15/T16 (precisam T14), T24/T26 (precisam T22), T25 (livre, src/cli).
**Regra nova de orquestração:** subagents de comandos CLI NÃO tocam `src/cli/index.ts` — exportam `registerX(program)` e o orquestrador fia no index (evita conflito entre agents paralelos).
**Fix pendente (fora de task, achado no T7):** `probeVersion` em `src/core/harness/detect.ts` pendura quando grandchild segura o pipe do stdout (codex --version com cache frio ~43s; spawnSync timeout não resolve). Fix: capturar stdout/stderr via arquivo temp (fd), não pipe; teste com bin fixture que spawna filho background segurando stdout — duração < 2s.

## Todos

- [x] Reverificar tabela de capacidades §7.1 contra versões atuais de Claude Code e Codex — feito 2026-08-07, resultado em design.md §0
- [x] M0: checar disponibilidade do nome `lumem` no npm registry — feito na T1: livre (404)

## Lessons

- [2026-08-07] Tabela de capacidades de harness em PRD envelhece em semanas (Codex: hooks saíram de experimental→estável, skills mudaram de diretório). Fatos de harness devem viver nos descritores versionados + `doctor`, nunca só em doc.

## Deferred Ideas

- Um arquivo por fato (mitigação de conflito de merge em `project.md`) — pós-V1
- Binário compilado se cold start do Node não fechar NFR-2 — avaliar após medição em M3

## Preferences

- Documentos de spec/projeto em português (idioma do PRD)
