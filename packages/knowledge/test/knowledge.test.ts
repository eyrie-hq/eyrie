import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ArchGraph, ArchNode } from '@eyrie/core';
import {
  ProjectKnowledge,
  agentsOf,
  CODEX_DISABLED_FEATURES,
  KnowledgeStore,
  VIEW_LIMITS,
  commitView,
  analysisRequest,
  claudeArgs,
  codexArgs,
  createAiBackend,
  parseCodexRun,
  seatbeltProfile,
  strictSchema,
  headCommit,
  parseClaudeOutput,
  readCommits,
  recentHashes,
  validateNote,
  type AiBackend,
  type AiRequest,
  type CommitRecord,
} from '../src/index.js';

const temp = mkdtempSync(join(tmpdir(), 'eyrie-knowledge-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

let n = 0;
function repo(): { root: string; commit: (message: string, files: Record<string, string>, opts?: { author?: string }) => string } {
  const root = join(temp, `repo-${n++}`);
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Ada');
  git('config', 'user.email', 'ada@example.com');
  git('config', 'commit.gpgsign', 'false');
  return {
    root,
    commit: (message, files, opts = {}) => {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      git('add', '-A');
      git('commit', '-q', '-m', message, ...(opts.author ? ['--author', opts.author] : []));
      return git('rev-parse', 'HEAD');
    },
  };
}

const node = (id: string, label: string, files: string[], lane: ArchNode['lane'], kind: ArchNode['kind'], category: ArchNode['category']): ArchNode => ({
  id,
  key: id,
  label,
  files,
  lane,
  kind,
  category,
  members: [],
});

const arch: ArchGraph = {
  nodes: [
    node('page-checkout', 'Checkout page', ['src/ui/checkout.tsx'], 'ui', 'page', 'frontend'),
    node('model-order', 'Order', ['src/db/order.ts'], 'data', 'database_model', 'data'),
    node('route-orders', 'POST /api/orders', ['src/api/orders.ts'], 'api', 'api_route', 'api'),
  ],
  edges: [],
};

describe('git history', () => {
  it('reads commits newest first, with files, line counts, merges and co-authors', async () => {
    const r = repo();
    const first = r.commit('feat: add the orders route', { 'src/api/orders.ts': 'export {}\n' });
    const second = r.commit('fix: typo in checkout\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>', {
      'src/ui/checkout.tsx': 'export const a = 1;\nexport const b = 2;\n',
      'src/db/order.ts': 'export {}\n',
      'logo.png': Buffer.from([0, 1, 2, 3, 0]).toString('binary'),
    });
    expect(await headCommit(r.root)).toBe(second);
    expect(await recentHashes(r.root, 10)).toEqual([second, first]);

    const [latest, older] = await readCommits(r.root, [second, first]);
    expect(latest).toMatchObject({ hash: second, parents: [first], subject: 'fix: typo in checkout', authorName: 'Ada', coAuthors: [{ name: 'Claude Opus 5.5', email: 'noreply@anthropic.com' }] });
    expect(latest!.files).toEqual(
      expect.arrayContaining([
        { path: 'src/ui/checkout.tsx', added: 2, deleted: 0 },
        { path: 'src/db/order.ts', added: 1, deleted: 0 },
        { path: 'logo.png', added: null, deleted: null },
      ]),
    );
    expect(agentsOf(latest!)).toEqual(['Claude']);
    expect(older!.files).toEqual([{ path: 'src/api/orders.ts', added: 1, deleted: 0 }]);
    expect(agentsOf(older!)).toEqual([]);
  });

  it('limits history and paths to a project opened at a sub-folder', async () => {
    const r = repo();
    r.commit('ui', { 'web/app.tsx': 'a\n', 'api/server.ts': 'b\n' });
    r.commit('api only', { 'api/server.ts': 'c\n' });
    const web = join(r.root, 'web');
    const hashes = await recentHashes(web, 10);
    expect(hashes).toHaveLength(1);
    const [commit] = await readCommits(web, hashes);
    expect(commit!.subject).toBe('ui');
    expect(commit!.files).toEqual([{ path: 'app.tsx', added: 1, deleted: 0 }]);
  });

  it('records nothing outside a git work tree', async () => {
    const plain = join(temp, 'plain');
    mkdirSync(plain);
    expect(await headCommit(plain)).toBeNull();
    expect(await recentHashes(plain, 10)).toEqual([]);
  });

  it('recognises agents by name or address, in authors and co-authors', () => {
    const person = (authorName: string, authorEmail: string) => ({ authorName, authorEmail, coAuthors: [] });
    expect(agentsOf(person('Codex', 'codex@example.com'))).toEqual(['Codex']);
    expect(agentsOf(person('github-actions', 'x@users.noreply.github.com'))).toEqual([]);
    expect(agentsOf({ authorName: 'Ada', authorEmail: 'a@b.c', coAuthors: [{ name: 'Cursor Agent', email: 'cursoragent@cursor.com' }] })).toEqual(['Cursor']);
  });
});

/** A backend that answers from a function, and records what it was asked. */
function fakeBackend(answer: (request: AiRequest) => unknown): AiBackend & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    name: 'fake',
    requests,
    run: async (request) => {
      requests.push(request);
      const json = answer(request);
      if (json instanceof Error) throw json;
      return { json, model: 'fake-1', usage: { input_tokens: 10 } };
    },
  };
}

