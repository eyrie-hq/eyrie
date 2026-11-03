import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProjectStore } from '../src/projects.js';
import type { IndexSummary } from '../src/protocol.js';

const dir = mkdtempSync(join(tmpdir(), 'eyrie-projects-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function folder(name: string): string {
  const path = join(dir, `${n++}`, name);
  mkdirSync(path, { recursive: true });
  return path;
}
const listFile = () => join(dir, `list-${n++}`, 'projects.json');

const summary: IndexSummary = {
  repo: { name: 'bookstore-app', root: '/x', frameworks: ['next', 'prisma'] },
  stats: { files: 12, symbols: 80, nodes: 120, edges: 200, archNodes: 9, archEdges: 14, parseMs: 30, buildMs: 5 },
  ms: 412,
};

describe('ProjectStore', () => {
  it('adds a folder once, named after it, and keeps it across restarts', () => {
    const file = listFile();
    const repo = folder('shop');
    const store = new ProjectStore(file);
    const first = store.add(repo, 1000);
    expect(first.added).toBe(true);
    expect(first.project).toMatchObject({ root: repo, name: 'shop', addedAt: 1000 });
    expect(store.add(`${repo}/./`).added).toBe(false);

    const again = new ProjectStore(file);
    expect(again.list()).toEqual([first.project]);
  });

  it('rejects paths that are not folders', () => {
    const store = new ProjectStore(listFile());
    const file = join(folder('x'), 'file.txt');
    writeFileSync(file, '');
    expect(() => store.add(file)).toThrow(/Not a folder/);
    expect(() => store.add(join(dir, 'missing'))).toThrow(/Not a folder/);
    expect(store.list()).toEqual([]);
  });

  it('lists the most recently opened first, then the most recently added', () => {
    const store = new ProjectStore(listFile());
    const a = store.add(folder('a'), 1).project;
    const b = store.add(folder('b'), 2).project;
    const c = store.add(folder('c'), 3).project;
    expect(store.list().map((p) => p.name)).toEqual(['c', 'b', 'a']);
    store.markOpened(a.id, 10);
    expect(store.list().map((p) => p.id)).toEqual([a.id, c.id, b.id]);
  });

  it('records what an index found, and clears an earlier error', () => {
    const file = listFile();
    const store = new ProjectStore(file);
    const { project } = store.add(folder('shop'));
    store.recordError(project.id, 'boom');
    expect(store.get(project.id)?.error).toBe('boom');

    store.recordIndex(project.id, summary, 5000);
    const saved = new ProjectStore(file).get(project.id)!;
    expect(saved.error).toBeUndefined();
    expect('error' in saved).toBe(false);
    expect(saved.name).toBe('bookstore-app');
    expect(saved.scan).toEqual({ at: 5000, ms: 412, files: 12, symbols: 80, components: 9, links: 14, frameworks: ['next', 'prisma'] });
  });

  it('asks about agents once per project', () => {
    const file = listFile();
    const store = new ProjectStore(file);
    const { project } = store.add(folder('shop'));
    expect(project.agentsPromptedAt).toBeUndefined();
    store.markAgentsPrompted(project.id, 7000);
    expect(new ProjectStore(file).get(project.id)?.agentsPromptedAt).toBe(7000);
  });

  it('removes a project from the list only', () => {
    const store = new ProjectStore(listFile());
    const repo = folder('shop');
    const { project } = store.add(repo);
    expect(store.remove(project.id)).toBe(true);
    expect(store.remove(project.id)).toBe(false);
    expect(store.list()).toEqual([]);
    expect(store.add(repo).added).toBe(true);
  });

  it('starts empty from a damaged file, and drops entries it cannot use', () => {
    const broken = listFile();
    mkdirSync(join(broken, '..'), { recursive: true });
    writeFileSync(broken, '{ not json');
    expect(new ProjectStore(broken).list()).toEqual([]);

    const partial = listFile();
    mkdirSync(join(partial, '..'), { recursive: true });
    const good = { id: 'p1', root: '/repo', name: 'repo', addedAt: 1 };
    writeFileSync(partial, JSON.stringify({ version: 1, projects: [good, { id: 'p2' }, null, 'x'] }));
    expect(new ProjectStore(partial).list()).toEqual([good]);
  });

  it('writes the list as versioned JSON', () => {
    const file = listFile();
    const store = new ProjectStore(file);
    store.add(folder('shop'));
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.version).toBe(1);
    expect(written.projects).toHaveLength(1);
  });
});
