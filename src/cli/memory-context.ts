import type { Command } from 'commander'
import { buildInjection } from '../core/memory/budget'
import type { CliContext } from './context'
import { loadAllMemory } from './memory-read'

/** Fallback budget until the config file wiring lands. */
export const DEFAULT_BUDGET_BYTES = 4096

/**
 * Build the memory injection block. This is the single source consumed by the
 * skill (M2) and by the SessionStart hook (M3), so it never fails: no memory at
 * all simply yields an empty string.
 */
export function runMemoryContext(
  ctx: CliContext,
  opts?: { budgetBytes?: number },
): { text: string; exitCode: number } {
  const { text } = buildInjection(loadAllMemory(ctx), opts?.budgetBytes ?? DEFAULT_BUDGET_BYTES)
  return { text, exitCode: 0 }
}

/**
 * Attach the hidden `context` subcommand: it writes the raw injection text to
 * stdout — no JSON wrapper, no decoration, no trailing newline of its own —
 * because the hook echoes this output straight into the agent's context.
 */
export function registerMemoryContextCommand(
  memoryCmd: Command,
  buildContext: () => CliContext,
): void {
  memoryCmd
    .command('context', { hidden: true })
    .description('Imprimir o bloco de injeção de memória (fonte única da skill e do hook)')
    .action(() => {
      const { text, exitCode } = runMemoryContext(buildContext())
      if (text !== '') process.stdout.write(text)
      process.exitCode = exitCode
    })
}