const goodNote = (hash: string) => ({ hash, intent: 'Fixes a typo.', matchesMessage: 'no', mismatch: 'It also adds the Order model.', risk: 'medium', observations: [{ text: 'UI and data changed together.', evidence: ['component:page-checkout', 'file:src/db/order.ts'] }] });

describe('ProjectKnowledge', () => {
  const open = (root: string, ai?: AiBackend) =>
    ProjectKnowledge.open({ root, dataDir: join(root, '.data'), architecture: () => arch, project: () => ({ name: 'shop', frameworks: ['next'] }), ai });

  it('records each commit once, with the components that own its files, and keeps them across restarts', async () => {
    const r = repo();
    r.commit('feat: orders route', { 'src/api/orders.ts': 'x\n' });
    const k = open(r.root);
    expect(await k.record()).toBe(1);
    expect(await k.record()).toBe(0);
    const head = r.commit('fix: typo in checkout', { 'src/ui/checkout.tsx': 'y\n', 'src/db/order.ts': 'z\n', 'README.md': 'r\n' });
    expect(await k.record()).toBe(1);
    const recorded = k.store.commit(head)!;
    expect(recorded.components.map((c) => c.id).sort()).toEqual(['model-order', 'page-checkout']);
    expect(recorded.components.find((c) => c.id === 'page-checkout')).toEqual({ id: 'page-checkout', label: 'Checkout page', kind: 'page', lane: 'ui', category: 'frontend' });
    expect(k.summary()).toMatchObject({ commits: 2, analysed: 0, added: 1, head, ai: null });
    await k.close();

    const again = open(r.root);
    expect(await again.record()).toBe(0);
    expect(again.store.commits().map((c) => c.subject)).toEqual(['fix: typo in checkout', 'feat: orders route']);
    expect(again.store.commits({ component: 'route-orders' }).map((c) => c.subject)).toEqual(['feat: orders route']);
    await again.close();
  });

  it('analyses nothing without a backend', async () => {
    const r = repo();
    r.commit('one', { 'a.ts': 'a\n' });
    const k = open(r.root);
    await k.record();
    expect(await k.analyze()).toBeNull();
    await k.close();
  });

  it('keeps valid notes, rejects notes citing evidence the commit lacks, and does not ask again', async () => {
    const r = repo();
    const a = r.commit('fix: typo in checkout', { 'src/ui/checkout.tsx': 'y\n', 'src/db/order.ts': 'z\n' });
    const b = r.commit('chore: route', { 'src/api/orders.ts': 'x\n' });
    const backend = fakeBackend(() => ({
      commits: [
        { hash: b, intent: 'Route.', matchesMessage: 'yes', risk: 'low', observations: [{ text: 'Touches the payments service.', evidence: ['component:payments'] }] },
        goodNote(a.slice(0, 10)),
      ],
    }));
    const k = open(r.root, backend);
    await k.record();
    expect(await k.analyze()).toEqual({ ok: 1, rejected: 1, failed: 0 });

    expect(k.store.latestNote(a)?.note).toMatchObject({ matchesMessage: 'no', mismatch: 'It also adds the Order model.', risk: 'medium' });
    expect(k.store.latestNote(a)?.model).toBe('fake-1');
    expect(k.store.latestNote(b)).toBeNull();
    expect(k.store.analyses(b)[0]).toMatchObject({ status: 'rejected', error: 'cites evidence the commit does not have: component:payments' });
    expect(k.summary().analysed).toBe(1);

    expect(await k.analyze()).toEqual({ ok: 0, rejected: 0, failed: 0 });
    expect(backend.requests).toHaveLength(1);
    await k.close();
  });

  it('sends names, paths and counts, never file contents', async () => {
    const r = repo();
    r.commit('feat: secret handling', { 'src/api/orders.ts': 'const API_KEY = "sk-not-for-models";\n' });
    const backend = fakeBackend(() => ({ commits: [] }));
    const k = open(r.root, backend);
    await k.record();
    await k.analyze();
    const sent = backend.requests[0]!;
    expect(sent.prompt).toContain('src/api/orders.ts');
    expect(sent.prompt).toContain('POST /api/orders');
    expect(sent.prompt).not.toContain('sk-not-for-models');
    await k.close();
  });

  it('records a failed request per commit and retries it, at most three times', async () => {
    const r = repo();
    r.commit('one', { 'a.ts': 'a\n' });
    const backend = fakeBackend(() => new Error('quota exceeded'));
    const k = open(r.root, backend);
    await k.record();
    for (let i = 0; i < 4; i++) await k.analyze();
    expect(backend.requests).toHaveLength(3);
    const [latest] = k.store.analyses(k.store.commits()[0]!.hash);
    expect(latest).toMatchObject({ status: 'failed', error: 'quota exceeded' });
    await k.close();
  });
});

