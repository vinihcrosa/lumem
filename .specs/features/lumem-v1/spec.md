# lumem V1 — Especificação

**Fonte:** [PRD.md](PRD.md) (Draft, 2026-08-07)
**Escopo do documento:** toda a V1 (marcos M0–M5). Stories organizadas por prioridade; cada uma mapeia 1:1 para um marco do roadmap.
**Idioma dos IDs:** categorias `HARN` (harness/adapters), `CLI` (comandos), `INST` (instalador), `MEM` (memória), `CAP` (captura), `CONS` (consolidação), `OPS` (não-funcionais).

## Problem Statement

Toda sessão de agente de código começa do zero: decisões e seus porquês, correções do usuário, becos sem saída e preferências pessoais se perdem entre sessões. As alternativas atuais ou exigem disciplina manual (`CLAUDE.md`/`AGENTS.md` à mão) ou acoplam a memória a um orquestrador inteiro. Falta uma camada de memória fina, portável e agnóstica de harness que capture conhecimento durável automaticamente e o reinjete nas sessões seguintes.

## Goals

- [ ] Instalação limpa em repo novo em < 2 min, sem edição manual
- [ ] **Zero** sessões de agente quebradas pela ferramenta (critério de aceite mais importante)
- [ ] 5–15 fatos duráveis/semana num repo ativo (abaixo = não captura; acima = ruído)
- [ ] > 60% dos fatos sobrevivem a revisão manual sem serem apagados
- [ ] Redução perceptível de reexplicação de contexto relatada pelo time após 2 semanas

## Out of Scope

| Feature | Razão |
|---|---|
| Geração de skills específicas do repo (tipo Hermes Agent) | V2; V1 valida só a memória |
| Harnesses além de Claude Code e Codex | Arquitetura de adapter prepara; V1 não entrega |
| Sync de memória via servidor | Git resolve o suficiente nesta escala |
| Busca semântica / embeddings | Grep sobre markdown basta |
| Web UI, dashboard, marketplace | Fora da tese do produto |
| Orquestração de tarefas / multi-agente | lumem não é orquestrador |
| Hooks no Windows | CLI funciona; hooks degradam para skill-only (OPS-08) |

## Decisões assumidas (PRD §13 — defaults adotados, confirmar com o autor)

| # | Decisão | Default assumido |
|---|---|---|
| 1 | Nome npm | Verificar `lumem` no registry em M0; fallback `@<user>/lumem` com `"bin": {"lumem": ...}` |
| 2 | `project.md` commitado por padrão? | **Sim** (default do PRD §5.2) |
| 3 | Runtime da consolidação | Harness em uso (`claude -p` / `codex exec`), modelo barato por padrão, configurável em `lumem.config.json` |
| 4 | Dois harnesses no mesmo repo | **Memória compartilhada** (mesmo projeto, mesmo conhecimento) |
| 5 | Versões mínimas de harness | Congelar em M0 ao reverificar a tabela PRD §7.1; gravar em `lumem.config.json` |

Registradas também em [.specs/project/STATE.md](../../project/STATE.md). Mudança em qualquer uma exige revisão desta spec.

---

## User Stories

### P1.1: Diagnóstico de ambiente (M0 — Esqueleto) ⭐ MVP

**User Story**: Como dev, quero rodar `npx lumem doctor` e ver quais harnesses existem na minha máquina, com quais capacidades e em qual modo de operação, para saber o que o lumem consegue fazer antes de instalar qualquer coisa.

**Why P1**: É a fundação de tudo — detecção declarativa de harness é o coração do princípio 5 (adapter é dado). Sem ela, nenhum outro comando sabe onde operar. Critério de saída do M0.

**Acceptance Criteria**:

