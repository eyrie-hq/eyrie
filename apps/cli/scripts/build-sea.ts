/**
 * Builds the single-executable `eyrie` for this platform from apps/cli/dist
 * (run `build` first): Node's single-executable snapshot of eyrie-sea.cjs,
 * injected into a copy of the running Node with postject.
 *
 * Usage: `pnpm --filter @eyrie-hq/cli build:sea [out]`, where out defaults to
 * dist/eyrie (dist/eyrie.exe on Windows). The desktop app's prepare-resources
 * imports buildSea() and ships the binary with dist/grammars and dist/web
 * beside it.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { cliPaths } from './paths.js';

const require = createRequire(import.meta.url);
const { cliDir } = cliPaths(import.meta.url);
const dist = join(cliDir, 'dist');

/**
 * The sentinel postject flips, read from the Node binary itself rather than
 * copied from the docs: its suffix differs between Node builds (official
 * 22.x carries `…5d2f31b6`; other builds differ).
 */
function sentinelFuse(binary: string): string {
  const bytes = readFileSync(binary);
  const found = Buffer.from(bytes).toString('latin1').match(/NODE_SEA_FUSE_[0-9a-f]{32}/g) ?? [];
  const unique = [...new Set(found)];
  if (unique.length !== 1) throw new Error(`Expected one NODE_SEA_FUSE in ${binary}, found ${unique.length}.`);
  return unique[0]!;
}

/** Injects the snapshot into a copy of the running Node at `out`. Returns `out`. */
export function buildSea(out: string = join(dist, process.platform === 'win32' ? 'eyrie.exe' : 'eyrie')): string {
  if (!existsSync(join(dist, 'sea-config.json')) || !existsSync(join(dist, 'grammars'))) {
    throw new Error('apps/cli/dist is missing. Build the bundle first: pnpm --filter @eyrie-hq/cli build:bundle');
  }
  console.log('Generating the SEA snapshot…');
  execFileSync(process.execPath, ['--experimental-sea-config', join(dist, 'sea-config.json')], { stdio: 'inherit' });

  // postject alters the binary in place, so inject into a copy of Node, never Node itself.
  copyFileSync(process.execPath, out);
  if (process.platform === 'darwin') {
    // A copy of a signed binary keeps a signature that no longer matches; drop it before postject.
    execFileSync('codesign', ['--remove-signature', out], { stdio: 'inherit' });
  }
  const postject = require.resolve('postject/dist/cli.js');
  const args = [out, 'NODE_SEA_BLOB', join(dist, 'eyrie-sea.blob'), '--sentinel-fuse', sentinelFuse(process.execPath)];
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  console.log('Injecting the snapshot…');
  execFileSync(process.execPath, [postject, ...args], { stdio: 'inherit' });
  if (process.platform === 'darwin') {
    // Ad hoc, like the desktop app itself: not notarized, but no longer "damaged".
    execFileSync('codesign', ['-s', '-', out], { stdio: 'inherit' });
  }
  console.log(`Checking ${out}…`);
  const help = execFileSync(out, ['--help'], { encoding: 'utf8' });
  if (!help.includes('eyrie — live architecture graph')) throw new Error(`${out} --help did not print the CLI help.`);
  console.log(`Single-executable eyrie at ${out} (${dirname(out)} also needs grammars/ and web/ beside it).`);
  return out;
}

// Runs on direct invocation; prepare-resources imports buildSea() instead.
// (EYRIE_DIRECT_RUN is set only by a local tsx stand-in that bundles before running.)
if (process.argv[1]?.endsWith('build-sea.ts') || process.env.EYRIE_DIRECT_RUN?.endsWith('build-sea.ts')) {
  try {
    buildSea(process.argv[2]);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
