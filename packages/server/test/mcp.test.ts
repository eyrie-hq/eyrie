import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ArchNode } from '@eyrie/core';
import { GraphEngine, type EngineBatch } from '@eyrie/engine';
import type { ProjectKnowledge } from '@eyrie/knowledge';
import { focusSet } from '@eyrie/lens';
import { EyrieMcp, PROTOCOL_VERSIONS, openKnowledge } from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/bookstore-app', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The bookstore fixture as a git repository of its own, with one commit co-authored by Claude. */
function fixtureRepo(dir: string): string {
  const root = join(dir, 'bookstore');
  cpSync(FIXTURE, root, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Ada');
  git('config', 'user.email', 'ada@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: bookstore');
  appendFileSync(join(root, 'prisma/schema.prisma'), '\n// touched\n');
  git('commit', '-q', '-am', 'chore: tidy the schema', '-m', 'Co-Authored-By: Claude <noreply@anthropic.com>');
  return root;
}

type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } } | null;

describe('MCP server', () => {
  let dir: string;
  let engine: GraphEngine;
  let knowledge: ProjectKnowledge;
  let mcp: EyrieMcp;
  let next = 1;
  const rpc = async (method: string, params?: Record<string, unknown>) => (await mcp.handle({ jsonrpc: '2.0', id: next++, method, params })) as Rpc;
  /** Calls a tool and returns its parsed answer, and whether it was an error. */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    const result = res!.result as { content: { text: string }[]; isError?: boolean };
    return { body: JSON.parse(result.content[0]!.text) as Record<string, any>, isError: !!result.isError };
  };
  const byKind = (kind: ArchNode['kind']) => engine.architecture.nodes.find((n) => n.kind === kind)!;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eyrie-mcp-'));
    const root = fixtureRepo(dir);
    engine = new GraphEngine({ root, dataDir: join(dir, 'data'), watch: false });
    const ready = engine.start().then(async () => {
      knowledge = await openKnowledge(engine, { watch: false });
      return { knowledge };
    });
    mcp = new EyrieMcp({ engine, ready, version: '9.9.9' });
    await ready;
  });
  afterAll(async () => {
    mcp.dispose();
    await knowledge.close();
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('negotiates the protocol version and describes itself', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init!.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'eyrie', version: '9.9.9' } });
    expect(String(init!.result!.instructions)).toContain('components_for_files');
    const future = await rpc('initialize', { protocolVersion: '2099-01-01' });
    expect(future!.result!.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect((await rpc('ping'))!.result).toEqual({});
  });

  it('answers JSON-RPC errors and ignores notifications', async () => {
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect((await rpc('resources/list'))!.error!.code).toBe(-32601);
    expect(((await mcp.handle({ id: 1, method: 'ping' })) as Rpc)!.error!.code).toBe(-32600);
    expect((await rpc('tools/call', { name: 'rm_rf' }))!.error!.code).toBe(-32602);
  });

  it('lists read-only tools, plus ask, which stores its answer', async () => {
    const { tools } = (await rpc('tools/list'))!.result as { tools: { name: string; inputSchema: object; annotations: { readOnlyHint: boolean } }[] };
    expect(tools.map((t) => t.name)).toEqual([
      'architecture_overview',
      'find_components',
      'explain_component',
      'impact',
      'trace',
      'find_path',
      'components_for_files',
      'recent_changes',
      'record_intent',
      'commit_history',
      'check',
      'ask',
    ]);
    for (const t of tools) {
      expect(t.annotations.readOnlyHint).toBe(t.name !== 'ask' && t.name !== 'record_intent');
      expect(t.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('refuses to ask with AI off, and answers through a backend when one is set', async () => {
    const off = await call('ask', { question: 'Where is the cart?' });
    expect(off.isError).toBe(true);
    expect(off.body.error).toContain('AI is off');

    const turns = [
      { answer: { answer: 'I cannot tell without looking.', steps: [] } },
      { answer: { answer: 'The cart is a service.', steps: [{ text: 'Find the cart.', componentIds: ['service:cart'] }] } },
    ];
    let n = 0;
    const backend = { name: 'scripted', run: async () => ({ json: turns[n++] }) };
    const asking = new EyrieMcp({ engine, ready: Promise.resolve({ knowledge }), version: '9.9.9', ai: backend });
    const askRpc = async (question: string) => {
      const res = await asking.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { question } } });
      const ok = res as unknown as { result: { content: { text: string }[] } };
      return JSON.parse(ok.result.content[0]!.text) as { status: string; answer: { steps: unknown[] } | null; backend: string; id: number; error: string | null };
    };
    try {
      const ok = await askRpc('Is there a cart?');
      expect(ok.status).toBe('ok');
      expect(ok.answer?.steps).toEqual([]);
      expect(ok.backend).toBe('scripted');
      expect(typeof ok.id).toBe('number');
      // service:cart is not grounded in a tool result (the script answered at once), so the loop rejects it — and stores the rejection.
      const rejected = await askRpc('Where is the cart?');
      expect(rejected.status).toBe('rejected');
      expect(rejected.error).toContain('service:cart');
      expect(knowledge.store.askHistory(2).map((q) => q.status)).toEqual(['rejected', 'ok']);
    } finally {
      asking.dispose();
    }
  });

  it('gives an overview by lane, with size and history', async () => {
    const { body } = await call('architecture_overview');
    expect(body.size.components).toBe(engine.architecture.nodes.length);
    expect(Object.keys(body.lanes)).toEqual(expect.arrayContaining(['ui', 'api', 'data']));
    expect(body.mostConnected.length).toBeGreaterThan(0);
    expect(body.history).toMatchObject({ commits: 2, analysed: 0, ai: null });
  });

  it('explains a component by id, name or file, with its links both ways', async () => {
    const route = byKind('api_route');
    const byId = await call('explain_component', { component: route.id });
    expect(byId.body.component).toMatchObject({ id: route.id, label: route.label, lane: route.lane });
    expect(byId.body.dependsOn.length + byId.body.usedBy.length).toBeGreaterThan(0);
    expect((await call('explain_component', { component: route.files[0] })).body.component.id).toBe(route.id);
    expect((await call('explain_component', { component: join(engine.root, route.files[0]!) })).body.component.id).toBe(route.id);
  });

  it('refuses an ambiguous or unknown reference, listing candidates', async () => {
    const ambiguous = await call('explain_component', { component: 'src' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.body.error).toMatch(/Call again with one of these ids/);
    expect(ambiguous.body.candidates.length).toBeGreaterThan(1);
    const unknown = await call('impact', { component: 'no-such-thing-anywhere' });
    expect(unknown).toMatchObject({ isError: true, body: { error: expect.stringMatching(/No component matches/) } });
  });

  it('reports impact and trace as the map computes them', async () => {
    const model = byKind('database_model');
    const impact = await call('impact', { component: model.id });
    const expected = focusSet(engine.architecture.edges, model.id, 'upstream');
    expect(impact.body.dependents.components.map((c: { id: string }) => c.id).sort()).toEqual([...expected.depth.keys()].filter((id) => id !== model.id).sort());
    expect(impact.body.dependents.direct).toBeGreaterThan(0);
    const page = byKind('page');
    const trace = await call('trace', { component: page.id });
    expect(trace.body.dependencies.components.length).toBeGreaterThan(0);
  });

  it('finds the path from a page down to data, in either order', async () => {
    const page = byKind('page');
    const reachable = focusSet(engine.architecture.edges, page.id, 'downstream');
    const target = engine.architecture.nodes.find((n) => n.lane === 'data' && reachable.depth.has(n.id))!;
    const down = await call('find_path', { from: page.id, to: target.id });
    expect(down.body.components[0].id).toBe(page.id);
    expect(down.body.components.at(-1).id).toBe(target.id);
    expect(down.body.links.length).toBe(down.body.components.length - 1);
    const up = await call('find_path', { from: target.id, to: page.id });
    expect(up.body.direction).toMatch(/only this way round/);
  });

  it('maps files to the components that own them', async () => {
    const route = byKind('api_route');
    const [owned, loose] = (await call('components_for_files', { files: [route.files[0], 'nowhere/new-file.ts'] })).body as Record<string, any>[];
    expect(owned!.components.map((c: { id: string }) => c.id)).toContain(route.id);
    expect(loose).toMatchObject({ file: 'nowhere/new-file.ts', components: [], note: expect.any(String) });
    // Agents often pass one path as a string.
    const single = (await call('components_for_files', { files: route.files[0] })).body as Record<string, any>[];
    expect(single[0]!.components.map((c: { id: string }) => c.id)).toContain(route.id);
    expect(await call('components_for_files', { files: [] })).toMatchObject({ isError: true, body: { error: 'Give the files as a list of paths.' } });
  });

  it('checks the whole project, or only the files given', async () => {
    const full = await call('check');
    expect(full.isError).toBe(false);
    expect(full.body).toMatchObject({ filesChecked: expect.any(Number), checkedAt: expect.any(Number), counts: expect.any(Object) });
    expect(Array.isArray(full.body.findings)).toBe(true);
    for (const f of full.body.findings as Record<string, any>[]) {
      expect(f).toMatchObject({ id: expect.any(String), rule: expect.any(String), severity: expect.any(String), evidence: expect.any(String), fixPrompt: expect.any(String) });
    }
    const route = byKind('api_route');
    const scoped = await call('check', { files: [route.files[0]] });
    expect(scoped.isError).toBe(false);
    for (const f of (scoped.body.findings ?? []) as Record<string, any>[]) {
      expect(f.files.some((file: { path: string }) => file.path === route.files[0])).toBe(true);
    }
  });

  it('keeps counts in range, and cuts long lanes to their most connected components', async () => {
    expect((await call('commit_history', { limit: -5 })).body.commits).toHaveLength(1);
    expect((await call('commit_history', { limit: 'lots' })).body.commits).toHaveLength(2);
    expect((await call('find_components', { query: 'src', limit: 1 })).body.components).toHaveLength(1);

    const small = new EyrieMcp({ engine, ready: Promise.resolve({}), version: '1', laneLimit: 2 });
    const { result } = (await small.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'architecture_overview' } })) as { result: { content: { text: string }[] } };
    const body = JSON.parse(result.content[0]!.text);
    const ui = engine.architecture.nodes.filter((n) => n.lane === 'ui');
    expect(body.lanes.ui).toHaveLength(2);
    expect(body.omitted.ui).toBe(ui.length - 2);
    expect(body.note).toMatch(/2 most connected/);
    const links = (id: string) => engine.architecture.edges.filter((e) => e.source === id || e.target === id).length;
    expect(links(body.lanes.ui[0].id)).toBe(Math.max(...ui.map((n) => links(n.id))));
    small.dispose();
  });

  it('names what changed in the architecture since it started, including removed components', async () => {
    const victim = byKind('service');
    const added: ArchNode = { ...victim, id: 'new-svc', key: 'new-svc', label: 'PaymentsService', files: ['src/services/payments.ts'] };
    const batch = {
      seq: 41,
      at: Date.now(),
      ms: 1,
      files: [{ file: 'src/services/payments.ts', change: 'add' }],
      code: { addedNodes: [], updatedNodes: [], removedNodes: [], addedEdges: [], updatedEdges: [], removedEdges: [] },
      architecture: { addedNodes: [added], updatedNodes: [], removedNodes: [victim.id], addedEdges: [{ id: 'e-new', source: 'new-svc', target: victim.id, kinds: ['CALLS'], weight: 1 }], updatedEdges: [], removedEdges: [] },
      reresolved: 1,
      stats: engine.stats,
    } as unknown as EngineBatch;
    engine.emit('batch', batch);
    const { body } = await call('recent_changes');
    const change = body.changes.find((c: { seq: number }) => c.seq === 41);
    expect(change.componentsAdded).toEqual([{ id: 'new-svc', label: 'PaymentsService', kind: victim.kind, lane: victim.lane }]);
    expect(change.componentsRemoved[0]).toMatchObject({ id: victim.id, label: victim.label });
    expect(change.linksAdded).toEqual([{ source: 'new-svc', target: victim.id, from: 'PaymentsService', to: victim.label, kinds: ['CALLS'] }]);
    expect((await call('recent_changes', { since: 41 })).body.changes).toEqual([]);
  });

  it('lists recorded commits with their agents, filters them, and shows one in full', async () => {
    const all = await call('commit_history');
    expect(all.body.commits.map((c: { subject: string }) => c.subject)).toEqual(['chore: tidy the schema', 'feat: bookstore']);
    expect(all.body.commits[0].agents).toEqual(['Claude']);
    const claude = await call('commit_history', { agent: 'claude' });
    expect(claude.body.commits).toHaveLength(1);
    const full = await call('commit_history', { hash: all.body.commits[0].hash.slice(0, 8) });
    expect(full.body.files).toEqual([{ path: 'prisma/schema.prisma', added: 2, deleted: 0 }]);
    expect(full.body.body).toContain('Co-Authored-By: Claude');
  });

  it('answers the handshake before indexing finishes, and holds tool calls until it does', async () => {
    let finish!: (v: { knowledge?: ProjectKnowledge }) => void;
    const slow = new EyrieMcp({ engine, ready: new Promise((r) => (finish = r)), version: '1' });
    expect(((await slow.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as Rpc)!.result).toBeDefined();
    let answered = false;
    const pending = slow.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'architecture_overview' } }).then((r) => ((answered = true), r));
    await new Promise((r) => setTimeout(r, 30));
    expect(answered).toBe(false);
    finish({});
    expect(((await pending) as Rpc)!.result).toBeDefined();
    slow.dispose();
  });
});

