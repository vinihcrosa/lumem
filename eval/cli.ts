/**
 * Entrypoint for `npm run eval`. Nothing lives here but the invocation: the
 * parsing and the flow are in `cli-main.ts`, which imports clean so the unit
 * suite can drive them without ever starting a run.
 *
 * `vite-node` passes the flags after `--`, so they land at `process.argv[2]`
 * onward exactly as they would under plain node.
 */
import { main } from './cli-main'

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
