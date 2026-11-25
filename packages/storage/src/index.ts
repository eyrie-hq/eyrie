import { createHash, type Hash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CodeDiff, CodeEdge, CodeNode, FileFacts } from '@eyrie/core';

// node:sqlite prints an ExperimentalWarning on load; it is stable enough for a local cache.
// Loaded with getBuiltinModule (not a top-level await) so this module also
// bundles to CommonJS: the desktop app's single-executable `eyrie` command is
// a CJS snapshot, where neither await nor import.meta exists.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite')) return;
  return (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
process.emitWarning = emitWarning;

type Database = InstanceType<typeof DatabaseSync>;

/** Bump when the schema changes; old databases are rebuilt. */
const SCHEMA_VERSION = '1';

const NODES_TABLE = `CREATE TABLE IF NOT EXISTS nodes (
  id TEXT NOT NULL, repo_id TEXT NOT NULL, file TEXT, kind TEXT NOT NULL, name TEXT NOT NULL,
  qualified_name TEXT NOT NULL, start_line INTEGER, end_line INTEGER, data TEXT NOT NULL,
  PRIMARY KEY (repo_id, id)
)`;
const EDGES_TABLE = `CREATE TABLE IF NOT EXISTS edges (
  id TEXT NOT NULL, repo_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
  kind TEXT NOT NULL, confidence REAL NOT NULL, owner TEXT, data TEXT NOT NULL,
  PRIMARY KEY (repo_id, id)
)`;
const GRAPH_INDEXES = `
  CREATE INDEX IF NOT EXISTS nodes_file ON nodes (repo_id, file);
  CREATE INDEX IF NOT EXISTS edges_source ON edges (repo_id, source_id);
  CREATE INDEX IF NOT EXISTS edges_target ON edges (repo_id, target_id);
`;
/** `meta` key of the digest of the graph rows a repository has stored. */
const graphDigestKey = (repoId: string) => `graph_digest:${repoId}`;

export interface CachedFile {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  facts: FileFacts;
}

/**
 * SQLite persistence: a facts cache (so restarts skip unchanged files) and
 * the code graph's nodes and edges (so other tools can query it).
 */
export class GraphStorage {
  private constructor(private readonly db: Database) {}

  static open(path: string, opts: { factsVersion: string }): GraphStorage {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    // Several engines share one cache (the app's, one per agent's MCP server):
    // a writer that meets another waits instead of failing at once.
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    const storage = new GraphStorage(db);
    storage.migrate(opts.factsVersion);
    return storage;
  }

  private migrate(factsVersion: string): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const schema = this.getMeta('schema_version');
    if (schema !== SCHEMA_VERSION) {
      this.db.exec('DROP TABLE IF EXISTS repositories; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS snapshots;');
      this.db.exec("DELETE FROM meta WHERE key LIKE 'graph_digest:%'");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        repo_id TEXT NOT NULL, path TEXT NOT NULL, language TEXT, hash TEXT NOT NULL,
        size INTEGER, mtime INTEGER, last_parsed INTEGER, facts TEXT NOT NULL,
        PRIMARY KEY (repo_id, path)
      );
      ${NODES_TABLE};
      ${EDGES_TABLE};
      ${GRAPH_INDEXES}
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL, commit_hash TEXT,
        created_at INTEGER NOT NULL, metadata TEXT
      );
    `);
    this.setMeta('schema_version', SCHEMA_VERSION);
    if (this.getMeta('facts_version') !== factsVersion) {
      this.db.exec('DELETE FROM files');
      this.setMeta('facts_version', factsVersion);
    }
  }

  private getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  upsertRepository(id: string, name: string, rootPath: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO repositories (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path, updated_at = excluded.updated_at`,
      )
      .run(id, name, rootPath, now, now);
  }

  loadFiles(repoId: string): Map<string, CachedFile> {
    const rows = this.db.prepare('SELECT path, hash, size, mtime, facts FROM files WHERE repo_id = ?').all(repoId) as {
      path: string;
      hash: string;
      size: number;
      mtime: number;
      facts: string;
    }[];
    const out = new Map<string, CachedFile>();
    for (const r of rows) out.set(r.path, { path: r.path, hash: r.hash, size: r.size, mtimeMs: r.mtime, facts: JSON.parse(r.facts) as FileFacts });
    return out;
  }

  saveFiles(repoId: string, files: CachedFile[], removed: string[] = []): void {
    if (!files.length && !removed.length) return;
    const upsert = this.db.prepare(
      `INSERT INTO files (repo_id, path, language, hash, size, mtime, last_parsed, facts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, path) DO UPDATE SET language = excluded.language, hash = excluded.hash, size = excluded.size,
       mtime = excluded.mtime, last_parsed = excluded.last_parsed, facts = excluded.facts`,
    );
    const del = this.db.prepare('DELETE FROM files WHERE repo_id = ? AND path = ?');
    const now = Date.now();
    this.transaction(() => {
      for (const f of files) upsert.run(repoId, f.path, f.facts.language, f.hash, f.size, Math.round(f.mtimeMs), now, JSON.stringify(f.facts));
      for (const p of removed) del.run(repoId, p);
    });
  }

  /**
   * Replaces the stored graph (after a full build). Returns false, writing
   * nothing, when the stored rows are already exactly these: a restart of an
   * unchanged repository then costs a digest instead of a rewrite.
   */
  replaceGraph(repoId: string, nodes: Iterable<CodeNode>, edges: Iterable<CodeEdge>): boolean {
    const nodeList = [...nodes];
    const edgeList = [...edges];
    const key = graphDigestKey(repoId);
    const stored = this.getMeta(key);
    // Hashing costs a serialisation of every row, so it runs up front only when a skip is
    // possible. The counts also catch rows changed by an older Eyrie sharing this cache,
    // which does not clear the digest.
    const unchanged = stored !== undefined && this.countRows('nodes', repoId) === nodeList.length && this.countRows('edges', repoId) === edgeList.length && graphDigest(repoId, nodeList, edgeList) === stored;
    if (unchanged) return false;
    this.transaction(() => {
      // Bulk load when no other repository shares the tables: empty tables with no indexes
      // to maintain row by row, then one index build each.
      const bulk = this.holdsOnlyGraphOf(repoId);
      if (bulk) this.db.exec(`DROP TABLE nodes; DROP TABLE edges; ${NODES_TABLE}; ${EDGES_TABLE};`);
      else {
        this.db.prepare('DELETE FROM nodes WHERE repo_id = ?').run(repoId);
        this.db.prepare('DELETE FROM edges WHERE repo_id = ?').run(repoId);
      }
      // The digest is taken from the very strings written, in the same pass.
      const digest = startDigest(repoId);
      this.insertNodes(repoId, nodeList, digest);
      digest.update('\0');
      this.insertEdges(repoId, edgeList, digest);
      if (bulk) this.db.exec(GRAPH_INDEXES);
      this.setMeta(key, digest.digest('hex'));
    });
    return true;
  }

  /** True when no other repository has graph rows in this database (the usual case: one database per repository). */
  private holdsOnlyGraphOf(repoId: string): boolean {
    const other = (table: string) => this.db.prepare(`SELECT 1 FROM ${table} WHERE repo_id <> ? LIMIT 1`).get(repoId) !== undefined;
    return !other('nodes') && !other('edges');
  }

  applyDiff(repoId: string, diff: CodeDiff): void {
    this.transaction(() => {
      // The stored rows no longer match the digest of the last full write.
      this.db.prepare('DELETE FROM meta WHERE key = ?').run(graphDigestKey(repoId));
      const delNode = this.db.prepare('DELETE FROM nodes WHERE repo_id = ? AND id = ?');
      const delEdge = this.db.prepare('DELETE FROM edges WHERE repo_id = ? AND id = ?');
      for (const id of diff.removedEdges) delEdge.run(repoId, id);
      for (const id of diff.removedNodes) delNode.run(repoId, id);
      this.writeNodes(repoId, [...diff.addedNodes, ...diff.updatedNodes]);
      this.writeEdges(repoId, [...diff.addedEdges, ...diff.updatedEdges]);
    });
  }

  recordSnapshot(repoId: string, commitHash: string | null, metadata: unknown): void {
    this.db.prepare('INSERT INTO snapshots (repo_id, commit_hash, created_at, metadata) VALUES (?, ?, ?, ?)').run(repoId, commitHash, Date.now(), JSON.stringify(metadata));
  }

  counts(repoId: string): { files: number; nodes: number; edges: number } {
    return { files: this.countRows('files', repoId), nodes: this.countRows('nodes', repoId), edges: this.countRows('edges', repoId) };
  }

  private countRows(table: 'files' | 'nodes' | 'edges', repoId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repo_id = ?`).get(repoId) as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }

  /** Plain inserts (replaceGraph has just removed the repository's rows), adding each row to `digest`. */
  private insertNodes(repoId: string, nodes: CodeNode[], digest: Hash): void {
    const stmt = this.db.prepare('INSERT INTO nodes (id, repo_id, file, kind, name, qualified_name, start_line, end_line, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const n of nodes) {
      const data = JSON.stringify(n);
      digest.update(data).update('\n');
      stmt.run(n.id, repoId, n.file ?? null, n.kind, n.name, n.qualifiedName, n.range?.start ?? null, n.range?.end ?? null, data);
    }
  }

  private insertEdges(repoId: string, edges: CodeEdge[], digest: Hash): void {
    const stmt = this.db.prepare('INSERT INTO edges (id, repo_id, source_id, target_id, kind, confidence, owner, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const e of edges) {
      const data = JSON.stringify(e);
      digest.update(data).update('\n');
      stmt.run(e.id, repoId, e.source, e.target, e.kind, e.confidence, e.owner ?? null, data);
    }
  }

  private writeNodes(repoId: string, nodes: Iterable<CodeNode>): void {
    const stmt = this.db.prepare(
      `INSERT INTO nodes (id, repo_id, file, kind, name, qualified_name, start_line, end_line, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, id) DO UPDATE SET file = excluded.file, kind = excluded.kind, name = excluded.name,
       qualified_name = excluded.qualified_name, start_line = excluded.start_line, end_line = excluded.end_line, data = excluded.data`,
    );
    for (const n of nodes) stmt.run(n.id, repoId, n.file ?? null, n.kind, n.name, n.qualifiedName, n.range?.start ?? null, n.range?.end ?? null, JSON.stringify(n));
  }

  private writeEdges(repoId: string, edges: Iterable<CodeEdge>): void {
    const stmt = this.db.prepare(
      `INSERT INTO edges (id, repo_id, source_id, target_id, kind, confidence, owner, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, id) DO UPDATE SET source_id = excluded.source_id, target_id = excluded.target_id, kind = excluded.kind,
       confidence = excluded.confidence, owner = excluded.owner, data = excluded.data`,
    );
    for (const e of edges) stmt.run(e.id, repoId, e.source, e.target, e.kind, e.confidence, e.owner ?? null, JSON.stringify(e));
  }
}

const startDigest = (repoId: string): Hash => createHash('sha256').update(repoId).update('\0');

/**
 * Digest of the rows replaceGraph would write, the same as the one it takes
 * while writing them. Every column is derived from the serialised node or
 * edge, so hashing that text covers the whole row; the order is the graph's
 * own, which a deterministic build keeps.
 */
function graphDigest(repoId: string, nodes: CodeNode[], edges: CodeEdge[]): string {
  const h = startDigest(repoId);
  for (const n of nodes) h.update(JSON.stringify(n)).update('\n');
  h.update('\0');
  for (const e of edges) h.update(JSON.stringify(e)).update('\n');
  return h.digest('hex');
}
