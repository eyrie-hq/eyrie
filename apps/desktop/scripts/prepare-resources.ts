/**
 * Fills resources/ with what the app reads from disk at run time: the built web
 * UI (it carries LICENSE and THIRD-PARTY-NOTICES.md), tree-sitter's WASM
 * files, the window icon, and the single-executable `eyrie` command with its
 * own grammars and web UI beside it (resources/cli, for coding agents).
 * forge.config.mts ships them as extra resources; during `electron-forge
 * start` the app reads them from here.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { grammarFiles } from '@eyrie/parser';
import { buildCli } from '../../cli/scripts/build.js';
import { buildSea } from '../../cli/scripts/build-sea.js';
import { cliPaths } from '../../cli/scripts/paths.js';

const { repoRoot } = cliPaths(import.meta.url);
const out = join(repoRoot, 'apps', 'desktop', 'resources');
const webDist = join(repoRoot, 'apps', 'web', 'dist');
const iconPng = join(repoRoot, 'apps', 'desktop', 'assets', 'icon.png');

if (!existsSync(join(webDist, 'index.html'))) {
  console.error('apps/web/dist is missing. Build the UI first: pnpm --filter @eyrie/web build');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(webDist, join(out, 'web'), { recursive: true });
mkdirSync(join(out, 'grammars'), { recursive: true });
const wasm = grammarFiles();
for (const file of wasm) copyFileSync(file, join(out, 'grammars', basename(file)));
// The window's icon on Linux, and the Dock's while the app runs unpackaged on macOS.
copyFileSync(iconPng, join(out, 'icon.png'));

// The `eyrie` command for coding agents: a single executable that needs no
// Node, with its grammars and web UI beside it so it also runs after the user
// installs it elsewhere from the app's Connect menu.
const { dist } = await buildCli();
const cliOut = join(out, 'cli');
mkdirSync(cliOut, { recursive: true });
buildSea(join(cliOut, process.platform === 'win32' ? 'eyrie.exe' : 'eyrie'));
cpSync(join(dist, 'grammars'), join(cliOut, 'grammars'), { recursive: true });
cpSync(join(dist, 'web'), join(cliOut, 'web'), { recursive: true });

console.log(`Prepared resources/: the web UI, ${wasm.length} WASM files, the icon, and the eyrie command.`);