1. WHEN `npx lumem doctor` roda numa máquina com Claude Code e Codex instalados THEN o sistema SHALL identificar ambos via regras `detect` dos descritores (`dir`, `bin`), listando versão, capacidades e modo de operação de cada um
2. WHEN um harness não está presente THEN o sistema SHALL reportá-lo como "não detectado" e sair com código 0 (ausência não é erro)
3. WHEN uma capacidade está ausente no harness (ex.: sem `SessionStart`) THEN `doctor` SHALL reportar o modo degradado correspondente e qual fallback está ativo (PRD §7.3) — o usuário nunca descobre o modo degradado por acidente
4. WHEN hooks do Codex estão instalados mas não confiados THEN `doctor` SHALL apontar isso e instruir a rodar `/hooks`
5. WHEN `lumem status` roda antes de qualquer instalação THEN o sistema SHALL reportar "nada instalado" sem erro
6. WHEN qualquer comando de leitura recebe `--json` THEN o sistema SHALL emitir saída estruturada estável
7. WHEN um descritor de adapter é inválido perante o schema THEN o sistema SHALL rejeitá-lo com erro claro apontando o campo, sem crash
8. WHEN um harness novo é adicionado como descritor JSON válido THEN `doctor` SHALL detectá-lo sem nenhuma alteração em `core/`

**Independent Test**: Numa máquina com os dois harnesses, `npx lumem doctor` lista ambos corretamente; remover `~/.codex` do PATH/HOME faz o Codex sumir do relatório sem erro.

---

### P1.2: Instalação reversível (M1 — Instalador) ⭐ MVP

**User Story**: Como dev, quero instalar e desinstalar as skills, hooks e agents do lumem nos meus harnesses de forma idempotente e reversível, para adotar (ou abandonar) a ferramenta sem risco para meus arquivos.

**Why P1**: Sem instalador confiável não há adoção. "Nunca sobrescrever o que é do usuário" (princípio 6) é condição de confiança. Critério de saída do M1: instala e desinstala sem resíduo nem tocar conteúdo do usuário.

**Acceptance Criteria**:

1. WHEN `lumem init` roda num repo THEN o sistema SHALL detectar harnesses, perguntar o que instalar, criar `.lumem/` com `lumem.config.json`, `memory/`, `local/` e `.gitignore` cobrindo `local/`
2. WHEN `lumem install` roda N vezes seguidas THEN o estado em disco após cada execução SHALL ser idêntico (idempotência)
3. WHEN um artefato é instalado THEN o manifest SHALL declará-lo (id, tipo, versão, hash, destino) e o lockfile `lumem-lock.json` SHALL registrar o que foi instalado, onde, com qual hash e quando
4. WHEN o destino é um arquivo compartilhado (`CLAUDE.md`, `AGENTS.md`, `hooks.json`) THEN o sistema SHALL escrever somente dentro do bloco `<!-- lumem:start -->` / `<!-- lumem:end -->` e SHALL nunca tocar conteúdo fora dos marcadores
5. WHEN um arquivo pré-existente será modificado pela primeira vez THEN o sistema SHALL criar backup timestampado antes da escrita
6. WHEN o usuário editou um arquivo gerenciado (hash difere do lockfile) e roda `sync` THEN o sistema SHALL avisar o drift e SHALL NOT sobrescrever sem `--force`
7. WHEN `lumem uninstall` roda THEN o sistema SHALL remover tudo que instalou, restaurar os blocos gerenciados ao estado anterior e SHALL preservar a memória — apagá-la exige `--purge` explícito
8. WHEN qualquer comando que escreve recebe `--dry-run` THEN o sistema SHALL mostrar o diff completo e SHALL NOT aplicar nenhuma escrita
9. WHEN a instalação usa o modo default THEN artefatos SHALL ser symlinks; com `--copy`, cópias
10. WHEN `--global` é passado THEN a instalação SHALL ir para o escopo global do harness (ex.: `~/.claude`, `~/.codex`); sem a flag, escopo projeto
11. WHEN hooks são instalados no Codex THEN o pós-instalação SHALL instruir explicitamente o usuário a rodar `/hooks` para confiar
12. WHEN o AGENTS.md resultante excederia o limite do harness (`maxBytes` do descritor, ~32 KiB no Codex) THEN o sistema SHALL truncar o bloco gerenciado por prioridade e avisar — nunca estourar o limite

