/**
 * Smoke-tests a built `eyrie`: starts `eyrie mcp` on a repository, asks for
 * `architecture_overview` over JSON-RPC, and checks the answer names real
 * components. What CI runs against the packed tarball on every platform.
 *
 * Usage: `tsx scripts/smoke.ts [--tarball <tgz>] [repo]`. Without --tarball
 * it runs apps/cli/dist/cli.js; with it, the tarball is installed into a fresh
 * prefix first, the way a user installs it. The repo defaults to
 * fixtures/bookstore-app.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliPaths } from './paths.js';

const { cliDir, repoRoot } = cliPaths(import.meta.url);

const args = process.argv.slice(2);
const tarballAt = args.indexOf('--tarball');
const tarball = tarballAt === -1 ? null : args[tarballAt + 1]!;
const rest = args.filter((_, i) => i !== tarballAt && i !== tarballAt + 1);
const repo = rest[0] ?? join(repoRoot, 'fixtures', 'bookstore-app');

let command = 'node';
let prefix = [join(cliDir, 'dist', 'cli.js')];
if (tarball) {
  const install = mkdtempSync(join(tmpdir(), 'eyrie-install-'));
  console.log(`Installing ${tarball} into ${install}`);
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', install, tarball], {
    stdio: 'inherit',
    env: { ...process.env, npm_config_cache: join(install, 'npm-cache') },
  });
  command = join(install, 'node_modules', '.bin', process.platform === 'win32' ? 'eyrie.cmd' : 'eyrie');
  prefix = [];
}
console.log(`Starting ${command} ${[...prefix, 'mcp', repo].join(' ')}`);

// A fresh Eyrie home every run: the smoke test never touches the user's cache.
const child = spawn(command, [...prefix, 'mcp', repo], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, EYRIE_HOME: mkdtempSync(join(tmpdir(), 'eyrie-smoke-')) } });
const fail = (message: string): never => {
  child.kill();
  console.error(`smoke: ${message}`);
  process.exit(1);
};

let id = 0;
const pending = new Map<number, (result: unknown) => void>();
let buffer = '';
child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
  buffer += chunk;
  let end: number;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      fail(`not JSON-RPC: ${line.slice(0, 120)}`);
    }
    if (typeof message!.id === 'number' && pending.has(message!.id)) {
      const resolve = pending.get(message!.id)!;
      pending.delete(message!.id);
      if (message!.error) fail(`JSON-RPC error: ${message!.error.message ?? 'unknown'}`);
      resolve(message!.result);
    }
  }
});

const call = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<unknown>((resolve) => {
    const next = ++id;
    pending.set(next, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
  });

const timeout = setTimeout(() => fail('timed out after 120 s'), 120_000);
try {
  const hello = (await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'eyrie-smoke', version: '0' } })) as { serverInfo?: { name?: string; version?: string } };
  if (hello?.serverInfo?.name !== 'eyrie') fail(`unexpected serverInfo: ${JSON.stringify(hello)}`);
  const answer = (await call('tools/call', { name: 'architecture_overview', arguments: {} })) as { content?: { text?: string }[] };
  const overview = JSON.parse(answer?.content?.[0]?.text ?? 'null') as { size?: { components?: number }; lanes?: Record<string, unknown[]> } | null;
  const components = overview?.size?.components ?? 0;
  if (!overview || components < 5) fail(`unexpected overview: ${JSON.stringify(overview)?.slice(0, 200)}`);
  console.log(`smoke: eyrie ${hello.serverInfo?.version} answered architecture_overview with ${components} components.`);
} finally {
  clearTimeout(timeout);
  child.kill();
  await new Promise((r) => child.once('exit', r));
}
