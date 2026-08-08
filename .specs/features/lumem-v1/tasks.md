# lumem V1 — Tasks

**Design**: [design.md](design.md) · **Spec**: [spec.md](spec.md) · **Testing**: [../../codebase/TESTING.md](../../codebase/TESTING.md)
**Status**: Done — 48/48 tasks, M0–M5 completos

**Convenções:**
- Tools (todas as tasks): ferramentas built-in de arquivo + Bash. MCP: NONE. Skills: NONE. Exceções anotadas na task.
- 1 commit por task, Conventional Commits, escopo = módulo (`feat(harness): …`).
- `[P]` = paralelizável com as irmãs da mesma fase (deps satisfeitas + testes parallel-safe por TESTING.md).
- Toda task: suíte verde, contagem de testes só cresce.
- Gate commands: ver TESTING.md (quick / full / build / bench).

---

## Execution Plan

### Fase 0 — M0 Esqueleto (saída: `lumem doctor` identifica os dois harnesses)

```
T1 ──┬→ T2 ──┬────────────→ T5 ─┐
     └→ T3 ──┼→ T4 [P] ─────────┼→ T7
             ├→ T5 [P] (c/ T2) ─┤
             └→ T6 [P] ─────────┘
```

### Fase 1 — M1 Instalador (saída: install→uninstall sem resíduo, round-trip byte-idêntico)

```
T1 ─→ T8 [P]
T2 ─┬→ T9 [P] ──┐
    ├→ T10 [P] ─┤
    ├→ T11 [P]* ┼→ T13 ─→ T14 ─┐
    └→ T12 [P] ─┘              ├→ T16 ─┬→ T17 [P]
T5,T6,T12 ──────→ T15 ─────────┘       ├→ T18 [P]
                                       └→ T19 [P] (c/ T12)
* T11 também depende de T8
```

### Fase 2 — M2 Memória manual (saída: agente lê e usa memória injetada)

```
T2 ─→ T20 ─→ T21 ─┬→ T22 [P] ─┬→ T24 [P]   T26 ─→ T27 (c/ T8)
                  └→ T23 [P]  ├→ T25 [P]
                              └→ T26
```

### Fase 3 — M3 Captura (saída: sinais no diário, zero sessão quebrada)

```
T2 ──→ T28 [P] ──┐
T2 ──→ T29 [P] ─┬┤
T20 ─→ T30 [P]  ├┼→ T32 ─┬→ T34
       T29 → T31┘│       │
T26 ─────────────┘       │
T14,T16,T28 ─→ T33 [P] ──┘
```

### Fase 4 — M4 Consolidação (saída: fatos úteis aparecem sozinhos)

```
T23,T29 ─→ T35 [P] ─┐
T2 ──────→ T36 [P] ─┤
T21 ─────→ T37 [P] ─┼→ T39 ─┬→ T40 (c/ T32)
T8 ──────→ T38 [P] ─┘       ├→ T41 [P]
T8 ──────→ T43 [P]          └→ T42 [P] (c/ T23)
```

### Fase 5 — M5 Endurecimento (saída: pronto p/ repo público)

```
T32,T40 ─→ T44 [P]
T41 ─────→ T45 [P]     T44,T45,T46,T47 ─→ T48
T2 ──────→ T46 [P]
T1,T41 ──→ T47 [P]
```

---

## Task Breakdown

## Fase 0 — M0