describe('commitView', () => {
  it('cuts long lists and says how much was left out', async () => {
    const store = KnowledgeStore.open(':memory:');
    const files = Array.from({ length: 70 }, (_, i) => ({ path: `src/f${i}.ts`, added: 1, deleted: 0 }));
    const components = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, label: `C${i}`, kind: 'service', lane: 'logic', category: 'service' }));
    store.addCommits([{ hash: 'abc1234', parents: [], authorName: 'Ada', authorEmail: 'a@b.c', authoredAt: 1, committedAt: 1, subject: 'big merge', body: 'details', agents: [], files, components, recordedAt: 1 }]);
    const commit = store.commit('abc1234')!;
    const list = commitView(store, commit);
    expect(list.components).toHaveLength(VIEW_LIMITS.listComponents);
    expect(list.moreComponents).toBe(50 - VIEW_LIMITS.listComponents);
    expect(list.files).toBeUndefined();
    expect(list.filesChanged).toBe(70);
    const full = commitView(store, commit, { detail: true });
    expect(full.files).toHaveLength(VIEW_LIMITS.detailFiles);
    expect(full.moreFiles).toBe(70 - VIEW_LIMITS.detailFiles);
    expect(full.components).toHaveLength(VIEW_LIMITS.detailComponents);
    expect(full.moreComponents).toBe(50 - VIEW_LIMITS.detailComponents);
    expect(full.body).toBe('details');
    store.close();
  });
});

