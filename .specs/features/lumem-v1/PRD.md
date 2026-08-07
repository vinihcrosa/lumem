# PRD — `lumem` V1

> **Nome.** `lumem` — binário, diretório `.lumem/` e namespace dos blocos gerenciados. Pacote npm sob escopo próprio (ver §13.1).

**Status:** Draft
**Autor:** —
**Data:** 2026-08-07

---

## 1. Resumo

`lumem` é uma camada de memória e auto-aprendizado para agentes de código, distribuída como CLI Node/TypeScript. Ela se acopla a harnesses existentes (Claude Code, Codex) via **skills, hooks e agents**, sem substituir o runtime do agente.

O objetivo: o agente acumula conhecimento durável sobre o projeto e sobre as preferências do dev **sem que ninguém precise pedir**, e usa esse conhecimento nas sessões seguintes.

**O que não é:** orquestrador de pipeline, loja de skills, servidor, produto SaaS. É um instalador + um contrato de memória.

---

## 2. Problema

Toda sessão de agente começa do zero. O que se perde entre sessões:

- **Decisões e o porquê delas.** "Não usamos ORM aqui porque X." O agente propõe ORM de novo na semana seguinte.
- **Correções do usuário.** Você corrige o mesmo padrão de código cinco vezes. Nada disso persiste.
- **Becos sem saída.** O agente tenta uma abordagem, descobre que não funciona, e tenta de novo em outra sessão.
- **Preferências pessoais.** Estilo de commit, tolerância a comentários, como você gosta que ele te responda.

Soluções atuais falham em duas direções opostas:

- `CLAUDE.md` / `AGENTS.md` escritos à mão — funcionam, mas exigem disciplina manual e envelhecem mal.
- Ferramentas que resolvem isso vêm acopladas a um orquestrador inteiro (Compozy, harnesses de workflow). Você adota a memória junto com um pipeline que talvez não queira.

**Lacuna:** não existe uma camada de memória fina, portável e agnóstica de harness.

---

## 3. Público-alvo

| Fase | Usuário | Necessidade |
|---|---|---|
| V1 (interno) | Autor + time pequeno | Padronizar convenções entre repos; parar de reexplicar contexto |
| Pós-V1 (público) | Dev individual usando 1–2 agentes CLI | Memória sem adotar um orquestrador |

V1 otimiza para o primeiro. Decisões que travem o segundo devem ser evitadas, mas não é preciso resolvê-las agora.

---

## 4. Princípios de design

Ordem importa: em conflito, o de cima vence.

1. **Fail-open.** Se a camada de memória quebrar, o agente continua funcionando normalmente. Um hook que trava é pior que memória nenhuma.
2. **Markdown é o banco de dados.** Sem SQLite, sem vector DB, sem daemon na V1. Arquivos legíveis, versionáveis, editáveis à mão, inspecionáveis com `cat`.
3. **Captura é barata, consolidação é cara.** Registrar sinal é append em arquivo, determinístico, sem LLM. Transformar sinal em fato durável usa LLM e é *gated*.
4. **Contexto é orçamento, não depósito.** Memória que cresce sem limite piora o agente. Todo conteúdo injetado tem teto duro.
5. **Adapter é dado, não código.** Suportar um harness novo = adicionar um descritor declarativo, não escrever um `switch`.
6. **Nunca sobrescrever o que é do usuário.** Arquivos compartilhados recebem bloco gerenciado delimitado, nunca reescrita total.
7. **Local-first.** Nada sai da máquina. Zero rede em runtime.

---

## 5. Modelo de memória

### 5.1 Tipos

Quatro tipos, cada um com regra própria de escrita, retenção e escopo:

| Tipo | Conteúdo | Escopo | Versionado? |
|---|---|---|---|
| `project` | Arquitetura, convenções, decisões e o porquê, armadilhas do repo | Projeto | Sim (commitado) |
| `preference` | Preferências do dev: estilo, tom, tolerâncias | Global | Não |
| `correction` | Correções explícitas do usuário ao agente — o sinal de self-learn | Projeto + global | Projeto sim |
| `session` | Diário bruto da sessão atual; matéria-prima da consolidação | Projeto | Não (gitignored) |

### 5.2 Layout em disco

```
~/.lumem/                          # escopo global
  memory/
    preference.md
    correction.md
  config.json

<repo>/.lumem/                     # escopo projeto
  memory/
    project.md                     # commitado
    correction.md                  # commitado
  local/                           # gitignored
    sessions/2026-08-07T14-22-Z.jsonl
    state.json
  lumem.config.json                # commitado
  .gitignore                       # gera-se automaticamente, ignora local/
```

