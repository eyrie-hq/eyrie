import { defineConfig } from 'vite';

// The engine host is an ES module. Electron runs a utility process from an
// .mjs file as ESM. (@eyrie/storage loads node:sqlite with require, so the
// engine also bundles to CommonJS for the desktop app's single-executable
// `eyrie` command; this host simply stays ESM.)
export default defineConfig({
  build: {
    target: 'node22',
    lib: { entry: 'src/engine-host.ts', formats: ['es'], fileName: () => 'engine-host.mjs' },
    rollupOptions: {
      // Built-ins only available with the `node:` prefix (node:sqlite), and the
      // optional native add-ons `ws` tries to load and works without.
      external: [/^node:/, 'bufferutil', 'utf-8-validate'],
      output: {
        // CommonJS dependencies in the bundle (graphology, ws) still call
        // `require('events')`; an ES module has no `require` unless it makes one.
        banner: "import { createRequire as __eyrieCreateRequire } from 'node:module';\nconst require = __eyrieCreateRequire(import.meta.url);",
      },
    },
  },
});
