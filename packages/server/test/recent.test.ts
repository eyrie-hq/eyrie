/**
 * A scripted agent session on bookstore-app: record the intent, edit, end
 * the task. The session's changed components match the graph diff exactly,
 * notes cite touched files or are rejected, and the session links to its
 * commit once one lands.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectKnowledge } from '@eyrie/knowledge';
import { GraphEngine } from '@eyrie/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openKnowledge } from '../src/launch.js';
import { EyrieMcp } from '../src/mcp.js';
import { recentSessions } from '../src/recent.js';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/bookstore-app', import.meta.url));
const EDITED = 'src/services/recommender.service.ts';
const ADDED = 'src/services/gift.service.ts';

function fixtureRepo(dir: string): { root: string; git: (...args: string[]) => string } {
  const root = join(dir, 'bookstore');
  cpSync(FIXTURE, root, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }) as string;
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Ada');
  git('config', 'user.email', 'ada@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: bookstore');
  return { root, git };
}

describe('recorded session', () => {
  let dir: string;
  let git: (...args: string[]) => string;
  let engine: GraphEngine;
  let knowledge: ProjectKnowledge;
  let mcp: EyrieMcp;
  let next = 1;
  let startSeq = 0;
  let editedId = '';
  let ended: Record<string, any>;

  /** A backend that notes the first component well and invents evidence for the second. */
  const backend = {
    name: 'scripted',
    run: async (request: { prompt: string }) => {
      const packet = JSON.parse(request.prompt.split('\n\n')[1]!) as { components: { id: string }[]; touchedFiles: string[] };
      return {
        json: {
          notes: [
            { component: packet.components[0]!.id, note: 'Serves the task.', files: [packet.touchedFiles[0]] },
            ...(packet.components[1] ? [{ component: packet.components[1]!.id, note: 'Serves it too.', files: ['src/invented.ts'] }] : []),
          ],
        },
        model: 'scripted-model',
      };
    },
  };

  const rpc = async (method: string, params?: Record<string, unknown>) => mcp.handle({ jsonrpc: '2.0', id: next++, method, params });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    const result = (res as unknown as { result: { content: { text: string }[]; isError?: boolean } }).result;
    return { body: JSON.parse(result.content[0]!.text) as Record<string, any>, isError: !!result.isError };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eyrie-recent-'));
    const repo = fixtureRepo(dir);
    git = repo.git;
    engine = new GraphEngine({ root: repo.root, dataDir: join(dir, 'data'), watch: false });
    await engine.start();
    knowledge = await openKnowledge(engine, { watch: false });
    mcp = new EyrieMcp({ engine, ready: Promise.resolve({ knowledge }), version: '9.9.9', ai: backend });
    await rpc('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'claude-code', version: '1' } });
    editedId = engine.architecture.nodes.find((n) => n.files.includes(EDITED))!.id;

    const started = await call('record_intent', { task: 'Add gift wrapping' });
    expect(started.body.status).toBe('started');
    startSeq = engine.seq;

    writeFileSync(join(repo.root, ADDED), "export class GiftService {\n  wrap(): string {\n    return 'wrapped';\n  }\n}\n");
    appendFileSync(join(repo.root, EDITED), "\nexport function giftNote(): string {\n  return 'gift';\n}\n");
    engine.enqueue(ADDED, 'add');
    engine.enqueue(EDITED, 'change');
    await engine.idle();

    ended = (await call('record_intent', { done: true, summary: 'Gift wrapping added.' })).body;
  });

  afterAll(async () => {
    mcp.dispose();
    await knowledge.close();
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('attributes the session to the agent behind the MCP client', () => {
    expect(ended).toMatchObject({ agent: 'Claude', task: 'Add gift wrapping', summary: 'Gift wrapping added.', status: 'ended' });
    expect(knowledge.store.sessions(5).find((s) => s.id === ended.session)).toMatchObject({ agent: 'Claude', startSeq });
  });

  it('matches the graph diff exactly', async () => {
    const changes = ended.changes as { files: { file: string; change: string }[]; added: { id: string }[]; changed: { id: string }[]; removed: { id: string }[] };
    expect(changes.files).toEqual([
      { file: ADDED, change: 'add' },
      { file: EDITED, change: 'change' },
    ]);
    expect(changes.added).toHaveLength(1);
    expect(changes.added[0]!.id).not.toBe(editedId);
    expect(changes.changed.map((c) => c.id)).toEqual([editedId]);
    expect(changes.removed).toEqual([]);

    // The same window through recent_changes nets to the same sets.
    const window = (await call('recent_changes', { since: startSeq })).body.changes as {
      componentsAdded: { id: string }[];
      componentsChanged: { id: string }[];
      componentsRemoved: { id: string }[];
    }[];
    const net = { added: new Set<string>(), changed: new Set<string>(), removed: new Set<string>() };
    for (const record of window) {
      for (const n of record.componentsAdded) {
        net.added.add(n.id);
        net.changed.delete(n.id);
        net.removed.delete(n.id);
      }
      for (const n of record.componentsChanged) {
        if (!net.added.has(n.id) && !net.removed.has(n.id)) net.changed.add(n.id);
      }
      for (const n of record.componentsRemoved) {
        net.removed.add(n.id);
        net.added.delete(n.id);
        net.changed.delete(n.id);
      }
    }
    expect(new Set(changes.added.map((c) => c.id))).toEqual(net.added);
    expect(new Set(changes.changed.map((c) => c.id))).toEqual(net.changed);
    expect(new Set(changes.removed.map((c) => c.id))).toEqual(net.removed);
  });

  it('stores grounded notes and rejects the invented one', () => {
    expect(ended.notes).toHaveLength(2);
    expect(ended.notes[0]).toMatchObject({ status: 'ok', note: 'Serves the task.', files: [ADDED] });
    expect(ended.notes[1]).toMatchObject({ status: 'rejected', error: expect.stringContaining('src/invented.ts') });
    const stored = knowledge.store.sessionNotes([ended.session as number]);
    expect(stored.map((n) => ({ component: n.component, status: n.status, backend: n.backend, model: n.model }))).toEqual([
      { component: ended.notes[0].component, status: 'ok', backend: 'scripted', model: 'scripted-model' },
      { component: ended.notes[1].component, status: 'rejected', backend: 'scripted', model: 'scripted-model' },
    ]);
  });

  it('links the session to its commit once one lands', async () => {
    expect(recentSessions(knowledge).sessions.find((s) => s.id === ended.session)?.commit).toBeNull();
    git('add', '-A');
    git('commit', '-q', '-m', 'feat: gift wrapping', '-m', 'Co-Authored-By: Claude <noreply@anthropic.com>');
    const head = git('rev-parse', 'HEAD').trim();
    await knowledge.record();
    const linked = recentSessions(knowledge).sessions.find((s) => s.id === ended.session);
    expect(linked?.commit).toMatchObject({ hash: head, subject: 'feat: gift wrapping' });
  });

  it('ends the open session when a new task starts, and refuses to end nothing', async () => {
    const second = await call('record_intent', { task: 'Wrap the wrap' });
    expect(second.body.status).toBe('started');
    const third = await call('record_intent', { task: 'Unwrap' });
    expect(third.body.status).toBe('started');
    const auto = knowledge.store.sessions(5).find((s) => s.id === (second.body.session as number));
    expect(auto?.endedAt).not.toBeNull();
    expect(auto?.summary).toBeNull();
    await call('record_intent', { done: true });
    const nothing = await call('record_intent', { done: true });
    expect(nothing.isError).toBe(true);
    expect(nothing.body.error).toContain('No open session');
    expect(recentSessions(null)).toEqual({ sessions: [] });
  });
});
