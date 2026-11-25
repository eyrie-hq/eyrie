import { cpSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { McpWorkspace, serveStdio, TOOL_SPECS } from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/bookstore-app', import.meta.url));

type Rpc = { jsonrpc: '2.0'; id: unknown; result?: Record<string, any>; error?: { code: number; message: string } };

describe('MCP workspace: several repositories in one process', () => {
  let dir: string;
  let code: string;
  let shop: string;
  let books: string;
  let outside: string;
  let ws: McpWorkspace | null = null;
  let next = 1;
  const home = process.env.EYRIE_HOME;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'eyrie-ws-'));
    // Engines keep their caches under EYRIE_HOME; never the user's own.
    process.env.EYRIE_HOME = join(dir, 'data');
    code = join(dir, 'code');
    shop = join(code, 'shop');
    books = join(code, 'books');
    outside = join(dir, 'elsewhere');
    for (const repo of [shop, books, outside]) {
      cpSync(FIXTURE, repo, { recursive: true });
      mkdirSync(join(repo, '.git'));
    }
    // Make the two repositories tell apart: books has no recommender.
    unlinkSync(join(books, 'src/services/recommender.service.ts'));
    writeFileSync(join(code, 'notes.txt'), 'not a repository\n');
  });

  afterEach(async () => {
    await ws?.close();
    ws = null;
  });

  afterAll(() => {
    if (home === undefined) delete process.env.EYRIE_HOME;
    else process.env.EYRIE_HOME = home;
    rmSync(dir, { recursive: true, force: true });
  });

  const workspace = (opts: Partial<ConstructorParameters<typeof McpWorkspace>[0]> = {}) => {
    ws = new McpWorkspace({ version: '9.9.9', watch: false, ...opts });
    return ws;
  };
  const rpc = async (method: string, params?: Record<string, unknown>) => (await ws!.handle({ jsonrpc: '2.0', id: next++, method, params })) as Rpc;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    const result = res.result as { content: { text: string }[]; isError?: boolean };
    return { body: JSON.parse(result.content[0]!.text) as Record<string, any>, isError: !!result.isError };
  };
  const labels = (body: Record<string, any>) => Object.values(body.lanes as Record<string, { label: string }[]>).flat().map((c) => c.label);

  it('answers as before for the repository it was started with, and lists repo as an optional argument', async () => {
    workspace({ defaultRoot: shop });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code' } });
    const tools = (await rpc('tools/list')).result!.tools as { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[];
    expect(tools.map((t) => t.name)).toEqual(TOOL_SPECS.map((t) => t.name));
    for (const t of tools) {
      expect(t.inputSchema.properties.repo).toMatchObject({ type: 'string' });
      expect(t.inputSchema.required ?? []).not.toContain('repo');
    }
    const { body, isError } = await call('architecture_overview');
    expect(isError).toBe(false);
    expect(body.repo.root).toBe(shop);
    expect(labels(body)).toContain('RecommenderService');
    expect(ws!.openRepositories()).toEqual([shop]);
  });

  it('opens the repository a call names, by folder name or by a path inside it', async () => {
    workspace({ roots: [code] });
    const byName = await call('architecture_overview', { repo: 'books' });
    expect(byName.body.repo.root).toBe(books);
    expect(labels(byName.body)).not.toContain('RecommenderService');
    const byPath = await call('components_for_files', { repo: join(shop, 'src/services/order.service.ts'), files: ['src/services/order.service.ts'] });
    expect(byPath.body[0].components.map((c: { label: string }) => c.label)).toEqual(['OrderService']);
    expect(ws!.openRepositories()).toEqual([shop, books]);
  });

  it('refuses a repository outside the allowed folders, and asks for repo when several are possible', async () => {
    workspace({ roots: [code] });
    const out = await call('architecture_overview', { repo: outside });
    expect(out.isError).toBe(true);
    expect(out.body.error).toMatch(/outside the folders/);
    expect(ws!.openRepositories()).toEqual([]);
    const none = await call('architecture_overview');
    expect(none.isError).toBe(true);
    expect(none.body.error).toMatch(/Name one with repo/);
    expect(none.body.repositories).toEqual([books, shop].sort());
  });

  it("uses the client's workspace root when a call names no repository, and follows roots/list_changed", async () => {
    workspace({});
    const sent: Rpc[] = [];
    ws!.connect((m) => sent.push(m as Rpc));
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'codex' } });
    await ws!.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(sent).toEqual([{ jsonrpc: '2.0', id: expect.any(String), method: 'roots/list' }]);
    await ws!.handle({ jsonrpc: '2.0', id: sent[0]!.id, result: { roots: [{ uri: pathToFileURL(books).href, name: 'books' }] } });
    expect((await call('architecture_overview')).body.repo.root).toBe(books);

    await ws!.handle({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
    expect(sent).toHaveLength(2);
    const answer = ws!.handle({ jsonrpc: '2.0', id: sent[1]!.id, result: { roots: [{ uri: pathToFileURL(shop).href }] } });
    await answer;
    expect((await call('architecture_overview')).body.repo.root).toBe(shop);
    // A client root is an allowed folder, nothing else is.
    expect((await call('architecture_overview', { repo: outside })).isError).toBe(true);
  });

  it('keeps at most --max-repos repositories open, but never closes one with an open session', async () => {
    workspace({ roots: [code, dirname(outside)], maxRepos: 1 });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code' } });
    await call('architecture_overview', { repo: shop });
    await call('architecture_overview', { repo: books });
    expect(ws!.openRepositories()).toEqual([books]);
    expect((await call('record_intent', { repo: books, task: 'Rename the catalog' })).isError).toBe(false);
    await call('architecture_overview', { repo: shop });
    expect(ws!.openRepositories().sort()).toEqual([books, shop].sort());
    await call('record_intent', { repo: books, done: true, summary: 'Renamed' });
    await call('architecture_overview', { repo: outside });
    expect(ws!.openRepositories()).toEqual([outside]);
  });

  it('serves stdio with a response to its own request taken ahead of a waiting tool call', async () => {
    workspace({});
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Rpc[] = [];
    output.setEncoding('utf8').on('data', (chunk: string) => {
      for (const l of chunk.split('\n')) if (l.trim()) lines.push(JSON.parse(l) as Rpc);
    });
    const served = serveStdio(ws!, input, output);
    const send = (m: unknown) => input.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: {} }, clientInfo: { name: 'codex' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // The tool call is queued while roots/list is unanswered; it must not block the answer.
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'architecture_overview', arguments: {} } });
    await waitFor(() => lines.some((l) => (l as { method?: string }).method === 'roots/list'));
    const request = lines.find((l) => (l as { method?: string }).method === 'roots/list')!;
    send({ jsonrpc: '2.0', id: request.id, result: { roots: [{ uri: pathToFileURL(shop).href }] } });
    await waitFor(() => lines.some((l) => l.id === 2));
    input.end();
    await served;
    const answer = lines.find((l) => l.id === 2)!;
    expect(JSON.parse(answer.result!.content[0].text).repo.root).toBe(shop);
    expect(lines.filter((l) => l.error)).toEqual([]);
  });
});

function dirname(path: string): string {
  return join(path, '..');
}

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
