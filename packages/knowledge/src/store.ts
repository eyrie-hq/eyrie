/**
 * knowledge.db: what Eyrie has learned about a project and must keep. Unlike
 * graph.db, which is a disposable parse cache, nothing here can be rebuilt
 * from the code alone (AI notes cost money, history can be rewritten), so
 * migrations only ever add.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AskAnswer, AskStatus, AskToolCall } from './ask.js';
import type { CommitFile } from './git.js';

// node:sqlite prints an ExperimentalWarning on load; silence it the same way @eyrie/storage does.
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

/** A component as it was when a commit was recorded: ids are stable, but labels and lanes can change later. */
export interface ComponentRef {
  id: string;
  label: string;
  kind: string;
  lane: string;
  category: string;
}

export interface CommitRecord {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: number;
  committedAt: number;
  subject: string;
  body: string;
  /** Coding agents named as author or co-author. */
  agents: string[];
  files: CommitFile[];
  /** Architecture components that own the changed files, as the graph stood when the commit was recorded. */
  components: ComponentRef[];
  recordedAt: number;
}

export type AnalysisStatus = 'ok' | 'failed' | 'rejected';

/** An AI note on one commit. Never a finding: it explains, it decides nothing. */
export interface CommitNote {
  intent: string;
  matchesMessage: 'yes' | 'partly' | 'no' | 'unclear';
  mismatch?: string;
  risk: 'low' | 'medium' | 'high';
  observations: { text: string; evidence: string[] }[];
}

export interface AnalysisRecord {
  id: number;
  commitHash: string;
  backend: string;
  model: string | null;
  /** Hash of everything sent, so a note is reused only for identical input. */
  inputHash: string;
  createdAt: number;
  status: AnalysisStatus;
  note: CommitNote | null;
  error: string | null;
  usage: Record<string, unknown> | null;
}

export interface AskRecord {
  id: number;
  question: string;
  backend: string;
  model: string | null;
  createdAt: number;
  status: AskStatus;
  answer: AskAnswer | null;
  calls: AskToolCall[];
  error: string | null;
  usage: Record<string, unknown> | null;
}

/** A component as a session saw it: ids are stable, but a removed component's labels are the last seen. */
export interface SessionComponent {
  id: string;
  label: string;
  kind: string;
  lane: string;
}

export interface SessionLink {
  source: string;
  target: string;
  from: string;
  to: string;
  kinds: string[];
}

/** The `recent_changes` window of a session, aggregated at its end. */
export interface SessionChanges {
  files: { file: string; change: string }[];
  added: SessionComponent[];
  changed: SessionComponent[];
  removed: SessionComponent[];
  linksAdded: SessionLink[];
  linksRemoved: SessionLink[];
}

export interface SessionRecord {
  id: number;
  task: string;
  summary: string | null;
  /** Canonical agent name from the MCP client info, e.g. `Claude`. */
  agent: string;
  startedAt: number;
  endedAt: number | null;
  startSeq: number;
  endSeq: number | null;
  changes: SessionChanges;
}

export type SessionNoteStatus = 'ok' | 'failed' | 'rejected';

