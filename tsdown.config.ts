import { defineConfig } from 'tsdown'

/**
 * The package's module id, which is also the id its client bundle must
 * register under: the harness serves the bundle at `/plugins/<package>/client.js`
 * and rejects a handoff whose id does not match the graph row being executed.
 */
const PACKAGE_ID = 'dsh-agent-messaging'

/**
 * The web shell loads a client bundle as a classic script that REGISTERS a
 * factory; nothing runs until the module system materializes it, and the
 * factory is handed a synchronous `require` bound to the shell's module table.
 * A plain CommonJS chunk is exactly that factory body, so the wrapper only has
 * to supply the `module`/`exports` pair it expects and hand back the result.
 */
const CLIENT_BANNER = [
  `window.__ModuleLoader__.load({`,
  `\tid: ${JSON.stringify(PACKAGE_ID)},`,
  `\tfactory: (require) => {`,
  `\t\tvar module = { exports: {} };`,
  `\t\tvar exports = module.exports;`,
].join('\n')

const CLIENT_FOOTER = ['\t\treturn module.exports;', '\t}', '});'].join('\n')

/**
 * Two builds, one package: the host half that the harness's Node process loads,
 * and the browser half the web shell fetches.
 *
 * `prepare` runs this after a `github:` install, where no sibling checkout and
 * no project references exist — so the config must not depend on either, and
 * type checking stays in the separate `typecheck` script.
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    // Each build cleans only what it writes: the two run against one directory,
    // and a blanket clean would race the other's output away.
    clean: ['lib/index.*'],
    // Declarations ship with the bundle so consumers get types without a
    // separate `tsc` pass, which a `github:` install would not run.
    dts: true,
    treeshake: true,
    // Shared runtimes stay external: bundling them would duplicate the Cordis and
    // tool-registry identities the host already owns.
    external: [/^@deepseek-ai\//, /^node:/],
  },
  {
    entry: ['src/client/index.ts'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    clean: ['lib/client.*'],
    // The browser half is a leaf: nothing imports it as a library, so it ships
    // no declarations.
    dts: false,
    treeshake: true,
    tsconfig: 'tsconfig.client.json',
    // React and the shell's own UI packages are singletons owned by the page.
    // Requiring them is the point of the factory's `require`; bundling a second
    // copy of React would break hooks outright.
    external: [/^@deepseek-ai\//, 'react', 'react-dom', /^react\//, /^react-dom\//],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: CLIENT_BANNER,
      footer: CLIENT_FOOTER,
    },
  },
])
