/**
 * The published `eyrie` command, built and run the way a user runs it: the
 * bundle answers `--help` and serves `architecture_overview` over MCP, with
 * its version stamped in and its assets (grammars, web UI) beside it.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCli } from '../scripts/build.js';

const cliDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(cliDir, '..', '..');
const FIXTURE = join(repoRoot, 'fixtures', 'bookstore-app');
const version: string = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')).version;

let dist = '';

/** One JSON-RPC call over an `eyrie mcp` process's stdio. */
async function mcpCall(child: ReturnType<typeof spawn>, id: number, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        if (message.id !== id) continue;
        child.stdout!.off('data', onData);
        if (message.error) reject(new Error(message.error.message ?? 'JSON-RPC error'));
        else resolve(message.result);
      }
    };
    child.stdout!.setEncoding('utf8').on('data', onData);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

describe('@eyrie-hq/cli', () => {
  beforeAll(async () => {
    if (!existsSync(join(repoRoot, 'apps', 'web', 'dist', 'index.html'))) {
      execFileSync('pnpm', ['--filter', '@eyrie/web', 'build'], { cwd: repoRoot, stdio: 'inherit' });
    }
    ({ dist } = await buildCli());
  }, 300_000);

  it('prints help', () => {
    const help = execFileSync('node', [join(dist, 'cli.js'), '--help'], { encoding: 'utf8' });
    expect(help).toContain('eyrie — live architecture graph');
  });

  it('ships its assets beside the bundle', () => {
    expect(existsSync(join(dist, 'grammars', 'tree-sitter-typescript.wasm'))).toBe(true);
    expect(existsSync(join(dist, 'web', 'index.html'))).toBe(true);
  });

  it('tells agents about Eyrie with init-agents', () => {
    const root = mkdtempSync(join(tmpdir(), 'eyrie-init-agents-'));
    const out = execFileSync('node', [join(dist, 'cli.js'), 'init-agents', root], { encoding: 'utf8' });
    expect(out).toContain('AGENTS.md');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('components_for_files');
  });

  it('serves architecture_overview over MCP', async () => {
    const child = spawn('node', [join(dist, 'cli.js'), 'mcp', FIXTURE, '--no-watch'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, EYRIE_HOME: mkdtempSync(join(tmpdir(), 'eyrie-cli-test-')) },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    try {
      const hello = (await mcpCall(child, 1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cli-test', version: '0' } })) as {
        serverInfo?: { name?: string; version?: string };
      };
      expect(hello?.serverInfo?.name).toBe('eyrie');
      expect(hello?.serverInfo?.version).toBe(version);
      const answer = (await mcpCall(child, 2, 'tools/call', { name: 'architecture_overview', arguments: {} })) as { content?: { text?: string }[] };
      const overview = JSON.parse(answer?.content?.[0]?.text ?? 'null') as { size?: { components?: number } } | null;
      expect(overview?.size?.components).toBe(36);
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    expect(stderr).not.toMatch(/Could not (read|write) cache|database is locked/);
  }, 120_000);
});