### T1: Scaffold do repositório ✅
**What**: `package.json` (ESM, `engines.node>=20`, `bin: {lumem}`), tsconfig, biome, vitest, tsup multi-entry (`cli`, `lumem-hook`, `lumem-runner`), scripts `check`/`verify`/`build`/`bench:hook`; checar disponibilidade do nome `lumem` no npm registry e registrar resultado em STATE.md (decisão aberta #1).
**Where**: raiz; `src/` esqueleto vazio
**Depends on**: None · **Reuses**: — · **Requirement**: OPS-04, OPS-03 (parcial)
**Done when**:
- [ ] `npm run build` gera os 3 bundles a partir de entrypoints stub
- [ ] `npm run verify` verde (0 testes é aceitável só nesta task)
- [ ] Resultado do `npm view lumem` registrado em STATE.md
**Tests**: none (infra) · **Gate**: build + full
**Verify**: `node dist/cli.js --version` imprime versão.
**Commit**: `chore: scaffold TS/ESM, build multi-entry e gates`

### T2: core/shared — fsx, log ✅
**What**: `fsx.ts` (`atomicWrite` tmp+rename, `expandHome`, `sha256`, `readJsonSafe`), `log.ts` (append JSONL estruturado em `local/lumem.log`; rotação = stub com interface pronta).
**Where**: `src/core/shared/{fsx,log}.ts` + testes
**Depends on**: T1 · **Reuses**: node builtins · **Requirement**: OPS-09 (parcial)
**Done when**:
- [ ] `atomicWrite` sobrevive a crash simulado (tmp órfão não corrompe destino)
- [ ] Gate quick passa
**Tests**: unit · **Gate**: quick
**Commit**: `feat(shared): fsx atômico e log estruturado`

### T3: Schema do AdapterDescriptor + loader [P] ✅
**What**: zod schema completo (design §Data Models) + `loadDescriptors(dir)`; descritor inválido → erro nomeando campo, harness excluído.
**Where**: `src/adapters/schema.ts`, `src/core/harness/load.ts` + testes
**Depends on**: T1 · **Reuses**: — · **Requirement**: HARN-02
**Done when**:
- [ ] Fixture inválida rejeitada com path do campo no erro; válida carrega tipada
- [ ] Gate quick passa
**Tests**: unit · **Gate**: quick
**Commit**: `feat(harness): schema zod e loader de descritores`

### T4: Descritores claude-code.json e codex.json [P] ✅
**What**: os dois descritores com fatos verificados (design §0/§Data Models): Codex skills em `.agents/skills`, hooks `.codex/hooks.json`, minVersions 2.1.224/0.147.0, `injection[]`, `headless`.
**Where**: `src/adapters/{claude-code,codex}.json` + teste de validação
**Depends on**: T3 · **Reuses**: schema T3 · **Requirement**: HARN-01
**Done when**:
- [ ] Ambos passam no schema em teste; snapshot dos campos críticos
**Tests**: unit (via schema) · **Gate**: quick
**Commit**: `feat(adapters): descritores claude-code e codex verificados`

### T5: Engine de detecção [P] ✅
**What**: `detect(descriptor)` — regras `dir`/`bin`/`file`, probe de versão via `versionArgs`; nunca lança por harness ausente.
**Where**: `src/core/harness/detect.ts` + testes (fixtures em tmp, PATH fake)
**Depends on**: T2, T3 · **Reuses**: fsx · **Requirement**: HARN-01
**Done when**:
- [ ] Detecta por dir e por bin; ausente → `detected:false` sem erro; versão parseada
**Tests**: unit · **Gate**: quick
**Commit**: `feat(harness): detecção declarativa dir/bin/file`

### T6: Resolução de OperatingMode [P] ✅
**What**: `resolveMode(descriptor, detection)` — capacidades → `grade` (`full|degraded|skill-only|unavailable`) + `fallbacks` declarados; versão < mínima ⇒ degrade explícito.
**Where**: `src/core/harness/mode.ts` + testes
**Depends on**: T3 · **Reuses**: — · **Requirement**: HARN-03
**Done when**:
- [ ] Matriz de casos: full, sem sessionStart→fallback injeção, sem hooks→skill-only, versão velha→aviso
**Tests**: unit · **Gate**: quick
**Commit**: `feat(harness): operating mode com degradação declarada`

### T7: CLI esqueleto + doctor + status ✅
**What**: programa commander, flags globais `--json`/`--dry-run`, exit codes (0/1/3); `lumem doctor` (harnesses, versões, capacidades, modo, fallbacks) e `lumem status` ("nada instalado" limpo).
**Where**: `src/cli/{index,doctor,status}.ts` + testes integration
**Depends on**: T4, T5, T6 · **Reuses**: harness engine · **Requirement**: CLI-05, CLI-06, CLI-11, HARN-04
**Done when**:
- [ ] Em fake home com os 2 harnesses: doctor lista ambos; sem harness: "não detectado", exit 0
- [ ] `--json` estável nos dois comandos
- [ ] **Saída M0**: doctor correto contra harnesses reais da máquina (verificação manual registrada)
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): doctor e status com modos de operação`

## Fase 1 — M1

### T8: Assets stub [P] ✅
**What**: `assets/` inicial: `skills/lumem-memory/SKILL.md` e `skills/lumem-consolidate/SKILL.md` (frontmatter válido + corpo mínimo), `agents/lumem-consolidator.md`, `harness/*/hooks.tmpl.json` (eventos do eventMap chamando `lumem-hook.mjs`).
**Where**: `assets/**`
**Depends on**: T1 · **Reuses**: eventMap dos descritores · **Requirement**: MEM-07, CONS-03/04, CONS-06 (stubs)
**Done when**:
- [ ] Frontmatter compatível com os dois harnesses (name+description); templates JSON parseáveis
**Tests**: none (dados; validados por T11/T33) · **Gate**: build
**Commit**: `feat(assets): skills, agent e templates de hook iniciais`

### T9: Blocos gerenciados [P] ✅
**What**: `upsertManagedBlock`/`removeManagedBlock` com marcadores `<!-- lumem:start/end -->`; cria arquivo se ausente; conteúdo externo intocado byte a byte; respeita `maxBytes` truncando por prioridade.
**Where**: `src/core/install/managed-block.ts` + golden tests
**Depends on**: T2 · **Reuses**: fsx · **Requirement**: INST-05
**Done when**:
- [ ] Goldens: sem bloco, com bloco, conteúdo antes/depois, remoção restaura, maxBytes trunca com aviso
**Tests**: unit · **Gate**: quick
**Commit**: `feat(install): blocos gerenciados com marcadores`

### T10: Backup timestampado [P] ✅
**What**: `backupOnce(path)` → `.lumem/local/backups/<ts>/<relpath>`; idempotente (1º backup vence).
**Where**: `src/core/install/backup.ts` + testes
**Depends on**: T2 · **Reuses**: fsx · **Requirement**: INST-06
**Done when**:
- [ ] Segundo backup do mesmo arquivo não sobrescreve o primeiro
**Tests**: unit · **Gate**: quick
**Commit**: `feat(install): backup único timestampado`

### T11: Manifest [P] ✅
**What**: build do manifest a partir de `assets/` + `dist/` (id, kind, versão, hash sha256, dest por harness/escopo).
**Where**: `src/core/install/manifest.ts` + testes
**Depends on**: T2, T8 · **Reuses**: fsx.sha256 · **Requirement**: INST-01
**Done when**:
- [ ] Manifest determinístico (mesmo input ⇒ mesmos hashes); cobre skill/agent/hook-config
**Tests**: unit · **Gate**: quick
**Commit**: `feat(install): manifest de artefatos com hash`

### T12: Lockfile + drift [P] ✅
**What**: read/write `lumem-lock.json`; `detectDrift(lock, disk)` por hash.
**Where**: `src/core/install/lockfile.ts` + testes
**Depends on**: T2 · **Reuses**: fsx · **Requirement**: INST-02, INST-04
**Done when**:
- [ ] Drift detectado quando arquivo gerenciado editado; ausência de arquivo = drift tipo `missing`
**Tests**: unit · **Gate**: quick
**Commit**: `feat(install): lockfile e detecção de drift`

### T13: Planner puro ✅
**What**: `plan(manifest, lock, modes, opts)` — diff desejado × lock × disco ⇒ lista de ações (`create|update|skip|conflict`); zero I/O de escrita; é o que `--dry-run` imprime.
**Where**: `src/core/install/plan.ts` + testes
**Depends on**: T11, T12 · **Reuses**: manifest, lockfile · **Requirement**: INST-03
**Done when**:
- [ ] Estado já instalado ⇒ plan vazio (idempotência provada no plano); drift ⇒ `conflict`, nunca `update` sem force
**Tests**: unit · **Gate**: quick
**Commit**: `feat(install): planner idempotente puro`

### T14: Apply ✅
**What**: executa plan: symlink/`--copy`, blocos gerenciados, backups, atualiza lockfile por ação; falha no meio deixa lockfile coerente com o aplicado.
**Where**: `src/core/install/apply.ts` + testes integration (fake homes)
**Depends on**: T9, T10, T13 · **Reuses**: T9/T10/T13 · **Requirement**: INST-07, OPS-06 (parcial)
**Done when**:
- [ ] `apply(plan)` 2× ⇒ segunda vez zero ações; modo copy e symlink cobertos
**Tests**: integration · **Gate**: full
**Commit**: `feat(install): apply transacional com lockfile`

### T15: `lumem init` ✅
**What**: detecta harnesses, seleção interativa (ou `--yes`), cria `.lumem/` (`memory/`, `local/`, `lumem.config.json` com defaults do design, `.gitignore` cobrindo `local/`), lockfile vazio.
**Where**: `src/cli/init.ts` + testes integration
**Depends on**: T5, T6, T12 · **Reuses**: detect/mode/lockfile · **Requirement**: CLI-01, MEM-06
**Done when**:
- [ ] Repo novo: estrutura criada; re-run: no-op; `.lumem/local/` gitignored
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): init com config e gitignore automáticos`

### T16: `lumem install` ✅
**What**: `install [--harness <id>] [--global] [--copy] [--dry-run]` — plan+apply nos harnesses selecionados; pós-instalação Codex imprime instrução `/hooks`.
**Where**: `src/cli/install.ts` + testes integration
**Depends on**: T14, T15 · **Reuses**: plan/apply · **Requirement**: CLI-02, INST-08, CLI-10, INST-09 (mensagem)
**Done when**:
- [ ] `--dry-run` imprime diff e não escreve nada (asserta fs intacto); N runs idênticos; escopo global vai pra home fake
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): install idempotente com dry-run`

### T17: `lumem uninstall` [P] ✅
**What**: remove artefatos do lockfile, restaura blocos gerenciados, preserva memória; `--purge` apaga `.lumem/` com confirmação.
**Where**: `src/cli/uninstall.ts` + teste round-trip
**Depends on**: T16 · **Reuses**: removeManagedBlock, lockfile · **Requirement**: CLI-04, OPS-06
**Done when**:
- [ ] **Round-trip**: repo com `CLAUDE.md`/`AGENTS.md` de usuário → install → uninstall ⇒ byte-idêntico fora de `.lumem/` (Independent Test P1.2)
- [ ] Sem `--purge`, `memory/` sobrevive
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): uninstall reversível com purge explícito`

### T18: `lumem sync` [P] ✅
**What**: reconcilia disco × manifest × lock; atualiza versão mudada; drift ⇒ avisa e exige `--force`; exit 3 em drift.
**Where**: `src/cli/sync.ts` + testes integration
**Depends on**: T16 · **Reuses**: plan/apply/drift · **Requirement**: CLI-03, INST-04
**Done when**:
- [ ] Arquivo editado pelo usuário: sync avisa, não toca; `--force` sobrescreve com backup
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): sync com proteção de drift`

### T19: Doctor estendido [P] ✅
**What**: doctor soma: drift lock×disco, versão < mínima, hooks Codex instalados → lembrete de trust `/hooks`, última falha de consolidação (lê log).
**Where**: `src/cli/doctor.ts` (modif.) + testes
**Depends on**: T12, T16 · **Reuses**: drift, mode · **Requirement**: INST-09, HARN-04
**Done when**:
- [ ] Cada condição gera seção própria no relatório; exit 3 quando drift/incompat
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): doctor com drift, versões e trust`

## Fase 2 — M2

### T20: Scanner de segredos ✅
**What**: `scanSecrets(text)` — regexes (AKIA, PEM, JWT, `KEY=` alta entropia ≥20 chars, tokens comuns) + Shannon entropy; corpus positivo/negativo.
**Where**: `src/core/shared/secrets.ts` + testes
**Depends on**: T2 · **Reuses**: — · **Requirement**: MEM-05
**Done when**:
- [ ] Corpus: ≥12 positivos detectados, ≥12 negativos limpos (código normal, hashes de commit, UUIDs não flagam)
**Tests**: unit · **Gate**: quick
**Commit**: `feat(shared): scanner de segredos regex+entropia`

### T21: Memory store ✅
**What**: parse/serialize de fatos (formato PRD §5.3 exato), parser tolerante (entrada malformada pulada+logada), id derivado `sha256[0:8]`, `writeStore` atômico como **choke point** com `scanSecrets` (recusa = erro tipado).
**Where**: `src/core/memory/store.ts` + golden tests
**Depends on**: T20 · **Reuses**: fsx, secrets · **Requirement**: MEM-01, MEM-02, MEM-05
**Done when**:
- [ ] Goldens round-trip parse→serialize byte-idêntico; malformado não crasha; write com segredo lança `SecretRefusal`
**Tests**: unit · **Gate**: quick
**Commit**: `feat(memory): store com proveniência e scrub no write`

### T22: Orçamento de injeção [P] ✅
**What**: `buildInjection(stores, budgetBytes)` — prioridade corrections recentes → project → preference; trunca por entrada inteira; nunca excede teto.
**Where**: `src/core/memory/budget.ts` + testes
**Depends on**: T21 · **Reuses**: store · **Requirement**: MEM-03
**Done when**:
- [ ] Property test: qualquer store, output ≤ budget; ordem de prioridade asserta
**Tests**: unit · **Gate**: quick
**Commit**: `feat(memory): injeção com orçamento e prioridade`

### T23: Soft limits + state.json [P] ✅
**What**: `checkSoftLimits(store, config)` ⇒ `CompactionFlag[]` persistidos em `local/state.json`; leitura/escrita de `LocalState`.
**Where**: `src/core/memory/limits.ts` + testes
**Depends on**: T21 · **Reuses**: fsx · **Requirement**: MEM-04 (flags)
**Done when**:
- [ ] Limites de linhas E bytes por tipo; flag persiste e deduplica
**Tests**: unit · **Gate**: quick
**Commit**: `feat(memory): soft limits e flags de compactação`

### T24: `lumem memory list|show|search` [P] ✅
**What**: leitura humana (ids derivados exibidos) + `--json`; search = substring case-insensitive sobre corpo.
**Where**: `src/cli/memory-read.ts` + testes integration
**Depends on**: T21, T22 · **Reuses**: store · **Requirement**: CLI-07, CLI-11
**Done when**:
- [ ] Ids exibidos funcionam como argumento de show; escopos global+projeto mesclados com origem marcada
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): memory list/show/search`

### T25: `lumem memory add|edit|forget` [P] ✅
**What**: escrita manual (add com `--type/--scope/--conf`, src=`manual`), edit abre `$EDITOR` ou aceita `--body`, forget por id; tudo passa pelo choke point (segredo recusado com mensagem clara).
**Where**: `src/cli/memory-write.ts` + testes integration
**Depends on**: T21 · **Reuses**: store · **Requirement**: CLI-08
**Done when**:
- [ ] Add grava formato PRD exato; forget remove por id; segredo recusado exit 1 com motivo
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): memory add/edit/forget com scrub`

### T26: `lumem memory context` ✅
**What**: comando (oculto de help principal) que imprime o bloco de injeção — fonte única usada pela skill (M2) e pelo hook inject (M3).
**Where**: `src/cli/memory-context.ts` + testes
**Depends on**: T22 · **Reuses**: buildInjection · **Requirement**: MEM-03
**Done when**:
- [ ] Output ≤ budget do config; vazio ⇒ string vazia exit 0 (nunca erro)
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): memory context para injeção`

### T27: Skill lumem-memory final ✅
**What**: SKILL.md real: contrato de leitura/escrita durante sessão, instrução de injeção para modo degradado ("rode `lumem memory context` e leia antes de agir"), gatilhos de escrita explícita.
**Where**: `assets/skills/lumem-memory/SKILL.md`
**Depends on**: T8, T26 · **Reuses**: — · **Requirement**: MEM-07
**Done when**:
- [ ] Frontmatter válido nos 2 harnesses; **Saída M2**: sessão real do Claude Code usa memória injetada (verificação manual registrada em STATE)
**Tests**: none (dado) · **Gate**: build
**Commit**: `feat(assets): skill lumem-memory completa`

## Fase 3 — M3

### T28: Hook entrypoint fail-open [P] ✅
**What**: `hooks/main.ts` → bundle `lumem-hook.mjs`: dispatch por argv `<harnessId> <event>`, wrapper try/catch total + deadline (`inject` 2000ms / captura 100ms) + `exit 0` incondicional; parse manual de stdin; teste de bundle **zero imports externos**.
**Where**: `src/hooks/main.ts` + testes + assert no build
**Depends on**: T2 · **Reuses**: fsx (builtins-only) · **Requirement**: OPS-01, OPS-05
**Done when**:
- [ ] Handler que lança/trava ⇒ exit 0 em ≤ deadline+margem; grep no bundle: nenhum `require`/`import` externo
**Tests**: unit + chaos-lite · **Gate**: quick + build
**Commit**: `feat(hooks): entrypoint único fail-open bundlado`

### T29: Diário de sessão [P] ✅
**What**: `appendSignal(sessionsDir, sessionId, signal)` — JSONL `O_APPEND`, naming `<iso>.jsonl`, tipos `Signal` do design.
**Where**: `src/core/capture/journal.ts` + testes
**Depends on**: T2 · **Reuses**: fsx · **Requirement**: CAP-01
**Done when**:
- [ ] Appends concorrentes não corrompem linhas (teste com N writers)
**Tests**: unit · **Gate**: quick
**Commit**: `feat(capture): diário JSONL append-only`

### T30: Heurísticas de correção + redação [P] ✅
**What**: `classifyPrompt(text, markers)` (markers do config) e `redact(text, maxLen=500)` com scrub de segredo antes de gravar no diário.
**Where**: `src/core/capture/heuristics.ts` + testes
**Depends on**: T20 · **Reuses**: secrets · **Requirement**: CAP-02, CAP-03
**Done when**:
- [ ] Marca "na verdade…"/"nunca…"; NÃO escreve em memória durável (só retorna sinal); prompt com token redigido
**Tests**: unit · **Gate**: quick
**Commit**: `feat(capture): heurística de correção que só marca`

### T31: Detecção de recovery ✅
**What**: `detectRecovery(journalPath, newCmd)` — tail bounded do diário da própria sessão; falha anterior + sucesso agora ⇒ sinal `recovery`.
**Where**: `src/core/capture/recovery.ts` + testes
**Depends on**: T29 · **Reuses**: journal · **Requirement**: CAP-02
**Done when**:
- [ ] Cenário falha→passa detecta; passa→passa não; tail limitado (não lê arquivo inteiro)
**Tests**: unit · **Gate**: quick
**Commit**: `feat(capture): sinal de comando recuperado`

### T32: Handlers de evento do hook ✅
**What**: `inject` (reusa lógica do `memory context` — import direto do core, não subprocess), `capture-prompt`, `capture-tool`, `end` (grava sinal `session end`; spawn do runner entra na T40); resolução de projeto `CLAUDE_PROJECT_DIR` → `cwd` do payload; `cwd` sem `.lumem/` ⇒ descarta com log.
**Where**: `src/hooks/handlers/*.ts` + testes integration (stdin fake)
**Depends on**: T26, T28, T29, T30, T31 · **Reuses**: budget, journal, heuristics · **Requirement**: CAP-01..03, CONS-06 (parcial)
**Done when**:
- [ ] Cada evento com payload real dos 2 harnesses (fixtures) produz sinal/stdout esperado; cwd órfão descartado
**Tests**: integration · **Gate**: full
**Commit**: `feat(hooks): handlers inject/capture/end`

### T33: Instalação de hooks por harness [P] ✅
**What**: templates finais + wiring no install: Claude Code = bloco gerenciado em `.claude/settings.json` (merge-json); Codex = `.codex/hooks.json` (own-file; bloco se pré-existente); comandos apontam pro bundle absoluto.
**Where**: `assets/harness/*/hooks.tmpl.json`, `src/core/install/hooks-config.ts` + testes
**Depends on**: T14, T16, T28 · **Reuses**: managed-block, apply · **Requirement**: CONS-06, INST-05
**Done when**:
- [ ] Install em fake homes registra hooks nos formatos certos; settings.json de usuário com hooks próprios preservado; uninstall remove só o bloco lumem
**Tests**: integration · **Gate**: full
**Commit**: `feat(install): registro de hooks nos dois harnesses`

### T34: Bench de latência (sequencial — bench não é parallel-safe) ✅
**What**: `npm run bench:hook` — 100 execuções reais `node dist/lumem-hook.mjs codex capture-prompt < fixture`, p95 reportado; falha se ≥ 150ms; step de CI.
**Where**: `scripts/bench-hook.mjs`
**Depends on**: T32 · **Reuses**: bundle · **Requirement**: CAP-04
**Done when**:
- [ ] p95 < 150ms na máquina de dev registrado; **Saída M3** checklist: sinais aparecem em diário real nos 2 harnesses (verificação manual em STATE)
**Tests**: bench · **Gate**: bench
**Commit**: `test(hooks): bench p95 de latência`

## Fase 4 — M4

### T35: Gate de consolidação [P] ✅
**What**: `checkGate(state, journalPath, config)` — 4 condições (≥N sinais, ≥N min, ≥N h desde última, sem lock); barato (conta linhas, lê timestamps).
**Where**: `src/core/consolidate/gate.ts` + testes
**Depends on**: T23, T29 · **Reuses**: state, journal · **Requirement**: CONS-01
**Done when**:
- [ ] Matriz 4 condições × pass/fail; motivo da recusa no resultado
**Tests**: unit · **Gate**: quick
**Commit**: `feat(consolidate): gate de 4 condições`

### T36: Lock com TTL [P] ✅
**What**: `acquireLock(localDir, ttlMin=30)` — `O_CREAT|O_EXCL` com `{pid, startedAt}`; stale (> TTL) removido e readquirido; `releaseLock`.
**Where**: `src/core/consolidate/lock.ts` + testes (contenção com 2 processos)
**Depends on**: T2 · **Reuses**: fsx · **Requirement**: CONS-05
**Done when**:
- [ ] 2 aquisições concorrentes ⇒ exatamente 1 vence; stale readquirível
**Tests**: unit · **Gate**: quick
**Commit**: `feat(consolidate): lock O_EXCL com stale TTL`

### T37: Patch — schema + aplicação atômica [P] ✅
**What**: zod schema `ConsolidationPatch`; `applyPatch(patch, stores)` — entrada inválida/com segredo descartada individualmente + logada; falha estrutural ⇒ nada muda; escrita via choke point do store.
**Where**: `src/core/consolidate/patch.ts` + testes (fixtures válida/inválida/segredo/contradição)
**Depends on**: T21 · **Reuses**: store (T21) · **Requirement**: CONS-03, MEM-05, MEM-02
**Done when**:
- [ ] add/replace/remove aplicam com proveniência; patch não-parseável ⇒ memória byte-idêntica
**Tests**: unit · **Gate**: quick
**Commit**: `feat(consolidate): patch validado com aplicação atômica`

### T38: Skill lumem-consolidate final [P] ✅
**What**: prompt completo: regras anti-lixo PRD §5.4, schema JSON do patch embutido com exemplos, instrução de compactação quando flags presentes.
**Where**: `assets/skills/lumem-consolidate/SKILL.md`
**Depends on**: T8 · **Reuses**: schema T37 (copiado como texto) · **Requirement**: CONS-03
**Done when**:
- [ ] Schema no prompt == schema zod (teste que compara exemplo do prompt contra o zod real)
**Tests**: unit (exemplo do prompt valida) · **Gate**: quick
**Commit**: `feat(assets): prompt de consolidação com anti-lixo`

### T39: Runner desanexado ✅
**What**: `runner/main.ts` → `lumem-runner.mjs`: re-checa gate, lock, monta prompt (skill + diário + memória atual), invoca `headless` do descritor (comando+modelFlag+defaultModel; runtime `auto` = harness da sessão), parseia, `applyPatch`, atualiza `state.json`, loga, libera lock.
**Where**: `src/runner/main.ts` + testes integration (LLM = script mock no PATH)
**Depends on**: T4, T35, T36, T37, T38 · **Reuses**: tudo da fase · **Requirement**: CONS-02, CONS-04
**Done when**:
- [ ] Mock devolve patch válido ⇒ memória atualizada; mock exit≠0/JSON inválido ⇒ memória intacta, lock liberado, log
**Tests**: integration · **Gate**: full
**Commit**: `feat(runner): consolidação headless desanexada`

### T40: SessionEnd → spawn do runner ✅
**What**: handler `end` ganha: gate pré-check barato ⇒ `spawn(execPath, [runner], {detached, stdio:'ignore'}).unref()`; hook retorna imediato.
**Where**: `src/hooks/handlers/end.ts` (modif.) + teste
**Depends on**: T32, T39 · **Reuses**: gate, runner · **Requirement**: CONS-02
**Done when**:
- [ ] Hook sai em < deadline com runner vivo (teste observa pidfile/efeito); gate reprovado ⇒ nenhum spawn
**Tests**: integration · **Gate**: full
**Commit**: `feat(hooks): disparo desanexado da consolidação`

### T41: `lumem memory consolidate` [P] ✅
**What**: comando manual: `--force` (ignora gate, não o lock), `--dry-run` (imprime patch sem aplicar — roda LLM, avisa custo).
**Where**: `src/cli/memory-consolidate.ts` + testes (mock LLM)
**Depends on**: T39 · **Reuses**: runner core · **Requirement**: CLI-09, CLI-10
**Done when**:
- [ ] `--force` consolida com gate reprovado; `--dry-run` deixa memória intacta e mostra patch
**Tests**: integration · **Gate**: full
**Commit**: `feat(cli): consolidação manual com force e dry-run`

### T42: Compactação via flags [P] ✅
**What**: runner inclui no prompt os arquivos com `CompactionFlag` + instrução de compactar; pós-aplicação limpa flags; resultado respeita soft limits.
**Where**: `src/runner/main.ts` (modif.), `src/core/consolidate/patch.ts` (se necessário) + testes
**Depends on**: T23, T39 · **Reuses**: limits, runner · **Requirement**: MEM-04
**Done when**:
- [ ] Fixture acima do limite + mock compactador ⇒ arquivo volta pra dentro do limite, decisões/riscos preservados no fixture
**Tests**: integration · **Gate**: full
**Commit**: `feat(consolidate): compactação disparada por soft limit`

### T43: Agent lumem-consolidator final [P] ✅
**What**: definição do agente headless (modelo barato default, permissões mínimas, referência à skill de consolidação) nos formatos dos 2 harnesses.
**Where**: `assets/agents/lumem-consolidator.md`
**Depends on**: T8 · **Reuses**: — · **Requirement**: CONS-04
**Done when**:
- [ ] Instalável pelos 2 harnesses; **Saída M4** checklist manual em STATE após uso real
**Tests**: none (dado) · **Gate**: build
**Commit**: `feat(assets): agent consolidator`

## Fase 5 — M5

### T44: Suíte de chaos dos hooks [P] ✅
**What**: injeção sistemática: exceção em cada handler, timeout, stdin malformado/vazio/gigante, disco cheio (mock fs), journal read-only ⇒ sempre exit 0 + log; cobre os 4 eventos.
**Where**: `test/chaos/hooks.test.ts`
**Depends on**: T32, T40 · **Reuses**: bundle real · **Requirement**: OPS-01
**Done when**:
- [ ] Matriz eventos × falhas 100% exit 0; nenhum stderr não-intencional
**Tests**: chaos · **Gate**: full
**Commit**: `test(hooks): chaos fail-open completo`

### T45: Auditoria zero-rede [P] ✅
**What**: teste estático (grep de `http`/`fetch`/`net` fora de install/sync) + runtime (roda doctor/status/memory/consolidate-mock com resolver DNS bloqueado) provando NFR-3.
**Where**: `test/no-network.test.ts`
**Depends on**: T41 · **Reuses**: — · **Requirement**: OPS-02
**Done when**:
- [ ] Todos comandos runtime passam com rede bloqueada
**Tests**: integration · **Gate**: full
**Commit**: `test: auditoria zero rede em runtime`

### T46: Rotação de log [P] ✅
**What**: implementa rotação real no `log.ts` (tamanho máx + N arquivos), substituindo stub da T2.
**Where**: `src/core/shared/log.ts` (modif.) + testes
**Depends on**: T2 · **Reuses**: fsx · **Requirement**: OPS-09
**Done when**:
- [ ] Log > limite rotaciona; máx N arquivos antigos
**Tests**: unit · **Gate**: quick
**Commit**: `feat(shared): rotação de log`

### T47: Packaging + zero-install [P] ✅
**What**: `files` whitelist, `prepublishOnly`, bin permissions; validar `npm pack` + instalação do tarball + `npx` em dir limpo; publicar nome conforme decisão #1 (registrada na T1).
**Where**: `package.json`, `scripts/verify-pack.sh`
**Depends on**: T1, T41 · **Reuses**: — · **Requirement**: OPS-03
**Done when**:
- [ ] `npm pack` + install do tarball em tmp: `lumem doctor` funciona; tarball sem assets sobrando/faltando
**Tests**: integration (script) · **Gate**: build + script
**Commit**: `chore: packaging npx-ready`

### T48: README + docs ✅
**What**: README (quickstart, modelo de memória, modos degradados, uninstall), docs de config e troubleshooting; **Saída M5**: checklist de publicação.
**Where**: `README.md`, `docs/`
**Depends on**: T44, T45, T46, T47 · **Reuses**: specs · **Requirement**: P3.1 AC4
**Done when**:
- [ ] Quickstart executável do zero por alguém de fora; seções cobrem os 4 tópicos
**Tests**: none · **Gate**: full (regressão geral final)
**Commit**: `docs: README e guia de uso`

---

## Diagram-Definition Cross-Check

| Task | Depends on (corpo) | Diagrama | Status |
|---|---|---|---|
| T1 | — | raiz | ✅ |
| T2 | T1 | T1→T2 | ✅ |
| T3 | T1 | T1→T3 | ✅ |
| T4 | T3 | T3→T4 | ✅ |
| T5 | T2, T3 | T2→T5, T3→T5 | ✅ |
| T6 | T3 | T3→T6 | ✅ |
| T7 | T4, T5, T6 | convergem em T7 | ✅ |
| T8 | T1 | T1→T8 | ✅ |
| T9 | T2 | T2→T9 | ✅ |
| T10 | T2 | T2→T10 | ✅ |
| T11 | T2, T8 | T2→T11 (*nota T8) | ✅ |
| T12 | T2 | T2→T12 | ✅ |
| T13 | T11, T12 | T11,T12→T13 | ✅ |
| T14 | T9, T10, T13 | T9,T10,T13→T14 | ✅ |
| T15 | T5, T6, T12 | T5,T6,T12→T15 | ✅ |
| T16 | T14, T15 | T14,T15→T16 | ✅ |
| T17 | T16 | T16→T17 | ✅ |
| T18 | T16 | T16→T18 | ✅ |
| T19 | T12, T16 | T16→T19 (c/ T12) | ✅ |
| T20 | T2 | T2→T20 | ✅ |
| T21 | T20 | T20→T21 | ✅ |
| T22 | T21 | T21→T22 | ✅ |
| T23 | T21 | T21→T23 | ✅ |
| T24 | T21, T22 | T21,T22→T24 | ✅ |
| T25 | T21 | T21→T25 | ✅ |
| T26 | T22 | T22→T26 | ✅ |
| T27 | T8, T26 | T26→T27 (c/ T8) | ✅ |
| T28 | T2 | T2→T28 | ✅ |
| T29 | T2 | T2→T29 | ✅ |
| T30 | T20 | T20→T30 | ✅ |
| T31 | T29 | T29→T31 | ✅ |
| T32 | T26, T28, T29, T30, T31 | convergem em T32 | ✅ |
| T33 | T14, T16, T28 | T14,T16,T28→T33 | ✅ |
| T34 | T32 | T32→T34 | ✅ |
| T35 | T23, T29 | T23,T29→T35 | ✅ |
| T36 | T2 | T2→T36 | ✅ |
| T37 | T21 | T21→T37 | ✅ |
| T38 | T8 | T8→T38 | ✅ |
| T39 | T4, T35, T36, T37, T38 | convergem em T39 | ✅ |
| T40 | T32, T39 | T32,T39→T40 | ✅ |
| T41 | T39 | T39→T41 | ✅ |
| T42 | T23, T39 | T39→T42 (c/ T23) | ✅ |
| T43 | T8 | T8→T43 | ✅ |
| T44 | T32, T40 | T32,T40→T44 | ✅ |
| T45 | T41 | T41→T45 | ✅ |
| T46 | T2 | T2→T46 | ✅ |
| T47 | T1, T41 | T1,T41→T47 | ✅ |
| T48 | T44, T45, T46, T47 | convergem em T48 | ✅ |

Tasks `[P]` da mesma fase: nenhuma depende de outra `[P]` irmã (T5 depende de T2 que é de fase anterior à sua execução paralela com T4/T6 — T2 conclui antes da janela paralela abrir). T34 sem `[P]` por bench não-parallel-safe. ✅

## Test Co-location Validation

| Task | Camada | Matriz exige | Task diz | Status |
|---|---|---|---|---|
| T1 | infra/build | none | none (gate build+full) | ✅ |
| T2 | core/shared | unit | unit | ✅ |
| T3 | core/harness + adapters | unit | unit | ✅ |
| T4 | adapters JSON | unit via schema | unit | ✅ |
| T5, T6 | core/harness | unit | unit | ✅ |
| T7 | cli | integration | integration | ✅ |
| T8 | assets | none | none | ✅ |
| T9–T13 | core/install | unit | unit | ✅ |
| T14 | core/install (I/O real) | unit→integration (maior) | integration | ✅ |
| T15–T19 | cli | integration | integration | ✅ |
| T20–T23 | core | unit | unit | ✅ |
| T24–T26 | cli | integration | integration | ✅ |
| T27 | assets | none | none | ✅ |
| T28 | hooks entry | unit+chaos | unit+chaos-lite (chaos completo T44) | ✅ |
| T29–T31 | core/capture | unit | unit | ✅ |
| T32 | hooks handlers | integration | integration | ✅ |
| T33 | core/install + assets | integration | integration | ✅ |
| T34 | bench | bench | bench | ✅ |
| T35–T37 | core/consolidate | unit | unit | ✅ |
| T38 | assets (c/ teste de schema) | none/unit | unit | ✅ |
| T39–T42 | runner + cli | integration | integration | ✅ |
| T43 | assets | none | none | ✅ |
| T44 | chaos | chaos | chaos | ✅ |
| T45 | auditoria | integration | integration | ✅ |
| T46 | core/shared | unit | unit | ✅ |
| T47 | packaging | script | integration script | ✅ |
| T48 | docs | none | none (+full final) | ✅ |

Nenhuma deferral de teste: T28 tem chaos-lite na criação e T44 amplia (não substitui — T28 já verifica exit 0 sozinho). ✅

## Granularity Check

48 tasks; cada uma = 1 módulo/1 comando/1 asset. Casos ⚠️ avaliados: T7 (esqueleto CLI + 2 comandos — coeso, é o bootstrap do commander), T32 (4 handlers — mesmo diretório, mesmo contrato de stdin, coeso), T39 (runner — 1 processo, 1 fluxo). Nenhum ❌.
