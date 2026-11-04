import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The workspace root: the first folder above `from` holding pnpm-workspace.yaml. */
export function workspaceRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No pnpm-workspace.yaml above ${from}`);
    dir = parent;
  }
}

/** Paths for the CLI's scripts, whether run from source (tsx) or bundled. */
export function cliPaths(metaUrl: string): { cliDir: string; repoRoot: string } {
  const repoRoot = workspaceRoot(dirname(fileURLToPath(metaUrl)));
  return { cliDir: join(repoRoot, 'apps', 'cli'), repoRoot };
}
