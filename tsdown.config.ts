import { defineConfig } from 'tsdown'

/**
 * Self-contained build for the host bundle.
 *
 * `prepare` runs this after a `github:` install, where no sibling checkout and
 * no project references exist — so the config must not depend on either, and
 * type checking stays in the separate `typecheck` script.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Declarations ship with the bundle so consumers get types without a
  // separate `tsc` pass, which a `github:` install would not run.
  dts: true,
  treeshake: true,
  // Shared runtimes stay external: bundling them would duplicate the Cordis and
  // tool-registry identities the host already owns.
  external: [/^@deepseek-ai\//, /^node:/],
})
