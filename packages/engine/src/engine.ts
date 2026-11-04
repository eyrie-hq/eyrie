import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { deriveArchitecture } from '@eyrie/architecture';
import {
  diffGraphs,
  hash53,
  type ArchDiff,
  type ArchGraph,
  type ArchNode,
  type CodeDiff,
  type CodeEdge,
  type CodeNode,
  type FileChange,
  type FileChangeKind,
  type GraphStats,
  type RepoInfo,
} from '@eyrie/core';
import { GraphIndex, type FileUpdate, type ProjectConfig } from '@eyrie/graph';
import { FACTS_VERSION, SourceParser, contentHash } from '@eyrie/parser';
import { GraphStorage, type CachedFile } from '@eyrie/storage';
import { loadProjectConfig } from './config.js';
import { IgnoreRules, MAX_FILE_BYTES, isConfigFile, isSourceFile, scanRepository } from './scanner.js';

export interface EngineOptions {
  root: string;
  /** Where the SQLite cache lives. Defaults to ~/.eyrie/repos/<hash>. */
  dataDir?: string;
  watch?: boolean;
  /** Ignore the facts cache and re-parse everything. */
  reset?: boolean;
  /** Debounce window for file events. */
  debounceMs?: number;
  log?: (message: string) => void;
}

export interface EngineBatch {
  seq: number;
  at: number;
  ms: number;
  files: FileChange[];
  code: CodeDiff;
  architecture: ArchDiff;
  /** Files whose relationships were recomputed. */
  reresolved: number;
  stats: GraphStats;
}

export interface MemberInfo {
  id: string;
  kind: CodeNode['kind'];
  name: string;
  qualifiedName: string;
  file?: string;
  line?: number;
  endLine?: number;
  doc?: string;
  signature?: string;
}

export interface ArchNodeDetails {
  node: ArchNode;
  members: MemberInfo[];
}

const SENSITIVE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|crt)|id_rsa.*|\.npmrc|\.netrc)$/i;

const toPosix = (p: string) => p.split(sep).join('/');

/**
 * Indexes a repository and keeps the graph synchronised with the file
 * system. Emits a `batch` event with code and architecture diffs after
 * every incremental update.
 */
export class GraphEngine extends EventEmitter<{ batch: [EngineBatch]; error: [Error]; ready: [] }> {
  readonly root: string;
  /** Where this repository's cache lives (graph.db), and other per-project data such as knowledge.db. */
  readonly dataDir: string;
  repo!: RepoInfo;
  index!: GraphIndex;
  architecture: ArchGraph = { nodes: [], edges: [] };
  stats: GraphStats = { files: 0, symbols: 0, nodes: 0, edges: 0, archNodes: 0, archEdges: 0 };
  seq = 0;

  private parser = new SourceParser();
  private storage: GraphStorage | null = null;
  private watcher: FSWatcher | null = null;
  private rules!: IgnoreRules;
  private configFiles: string[] = [];
  private config!: ProjectConfig;
  private fileHashes = new Map<string, string>();
  private pending = new Map<string, FileChangeKind>();
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly log: (m: string) => void;

  constructor(private readonly opts: EngineOptions) {
    super();
    this.root = resolve(opts.root);
    this.dataDir = opts.dataDir ?? join(process.env.EYRIE_HOME ?? join(homedir(), '.eyrie'), 'repos', hash53(this.root));
    this.log = opts.log ?? (() => {});
  }

  get repoId(): string {
    return this.index.repoId;
  }

  async start(): Promise<void> {
    const t0 = performance.now();
    if (!existsSync(this.root) || !statSync(this.root).isDirectory()) throw new Error(`Not a directory: ${this.root}`);
    this.rules = new IgnoreRules(this.root);
    const scan = scanRepository(this.root, this.rules);
    this.configFiles = scan.configs;
    const loaded = loadProjectConfig(this.root, scan.configs);
    this.config = loaded.config;
    this.repo = { name: loaded.name, root: this.root, frameworks: loaded.config.frameworks };
    this.index = new GraphIndex({ repoName: loaded.name, config: loaded.config });
    this.openStorage();

    const cached = this.loadCachedFiles();
    const updates: FileUpdate[] = [];
    const fresh: CachedFile[] = [];
    let reused = 0;
    const tParse = performance.now();
    for (const f of scan.sources) {
      const hit = cached.get(f.path);
      if (hit && hit.size === f.size && Math.round(hit.mtimeMs) === Math.round(f.mtimeMs)) {
        updates.push({ path: f.path, facts: hit.facts });
        this.fileHashes.set(f.path, hit.hash);
        reused++;
        continue;
      }
      const content = this.readText(f.path);
      if (content === null) continue;
      const hash = contentHash(content);
      const facts = hit?.hash === hash ? hit.facts : await this.parser.parse(f.path, content);
      if (!facts) continue;
      updates.push({ path: f.path, facts });
      fresh.push({ path: f.path, hash, size: f.size, mtimeMs: f.mtimeMs, facts });
      this.fileHashes.set(f.path, hash);
    }
    const parseMs = performance.now() - tParse;
    const scanned = new Set(scan.sources.map((s) => s.path));
    const removed = [...cached.keys()].filter((p) => !scanned.has(p));

    const tBuild = performance.now();
    this.index.update(updates);
    this.architecture = deriveArchitecture(this.index);
    const buildMs = performance.now() - tBuild;
    this.persist(() => {
      this.storage!.upsertRepository(this.repoId, this.repo.name, this.root);
      this.storage!.saveFiles(this.repoId, fresh, removed);
      this.storage!.replaceGraph(this.repoId, this.index.store.nodes(), this.index.store.edges());
    });
    this.refreshStats({ parseMs, buildMs });
    this.log(
      `Indexed ${updates.length} files (${fresh.length} parsed, ${reused} from cache) → ${this.stats.nodes} nodes, ${this.stats.edges} edges, ` +
        `${this.stats.archNodes} architecture components in ${Math.round(performance.now() - t0)}ms`,
    );
    if (this.opts.watch !== false) await this.startWatcher();
    this.emit('ready');
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
    await this.queue;
    this.storage?.close();
    this.parser.dispose();
  }

