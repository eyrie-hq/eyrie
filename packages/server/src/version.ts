import { readFileSync } from 'node:fs';

// The npm bundle and the single-executable build stamp their version in;
// a checkout reads its own package.json. The single executable has no
// package.json next to it, so the environment is checked first.
//
// This lives apart from cli.ts so modules can read the version without
// running the CLI: cli.ts calls main() on import, by design.
export const VERSION =
  process.env.EYRIE_VERSION ?? (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
