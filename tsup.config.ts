import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node20',
    // No `clean`: it deletes dist/ wholesale, and tests spawn these bundles as
    // real processes. Overwriting in place leaves no window where they vanish.
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    // hook entrypoint: single self-contained file, zero external imports (NFR-6)
    entry: { 'lumem-hook': 'src/hooks/main.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node20',
    noExternal: [/.*/],
    outExtension: () => ({ js: '.mjs' }),
  },
  {
    entry: { 'lumem-runner': 'src/runner/main.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node20',
    noExternal: [/.*/],
    outExtension: () => ({ js: '.mjs' }),
  },
])