**Decisão:** memória de projeto é commitada por padrão. É o que torna a ferramenta útil para time — o conhecimento vira artefato compartilhado revisável em PR. Diário de sessão nunca é commitado (ruído + risco de vazar dados).

**Risco aceito:** dois devs consolidando no mesmo dia geram conflito de merge em `project.md`. Mitigação na V1: arquivo estruturado em bullets curtos e independentes, que resolvem conflito trivialmente. Mitigação futura: um arquivo por fato.

### 5.3 Formato de um fato

Cada entrada de memória durável carrega proveniência:

```markdown
- [2026-08-07] Auth usa sessão via cookie, não JWT. JWT foi avaliado e
  descartado por causa do requisito de revogação imediata.
  <!-- src:sess_a1b2 conf:high -->
```

Campos: data, corpo, sessão de origem, confiança. Proveniência é o que permite auditar e expirar.

### 5.4 Regras anti-lixo

Esta é a parte que decide se o produto funciona ou vira ruído. São regras do prompt de consolidação, não do código:

- **Não duplicar o repo.** Se está no código, no git log, no README ou na spec, não vai pra memória. Memória guarda o que se perderia.
- **Fato precisa ser falsificável.** "O usuário prefere código limpo" é lixo. "O usuário rejeita comentários que repetem o nome da função" é fato.
- **Sem especulação.** Só o que foi observado nesta sessão.
- **Preferir remover a acumular.** Consolidação pode apagar. Fato contradito por evidência nova é substituído, não empilhado.

### 5.5 Orçamento e compactação

| Arquivo | Soft limit | Ação ao estourar |
|---|---|---|
| `project.md` | 150 linhas / 12 KB | Marca para compactação na próxima consolidação |
| `correction.md` | 100 linhas / 8 KB | Idem |
| `preference.md` | 60 linhas / 4 KB | Idem |
| Injeção total em contexto | 4 KB (configurável) | Trunca por prioridade |

Compactação preserva riscos ativos, decisões e correções recentes; corta repetição e o que já foi absorvido pelo código.

---

## 6. Ciclo de vida

Três estágios. Só o terceiro custa tokens.

### Estágio 1 — Injeção (início da sessão)

**Gatilho:** hook `SessionStart` onde existir; senão, instrução na skill.
**Ação:** lê memória dos escopos aplicáveis, monta um bloco dentro do orçamento, injeta como contexto adicional.
**Custo:** leitura de arquivo. Sem LLM.

### Estágio 2 — Captura (durante a sessão)

**Gatilho:** hooks `UserPromptSubmit` e `PostToolUse`, mais escrita explícita via skill.
**Ação:** append de sinal bruto em `local/sessions/<id>.jsonl`. Sinais:

- arquivos tocados
- comando que falhou e depois passou (indica armadilha aprendida)
- prompt do usuário que casa com heurística de correção ("na verdade", "não, faz", "sempre que", "nunca")
- chamada explícita do agente à skill de memória

**Custo:** append. Sem LLM. Precisa ser rápido — ver NFR-2.

> **Risco conhecido:** detectar correção por heurística de string é frágil e gera falso positivo. Na V1 a heurística só *marca* o sinal; quem decide se virou fato é a consolidação (que tem LLM). Nunca escreve direto em memória durável.

### Estágio 3 — Consolidação (fim de sessão, com gate)

**Gatilho:** hook `SessionEnd`, ou `lumem memory consolidate` manual.
**Gate — só roda se todas forem verdadeiras:**

- sessão teve ≥ N sinais capturados (default 5)
- sessão durou ≥ N minutos (default 3)
- passou ≥ N horas desde a última consolidação neste projeto (default 6)
- não há lock ativo de consolidação para este projeto

**Ação:** roda um prompt de consolidação num agente headless (`claude -p` / `codex exec`), passando o diário bruto + memória atual. Recebe de volta um patch: fatos a adicionar, a substituir, a remover. Aplica.

**Custo:** uma chamada de LLM. O gate existe para que sessão de 30 segundos não dispare nada.

> **Decisão:** consolidação roda em processo separado e desanexado. `SessionEnd` dispara e retorna imediatamente. Bloquear o encerramento da sessão do usuário por causa de memória viola o princípio 1.

---

## 7. Camada de harness

### 7.1 O problema

A capacidade varia muito entre harnesses. Levantamento atual:

| Capacidade | Claude Code | Codex |
|---|---|---|
| Eventos de hook | 27+ | 5 (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`) |
| Tipos de hook | command, prompt, agent, HTTP | command |
| Config de hook | settings JSON | `hooks.json` ou `[hooks]` em `config.toml` |
| Flag experimental | não | `[features] codex_hooks = true` (verificar na versão alvo) |
| Windows | sim | hooks desabilitados |
| Contexto no hook | env vars (`CLAUDE_PROJECT_DIR`) + stdin | só stdin JSON; usar campo `cwd` |
| Trust de hook | — | projeto precisa ser confiável; usuário roda `/hooks` para aprovar |
| Skills | `.claude/skills/` | `SKILL.md` com frontmatter; suporta `scripts/`, `references/`, `assets/` |
| Doc de projeto | `CLAUDE.md` | `AGENTS.md` (limite ~32 KiB) |
| Home | `~/.claude` | `CODEX_HOME`, default `~/.codex` |

> Estes dados precisam ser reverificados contra as versões alvo antes da implementação; as duas ferramentas mudam rápido. Congelar versão mínima suportada no `lumem.config.json`.

### 7.2 A solução: adapter declarativo

Cada harness é um descritor. Adicionar harness = adicionar arquivo, não código.

```jsonc
{
  "id": "codex",
  "detect": [{ "type": "dir", "path": "~/.codex" }, { "type": "bin", "name": "codex" }],
  "paths": {
    "skills":  { "project": ".codex/skills",  "global": "~/.codex/skills" },
    "hooks":   { "project": ".codex/hooks.json" },
    "context": { "project": "AGENTS.md", "maxBytes": 32768 }
  },
  "capabilities": {
    "hooks.sessionStart": true,
    "hooks.sessionEnd": true,
    "hooks.postToolUse": true,
    "hooks.envVars": false,
    "hooks.requiresTrust": true,
    "hooks.featureFlag": "codex_hooks",
    "platform.windows": false
  },
  "contextInjection": "stdin",
  "eventMap": { "onStart": "SessionStart", "onEnd": "SessionEnd" }
}
```

### 7.3 Degradação graciosa

Se uma capacidade faltar, a funcionalidade não some — muda de mecanismo:

| Capacidade ausente | Fallback |
|---|---|
| Sem `SessionStart` | Injeção passa a ser instrução na skill ("leia a memória antes de agir") |
| Sem `SessionEnd` | Consolidação vira manual (`lumem memory consolidate`) + sugestão de cron |
| Sem hooks (Windows/Codex) | Modo skill-only: tudo funciona, com captura menos automática |
| Sem env vars | Resolver projeto pelo `cwd` do payload stdin |

`lumem doctor` reporta em qual modo cada harness está operando. O usuário nunca descobre por acidente que está no modo degradado.

---

## 8. Requisitos funcionais

### 8.1 CLI

| ID | Comando | Descrição |
|---|---|---|
| FR-1 | `lumem init` | Detecta harnesses, pergunta o que instalar, cria `.lumem/`, escreve config e lockfile |
| FR-2 | `lumem install [--harness <id>] [--global]` | Instala skills, hooks e agents nos harnesses selecionados |
| FR-3 | `lumem sync` | Reconcilia estado em disco com o manifest; atualiza o que mudou de versão |
| FR-4 | `lumem uninstall [--harness <id>]` | Remove tudo que instalou; restaura blocos gerenciados; **não** apaga a memória sem `--purge` |
| FR-5 | `lumem status` | Mostra o que está instalado, onde, qual versão, qual fonte |
| FR-6 | `lumem doctor` | Diagnostica: harness detectado, capacidades, modo de operação, hooks não confiados, drift entre lockfile e disco |
| FR-7 | `lumem memory list\|show\|search <q>` | Leitura humana da memória |
| FR-8 | `lumem memory add\|edit\|forget <id>` | Escrita e remoção manual |
| FR-9 | `lumem memory consolidate [--force]` | Dispara consolidação manual, ignorando gate com `--force` |
| FR-10 | `--dry-run` | Disponível em todo comando que escreve. Mostra diff, não aplica |
| FR-11 | `--json` | Saída estruturada em todo comando de leitura |

### 8.2 Instalação

| ID | Requisito |
|---|---|
| FR-12 | Manifest declara todo artefato instalável (id, tipo, versão, hash, destino) |
| FR-13 | Lockfile (`lumem-lock.json`) registra o que foi instalado, onde, qual hash, quando |
| FR-14 | Instalação é idempotente: rodar N vezes produz o mesmo estado |
| FR-15 | Detecção de drift: se o usuário editou um arquivo gerenciado, `sync` avisa e não sobrescreve sem `--force` |
| FR-16 | Arquivos compartilhados (`CLAUDE.md`, `AGENTS.md`, `hooks.json`) recebem bloco gerenciado com marcadores `<!-- lumem:start -->` / `<!-- lumem:end -->`; conteúdo fora dos marcadores nunca é tocado |
| FR-17 | Backup timestampado de todo arquivo pré-existente antes da primeira escrita |
| FR-18 | Modo symlink (default) e `--copy` |
| FR-19 | Instalação em escopo projeto (default) ou global (`--global`) |
| FR-20 | Ao instalar hooks no Codex, o pós-instalação instrui explicitamente o usuário a rodar `/hooks` para confiar, e o `doctor` verifica se ainda estão não-confiados |

### 8.3 Memória

| ID | Requisito |
|---|---|
| FR-21 | Injeta memória relevante no início da sessão, respeitando orçamento configurável |
| FR-22 | Captura sinais durante a sessão sem chamada de LLM |
| FR-23 | Consolida sinais em fatos duráveis via LLM, respeitando gate |
| FR-24 | Consolidação nunca bloqueia o encerramento da sessão |
| FR-25 | Todo fato durável carrega proveniência (data, sessão, confiança) |
| FR-26 | Compactação automática quando arquivo excede soft limit |
| FR-27 | Escaneia conteúdo antes de persistir e recusa gravar segredos aparentes (chaves, tokens, `.env`) |
| FR-28 | `.lumem/local/` entra no `.gitignore` automaticamente |

### 8.4 Skills e agents entregues

| ID | Artefato | Função |
|---|---|---|
| FR-29 | skill `lumem-memory` | Contrato de leitura/escrita de memória para o agente durante a sessão |
| FR-30 | skill `lumem-consolidate` | Prompt de consolidação: diário bruto → patch de fatos. Inclui as regras anti-lixo da §5.4 |
| FR-31 | agent `lumem-consolidator` | Definição do agente headless que roda a consolidação, com runtime barato por padrão |
| FR-32 | hooks | Scripts de injeção, captura e disparo de consolidação, por harness |

---

## 9. Requisitos não funcionais

| ID | Requisito | Critério |
|---|---|---|
| NFR-1 | **Fail-open** | Todo hook captura exceção, sempre sai com código 0, tem timeout. Falha vira log em `local/`, nunca erro visível ao usuário nem bloqueio de sessão |
| NFR-2 | **Latência de hook** | p95 < 150 ms para hooks de captura. Hook lento faz o agente parecer quebrado |
| NFR-3 | **Zero rede em runtime** | A CLI só acessa rede em `install`/`sync` para buscar pacote. Memória nunca sai da máquina |
| NFR-4 | **Zero-install** | `npx lumem init` funciona sem instalação prévia |
| NFR-5 | **Runtime** | Node ≥ 20, TypeScript, ESM. Zero dependência nativa |
| NFR-6 | **Bundle** | Entrypoint de hook empacotado num arquivo só, para minimizar cold start. Hook **nunca** invoca `npx` |
| NFR-7 | **Reversibilidade** | `uninstall` restaura o estado anterior de todo arquivo tocado |
| NFR-8 | **Privacidade** | Nenhuma telemetria na V1. Se existir depois, opt-in explícito |
| NFR-9 | **Portabilidade** | macOS e Linux na V1. Windows: CLI funciona, hooks degradam para skill-only |
| NFR-10 | **Observabilidade** | Log estruturado em `.lumem/local/lumem.log`, com rotação |

---

## 10. Fora de escopo na V1

Registrado para não virar creep:

- Geração de skills específicas do repositório (o comportamento tipo Hermes Agent) — **V2**
- Harnesses além de Claude Code e Codex — a arquitetura de adapter prepara, a V1 não entrega
- Sincronização de memória entre máquinas ou membros do time via servidor (git resolve o suficiente)
- Busca semântica / embeddings — grep sobre markdown basta nesta escala
- Web UI, dashboard, marketplace
- Orquestração de tarefas, execução multi-agente
- Suporte a hooks no Windows

---

## 11. Métricas de sucesso

Uso interno, V1. Metas propositalmente baixas — é validação, não crescimento.

| Métrica | Meta |
|---|---|
| Instalação limpa em repo novo | < 2 min, sem edição manual |
| Sessões de agente quebradas pela ferramenta | **zero** — é o critério de aceite mais importante |
| Fatos duráveis por semana num repo ativo | 5–15 (abaixo disso não captura; acima disso é ruído) |
| Taxa de fatos úteis | > 60% das entradas sobrevivem a uma revisão manual sem serem apagadas |
| Reexplicação de contexto | Redução perceptível relatada pelo time após 2 semanas |

A quarta métrica é a que importa. Se você abre o `project.md` e a maioria é óbvia ou errada, o prompt de consolidação está ruim — e é lá que o produto vive.

---

## 12. Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| Hook quebra sessão do agente | Fatal para adoção | NFR-1. Testar injeção de falha em todos os hooks |
| Memória vira ruído e degrada o agente | Fatal para o valor | Orçamento duro, compactação, regras anti-lixo, revisão manual fácil |
| Codex muda formato de hook | Retrabalho | Adapter declarativo isola; congelar versão mínima; `doctor` detecta incompatibilidade |
| Consolidação custa caro em tokens | Atrito | Gate agressivo, runtime barato por default, `--dry-run` mostra o custo |
| Vazamento de segredo pra dentro de arquivo commitado | Grave | FR-27 + memória de projeto passa por PR antes de mergear |
| Conflito de merge em `project.md` | Irritante | Bullets curtos independentes; futuro: um arquivo por fato |
| Detecção de correção com falso positivo | Ruído | Heurística só marca; LLM decide; nunca escrita direta |
| Cold start do Node em hook | Agente parece lento | NFR-6; medir cedo; se não fechar, avaliar binário compilado |

---

## 13. Decisões em aberto

Precisam de resposta antes ou durante a implementação:

1. **Publicação no npm.** Nome resolvido: `lumem`. Falta confirmar se `lumem` está livre no registry. Se não estiver, publicar como `@<user>/lumem` e declarar `"bin": { "lumem": "./dist/cli.js" }` — o binário chamado pelo usuário continua sendo `lumem` independentemente do nome do pacote.
2. **Memória de projeto commitada por padrão?** O documento assume que sim. Se o time achar ruidoso em PR, a alternativa é gitignored com opt-in — mas aí perde-se o compartilhamento, que é metade do valor pra time.
3. **Runtime da consolidação.** Sempre o harness em uso, ou modelo fixo e barato configurável? Fixo é mais previsível em custo; usar o harness evita configurar credencial extra.
4. **Sobre o que fazer quando os dois harnesses estão instalados no mesmo repo:** memória compartilhada entre eles (provável — é o mesmo projeto) ou segregada por harness?
5. **Versão mínima suportada** de Claude Code e Codex a congelar.

---

## 14. Marcos

| Marco | Entrega | Critério de saída |
|---|---|---|
| M0 — Esqueleto | CLI TS, detecção de harness, `doctor`, `status` | `npx lumem doctor` identifica corretamente os dois harnesses |
| M1 — Instalador | Manifest, lockfile, blocos gerenciados, `install`/`uninstall`/`--dry-run` | Instala e desinstala sem deixar resíduo nem tocar conteúdo do usuário |
| M2 — Memória manual | Formato de arquivo, comandos `memory *`, injeção via skill | Agente lê e usa a memória; escrita ainda é manual |
| M3 — Captura | Hooks de sinal nos dois harnesses, diário de sessão | Sinais aparecem no diário; zero sessão quebrada em uma semana de uso |
| M4 — Consolidação | Skill + agent de consolidação, gate, compactação | Fatos úteis aparecem sozinhos após uso real |
| M5 — Endurecimento | Fail-open testado, scrub de segredo, docs, README | Pronto para tornar o repositório público |

M0–M2 entregam valor interno sozinhos. Se o projeto morrer em M2, você ainda ganhou um instalador de convenções — que era a dor original.

---

## 15. Apêndice — esboço de estrutura do repositório

```
src/
  cli/              # comandos, parsing, output
  core/
    memory/         # formato, leitura, escrita, compactação, orçamento
    capture/        # normalização de sinal, diário de sessão
    consolidate/    # gate, disparo, aplicação de patch
    install/        # manifest, lockfile, blocos gerenciados, backup
  adapters/
    claude-code.json
    codex.json
    schema.ts       # validação do descritor
  hooks/            # entrypoints empacotados por evento
assets/
  skills/
    lumem-memory/SKILL.md
    lumem-consolidate/SKILL.md
  agents/
    lumem-consolidator/
```

A fronteira que importa: **`core/` não sabe que Claude Code ou Codex existem.** Se souber, o suporte a um harness novo deixa de ser dado e vira código — e o princípio 5 morre.