**Independent Test**: `lumem init && lumem install` num repo com `CLAUDE.md` pré-existente contendo texto do usuário; depois `lumem uninstall`. Diff do repo ao final = apenas `.lumem/` de memória (se `--purge` não foi usado); texto do usuário byte a byte intacto.

---

### P1.3: Memória manual com injeção via skill (M2 — Memória manual) ⭐ MVP

**User Story**: Como dev, quero gravar, listar, buscar e apagar fatos manualmente nos quatro tipos de memória, e ter esse conteúdo injetado no início da sessão do agente dentro de um orçamento, para que o agente pare de me fazer reexplicar o projeto — antes mesmo de existir captura automática.

**Why P1**: Fecha o loop de valor mínimo: memória lida e usada pelo agente. M0–M2 entregam valor interno sozinhos (instalador de convenções + memória manual). Critério de saída do M2.

**Acceptance Criteria**:

1. WHEN `lumem memory add` grava um fato THEN a entrada SHALL ir para o arquivo do tipo/escopo correto (PRD §5.1–5.2) e SHALL carregar proveniência: data, sessão de origem (`manual` quando aplicável) e confiança
2. WHEN `lumem memory list|show|search <q>` roda THEN o sistema SHALL retornar leitura humana; com `--json`, estruturada
3. WHEN `lumem memory forget <id>` roda THEN a entrada SHALL ser removida do arquivo correspondente
4. WHEN a sessão do agente inicia com o hook `SessionStart` disponível THEN o sistema SHALL montar um bloco com memória dos escopos aplicáveis (global + projeto) e injetá-lo como contexto adicional, sem LLM
5. WHEN o harness não tem `SessionStart` THEN a injeção SHALL degradar para instrução na skill `lumem-memory` ("leia a memória antes de agir")
6. WHEN o conteúdo total da memória excede o orçamento de injeção (4 KB default, configurável) THEN o sistema SHALL truncar por prioridade, nunca estourar o teto
7. WHEN o conteúdo a persistir aparenta conter segredo (chave, token, conteúdo de `.env`) THEN o sistema SHALL recusar a gravação e explicar o motivo
8. WHEN `.lumem/` é criado THEN `local/` SHALL estar gitignored automaticamente; `memory/project.md`, `memory/correction.md` e `lumem.config.json` SHALL ser commitáveis

**Independent Test**: Gravar 3 fatos com `memory add`, abrir sessão do Claude Code no repo e verificar que o agente cita o conteúdo injetado; `memory search` encontra os fatos; tentativa de gravar uma linha com `AWS_SECRET_ACCESS_KEY=...` é recusada.

---

### P2.1: Captura automática de sinais (M3 — Captura)

**User Story**: Como dev, quero que hooks registrem sinais brutos da sessão (arquivos tocados, comandos que falharam e passaram, prompts com cara de correção) num diário local, sem LLM e sem eu perceber, para alimentar a consolidação com matéria-prima real.

**Why P2**: É o "auto" do auto-aprendizado, mas depende de P1.2 (hooks instalados) e P1.3 (formato de memória). Critério de saída do M3: sinais no diário, zero sessão quebrada em uma semana.

**Acceptance Criteria**:

1. WHEN um hook de captura dispara (`UserPromptSubmit`, `PostToolUse`) THEN o sistema SHALL fazer append de sinal bruto em `local/sessions/<id>.jsonl` sem nenhuma chamada de LLM
2. WHEN um comando falha e depois uma variação passa THEN o sistema SHALL registrar sinal de armadilha aprendida
3. WHEN o prompt do usuário casa com heurística de correção ("na verdade", "não, faz", "sempre que", "nunca") THEN o sistema SHALL apenas **marcar** o sinal no diário — SHALL NOT escrever em memória durável (quem decide é a consolidação)
4. WHEN o agente invoca a skill `lumem-memory` explicitamente THEN a escrita SHALL ser registrada como sinal de alta confiança
5. WHEN qualquer hook lança exceção interna THEN o hook SHALL capturá-la, logar em `local/`, e sair com código 0 — a sessão do agente segue intacta (fail-open)
6. WHEN hooks de captura executam THEN a latência p95 SHALL ser < 150 ms
7. WHEN o harness não suporta hooks (Windows, Codex sem flag/trust) THEN o sistema SHALL operar em modo skill-only, com captura via skill, e `doctor` SHALL reportar esse modo
8. WHEN o hook recebe contexto só via stdin (sem env vars) THEN o sistema SHALL resolver o projeto pelo campo `cwd` do payload