/** An AI note on one changed component: how the change serves the session's task. A note explains; it never becomes a fact. */
export interface SessionNote {
  id: number;
  sessionId: number;
  component: string;
  label: string;
  backend: string;
  model: string | null;
  createdAt: number;
  status: SessionNoteStatus;
  note: string | null;
  /** Touched files the note cites. */
  files: string[];
  error: string | null;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE commits (
     hash TEXT PRIMARY KEY,
     parents TEXT NOT NULL,
     author_name TEXT NOT NULL,
     author_email TEXT NOT NULL,
     authored_at INTEGER NOT NULL,
     committed_at INTEGER NOT NULL,
     subject TEXT NOT NULL,
     body TEXT NOT NULL,
     agents TEXT NOT NULL,
     files TEXT NOT NULL,
     components TEXT NOT NULL,
     recorded_at INTEGER NOT NULL
   );
   CREATE INDEX commits_committed_at ON commits (committed_at DESC);
   CREATE TABLE analyses (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     commit_hash TEXT NOT NULL REFERENCES commits (hash),
     backend TEXT NOT NULL,
     model TEXT,
     input_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     status TEXT NOT NULL,
     note TEXT,
     error TEXT,
     usage TEXT
   );
   CREATE INDEX analyses_commit ON analyses (commit_hash, created_at DESC);
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `CREATE TABLE ask_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    backend TEXT NOT NULL,
    model TEXT,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    answer TEXT,
    calls TEXT NOT NULL,
    error TEXT,
    usage TEXT
  );
  CREATE INDEX ask_history_created ON ask_history (created_at DESC);`,
  `CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    summary TEXT,
    agent TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    start_seq INTEGER NOT NULL,
    end_seq INTEGER,
    changes TEXT NOT NULL
  );
  CREATE INDEX sessions_started ON sessions (started_at DESC, id DESC);
  CREATE TABLE session_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions (id),
    component TEXT NOT NULL,
    label TEXT NOT NULL,
    backend TEXT NOT NULL,
    model TEXT,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    files TEXT NOT NULL,
    error TEXT
  );
  CREATE INDEX session_notes_session ON session_notes (session_id);`,
];

interface CommitRow {
  hash: string;
  parents: string;
  author_name: string;
  author_email: string;
  authored_at: number;
  committed_at: number;
  subject: string;
  body: string;
  agents: string;
  files: string;
  components: string;
  recorded_at: number;
}

interface AskRow {
  id: number;
  question: string;
  backend: string;
  model: string | null;
  created_at: number;
  status: AskStatus;
  answer: string | null;
  calls: string;
  error: string | null;
  usage: string | null;
}

interface SessionRow {
  id: number;
  task: string;
  summary: string | null;
  agent: string;
  started_at: number;
  ended_at: number | null;
  start_seq: number;
  end_seq: number | null;
  changes: string;
}

interface SessionNoteRow {
  id: number;
  session_id: number;
  component: string;
  label: string;
  backend: string;
  model: string | null;
  created_at: number;
  status: SessionNoteStatus;
  note: string | null;
  files: string;
  error: string | null;
}

export const EMPTY_CHANGES: SessionChanges = { files: [], added: [], changed: [], removed: [], linksAdded: [], linksRemoved: [] };

interface AnalysisRow {
  id: number;
  commit_hash: string;
  backend: string;
  model: string | null;
  input_hash: string;
  created_at: number;
  status: AnalysisStatus;
  note: string | null;
  error: string | null;
  usage: string | null;
}

const toSession = (r: SessionRow): SessionRecord => ({
  id: r.id,
  task: r.task,
  summary: r.summary,
  agent: r.agent,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  startSeq: r.start_seq,
  endSeq: r.end_seq,
  changes: JSON.parse(r.changes) as SessionChanges,
});

const toCommit = (r: CommitRow): CommitRecord => ({
  hash: r.hash,
  parents: r.parents ? r.parents.split(' ') : [],
  authorName: r.author_name,
  authorEmail: r.author_email,
  authoredAt: r.authored_at,
  committedAt: r.committed_at,
  subject: r.subject,
  body: r.body,
  agents: JSON.parse(r.agents) as string[],
  files: JSON.parse(r.files) as CommitFile[],
  components: JSON.parse(r.components) as ComponentRef[],
  recordedAt: r.recorded_at,
});

const toAnalysis = (r: AnalysisRow): AnalysisRecord => ({
  id: r.id,
  commitHash: r.commit_hash,
  backend: r.backend,
  model: r.model,
  inputHash: r.input_hash,
  createdAt: r.created_at,
  status: r.status,
  note: r.note ? (JSON.parse(r.note) as CommitNote) : null,
  error: r.error,
  usage: r.usage ? (JSON.parse(r.usage) as Record<string, unknown>) : null,
});

