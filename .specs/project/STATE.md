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
5. **Versões mínimas de Claude Code e Codex.** Congeladas nos descritores: Claude Code ≥ 2.1.224, Codex ≥ 0.147.0 — escolhidas por serem o release estável na data da verificação, **não** por serem a versão mais antiga compatível. Consequência observada em smoke: a máquina do autor roda Codex 0.144.6, então `doctor` sai 3 com aviso de incompatibilidade (comportamento correto do design, mas ruidoso se 0.144.6 já suportar o que usamos). **Pendente:** verificar em qual versão hooks viraram estáveis e `.agents/skills` passou a ser o diretório de skills; baixar o mínimo até lá. Não chutar — verificar contra o changelog do `openai/codex`.

## Blockers

(nenhum — V1 completa)

## Estado atual (2026-08-08)

**48/48 tasks, M0–M5 completos.** 62 commits, 1052 testes em 43 arquivos, `npm run verify` verde em três rodadas consecutivas.

Verificado contra binário real, não só em teste:
- `doctor` identifica os dois harnesses instalados com grade e fallbacks
- install → uninstall devolve todo arquivo do usuário byte-idêntico, inclusive `.claude/settings.json` pré-existente
- ciclo de memória ponta a ponta pelo bundle instalado: injeção priorizada, captura de correção no diário, recusa de segredo com exit 1
- tarball empacotado instala em dir limpo e roda a CLI completa (`verify-pack.sh`)
- latência de hook p95 33 ms (teto NFR-2: 150 ms); 185 invocações de chaos, todas exit 0

### Bugs de integração achados por smoke/chaos (todos com regressão)

Padrão que se repetiu: cada peça passava isolada, o contrato entre elas estava errado. Só apareceram ao exercitar o caminho real.

1. **Lockfile guardava hash da fonte para artefato renderizado** → replan reportava conflito permanente, furava FR-14. Corrigido com `contentHash`.
2. **Mesmo bug em `detectDrift`** (passou batido no primeiro fix) → `doctor` sairia 3 e `sync` gritaria drift em todo projeto saudável.
3. **Bundles symlinkados para o cache do npx** → link pendura quando o cache é podado, hook morre. Bundle e hook-config agora sempre copiam.
4. **`parsePatch` travava no envelope do harness** (`claude -p --output-format json`) → consolidação com claude-code nunca funcionaria.
5. **`settings.json` do usuário era substituído inteiro** → destruía permissions/env/hooks. Agora merge com marcador `__lumem__`, e uninstall faz unmerge preservando edições pós-install.
6. **`probeVersion` pendurava com pipe** quando grandchild segura stdout (`codex --version` com cache frio, ~43s). Captura por arquivo.
7. **Corrida de build entre suítes** (`tsup --clean` apagando `dist/` sob spawn paralelo) → quebrava `npm run verify`. `globalSetup` constrói uma vez.

## Decisões tomadas na execução (sem consulta — reverter se discordar)

- **Saída da CLI em inglês**, specs seguem em português. Motivo: pacote npm público no M5. Commit isolado (`refactor(cli): saída do usuário toda em inglês`).
- **Subagents de CLI não tocam `src/cli/index.ts`**: exportam `registerX(program)` e o orquestrador fia. Evita conflito entre agents paralelos.

## Pendências reais para uso em produção

- **Nenhuma sessão real de agente exercitou o loop completo ainda.** Todo o fluxo foi validado com LLM mockado; a consolidação nunca rodou contra um modelo de verdade. É o próximo passo e o que valida a métrica que importa (>60% de fatos úteis).
- Mínimo do Codex está em 0.147.0 por ser o release atual, não por ser o mais antigo compatível — ver decisão em aberto #5.

## Todos

- [x] Reverificar tabela de capacidades §7.1 contra versões atuais de Claude Code e Codex — feito 2026-08-07, resultado em design.md §0
- [x] M0: checar disponibilidade do nome `lumem` no npm registry — feito na T1: livre (404)

## Lessons

- [2026-08-07] Tabela de capacidades de harness em PRD envelhece em semanas (Codex: hooks saíram de experimental→estável, skills mudaram de diretório). Fatos de harness devem viver nos descritores versionados + `doctor`, nunca só em doc.

## Deferred Ideas

- `SecretHit` devia carregar `length`/`end` além de `index`. Sem isso, `redact` (T30) re-deriva o span do segredo por heurística de formato. Funciona e é testado, mas é fragilidade evitável num caminho de segurança — ao mexer em `secrets.ts`, adicionar o campo e apagar `spanEnd()`.

- Um arquivo por fato (mitigação de conflito de merge em `project.md`) — pós-V1
- Binário compilado se cold start do Node não fechar NFR-2 — avaliar após medição em M3

## Preferences

- Documentos de spec/projeto em português (idioma do PRD)
