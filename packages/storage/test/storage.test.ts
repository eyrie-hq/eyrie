import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodeEdge, CodeNode, FileFacts } from '@eyrie/core';
import { GraphStorage, type CachedFile } from '../src/index.js';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

function facts(path: string, hash: string): FileFacts {
  return { path, language: 'typescript', hash, loc: 1, directives: [], imports: [], exports: [], symbols: [], references: [], routes: [], parseErrors: 0 };
}

function cached(path: string, hash: string): CachedFile {
  return { path, hash, size: 10, mtimeMs: 1_000.4, facts: facts(path, hash) };
}

const node = (id: string): CodeNode => ({ id, key: `file:${id}`, kind: 'file', name: id, qualifiedName: id, file: id });
const edge = (id: string, source: string, target: string): CodeEdge => ({ id, kind: 'IMPORTS', source, target, confidence: 1, owner: source });

describe('GraphStorage', () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eyrie-storage-'));
    db = join(dir, 'nested', 'graph.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the database folder and round-trips the facts cache', () => {
    const s = GraphStorage.open(db, { factsVersion: '1' });
    s.saveFiles('repo', [cached('src/a.ts', 'h1'), cached('src/b.ts', 'h2')]);
    const files = s.loadFiles('repo');
    expect([...files.keys()].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(files.get('src/a.ts')).toMatchObject({ hash: 'h1', size: 10, mtimeMs: 1000, facts: facts('src/a.ts', 'h1') });
    s.close();
  });

  it('updates and removes cached files', () => {
    const s = GraphStorage.open(db, { factsVersion: '1' });
    s.saveFiles('repo', [cached('src/a.ts', 'h1'), cached('src/b.ts', 'h2')]);
    s.saveFiles('repo', [cached('src/a.ts', 'h3')], ['src/b.ts']);
    const files = s.loadFiles('repo');
    expect([...files.keys()]).toEqual(['src/a.ts']);
    expect(files.get('src/a.ts')?.hash).toBe('h3');
    s.close();
  });

  it('keeps each repository separate', () => {
    const s = GraphStorage.open(db, { factsVersion: '1' });
    s.saveFiles('one', [cached('src/a.ts', 'h1')]);
    s.saveFiles('two', [cached('src/z.ts', 'h9')]);
    expect([...s.loadFiles('one').keys()]).toEqual(['src/a.ts']);
    expect([...s.loadFiles('two').keys()]).toEqual(['src/z.ts']);
    s.close();
  });

  it('keeps the cache across restarts while the facts version is unchanged', () => {
    const first = GraphStorage.open(db, { factsVersion: '1' });
    first.saveFiles('repo', [cached('src/a.ts', 'h1')]);
    first.close();
    const second = GraphStorage.open(db, { factsVersion: '1' });
    expect(second.loadFiles('repo').size).toBe(1);
    second.close();
  });

  it('drops cached facts when the facts version changes, but keeps the graph', () => {
    const first = GraphStorage.open(db, { factsVersion: '1' });
    first.saveFiles('repo', [cached('src/a.ts', 'h1')]);
    first.replaceGraph('repo', [node('a')], []);
    first.close();
    const second = GraphStorage.open(db, { factsVersion: '2' });
    expect(second.loadFiles('repo').size).toBe(0);
    expect(second.counts('repo')).toEqual({ files: 0, nodes: 1, edges: 0 });
    second.close();
    // The new version is now the stored one: reopening with it keeps what is saved next.
    const third = GraphStorage.open(db, { factsVersion: '2' });
    third.saveFiles('repo', [cached('src/a.ts', 'h1')]);
    third.close();
    const fourth = GraphStorage.open(db, { factsVersion: '2' });
    expect(fourth.loadFiles('repo').size).toBe(1);
    fourth.close();
  });

  it('replaces the graph and applies diffs to it', () => {
    const s = GraphStorage.open(':memory:', { factsVersion: '1' });
    s.replaceGraph('repo', [node('a'), node('b'), node('c')], [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')]);
    expect(s.counts('repo')).toEqual({ files: 0, nodes: 3, edges: 2 });
    s.applyDiff('repo', {
      addedNodes: [node('d')],
      updatedNodes: [{ ...node('a'), name: 'renamed' }],
      removedNodes: ['c'],
      addedEdges: [edge('ad', 'a', 'd')],
      updatedEdges: [],
      removedEdges: ['bc'],
    });
    expect(s.counts('repo')).toEqual({ files: 0, nodes: 3, edges: 2 });
    s.replaceGraph('repo', [node('x')], []);
    expect(s.counts('repo')).toEqual({ files: 0, nodes: 1, edges: 0 });
    s.close();
  });

  it('writes an unchanged graph only once', () => {
    const s = GraphStorage.open(db, { factsVersion: '1' });
    const nodes = [node('a'), node('b')];
    const edges = [edge('ab', 'a', 'b')];
    expect(s.replaceGraph('repo', nodes, edges)).toBe(true);
    expect(s.replaceGraph('repo', nodes, edges)).toBe(false);
    s.close();
    // The digest survives a restart, like the graph it describes.
    const again = GraphStorage.open(db, { factsVersion: '1' });
    expect(again.replaceGraph('repo', nodes, edges)).toBe(false);
    // Any change to a row is a rewrite.
    expect(again.replaceGraph('repo', nodes, [{ ...edge('ab', 'a', 'b'), confidence: 0.5 }])).toBe(true);
    expect(rows(db, 'edges')).toEqual([['ab', 'repo', 0.5]]);
    again.close();
  });

  it('rewrites after a diff, and when the stored rows were changed behind its back', () => {
    const s = GraphStorage.open(db, { factsVersion: '1' });
    const nodes = [node('a'), node('b')];
    s.replaceGraph('repo', nodes, []);
    s.applyDiff('repo', { addedNodes: [node('c')], updatedNodes: [], removedNodes: [], addedEdges: [], updatedEdges: [], removedEdges: [] });
    expect(s.replaceGraph('repo', nodes, [])).toBe(true);
    expect(s.counts('repo').nodes).toBe(2);
    s.close();
    // An older Eyrie sharing the cache applies diffs without clearing the digest.
    const other = new DatabaseSync(db);
    other.exec("DELETE FROM nodes WHERE id = 'b'");
    other.close();
    const again = GraphStorage.open(db, { factsVersion: '1' });
    expect(again.replaceGraph('repo', nodes, [])).toBe(true);
    expect(again.counts('repo').nodes).toBe(2);
    again.close();
  });

  it('bulk-loads a graph with its indexes, and leaves other repositories alone', () => {
    const s = GraphStorage.open(db, { factsVersion: '1' });
    s.replaceGraph('one', [node('a'), node('b')], [edge('ab', 'a', 'b')]);
    s.replaceGraph('two', [node('z')], []);
    s.replaceGraph('one', [node('a')], []);
    expect(s.counts('one')).toEqual({ files: 0, nodes: 1, edges: 0 });
    expect(s.counts('two')).toEqual({ files: 0, nodes: 1, edges: 0 });
    s.close();
    const raw = new DatabaseSync(db);
    const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    raw.close();
    expect(indexes.map((r) => r.name)).toEqual(['edges_source', 'edges_target', 'nodes_file']);
  });
});

/** A table's rows as `[id, repo_id, confidence]` (edges) or `[id, repo_id, kind]` (nodes), read without GraphStorage. */
function rows(path: string, table: 'nodes' | 'edges'): unknown[][] {
  const raw = new DatabaseSync(path);
  const third = table === 'edges' ? 'confidence' : 'kind';
  const out = raw.prepare(`SELECT id, repo_id, ${third} AS third FROM ${table} ORDER BY id`).all().map((r) => [r.id, r.repo_id, r.third]);
  raw.close();
  return out;
}