export class KnowledgeStore {
  private constructor(private readonly db: Database) {}

  static open(path: string): KnowledgeStore {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const store = new KnowledgeStore(db);
    store.migrate();
    return store;
  }

  /** Applies the migrations this database has not seen, in order, each in its own transaction. */
  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[i]!);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  knownHashes(hashes: string[]): Set<string> {
    const known = new Set<string>();
    const stmt = this.db.prepare('SELECT 1 FROM commits WHERE hash = ?');
    for (const hash of hashes) if (stmt.get(hash)) known.add(hash);
    return known;
  }

  addCommits(commits: CommitRecord[]): void {
    if (!commits.length) return;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO commits (hash, parents, author_name, author_email, authored_at, committed_at, subject, body, agents, files, components, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const c of commits) {
        stmt.run(c.hash, c.parents.join(' '), c.authorName, c.authorEmail, c.authoredAt, c.committedAt, c.subject, c.body, JSON.stringify(c.agents), JSON.stringify(c.files), JSON.stringify(c.components), c.recordedAt);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  commit(hash: string): CommitRecord | null {
    const row = this.db.prepare('SELECT * FROM commits WHERE hash = ? OR hash LIKE ?').get(hash, `${hash}%`) as CommitRow | undefined;
    return row ? toCommit(row) : null;
  }

  /** Newest first by commit time. */
  commits(opts: { limit?: number; agent?: string; component?: string } = {}): CommitRecord[] {
    const rows = this.db.prepare('SELECT * FROM commits ORDER BY committed_at DESC, recorded_at DESC').all() as unknown as CommitRow[];
    const out: CommitRecord[] = [];
    for (const row of rows) {
      const c = toCommit(row);
      if (opts.agent && !c.agents.some((a) => a.toLowerCase() === opts.agent!.toLowerCase())) continue;
      if (opts.component && !c.components.some((x) => x.id === opts.component)) continue;
      out.push(c);
      if (opts.limit && out.length >= opts.limit) break;
    }
    return out;
  }

  addAnalysis(a: Omit<AnalysisRecord, 'id'>): void {
    this.db
      .prepare('INSERT INTO analyses (commit_hash, backend, model, input_hash, created_at, status, note, error, usage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.commitHash, a.backend, a.model, a.inputHash, a.createdAt, a.status, a.note ? JSON.stringify(a.note) : null, a.error, a.usage ? JSON.stringify(a.usage) : null);
  }

  /** Every note on a commit, newest first. */
  analyses(hash: string): AnalysisRecord[] {
    return (this.db.prepare('SELECT * FROM analyses WHERE commit_hash = ? ORDER BY created_at DESC, id DESC').all(hash) as unknown as AnalysisRow[]).map(toAnalysis);
  }

  /** The newest note that passed validation, if any. */
  latestNote(hash: string): AnalysisRecord | null {
    return this.analyses(hash).find((a) => a.status === 'ok') ?? null;
  }

  /**
   * Commits that still need a note from this backend, newest first: no note
   * yet, and fewer than `maxAttempts` failures. A rejected note counts as an
   * answer; it is not retried until the input changes.
   */
  pendingAnalysis(backend: string, opts: { limit: number; maxAttempts?: number }): CommitRecord[] {
    const maxAttempts = opts.maxAttempts ?? 3;
    const rows = this.db
      .prepare(
        `SELECT c.* FROM commits c
         WHERE NOT EXISTS (SELECT 1 FROM analyses a WHERE a.commit_hash = c.hash AND a.backend = ? AND a.status IN ('ok', 'rejected'))
           AND (SELECT COUNT(*) FROM analyses a WHERE a.commit_hash = c.hash AND a.backend = ? AND a.status = 'failed') < ?
         ORDER BY c.committed_at DESC LIMIT ?`,
      )
      .all(backend, backend, maxAttempts, opts.limit) as unknown as CommitRow[];
    return rows.map(toCommit);
  }

  counts(): { commits: number; analysed: number } {
    const commits = (this.db.prepare('SELECT COUNT(*) AS n FROM commits').get() as { n: number }).n;
    const analysed = (this.db.prepare("SELECT COUNT(DISTINCT commit_hash) AS n FROM analyses WHERE status = 'ok'").get() as { n: number }).n;
    return { commits, analysed };
  }

  addAsk(entry: { question: string; backend: string; model: string | null; status: AskStatus; answer: AskAnswer | null; calls: AskToolCall[]; error: string | null; usage: Record<string, unknown> | null }): number {
    const row = this.db
      .prepare(
        'INSERT INTO ask_history (question, backend, model, created_at, status, answer, calls, error, usage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      )
      .get(
        entry.question,
        entry.backend,
        entry.model,
        Date.now(),
        entry.status,
        entry.answer ? JSON.stringify(entry.answer) : null,
        JSON.stringify(entry.calls),
        entry.error,
        entry.usage ? JSON.stringify(entry.usage) : null,
      ) as { id: number };
    return row.id;
  }

  askHistory(limit = 20): AskRecord[] {
    return (this.db.prepare('SELECT * FROM ask_history ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as unknown as AskRow[]).map((r) => ({
      id: r.id,
      question: r.question,
      backend: r.backend,
      model: r.model,
      createdAt: r.created_at,
      status: r.status,
      answer: r.answer ? (JSON.parse(r.answer) as AskAnswer) : null,
      calls: JSON.parse(r.calls) as AskToolCall[],
      error: r.error,
      usage: r.usage ? (JSON.parse(r.usage) as Record<string, unknown>) : null,
    }));
  }

  startSession(entry: { task: string; agent: string; startSeq: number }): number {
    const row = this.db
      .prepare('INSERT INTO sessions (task, summary, agent, started_at, ended_at, start_seq, end_seq, changes) VALUES (?, NULL, ?, ?, NULL, ?, NULL, ?) RETURNING id')
      .get(entry.task, entry.agent, Date.now(), entry.startSeq, JSON.stringify(EMPTY_CHANGES)) as { id: number };
    return row.id;
  }

  /** The newest still-open session for this agent, if any. */
  openSession(agent: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE agent = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(agent) as unknown as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  endSession(id: number, entry: { summary: string | null; endSeq: number; changes: SessionChanges }): void {
    this.db.prepare('UPDATE sessions SET summary = ?, ended_at = ?, end_seq = ?, changes = ? WHERE id = ?').run(entry.summary, Date.now(), entry.endSeq, JSON.stringify(entry.changes), id);
  }

  sessions(limit = 20): SessionRecord[] {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC, id DESC LIMIT ?').all(limit) as unknown as SessionRow[]).map(toSession);
  }

  addSessionNote(entry: { sessionId: number; component: string; label: string; backend: string; model: string | null; status: SessionNoteStatus; note: string | null; files: string[]; error: string | null }): number {
    const row = this.db
      .prepare('INSERT INTO session_notes (session_id, component, label, backend, model, created_at, status, note, files, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .get(entry.sessionId, entry.component, entry.label, entry.backend, entry.model, Date.now(), entry.status, entry.note, JSON.stringify(entry.files), entry.error) as { id: number };
    return row.id;
  }

  sessionNotes(sessionIds: number[]): SessionNote[] {
    if (!sessionIds.length) return [];
    const rows = this.db.prepare(`SELECT * FROM session_notes WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) ORDER BY id`).all(...sessionIds) as unknown as SessionNoteRow[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      component: r.component,
      label: r.label,
      backend: r.backend,
      model: r.model,
      createdAt: r.created_at,
      status: r.status,
      note: r.note,
      files: JSON.parse(r.files) as string[],
      error: r.error,
    }));
  }

  getMeta(key: string): string | null {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
