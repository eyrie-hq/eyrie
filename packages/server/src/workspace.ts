/**
 * One `eyrie mcp` process for several repositories.
 *
 * The protocol layer in front of one EyrieMcp per repository: it answers
 * initialize and tools/list itself, picks the repository each tool call is
 * about, indexes it on first use and keeps a bounded number of them warm.
 * The repository comes from the call's `repo` argument, else from the
 * client's MCP roots, else from the path `eyrie mcp` was started with.
 * Only repositories inside an allowed root (that path, `--root` folders and
 * the client's roots) are opened, so a tool call cannot make Eyrie index an
 * arbitrary folder.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphEngine } from '@eyrie/engine';
import type { AiBackend, ProjectKnowledge } from '@eyrie/knowledge';
import { openKnowledge } from './launch.js';
import { EyrieMcp, INSTRUCTIONS, PROTOCOL_VERSIONS, TOOL_SPECS } from './mcp.js';

type Id = string | number;
type Message = { jsonrpc?: unknown; id?: Id | null; method?: unknown; params?: Record<string, unknown>; result?: unknown; error?: unknown };

/** One open repository: its engine, knowledge and tools. */
export interface OpenRepository {
  root: string;
  engine: GraphEngine;
  mcp: EyrieMcp;
  /** Resolves once indexed; rejects when the repository could not be indexed. */
  ready: Promise<unknown>;
  close(): Promise<void>;
}

export interface WorkspaceOptions {
  version: string;
  /** The repository `eyrie mcp <path>` names: opened at once and used when a call names none. */
  defaultRoot?: string;
  /** Folders (`--root`) whose repositories may be opened, besides the default and the client's roots. */
  roots?: string[];
  /** Repositories kept open at once (default 4). The least recently used is closed first, never one with an open session. */
  maxRepos?: number;
  watch?: boolean;
  reset?: boolean;
  ai?: AiBackend | null;
  log?: (message: string) => void;
  /** Opens a repository; tests replace it. */
  open?: (root: string) => OpenRepository;
  /** How long a call without `repo` waits for the client's answer to roots/list (default 2 s). */
  rootsTimeoutMs?: number;
}

const REPO_ARG = {
  type: 'string',
  description:
    'The repository to answer for: its folder name, its path, or any path inside it. Optional when Eyrie serves one repository or the client shares its workspace roots; name it whenever several clients or repositories share this server.',
};

const WORKSPACE_NOTE = `
This server can serve several repositories. Pass repo (a folder name or a path inside the repository) on every call when more than one repository is in play; without it, the client's workspace root is used.`;

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const isInside = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const isDirectory = (p: string) => existsSync(p) && statSync(p).isDirectory();

export class McpWorkspace {
  private readonly repos = new Map<string, { repo: OpenRepository; usedAt: number }>();
  private readonly allowed: string[];
  private clientRoots: string[] = [];
  private initialize: Message | null = null;
  private clientSupportsRoots = false;
  private send: ((message: unknown) => void) | null = null;
  private nextRequest = 1;
  private readonly waiting = new Map<Id, (message: Message) => void>();
  private rootsPending: Promise<void> | null = null;
  private clock = 0;

  constructor(private readonly opts: WorkspaceOptions) {
    this.allowed = [...(opts.defaultRoot ? [resolve(opts.defaultRoot)] : []), ...(opts.roots ?? []).map((r) => resolve(r))];
    if (opts.defaultRoot) this.repository(resolve(opts.defaultRoot));
  }

  /** Lets the server send requests to the client (roots/list). serveStdio connects it. */
  connect(send: (message: unknown) => void): void {
    this.send = send;
  }

  /** Repositories open right now, most recently used first. */
  openRepositories(): string[] {
    return [...this.repos.values()].sort((a, b) => b.usedAt - a.usedAt).map((r) => r.repo.root);
  }

  async close(): Promise<void> {
    const all = [...this.repos.values()];
    this.repos.clear();
    await Promise.all(all.map((r) => r.repo.close()));
  }