  /** Waits until queued file events have been processed (used by tests and the CLI). */
  async idle(): Promise<void> {
    while (this.timer || this.pending.size) await new Promise((r) => setTimeout(r, 10));
    await this.queue;
  }

  // ── queries ──────────────────────────────────────────────────────────────

  archNodeDetails(id: string): ArchNodeDetails | null {
    const node = this.architecture.nodes.find((n) => n.id === id);
    if (!node) return null;
    const members: MemberInfo[] = [];
    for (const mid of node.members) {
      const n = this.index.store.getNode(mid);
      if (!n || n.kind === 'file' || n.kind === 'folder') continue;
      const info: MemberInfo = { id: n.id, kind: n.kind, name: n.name, qualifiedName: n.qualifiedName };
      if (n.file) info.file = n.file;
      if (n.range) {
        info.line = n.range.start;
        info.endLine = n.range.end;
      }
      if (typeof n.meta?.doc === 'string') info.doc = n.meta.doc;
      if (typeof n.meta?.signature === 'string') info.signature = n.meta.signature;
      members.push(info);
    }
    members.sort((a, b) => (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0));
    return { node, members };
  }

  codeNode(id: string): { node: CodeNode; incoming: CodeEdge[]; outgoing: CodeEdge[] } | null {
    const node = this.index.store.getNode(id);
    if (!node) return null;
    return { node, incoming: this.index.store.inEdges(id), outgoing: this.index.store.outEdges(id) };
  }

  /** Only indexed source files can be read; secrets and other files cannot. */
  readSource(file: string, start = 1, end = start + 80): { file: string; start: number; end: number; lines: string[]; total: number } | null {
    if (!this.index.files.has(file) || SENSITIVE.test(file)) return null;
    const text = this.readText(file);
    if (text === null) return null;
    const all = text.split('\n');
    const s = Math.max(1, start);
    const e = Math.min(all.length, Math.max(s, end), s + 400);
    return { file, start: s, end: e, lines: all.slice(s - 1, e), total: all.length };
  }

  absolutePath(file: string): string | null {
    if (!this.index.files.has(file)) return null;
    return join(this.root, file);
  }

  /** Whether `.gitignore` / `.eyrieignore` rules ignore this repo-relative path. */
  isIgnored(rel: string): boolean {
    return this.rules.ignores(rel, false);
  }

  // ── watching ─────────────────────────────────────────────────────────────