describe('validateNote', () => {
  const commit = { files: [{ path: 'a.ts', added: 1, deleted: 0 }], components: [{ id: 'c1', label: 'A', kind: 'service', lane: 'logic', category: 'service' }] } as unknown as CommitRecord;

  it('accepts evidence from the commit and drops a mismatch the verdict does not call for', () => {
    const checked = validateNote(commit, { intent: ' x ', matchesMessage: 'yes', mismatch: 'ignored', risk: 'low', observations: [{ text: 'ok', evidence: ['file:a.ts', 'component:c1'] }] });
    expect(checked).toEqual({ note: { intent: 'x', matchesMessage: 'yes', risk: 'low', observations: [{ text: 'ok', evidence: ['file:a.ts', 'component:c1'] }] } });
  });

  it('rejects malformed answers and uncited observations', () => {
    expect(validateNote(commit, { intent: 'x', matchesMessage: 'maybe', risk: 'low', observations: [] })).toEqual({ error: 'invalid matchesMessage' });
    expect(validateNote(commit, { intent: 'x', matchesMessage: 'yes', risk: 'low', observations: [{ text: 'no proof', evidence: [] }] })).toEqual({ error: 'an observation has no evidence' });
    expect(validateNote(commit, { intent: 'x', matchesMessage: 'yes', risk: 'low', observations: [{ text: 'y', evidence: ['file:b.ts'] }] })).toEqual({ error: 'cites evidence the commit does not have: file:b.ts' });
  });

  it('asks for every commit in the batch, in order', () => {
    const request = analysisRequest({ name: 'shop', frameworks: [] }, [{ ...commit, hash: 'h1', subject: 's', body: '', agents: [] } as CommitRecord], 1000);
    expect(request.prompt).toContain('"hash": "h1"');
    expect(request.schema).toMatchObject({ required: ['commits'] });
  });
});

describe('Claude Code backend', () => {
  it('runs claude with no tools, MCP servers, user settings or saved session', () => {
    const args = claudeArgs({ system: 'sys', schema: { type: 'object' } }, 'opus');
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain('--print');
    expect(value('--tools')).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(value('--mcp-config')).toBe('{"mcpServers":{}}');
    expect(value('--setting-sources')).toBe('local');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--disable-slash-commands');
    expect(value('--json-schema')).toBe('{"type":"object"}');
    expect(value('--model')).toBe('opus');
  });

  it('reads structured output, falls back to JSON in the text, and surfaces errors', () => {
    expect(parseClaudeOutput(JSON.stringify({ type: 'result', is_error: false, structured_output: { commits: [] }, total_cost_usd: 0.01, modelUsage: { 'claude-x': {} } }))).toEqual({
      json: { commits: [] },
      model: 'claude-x',
      usage: { costUsd: 0.01 },
    });
    expect(parseClaudeOutput(JSON.stringify({ is_error: false, result: '```json\n{"commits":[1]}\n```' })).json).toEqual({ commits: [1] });
    expect(() => parseClaudeOutput(JSON.stringify({ is_error: true, result: 'Not logged in' }))).toThrow(/Not logged in/);
    expect(() => parseClaudeOutput('Error: something')).toThrow(/other than JSON/);
  });
});