describe('eyrie mcp over stdio', () => {
  it('serves JSON-RPC on stdout and logs only to stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eyrie-mcp-stdio-'));
    const root = fixtureRepo(dir);
    // tsx's own CLI under this Node: node_modules/.bin/tsx is a shell script (tsx.cmd on Windows), which spawn cannot start there.
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const child = spawn(process.execPath, [tsx, join(REPO_ROOT, 'packages/server/src/cli.ts'), 'mcp', root, '--no-watch'], {
      env: { ...process.env, EYRIE_HOME: join(dir, 'home'), EYRIE_AI: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let buffer = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop()!;
      lines.push(...parts.filter(Boolean));
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const waitFor = async (count: number) => {
      for (let i = 0; i < 300 && lines.length < count; i++) await new Promise((r) => setTimeout(r, 50));
    };
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'architecture_overview', arguments: {} } });
      await waitFor(2);
      const messages = lines.map((l) => JSON.parse(l) as { id: number; result: Record<string, any> });
      expect(messages.map((m) => m.id)).toEqual([1, 2]);
      expect(messages[0]!.result.serverInfo.name).toBe('eyrie');
      expect(JSON.parse(messages[1]!.result.content[0].text).history.commits).toBe(2);
      expect(stderr).toContain('[eyrie] Indexed');
    } finally {
      child.stdin.end();
      await new Promise((r) => child.on('exit', r));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
