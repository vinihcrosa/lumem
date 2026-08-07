import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { type CliContext, resolveAdaptersDir } from './context'
import { renderDoctor, runDoctor } from './doctor'
import { renderStatus, runStatus } from './status'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string }

const program = new Command()

program
  .name('lumem')
  .description('Memory layer for coding agents')
  .version(pkg.version)
  .option('--json', 'output machine-readable JSON')

function buildContext(): CliContext {
  return {
    projectDir: process.cwd(),
    adaptersDir: resolveAdaptersDir(),
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    json: program.opts<{ json?: boolean }>().json === true,
  }
}

function emit(json: boolean, report: unknown, rendered: string): void {
  console.log(json ? JSON.stringify(report, null, 2) : rendered)
}

program
  .command('doctor')
  .description('Diagnose harness detection and operating modes')
  .action(() => {
    const ctx = buildContext()
    const { report, exitCode } = runDoctor(ctx)
    emit(ctx.json, report, renderDoctor(report))
    process.exitCode = exitCode
  })

program
  .command('status')
  .description('Show artifacts installed in this project')
  .action(() => {
    const ctx = buildContext()
    const { report, exitCode } = runStatus(ctx)
    emit(ctx.json, report, renderStatus(report))
    process.exitCode = exitCode
  })

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
