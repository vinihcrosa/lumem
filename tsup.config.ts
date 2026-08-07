import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node20',
    clean: true,
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