  private async startWatcher(): Promise<void> {
    const ignored = (abs: string, stats?: { isDirectory(): boolean; isFile(): boolean }) => {
      const rel = toPosix(relative(this.root, abs));
      if (!rel) return false;
      if (rel.startsWith('..')) return true;
      const isDir = stats?.isDirectory() ?? false;
      if (this.rules.ignores(rel, isDir)) return true;
      if (stats?.isFile()) return !(isSourceFile(rel) || isConfigFile(rel) || basename(rel) === '.gitignore');
      return false;
    };
    this.watcher = watch(this.root, {
      ignored,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 10 },
    });
    const on = (kind: FileChangeKind) => (abs: string) => this.enqueue(toPosix(relative(this.root, abs)), kind);
    this.watcher.on('add', on('add')).on('change', on('change')).on('unlink', on('unlink'));
    this.watcher.on('error', (err) => this.emit('error', err instanceof Error ? err : new Error(String(err))));
    await new Promise<void>((r) => this.watcher!.once('ready', () => r()));
  }

  /** Feed a change manually (also used when watching is disabled). */
  enqueue(rel: string, kind: FileChangeKind): void {
    const prev = this.pending.get(rel);
    this.pending.set(rel, prev === 'unlink' && kind === 'add' ? 'change' : prev === 'add' && kind === 'change' ? 'add' : kind);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const batch = new Map(this.pending);
      this.pending.clear();
      this.queue = this.queue
        .then(() => this.processBatch(batch))
        .catch((err: unknown) => {
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
        });
    }, this.opts.debounceMs ?? 60);
  }

  private async processBatch(batch: Map<string, FileChangeKind>): Promise<void> {
    const t0 = performance.now();
    const updates: FileUpdate[] = [];
    const files: FileChange[] = [];
    const fresh: CachedFile[] = [];
    const removed: string[] = [];
    let configChanged = false;

    for (const [rel, kind] of batch) {
      if (basename(rel) === '.gitignore') {
        this.rules = new IgnoreRules(this.root);
        continue;
      }
      if (isConfigFile(rel)) {
        configChanged = true;
        if (kind === 'add' && !this.configFiles.includes(rel)) this.configFiles.push(rel);
        if (kind === 'unlink') this.configFiles = this.configFiles.filter((f) => f !== rel);
        continue;
      }
      if (!isSourceFile(rel)) continue;
      const abs = join(this.root, rel);
      const gone = kind === 'unlink' || !existsSync(abs) || this.rules.ignores(rel, false);
      if (gone) {
        if (this.index.files.has(rel)) {
          updates.push({ path: rel, facts: null });
          files.push({ file: rel, change: 'unlink' });
          removed.push(rel);
          this.fileHashes.delete(rel);
        }
        continue;
      }
      const st = statSync(abs);
      if (st.size > MAX_FILE_BYTES) continue;
      const content = this.readText(rel);
      if (content === null) continue;
      const hash = contentHash(content);
      if (this.fileHashes.get(rel) === hash) continue;
      const facts = await this.parser.parse(rel, content);
      if (!facts) continue;
      updates.push({ path: rel, facts });
      files.push({ file: rel, change: this.index.files.has(rel) ? 'change' : 'add' });
      fresh.push({ path: rel, hash, size: st.size, mtimeMs: st.mtimeMs, facts });
      this.fileHashes.set(rel, hash);
    }

    if (configChanged) {
      const loaded = loadProjectConfig(this.root, this.configFiles);
      if (JSON.stringify(loaded.config) !== JSON.stringify(this.config)) {
        this.config = loaded.config;
        this.repo = { ...this.repo, frameworks: loaded.config.frameworks };
      } else configChanged = false;
    }
    if (!updates.length && !configChanged) return;

    const result = this.index.update(updates, configChanged ? { all: true, config: this.config } : {});
    const before = this.architecture;
    this.architecture = deriveArchitecture(this.index);
    const architecture = diffGraphs(before, this.architecture);
    this.persist(() => {
      this.storage!.saveFiles(this.repoId, fresh, removed);
      this.storage!.applyDiff(this.repoId, result.diff);
    });
    this.refreshStats({});
    this.seq++;
    const ms = performance.now() - t0;
    this.log(`${files.map((f) => `${f.change} ${f.file}`).join(', ') || 'config changed'} → ${result.reresolved.length} files re-resolved in ${ms.toFixed(1)}ms`);
    this.emit('batch', { seq: this.seq, at: Date.now(), ms, files, code: result.diff, architecture, reresolved: result.reresolved.length, stats: this.stats });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private openStorage(): void {
    try {
      this.storage = GraphStorage.open(join(this.dataDir, 'graph.db'), { factsVersion: FACTS_VERSION });
    } catch (err) {
      this.log(`Cache disabled: ${(err as Error).message}`);
      this.storage = null;
    }
  }

  private persist(fn: () => void): void {
    if (!this.storage) return;
    try {
      fn();
    } catch (err) {
      this.log(`Could not write cache: ${(err as Error).message}`);
    }
  }

  /** The cached facts, or an empty cache when it cannot be read: a full parse is slower, never wrong. */
  private loadCachedFiles(): Map<string, CachedFile> {
    if (this.opts.reset || !this.storage) return new Map<string, CachedFile>();
    try {
      return this.storage.loadFiles(this.repoId);
    } catch (err) {
      this.log(`Could not read cache, parsing every file: ${(err as Error).message}`);
      return new Map<string, CachedFile>();
    }
  }

  private readText(rel: string): string | null {
    try {
      return readFileSync(join(this.root, rel), 'utf8');
    } catch {
      return null;
    }
  }

  private refreshStats(times: { parseMs?: number; buildMs?: number }): void {
    let symbols = 0;
    for (const p of this.index.files) symbols += this.index.getFacts(p)?.symbols.length ?? 0;
    this.stats = {
      files: this.index.files.size,
      symbols,
      nodes: this.index.store.nodeCount,
      edges: this.index.store.edgeCount,
      archNodes: this.architecture.nodes.length,
      archEdges: this.architecture.edges.length,
      parseMs: times.parseMs !== undefined ? Math.round(times.parseMs) : this.stats.parseMs,
      buildMs: times.buildMs !== undefined ? Math.round(times.buildMs) : this.stats.buildMs,
    };
  }
}