describe('Codex backend', () => {
  it('runs codex exec read-only, without user config, rules, saved session, web search or extra tools', () => {
    const args = codexArgs({ workDir: '/w', schemaFile: '/w/s.json', lastMessageFile: '/w/out.json', model: 'gpt-x' });
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe('exec');
    for (const flag of ['--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']) expect(args).toContain(flag);
    expect(value('--sandbox')).toBe('read-only');
    expect(value('--cd')).toBe('/w');
    expect(value('--output-schema')).toBe('/w/s.json');
    expect(value('--output-last-message')).toBe('/w/out.json');
    expect(value('--model')).toBe('gpt-x');
    expect(args).toEqual(expect.arrayContaining(['-c', 'approval_policy="never"', '-c', 'web_search="disabled"']));
    for (const feature of ['shell_tool', 'apps', 'plugins', 'computer_use', 'browser_use', 'multi_agent']) {
      expect(CODEX_DISABLED_FEATURES).toContain(feature);
      expect(args[args.indexOf(feature) - 1]).toBe('--disable');
    }
    // The prompt goes in on stdin; a trailing "-" is rejected by codex 0.160.
    expect(args).not.toContain('-');
  });

  it('builds a sandbox that allows writing only to the workspace and /dev, and denies reading contents under home and temp', () => {
    const profile = seatbeltProfile({ denyRead: ['/Users/ada', '/private/var/folders/x/T'], workspace: '/private/var/folders/x/T/eyrie-codex-1', readOnly: ['/Users/ada/.local/codex'] });
    expect(profile.split('\n')).toEqual([
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      '(allow file-write* (subpath "/dev"))',
      '(deny file-read-data (subpath "/Users/ada") (subpath "/private/var/folders/x/T"))',
      '(allow file-read-data (subpath "/Users/ada/.local/codex"))',
      // Later rules win, so the workspace is allowed last.
      '(allow file-read-data file-write* (subpath "/private/var/folders/x/T/eyrie-codex-1"))',
    ]);
    expect(seatbeltProfile({ denyRead: ['/a"b\\c'], workspace: '/w' })).toContain('(subpath "/a\\"b\\\\c")');
  });

  it('makes the analysis schema strict: closed objects, every property required, optional ones nullable', () => {
    const request = analysisRequest({ name: 'shop', frameworks: [] }, [], 1000);
    const strict = strictSchema(request.schema) as any;
    expect(strict.additionalProperties).toBe(false);
    const entry = strict.properties.commits.items;
    expect(entry.additionalProperties).toBe(false);
    expect(entry.required).toEqual(['hash', 'intent', 'matchesMessage', 'mismatch', 'risk', 'observations']);
    expect(entry.properties.mismatch.type).toEqual(['string', 'null']);
    expect(entry.properties.risk).toEqual({ type: 'string', enum: ['low', 'medium', 'high'] });
    expect(entry.properties.observations.items.additionalProperties).toBe(false);
    // The original is left as it was.
    expect((request.schema as any).properties.commits.items.required).not.toContain('mismatch');
  });

  it('reads the answer and usage from a run, and distrusts a run in which a command completed', () => {
    const events = [
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { type: 'command_execution', command: 'ls /', exit_code: 1, aggregated_output: 'sandbox_apply: Operation not permitted' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 4 } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    expect(parseCodexRun(events, '{"commits":[]}')).toEqual({ json: { commits: [] }, usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } });
    const ran = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'cat ~/.ssh/id_rsa', exit_code: 0 } });
    expect(() => parseCodexRun(ran, '{"commits":[]}')).toThrow(/ran a command/);
    expect(() => parseCodexRun(JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } }), '')).toThrow(/usage limit reached/);
    expect(() => parseCodexRun('', 'not json')).toThrow(/without the requested JSON/);
  });

  it('is offered on macOS only, where it can be sandboxed', () => {
    expect(() => createAiBackend('codex', { platform: 'linux' })).toThrow(/needs macOS/);
    expect(createAiBackend('codex', { platform: 'darwin' })?.name).toBe('codex');
    expect(createAiBackend('claude')?.name).toBe('claude-code');
    expect(createAiBackend('off')).toBeNull();
    expect(() => createAiBackend('gpt')).toThrow(/Unknown AI backend "gpt". Available: claude, codex/);
  });

  it('rejects model tool events and incomplete streams in answer-only runs', () => {
    const complete = JSON.stringify({ type: 'turn.completed' });
    const command = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 1 } });
    const warning = JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'nonfatal warning' } });
    expect(() => parseCodexRun(`${command}\n${complete}`, '{}', { answerOnly: true })).toThrow('attempted to use a tool');
    expect(() => parseCodexRun('', '{}', { answerOnly: true })).toThrow('did not complete');
    expect(parseCodexRun(`${warning}\n${complete}`, '{}', { answerOnly: true }).json).toEqual({});
  });
});