  /** Answers one JSON-RPC message; null for notifications and for responses to our own requests. */
  async handle(message: unknown): Promise<unknown> {
    const msg = message as Message | null;
    if (msg && typeof msg === 'object' && msg.method === undefined && msg.id !== undefined && msg.id !== null && ('result' in msg || 'error' in msg)) {
      this.waiting.get(msg.id)?.(msg);
      this.waiting.delete(msg.id);
      return null;
    }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    }
    const params = msg.params ?? {};
    switch (msg.method) {
      case 'notifications/initialized':
      case 'notifications/roots/list_changed':
        if (this.clientSupportsRoots) this.requestRoots();
        return null;
    }
    if (msg.id === undefined) return null;
    const id = msg.id ?? null;
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    switch (msg.method) {
      case 'initialize': {
        this.initialize = msg;
        this.clientSupportsRoots = !!(params.capabilities as { roots?: unknown } | undefined)?.roots;
        for (const { repo } of this.repos.values()) await repo.mcp.handle(msg);
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'eyrie', title: 'Eyrie', version: this.opts.version },
          instructions: this.opts.defaultRoot ? INSTRUCTIONS : INSTRUCTIONS + WORKSPACE_NOTE,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: TOOL_SPECS.map(({ name, title, description, inputSchema, annotations }) => ({
            name,
            title,
            description,
            inputSchema: { ...inputSchema, properties: { ...(inputSchema.properties as Record<string, unknown>), repo: REPO_ARG } },
            annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, ...annotations },
          })),
        });
      case 'tools/call': {
        const { repo: named, ...args } = (params.arguments as Record<string, unknown> | undefined) ?? {};
        let repo: OpenRepository;
        try {
          repo = this.repository(await this.pick(named));
        } catch (err) {
          return reply({ content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message, repositories: this.candidates() }, null, 1) }], isError: true });
        }
        return repo.mcp.handle({ ...msg, params: { ...params, arguments: args } });
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  }

  // ── which repository ────────────────────────────────────────────────────

  /** Every folder a repository may be opened from: the default, `--root` folders and the client's roots. */
  private allowedRoots(): string[] {
    return [...this.allowed, ...this.clientRoots];
  }

  private async pick(named: unknown): Promise<string> {
    if (typeof named === 'string' && named.trim()) return this.resolveNamed(named.trim());
    if (named !== undefined && typeof named !== 'string') throw new Error('Give repo as a folder name or a path.');
    if (this.opts.defaultRoot) return resolve(this.opts.defaultRoot);
    if (this.rootsPending) await this.rootsPending;
    if (this.clientRoots.length === 1) return this.repositoryRoot(this.clientRoots[0]!);
    if (this.repos.size === 1) return [...this.repos.keys()][0]!;
    throw new Error('Several repositories are possible. Name one with repo.');
  }

  /** A folder name of an open or allowed repository, a path, or a path inside a repository. */
  private resolveNamed(named: string): string {
    const allowed = this.allowedRoots();
    const byName = [...this.repos.keys(), ...this.candidates()].find((r) => samePath(basename(r), named));
    const candidates = isAbsolute(named) ? [resolve(named)] : [...(byName ? [byName] : []), ...allowed.map((r) => resolve(r, named))];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      if (!allowed.some((r) => isInside(path, r))) {
        throw new Error(`${path} is outside the folders this server may open (${allowed.join(', ') || 'none'}). Start eyrie mcp with --root, or share the folder as a workspace root.`);
      }
      return this.repositoryRoot(path);
    }
    throw new Error(`No repository "${named}" in ${allowed.join(', ') || 'any allowed folder'}.`);
  }

  /**
   * The repository a path belongs to: the nearest folder with `.git` that is
   * still inside an allowed root, else the folder itself (a project that is
   * not a git repository).
   */
  private repositoryRoot(path: string): string {
    const start = isDirectory(path) ? resolve(path) : dirname(resolve(path));
    const allowed = this.allowedRoots().filter((r) => isInside(start, r));
    for (let dir = start; allowed.some((r) => isInside(dir, r)); dir = dirname(dir)) {
      if (existsSync(join(dir, '.git'))) return dir;
      if (dirname(dir) === dir) break;
    }
    return start;
  }

  /** Repositories a call could name: the open ones, the client's roots, and git repositories directly inside a `--root` folder. */
  private candidates(): string[] {
    const found = new Set<string>([...this.repos.keys(), ...this.clientRoots]);
    for (const root of this.allowed) {
      if (existsSync(join(root, '.git'))) {
        found.add(root);
        continue;
      }
      let entries: string[] = [];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      for (const name of entries) if (existsSync(join(root, name, '.git'))) found.add(join(root, name));
    }
    return [...found].sort();
  }

  // ── open repositories ──────────────────────────────────────────────────

  private repository(root: string): OpenRepository {
    const key = [...this.repos.keys()].find((k) => samePath(k, root)) ?? root;
    const known = this.repos.get(key);
    if (known) {
      known.usedAt = ++this.clock;
      return known.repo;
    }
    // The default repository logs as `eyrie mcp <path>` always has; others name themselves.
    const isDefault = !!this.opts.defaultRoot && samePath(root, resolve(this.opts.defaultRoot));
    if (!isDefault) this.opts.log?.(`Opening ${root}`);
    const repo = (this.opts.open ?? ((r: string) => openRepository(r, this.opts, isDefault ? '' : `${basename(r)}: `)))(root);
    if (this.initialize) void repo.mcp.handle(this.initialize);
    this.repos.set(root, { repo, usedAt: ++this.clock });
    this.evict(root);
    return repo;
  }

  /** Closes the least recently used repositories over the limit, keeping `keep` and any with an open session. */
  private evict(keep: string): void {
    const max = Math.max(1, this.opts.maxRepos ?? 4);
    const idle = [...this.repos.entries()]
      .filter(([root, { repo }]) => root !== keep && !repo.mcp.hasOpenSession())
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    while (this.repos.size > max && idle.length) {
      const [root, { repo }] = idle.shift()!;
      this.repos.delete(root);
      this.opts.log?.(`Closing ${root} (more than ${max} repositories open)`);
      repo.close().catch((err: unknown) => this.opts.log?.(`Could not close ${root}: ${(err as Error).message}`));
    }
  }

  // ── roots ───────────────────────────────────────────────────────────────

  private requestRoots(): void {
    if (!this.send) return;
    const id = `eyrie-roots-${this.nextRequest++}`;
    const answered = new Promise<Message | null>((done) => {
      this.waiting.set(id, done);
      setTimeout(() => done(null), this.opts.rootsTimeoutMs ?? 2_000).unref?.();
    });
    this.send({ jsonrpc: '2.0', id, method: 'roots/list' });
    const pending = answered.then((answer) => {
      this.waiting.delete(id);
      const roots = (answer?.result as { roots?: { uri?: unknown }[] } | undefined)?.roots;
      if (Array.isArray(roots)) this.clientRoots = roots.flatMap((r) => (typeof r.uri === 'string' && r.uri.startsWith('file:') ? [resolve(fileURLToPath(r.uri))] : []));
      if (this.rootsPending === pending) this.rootsPending = null;
    });
    this.rootsPending = pending;
  }
}

/** Indexes a repository the way `eyrie mcp <path>` always has: engine, knowledge, tools. */
function openRepository(root: string, opts: WorkspaceOptions, prefix: string): OpenRepository {
  const log = (m: string) => opts.log?.(prefix + m);
  const engine = new GraphEngine({ root, watch: opts.watch ?? true, reset: opts.reset, log });
  engine.on('error', (err) => log(`error: ${err.message}`));
  let knowledge: ProjectKnowledge | undefined;
  const ready = engine.start().then(async () => {
    knowledge = await openKnowledge(engine, { ai: opts.ai, watch: opts.watch ?? true, log });
    return { knowledge };
  });
  ready.catch((err: unknown) => log(`Could not index ${root}: ${(err as Error).message}`));
  const mcp = new EyrieMcp({ engine, ready, version: opts.version, ai: opts.ai });
  return {
    root,
    engine,
    mcp,
    ready,
    close: async () => {
      mcp.dispose();
      await ready.catch(() => {});
      await knowledge?.close();
      await engine.stop();
    },
  };
}
