import { join } from 'node:path';

declare const EYRIE_VERSION: string | undefined;

/**
 * Points the engine at the assets shipped beside the command (the tree-sitter
 * grammars, the built web UI), then runs the server's CLI. The environment
 * always wins, so a checkout or the desktop app can point the same bundle
 * elsewhere.
 */
export function run(home: string): void {
  process.env.EYRIE_GRAMMAR_DIR ??= join(home, 'grammars');
  process.env.EYRIE_WEB_DIR ??= join(home, 'web');
  if (typeof EYRIE_VERSION !== 'undefined' && EYRIE_VERSION) process.env.EYRIE_VERSION ??= EYRIE_VERSION;

  // Dynamic, after the environment is set: the CLI reads EYRIE_VERSION when it
  // loads. Promise form, not top-level await, so this also bundles to
  // CommonJS for the single-executable build.
  import('../../../packages/server/src/cli.js').catch((err: unknown) => {
    process.stderr.write(`[eyrie] ${(err as Error).message}\n`);
    process.exit(1);
  });
}
