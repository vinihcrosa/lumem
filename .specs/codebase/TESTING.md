# TESTING — lumem

Contrato de teste do projeto (greenfield; deriva da estratégia aprovada em design.md §Testing Strategy). Criado na fase Tasks; os scripts npm nascem na T1.

## Test Coverage Matrix

| Camada de código | Tipo exigido | Observação |
|---|---|---|
| `src/core/**` (harness, install, memory, capture, consolidate, shared) | **unit** | vitest + fixtures em `mkdtemp`; golden files para parser de fatos e blocos gerenciados |
| `src/cli/**` (comandos) | **integration** | Executa o comando contra dirs temporários (fake homes); asserta filesystem + stdout `--json` |
| `src/hooks/main.ts` (entrypoint) | **unit + chaos** | Chaos = exceção, timeout, stdin malformado, disco cheio → sempre exit 0 |
| `src/runner/main.ts` | **integration** | LLM mockado por script fixture no PATH; nunca chama LLM real em teste |
| `src/adapters/*.json` (descritores) | **unit** (via schema) | Teste valida cada descritor contra o zod schema |
| `assets/**` (SKILL.md, agent, templates) | **none** | Dados; validados indiretamente pelos testes de install/manifest |
| Latência de hook (NFR-2) | **bench** | Script dedicado; assert p95 < 150 ms; roda como step separado no CI |

## Gate Check Commands

| Gate | Comando | Quando |
|---|---|---|
| **quick** | `npm run check && npx vitest run <path-dos-testes-da-task>` | Fim de toda task unit |
| **full** | `npm run verify` (= `biome check . && tsc --noEmit && vitest run && npm run build`) | Fim de task integration / última task de cada fase |
| **build** | `npm run build` (tsup: `cli.js`, `lumem-hook.mjs`, `lumem-runner.mjs`) | Tasks que só tocam build/packaging |
| **bench** | `npm run bench:hook` | T34 e CI (step isolado) |

`npm run check` = `biome check . && tsc --noEmit`.

## Parallelism Assessment

| Tipo | Parallel-Safe | Motivo |
|---|---|---|
| unit | **Sim** | Cada teste cria seu próprio `mkdtemp`; zero estado global |
| integration | **Sim** | Funções core recebem base dirs explícitos; CLI e2e roda em child process com env próprio — nunca muta `process.env` global do worker |
| chaos | **Sim** | Mesmo isolamento de unit |
| bench | **Não** | Sensível a timing; roda sequencial em step de CI dedicado |

## Regras

- Testes co-locados na task que cria o código — nunca task separada de teste.
- Contagem total de testes só cresce; suíte sempre verde antes do commit da task.
- LLM real nunca roda em teste; runner testado com fixture executável mock no PATH.
