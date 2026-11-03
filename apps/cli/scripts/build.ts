/**
 * Builds @eyrie-hq/cli's dist/: one bundled `eyrie` command (ESM for npm, plus
 * a CommonJS snapshot entry for the desktop app's single-executable build),
 * the tree-sitter WASM files and the built web UI beside it. No native
 * modules, so the npm package serves every platform; the single executable is
 * built per platform from the same snapshot (scripts/build-sea.ts).
 *
 * Run from the workspace root as `pnpm --filter @eyrie-hq/cli build`, which
 * builds the web UI first, or `build:bundle` to bundle against the current
 * apps/web/dist.
 */
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { build } from 'esbuild';
import { grammarFiles } from '@eyrie/parser';
import { cliPaths } from './paths.js';

const { cliDir, repoRoot } = cliPaths(import.meta.url);
const dist = join(cliDir, 'dist');
const webDist = join(repoRoot, 'apps', 'web', 'dist');
const version: string = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')).version;

/** Bundles dist/. Imported by the CLI test; run directly by `build:bundle`. */
export async function buildCli(): Promise<{ dist: string; version: string; grammars: number }> {
  if (!existsSync(join(webDist, 'index.html'))) {
    throw new Error('apps/web/dist is missing. Build the UI first: pnpm --filter @eyrie/web build');
  }

  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  // The license travels in the tarball's root (npm packs package.json, README
  // and LICENSE from there). Copies, refreshed on every build.
  for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) copyFileSync(join(repoRoot, file), join(cliDir, file));

const shared = {
  bundle: true,
  platform: 'node' as const,
  target: 'node22',
  // The optional native add-ons `ws` and `chokidar` try to load and work without.
  external: ['fsevents', 'bufferutil', 'utf-8-validate'],
  define: { EYRIE_VERSION: JSON.stringify(version) },
  logLevel: 'warning' as const,
  // import.meta survives in two guarded CJS fallbacks (the version read, the
  // web-UI path); both only run when the environment already points elsewhere,
  // which the single-executable entry always sets up first.
  logOverride: { 'empty-import-meta': 'silent' } as const,
};

await build({
  ...shared,
  entryPoints: [join(cliDir, 'src', 'cli.ts')],
  format: 'esm',
  outfile: join(dist, 'cli.js'),
  // CommonJS dependencies in the bundle still call `require('events')`; an ES
  // module has no `require` unless it makes one. Same banner as the desktop
  // app's engine host (apps/desktop/vite.host.config.mts).
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __eyrieCreateRequire } from \'node:module\';\nconst require = __eyrieCreateRequire(import.meta.url);' },
});
chmodSync(join(dist, 'cli.js'), 0o755);

// The single-executable entry: Node's SEA snapshot must be CommonJS.
// web-tree-sitter's ESM build locates its files through import.meta.url,
// which does not exist in CJS, so the snapshot bundles its CJS build instead.
const parserRequire = createRequire(join(repoRoot, 'packages', 'parser', 'package.json'));
await build({
  ...shared,
  entryPoints: [join(cliDir, 'src', 'cli-sea.ts')],
  format: 'cjs',
  outfile: join(dist, 'eyrie-sea.cjs'),
  alias: { 'web-tree-sitter': parserRequire.resolve('web-tree-sitter') },
});
writeFileSync(join(dist, 'sea-config.json'), JSON.stringify({ main: join(dist, 'eyrie-sea.cjs'), output: join(dist, 'eyrie-sea.blob'), disableExperimentalSEAWarning: true }, null, 2) + '\n');

mkdirSync(join(dist, 'grammars'), { recursive: true });
const wasm = grammarFiles();
for (const file of wasm) copyFileSync(file, join(dist, 'grammars', basename(file)));
cpSync(webDist, join(dist, 'web'), { recursive: true });

  const size = (f: string) => `${(statSync(join(dist, f)).size / 1024).toFixed(0)} KB`;
  console.log(`Built dist/ for @eyrie-hq/cli ${version}: cli.js (${size('cli.js')}), eyrie-sea.cjs (${size('eyrie-sea.cjs')}), ${wasm.length} grammars, the web UI.`);
  return { dist, version, grammars: wasm.length };
}

// Runs on direct invocation; the CLI test and prepare-resources import buildCli() instead.
// (EYRIE_DIRECT_RUN is set only by a local tsx stand-in that bundles before running.)
if (process.argv[1]?.endsWith('build.ts') || process.env.EYRIE_DIRECT_RUN?.endsWith('build.ts')) {
  await buildCli().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
