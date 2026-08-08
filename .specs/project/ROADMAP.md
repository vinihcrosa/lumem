# Roadmap — lumem V1

Marcos do PRD §14. M0–M2 entregam valor interno sozinhos (instalador de convenções — a dor original).

| Marco | Entrega | Critério de saída | Status |
|---|---|---|---|
| M0 — Esqueleto | CLI TS, detecção de harness, `doctor`, `status` | `npx lumem doctor` identifica corretamente os dois harnesses | ✅ Done |
| M1 — Instalador | Manifest, lockfile, blocos gerenciados, `install`/`uninstall`/`--dry-run` | Instala e desinstala sem deixar resíduo nem tocar conteúdo do usuário | ✅ Done |
| M2 — Memória manual | Formato de arquivo, comandos `memory *`, injeção via skill | Agente lê e usa a memória; escrita ainda é manual | ✅ Done |
| M3 — Captura | Hooks de sinal nos dois harnesses, diário de sessão | Sinais aparecem no diário; zero sessão quebrada em uma semana de uso | ✅ Done |
| M4 — Consolidação | Skill + agent de consolidação, gate, compactação | Fatos úteis aparecem sozinhos após uso real | ✅ Done |
| M5 — Endurecimento | Fail-open testado, scrub de segredo, docs, README | Pronto para tornar o repositório público | ✅ Done |

## Mapeamento marco → stories da spec

| Marco | Stories |
|---|---|
| M0 | P1.1 |
| M1 | P1.2 |
| M2 | P1.3 |
| M3 | P2.1 |
| M4 | P2.2 |
| M5 | P3.1 |

## Fora de escopo V1 (anti-creep)

- Geração de skills específicas do repo (comportamento tipo Hermes Agent) — **V2**
- Harnesses além de Claude Code e Codex
- Sync de memória via servidor (git resolve)
- Busca semântica / embeddings
- Web UI, dashboard, marketplace
- Orquestração de tarefas, multi-agente
- Hooks no Windows
