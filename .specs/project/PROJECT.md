# lumem

## Visão

Camada de memória e auto-aprendizado para agentes de código, distribuída como CLI Node/TypeScript. Acopla-se a harnesses existentes (Claude Code, Codex) via skills, hooks e agents — sem substituir o runtime do agente.

O agente acumula conhecimento durável sobre o projeto e sobre as preferências do dev **sem que ninguém precise pedir**, e usa esse conhecimento nas sessões seguintes.

**O que não é:** orquestrador de pipeline, loja de skills, servidor, produto SaaS. É um instalador + um contrato de memória.

## Problema

Toda sessão de agente começa do zero. Perde-se entre sessões: decisões e o porquê delas, correções do usuário, becos sem saída já explorados, preferências pessoais. `CLAUDE.md`/`AGENTS.md` manuais exigem disciplina e envelhecem mal; ferramentas que resolvem isso vêm acopladas a orquestradores inteiros. Não existe camada de memória fina, portável e agnóstica de harness.

## Público

- **V1 (interno):** autor + time pequeno — padronizar convenções entre repos, parar de reexplicar contexto.
- **Pós-V1 (público):** dev individual com 1–2 agentes CLI — memória sem adotar orquestrador.

## Princípios de design (ordem importa; em conflito, o de cima vence)

1. **Fail-open.** Memória quebrada nunca quebra o agente.
2. **Markdown é o banco de dados.** Sem SQLite, vector DB ou daemon na V1.
3. **Captura é barata, consolidação é cara.** Sinal = append determinístico; fato durável = LLM gated.
4. **Contexto é orçamento, não depósito.** Todo conteúdo injetado tem teto duro.
5. **Adapter é dado, não código.** Harness novo = descritor declarativo novo.
6. **Nunca sobrescrever o que é do usuário.** Blocos gerenciados delimitados, nunca reescrita total.
7. **Local-first.** Zero rede em runtime.

## Fronteira arquitetural inegociável

`core/` não sabe que Claude Code ou Codex existem. Se souber, suporte a harness novo vira código e o princípio 5 morre.

## Documentos

- PRD completo: [.specs/features/lumem-v1/PRD.md](../features/lumem-v1/PRD.md)
- Spec V1: [.specs/features/lumem-v1/spec.md](../features/lumem-v1/spec.md)