**Independent Test**: Sessão de 10 min com edições e um comando que falha e depois passa; `cat .lumem/local/sessions/*.jsonl` mostra os sinais tipados. Injetar exceção proposital no hook: sessão do agente não quebra e falha aparece em `local/lumem.log`.

---

### P2.2: Consolidação gated (M4 — Consolidação)

**User Story**: Como dev, quero que ao fim de sessões relevantes um agente headless transforme o diário bruto em fatos duráveis com proveniência — adicionando, substituindo e removendo — para que conhecimento útil apareça sozinho, sem virar ruído nem custar tokens à toa.

**Why P2**: É onde o produto vive (métrica-chave: >60% de fatos úteis). Depende de P2.1 (diário) e P1.3 (formato de memória).

**Acceptance Criteria**:

1. WHEN `SessionEnd` dispara e o gate está satisfeito THEN o sistema SHALL iniciar a consolidação em processo separado e desanexado e retornar imediatamente — o encerramento da sessão SHALL nunca ser bloqueado
2. WHEN qualquer condição do gate falha (sinais < N, duração < N min, última consolidação < N h, lock ativo — defaults 5 / 3 min / 6 h) THEN o sistema SHALL NOT chamar LLM
3. WHEN `lumem memory consolidate --force` roda THEN o sistema SHALL ignorar o gate (exceto o lock) e consolidar
4. WHEN a consolidação roda THEN ela SHALL usar o agente headless `lumem-consolidator` (harness em uso, runtime barato por default — decisão assumida #3) com o prompt da skill `lumem-consolidate`, incluindo as regras anti-lixo do PRD §5.4
5. WHEN o LLM retorna o patch THEN o sistema SHALL aplicar adições, substituições e remoções nos arquivos de memória; todo fato adicionado SHALL carregar proveniência (data, `src:sess_*`, `conf:*`)
6. WHEN um fato novo contradiz um existente THEN o existente SHALL ser substituído, não empilhado
7. WHEN o patch contém segredo aparente THEN o sistema SHALL recusar persistir a entrada afetada e logar o descarte
8. WHEN um arquivo de memória excede o soft limit (PRD §5.5) THEN ele SHALL ser marcado e a próxima consolidação SHALL compactar: preservar riscos ativos, decisões e correções recentes; cortar repetição e o que o código já absorveu
9. WHEN já existe lock de consolidação para o projeto THEN a nova tentativa SHALL ser pulada silenciosamente (log apenas)
10. WHEN o processo de consolidação falha ou o patch é inválido/não parseável THEN a memória durável SHALL permanecer intacta (aplicação atômica: tudo ou nada) e a falha SHALL ir para o log
11. WHEN `consolidate --dry-run` roda THEN o sistema SHALL mostrar o patch proposto sem aplicar

**Independent Test**: Sessão real com ≥5 sinais e >3 min; fechar a sessão; em até alguns minutos `git diff .lumem/memory/project.md` mostra fatos novos com proveniência. Sessão de 30 s: nenhuma chamada de LLM ocorre (verificável no log).

---

### P3.1: Endurecimento (M5)

**User Story**: Como mantenedor, quero fail-open provado por teste de injeção de falha, scrub de segredos validado, logs com rotação e docs completas, para tornar o repositório público sem constrangimento nem risco.

**Why P3**: Não adiciona capacidade nova — eleva a confiança das existentes ao nível "público". Vem por último porque endurece o que M0–M4 construíram.

**Acceptance Criteria**:

1. WHEN a suíte de injeção de falha roda contra todos os hooks (exceção, timeout, disco cheio, JSON malformado no stdin) THEN nenhum cenário SHALL quebrar a sessão do agente ou sair com código ≠ 0
2. WHEN eventos de runtime ocorrem THEN o sistema SHALL logar estruturado em `.lumem/local/lumem.log` com rotação
3. WHEN a CLI roda qualquer comando fora de `install`/`sync` THEN nenhum acesso de rede SHALL ocorrer (verificável em teste)
4. WHEN o repo é publicado THEN README e docs SHALL cobrir instalação, modelo de memória, modos degradados e desinstalação

**Independent Test**: Rodar a suíte de caos de hooks em CI; auditar chamadas de rede com a CLI em modo runtime; revisar docs contra checklist do M5.

---

## Edge Cases

- WHEN os dois harnesses estão instalados no mesmo repo THEN a memória de projeto SHALL ser compartilhada entre eles (decisão assumida #4) e a instalação SHALL registrar artefatos por harness no lockfile
- WHEN dois devs consolidam no mesmo dia e `project.md` conflita no merge THEN os bullets curtos e independentes SHALL manter o conflito trivial (risco aceito no PRD §5.2)
- WHEN duas sessões terminam simultaneamente no mesmo projeto THEN o lock SHALL garantir no máximo uma consolidação; a outra é pulada
- WHEN `SessionEnd` não existe no harness THEN a consolidação SHALL ser manual (`lumem memory consolidate`) e o sistema SHALL sugerir cron
- WHEN o diário de sessão está vazio ou ausente THEN a consolidação SHALL sair limpa sem chamar LLM
- WHEN `.lumem/` não existe e um comando `memory *` roda THEN o sistema SHALL orientar a rodar `lumem init` em vez de criar estado implícito
- WHEN o arquivo de memória contém markdown malformado ou marcador de proveniência corrompido THEN leitura SHALL degradar graciosamente (pula entrada, loga) — nunca crash
- WHEN o hook roda em repo que não é o do projeto configurado (cwd inesperado) THEN o sinal SHALL ser descartado com log, não gravado no projeto errado
- WHEN o binário do harness existe mas a versão é menor que a mínima congelada THEN `doctor` SHALL reportar incompatibilidade e o modo de operação SHALL degradar de forma explícita
- WHEN o usuário remove manualmente um artefato instalado THEN `sync`/`doctor` SHALL reportar o drift entre lockfile e disco
- WHEN o processo de consolidação fica órfão ou excede timeout THEN o lock SHALL expirar (stale lock) permitindo a próxima consolidação
- WHEN a memória global (`~/.lumem`) não existe mas a de projeto sim THEN injeção SHALL funcionar só com o escopo disponível

---

## Requirement Traceability

| Requirement ID | PRD | Story | Phase | Status |
|---|---|---|---|---|
| HARN-01 | §7.2 | P1.1 | Design | In Tasks |
| HARN-02 | §7.2 (schema) | P1.1 | Design | In Tasks |
| HARN-03 | §7.3 | P1.1 | Design | In Tasks |
| HARN-04 | FR-6, §7.3 | P1.1 | Design | In Tasks |
| CLI-01 | FR-1 | P1.2 | Design | In Tasks |
| CLI-02 | FR-2 | P1.2 | Design | In Tasks |
| CLI-03 | FR-3 | P1.2 | Design | In Tasks |
| CLI-04 | FR-4 | P1.2 | Design | In Tasks |
| CLI-05 | FR-5 | P1.1 | Design | In Tasks |
| CLI-06 | FR-6 | P1.1 | Design | In Tasks |
| CLI-07 | FR-7 | P1.3 | Design | In Tasks |
| CLI-08 | FR-8 | P1.3 | Design | In Tasks |
| CLI-09 | FR-9 | P2.2 | Design | In Tasks |
| CLI-10 | FR-10 | P1.2, P2.2 | Design | In Tasks |
| CLI-11 | FR-11 | P1.1, P1.3 | Design | In Tasks |
| INST-01 | FR-12 | P1.2 | Design | In Tasks |
| INST-02 | FR-13 | P1.2 | Design | In Tasks |
| INST-03 | FR-14 | P1.2 | Design | In Tasks |
| INST-04 | FR-15 | P1.2 | Design | In Tasks |
| INST-05 | FR-16 | P1.2 | Design | In Tasks |
| INST-06 | FR-17 | P1.2 | Design | In Tasks |
| INST-07 | FR-18 | P1.2 | Design | In Tasks |
| INST-08 | FR-19 | P1.2 | Design | In Tasks |
| INST-09 | FR-20 | P1.2 | Design | In Tasks |
| MEM-01 | §5.1–5.2 | P1.3 | Design | In Tasks |
| MEM-02 | FR-25, §5.3 | P1.3, P2.2 | Design | In Tasks |
| MEM-03 | FR-21, §5.5 | P1.3 | Design | In Tasks |
| MEM-04 | FR-26, §5.5 | P2.2 | Design | In Tasks |
| MEM-05 | FR-27 | P1.3, P2.2 | Design | In Tasks |
| MEM-06 | FR-28 | P1.3 | Design | In Tasks |
| MEM-07 | FR-29 | P1.3 | Design | In Tasks |
| CAP-01 | FR-22 | P2.1 | - | In Tasks |
| CAP-02 | §6 est.2 | P2.1 | - | In Tasks |
| CAP-03 | §6 (heurística marca) | P2.1 | - | In Tasks |
| CAP-04 | NFR-2 | P2.1 | - | In Tasks |
| CONS-01 | FR-23, §6 gate | P2.2 | - | In Tasks |
| CONS-02 | FR-24 | P2.2 | - | In Tasks |
| CONS-03 | FR-30, §5.4 | P2.2 | - | In Tasks |
| CONS-04 | FR-31 | P2.2 | - | In Tasks |
| CONS-05 | §6 (lock) | P2.2 | - | In Tasks |
| CONS-06 | FR-32 | P2.1, P2.2 | - | In Tasks |
| OPS-01 | NFR-1 | P2.1, P3.1 | - | In Tasks |
| OPS-02 | NFR-3 | P3.1 | - | In Tasks |
| OPS-03 | NFR-4 | P1.1 | Design | In Tasks |
| OPS-04 | NFR-5 | P1.1 | Design | In Tasks |
| OPS-05 | NFR-6 | P2.1 | - | In Tasks |
| OPS-06 | NFR-7 | P1.2 | Design | In Tasks |
| OPS-07 | NFR-8 | P3.1 | - | In Tasks |
| OPS-08 | NFR-9 | P1.1, P2.1 | - | In Tasks |
| OPS-09 | NFR-10 | P3.1 | - | In Tasks |

**ID format:** `[CATEGORIA]-[NÚMERO]`. **Status:** Pending → In Design → In Tasks → Implementing → Verified.

**Coverage:** 50 requisitos; 50 mapeados a tasks em [tasks.md](tasks.md) (T1–T48), 0 sem mapeamento ✅; cobertura PRD: FR-1..FR-32 e NFR-1..NFR-10 todos mapeados ✅

---

## Success Criteria

- [ ] `npx lumem doctor` identifica corretamente os dois harnesses (saída M0)
- [ ] Instala e desinstala sem resíduo nem tocar conteúdo do usuário (saída M1)
- [ ] Agente lê e usa a memória injetada (saída M2)
- [ ] Sinais no diário; zero sessão quebrada em uma semana de uso real (saída M3)
- [ ] Fatos úteis aparecem sozinhos após uso real; >60% sobrevivem a revisão manual (saída M4)
- [ ] Suíte de injeção de falha verde; zero rede em runtime; docs prontas para repo público (saída M5)
- [ ] Instalação limpa em < 2 min; 5–15 fatos duráveis/semana em repo ativo (PRD §11)
