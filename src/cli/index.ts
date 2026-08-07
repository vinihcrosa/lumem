import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string }

const program = new Command()

program.name('lumem').description('Memory layer for coding agents').version(pkg.version)

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
