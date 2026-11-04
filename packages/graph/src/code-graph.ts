import {
  basename,
  dirname,
  hash53,
  idFor,
  keys,
  type ArgFact,
  type CodeDiff,
  type CodeEdge,
  type CodeEdgeKind,
  type CodeNode,
  type CodeNodeKind,
  type FileFacts,
  type ImportSpecifier,
  type ModelFact,
  type ReferenceFact,
  type SymbolFact,
} from '@eyrie/core';
import { packageName, providerForPackage, providerForUrl, type ExternalProvider } from './externals.js';
import { ModuleResolver, emptyProjectConfig, languageOfPath, type ProjectConfig } from './resolver.js';
import { HTTP_EXPORTS, matchRoutePath, nextFileInfo, normalizeUrlPath, type NextFileInfo } from './routes.js';
import { CodeGraphStore } from './store.js';

export interface FileUpdate {
  path: string;
  /** null = the file was deleted. */
  facts: FileFacts | null;
}

export interface UpdateResult {
  diff: CodeDiff;
  /** Files whose facts changed. */
  changed: string[];
  /** Files whose relationships were re-resolved (changed files + invalidated dependents). */
  reresolved: string[];
  ms: number;
}

type Target =
  | { kind: 'symbol'; file: string; symbol: SymbolFact }
  | { kind: 'module'; file: string }
  /** A package spread over several files (Go package, Java / C# namespace). */
  | { kind: 'package'; files: string[] }
  | { kind: 'external'; provider: ExternalProvider };

interface Resolved {
  target: string;
  confidence: number;
  edgeKind?: CodeEdgeKind;
  meta?: Record<string, unknown>;
}

/** Per-file resolution state. */
interface Ctx {
  path: string;
  facts: FileFacts;
  fileId: string;
  consulted: Set<string>;
  edges: Map<string, CodeEdge>;
}

interface RouteDesc {
  id: string;
  method: string;
  path: string;
  appRoot: string;
  line: number;
  /** Local names / exported names that handle the route. */
  handlers: string[];
  /** Reference scope for inline handlers (Express). */
  scope?: string;
}

const PRISMA_READ = new Set(['findMany', 'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy']);
const PRISMA_WRITE = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);
const MODEL_WRITE = /^(create|insert|update|upsert|delete|remove|save|destroy|bulk|replace|add|attach|persist|merge)/i;
const MODEL_READ = /^(find|get|select|count|aggregate|exists|where|query|list|read|search|populate|distinct|filter|all$|first|last|exclude|pluck|take|fetch|load)/i;
const FETCH_FUNCS = new Set(['fetch', '$fetch', 'ofetch', 'useSWR', 'useFetch', 'useSWRMutation']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);
const HTTP_CLIENTS = new Set(['axios', 'ky', 'got', 'superagent']);
const HTTP_FACTORIES = new Set(['axios.create', 'ky.create', 'ky.extend', 'got.extend']);
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
/** `get`, `Post`, `GetAsync`, `postForObject`, `get_json`... → the HTTP verb. */
const FOREIGN_HTTP_VERB = /^(get|post|put|patch|delete|head|options)(Async|ForObject|ForEntity|_json)?$/i;
const FOREIGN_HTTP_MODULES = new Set(['requests', 'httpx', 'aiohttp', 'urllib3', 'net/http', 'Illuminate.Support.Facades.Http', 'reqwest']);
const FOREIGN_HTTP_GLOBALS = new Set(['HTTParty', 'Faraday', 'RestClient', 'Net.HTTP', 'reqwest']);
const FOREIGN_HTTP_TYPES = new Set(['HttpClient', 'RestTemplate', 'WebClient', 'RestClient', 'AsyncClient', 'httpx.Client', 'requests.Session', 'reqwest.Client', 'Faraday.Connection', 'http.Client']);
const TABLE_FACTORIES: Record<string, RegExp> = {
  pgTable: /^drizzle-orm/,
  mysqlTable: /^drizzle-orm/,
  sqliteTable: /^drizzle-orm/,
  model: /^mongoose$/,
};

const strip = (s: string) => s.replace(/\(\)$/, '');
const mountedPath = (prefix: string, path: string) => prefix ? `${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/') : path;
const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isBare = (s: string) => !s.startsWith('.') && !s.startsWith('/');

function coarseKind(kind: SymbolFact['kind']): string {
  switch (kind) {
    case 'function':
    case 'method':
    case 'react_component':
    case 'hook':
      return 'fn';
    case 'class':
      return 'class';
    case 'variable':
      return 'var';
    default:
      return 'type';
  }
}

export const symbolId = (file: string, s: SymbolFact) => idFor(keys.symbol(file, coarseKind(s.kind), s.qualifiedName));
export const fileId = (file: string) => idFor(keys.file(file));

const symbolIndexes = new WeakMap<FileFacts, Map<string, SymbolFact>>();
function symbolIndex(facts: FileFacts): Map<string, SymbolFact> {
  let idx = symbolIndexes.get(facts);
  if (!idx) {
    idx = new Map(facts.symbols.map((s) => [s.qualifiedName, s]));
    symbolIndexes.set(facts, idx);
  }
  return idx;
}

/** `Stripe` for `stripe`, `Aws` for `aws-sdk-s3`, `OpenAI` for `OpenAI.Chat`: the name is the package's own. */
function namesPackage(name: string, source: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const first = source.split(/[./\\:]+/)[0] ?? source;
  return name.length >= 3 && norm(first).startsWith(norm(name));
}

/** The ORM model a class (or EF Core DbSet property) declares, if any. */
function modelOf(facts: FileFacts | undefined, qualifiedName: string): ModelFact | undefined {
  return facts?.models?.find((m) => m.symbol === qualifiedName);
}

/** How much an import edge's statement makes one file depend on another: type-only < dynamic < static. Other edges are static. */
function importStrength(meta: Record<string, unknown> | undefined): number {
  return meta?.typeOnly ? 0 : meta?.dynamic ? 1 : 2;
}

const importIndexes = new WeakMap<FileFacts, Map<string, { source: string; spec: ImportSpecifier; typeOnly: boolean }>>();
function importBinding(facts: FileFacts, local: string) {
  let idx = importIndexes.get(facts);
  if (!idx) {
    idx = new Map();
    for (const imp of facts.imports) {
      for (const spec of imp.specifiers) idx.set(spec.local, { source: imp.source, spec, typeOnly: imp.typeOnly || !!spec.typeOnly });
    }
    importIndexes.set(facts, idx);
  }
  return idx.get(local);
}

/**
 * Namespace and top-level names of a non-JS file: what the resolver indexes
 * and what same-package files can use without an import.
 */
function declarationKey(facts: FileFacts | undefined): string {
  if (!facts || languageOfPath(facts.path) === 'js') return '';
  const names = facts.symbols.filter((s) => !s.parent).map((s) => s.name);
  return `${facts.namespace ?? ''}|${[...new Set(names)].sort().join(',')}`;
}

const declaredNames = (key: string): string[] => (key ? key.slice(key.indexOf('|') + 1).split(',').filter(Boolean) : []);

/** Everything other files can observe about this file's exports. */
export function exportSignature(facts: FileFacts): string {
  const idx = symbolIndex(facts);
  const exported = new Set<string>();
  for (const e of facts.exports) if (e.kind === 'local') exported.add(e.local);
  for (const s of facts.symbols) if (s.exported && !s.parent) exported.add(s.qualifiedName);
  const members = new Map<string, string[]>();
  for (const s of facts.symbols) {
    if (!s.parent) continue;
    const list = members.get(s.parent) ?? [];
    list.push(s.name);
    members.set(s.parent, list);
  }
  const shape = [...exported].sort().map((name) => {
    const s = idx.get(name);
    if (!s) return [name];
    return [name, s.kind, s.instanceOf, s.initCall, s.typeName, s.extends, s.fields?.map((f) => `${f.name}:${f.type ?? f.instanceOf ?? ''}`), members.get(name)];
  });
  const exportsShape = facts.exports.map(({ line: _line, ...rest }) => rest);
  const receiverMethods = facts.language === 'go' ? facts.symbols.filter((s) => s.parent).map((s) => [s.qualifiedName, s.typeName]) : [];
  return hash53(JSON.stringify([exportsShape, shape, receiverMethods, facts.models?.map((m) => [m.name, m.relations])]));
}

/**
 * The detailed code knowledge graph.
 *
 * `update()` is the only way to change it: a full build is an update that
 * adds every file. Each update re-parses nothing (facts come in), rebuilds
 * nodes only for changed files, and re-resolves relationships only for
 * changed files plus the files that consulted them during their last
 * resolution (reverse-dependency invalidation).
 */
export class GraphIndex {
  readonly store = new CodeGraphStore();
  readonly repoName: string;
  readonly repoId: string;
  private facts = new Map<string, FileFacts>();
  private fileSet = new Set<string>();
  private resolver: ModuleResolver;
  private config: ProjectConfig;
  private exportSigs = new Map<string, string>();
  private consulted = new Map<string, Set<string>>();
  private consultedBy = new Map<string, Set<string>>();
  private unresolvedLocal = new Set<string>();
  private httpCallers = new Set<string>();
  private modelUsers = new Set<string>();
  private appRoots = new Set<string>();
  private fileRoutes = new Map<string, RouteDesc[]>();
  private routerMountPrefixes = new Map<string, string[]>();
  private routes: RouteDesc[] = [];
  private exportCache = new Map<string, { target: Target | null; files: string[] }>();
  private exportVisiting = new Set<string>();

  constructor(opts: { repoName: string; config?: ProjectConfig }) {
    this.repoName = opts.repoName;
    this.repoId = idFor(keys.repository(opts.repoName));
    this.config = opts.config ?? emptyProjectConfig();
    this.resolver = new ModuleResolver(this.fileSet, this.config, (p) => this.facts.get(p));
    this.store.upsertNode({ id: this.repoId, key: keys.repository(opts.repoName), kind: 'repository', name: opts.repoName, qualifiedName: opts.repoName });
    this.store.commit();
  }

  get files(): ReadonlySet<string> {
    return this.fileSet;
  }

  getFacts(path: string): FileFacts | undefined {
    return this.facts.get(path);
  }

  get projectConfig(): ProjectConfig {
    return this.config;
  }

  /** Replacing the config (tsconfig paths, workspaces) re-resolves everything. */
  setConfig(config: ProjectConfig): UpdateResult {
    return this.update([], { all: true, config });
  }

  nextInfo(path: string): NextFileInfo | null {
    return nextFileInfo(path, this.appRoots);
  }

  appRootOf(path: string): string {
    let best = '';
    for (const root of this.appRoots) if (root && path.startsWith(`${root}/`) && root.length > best.length) best = root;
    return best;
  }

  /** Files that consulted `path` during their last resolution. */
  dependentsOf(path: string): string[] {
    return [...(this.consultedBy.get(path) ?? [])];
  }

  update(changes: FileUpdate[], opts: { all?: boolean; config?: ProjectConfig } = {}): UpdateResult {
    const t0 = performance.now();
    if (opts.config) {
      this.config = opts.config;
      this.resolver.setConfig(opts.config);
    }
    this.exportCache.clear();
    const changed = new Set<string>();
    const affected = new Set<string>();
    const declaredChanged = new Set<string>();
    let structureChanged = false;
    const oldRouteSig = this.routeSignature();
    const oldModelSig = this.modelSignature();

    for (const { path, facts } of changes) {
      changed.add(path);
      const had = this.facts.has(path);
      const oldSig = this.exportSigs.get(path);
      // Namespaces and type names feed the resolver's indexes (Java / C# / PHP / Ruby imports),
      // and same-package or autoloaded names are used without an import we could watch.
      const oldDecl = declarationKey(this.facts.get(path));
      const newDecl = declarationKey(facts ?? undefined);
      if (oldDecl !== newDecl) {
        structureChanged = true;
        for (const name of [...declaredNames(oldDecl), ...declaredNames(newDecl)]) declaredChanged.add(name);
      }
      if (facts) {
        this.facts.set(path, facts);
        if (!had) {
          this.fileSet.add(path);
          structureChanged = true;
        }
        const sig = exportSignature(facts);
        this.exportSigs.set(path, sig);
        if (sig !== oldSig) {
          for (const f of this.consultedBy.get(path) ?? []) affected.add(f);
          // Receiver methods can live in a different file from the imported type.
          if (facts.language === 'go') for (const mate of this.resolver.matesOf(path)) {
            for (const f of this.consultedBy.get(mate) ?? []) affected.add(f);
          }
        }
      } else if (had) {
        if (languageOfPath(path) === 'go') for (const mate of this.resolver.matesOf(path)) {
          for (const f of this.consultedBy.get(mate) ?? []) affected.add(f);
        }
        this.facts.delete(path);
        this.fileSet.delete(path);
        this.exportSigs.delete(path);
        structureChanged = true;
        for (const f of this.consultedBy.get(path) ?? []) affected.add(f);
      }
    }

    if (structureChanged) {
      this.resolver.invalidate();
      for (const f of this.unresolvedLocal) affected.add(f);
      if (declaredChanged.size && !opts.all) for (const f of this.filesMentioning(declaredChanged)) affected.add(f);
      const roots = this.computeAppRoots();
      if (roots.size !== this.appRoots.size || [...roots].some((r) => !this.appRoots.has(r))) {
        this.appRoots = roots;
        for (const f of this.facts.keys()) if (/(^|\/)(middleware|proxy)\.[mc]?[jt]sx?$/.test(f)) changed.add(f);
      }
    }

    this.refreshRouterMounts(changed, affected);
    for (const path of changed) this.rebuildNodes(path);
    this.refreshRoutes();
    if (this.routeSignature() !== oldRouteSig) for (const f of this.httpCallers) affected.add(f);
    if (this.modelSignature() !== oldModelSig) for (const f of this.modelUsers) affected.add(f);
    for (const p of changed) affected.add(p);

    const targets = opts.all ? new Set([...this.facts.keys(), ...changed]) : affected;
    for (const p of targets) this.resolveFile(p);
    this.collectGarbage();

    return { diff: this.store.commit(), changed: [...changed], reresolved: [...targets], ms: performance.now() - t0 };
  }

  /** Non-JS files whose references or type annotations start with one of `names`. */
  private filesMentioning(names: Set<string>): string[] {
    const out: string[] = [];
    for (const [path, facts] of this.facts) {
      if (languageOfPath(path) === 'js') continue;
      const hit =
        facts.references.some((r) => names.has(strip(r.callee[0]!))) ||
        facts.symbols.some((s) =>
          [...(s.extends ?? []), ...(s.implements ?? []), s.typeName, s.instanceOf, ...(s.fields ?? []).map((f) => f.type ?? f.instanceOf), ...Object.values(s.locals ?? {})].some(
            (t) => !!t && names.has(t.split('.')[0]!),
          ),
        );
      if (hit) out.push(path);
    }
    return out;
  }

  // ── nodes ────────────────────────────────────────────────────────────────

  private computeAppRoots(): Set<string> {
    const roots = new Set<string>();
    for (const f of this.fileSet) {
      const info = nextFileInfo(f);
      if (info && info.role !== 'middleware') roots.add(info.appRoot);
    }
    return roots;
  }

  private rebuildNodes(path: string): void {
    const facts = this.facts.get(path);
    const old = this.store.nodeIdsOfFile(path);
    if (!facts) {
      for (const id of old) this.store.dropNode(id);
      this.fileRoutes.delete(path);
      return;
    }
    const nodes = this.buildNodes(facts);
    const keep = new Set(nodes.map((n) => n.id));
    for (const id of old) if (!keep.has(id)) this.store.dropNode(id);
    this.ensureFolders(path);
    for (const n of nodes) this.store.upsertNode(n);
  }

  private buildNodes(facts: FileFacts): CodeNode[] {
    const path = facts.path;
    const next = nextFileInfo(path, this.appRoots);
    const packages = [...new Set(facts.imports.map((i) => this.packageOf(path, i.source)).filter((p): p is string => !!p))].sort();
    const fileMeta: Record<string, unknown> = { language: facts.language, loc: facts.loc };
    if (facts.directives.length) fileMeta.directives = facts.directives;
    if (facts.parseErrors) fileMeta.parseErrors = facts.parseErrors;
    if (next) fileMeta.next = next;
    if (packages.length) fileMeta.packages = packages;
    const nodes: CodeNode[] = [
      {
        id: fileId(path),
        key: keys.file(path),
        kind: 'file',
        name: basename(path),
        qualifiedName: path,
        file: path,
        range: { start: 1, end: facts.loc },
        meta: fileMeta,
      },
    ];

    const defaultLocal = facts.exports.find((e) => e.kind === 'local' && e.exported === 'default');
    for (const s of facts.symbols) {
      let kind: CodeNodeKind = s.kind;
      const isEntry = !s.parent && (s.name === 'middleware' || s.name === 'proxy' || (defaultLocal?.kind === 'local' && defaultLocal.local === s.name));
      if (next?.role === 'middleware' && isEntry && s.kind !== 'variable') kind = 'middleware';
      const meta: Record<string, unknown> = {};
      if (s.doc) meta.doc = s.doc;
      if (s.signature) meta.signature = s.signature;
      if (s.async) meta.async = true;
      if (s.instanceOf) meta.instanceOf = s.instanceOf;
      if (s.initCall) meta.initCall = s.initCall;
      if (s.kind === 'variable' && s.initCall) {
        const table = this.tableName(facts, s);
        if (table) {
          kind = 'database_model';
          meta.table = table;
        }
      }
      nodes.push({
        id: symbolId(path, s),
        key: keys.symbol(path, coarseKind(s.kind), s.qualifiedName),
        kind,
        name: s.name,
        qualifiedName: s.qualifiedName,
        file: path,
        range: { start: s.startLine, end: s.endLine },
        exported: s.exported,
        meta,
      });
    }

    const routes: RouteDesc[] = [];
    const addRoute = (r: Omit<RouteDesc, 'id'>, key: string, framework: string, end?: number) => {
      const id = idFor(key);
      if (routes.some((x) => x.id === id)) return;
      routes.push({ ...r, id });
      const meta: Record<string, unknown> = { method: r.method, path: r.path, framework };
      if (r.appRoot) meta.appRoot = r.appRoot;
      nodes.push({ id, key, kind: 'api_route', name: `${r.method} ${r.path}`, qualifiedName: `${r.method} ${r.path}`, file: path, range: { start: r.line, end: end ?? r.line }, meta });
    };
    if (next?.role === 'route') {
      const idx = symbolIndex(facts);
      for (const e of facts.exports) {
        if ((e.kind !== 'local' && e.kind !== 'reexport') || !HTTP_EXPORTS.has(e.exported)) continue;
        const local = e.kind === 'local' ? e.local : e.exported;
        const sym = idx.get(local);
        const key = keys.route(e.exported, next.path) + (next.appRoot ? `@${next.appRoot}` : '');
        addRoute({ method: e.exported, path: next.path, appRoot: next.appRoot, line: sym?.startLine ?? e.line, handlers: [local] }, key, 'next', sym?.endLine);
      }
    } else if (next?.role === 'api-page' && defaultLocal?.kind === 'local') {
      const key = keys.route('ANY', next.path) + (next.appRoot ? `@${next.appRoot}` : '');
      addRoute({ method: 'ANY', path: next.path, appRoot: next.appRoot, line: defaultLocal.line, handlers: [defaultLocal.local] }, key, 'next');
    }
    for (const r of facts.routes) {
      const prefixes = this.routerMountPrefixes.get(`${path}#${r.router}`) ?? [''];
      for (const prefix of prefixes) {
        const routePath = mountedPath(prefix, r.path);
        addRoute(
          { method: r.method, path: routePath, appRoot: this.appRootOf(path), line: r.line, handlers: r.handlers, scope: r.scope },
          `${keys.route(r.method, routePath)}@${path}`,
          r.framework ?? 'express',
        );
      }
    }
    this.fileRoutes.set(path, routes);

    for (const m of facts.models ?? []) {
      nodes.push({
        id: idFor(keys.model(m.name)),
        key: keys.model(m.name),
        kind: 'database_model',
        name: m.name,
        qualifiedName: m.name,
        file: path,
        range: { start: m.line, end: m.endLine },
        meta: { orm: m.orm, fields: m.fields, relations: m.relations },
      });
    }
    return nodes;
  }

  /** Third-party package an import names, or null for local and relative imports. */
  private packageOf(file: string, source: string): string | null {
    if (languageOfPath(file) === 'js') return isBare(source) ? packageName(source) : null;
    const res = this.resolver.resolve(file, source);
    return res.kind === 'package' ? res.name : null;
  }

  private tableName(facts: FileFacts, s: SymbolFact): string | null {
    const fn = s.initCall!;
    const root = fn.split('.')[0]!;
    const fnName = fn.split('.').pop()!;
    const pattern = TABLE_FACTORIES[fnName];
    if (!pattern) return null;
    const binding = importBinding(facts, root);
    const fromPkg = binding ? pattern.test(binding.source) : fn === 'mongoose.model';
    if (!fromPkg) return null;
    const call = facts.references.find((r) => r.from === s.qualifiedName && r.callee.join('.') === fn);
    const arg = call?.args?.[0];
    return typeof arg === 'string' ? arg : s.name;
  }

  private ensureFolders(path: string): void {
    let child = fileId(path);
    let dir = dirname(path);
    let first = true;
    for (;;) {
      const id = dir === '' ? this.repoId : idFor(keys.folder(dir));
      if (dir !== '') {
        this.store.ensureNode({ id, key: keys.folder(dir), kind: 'folder', name: basename(dir), qualifiedName: dir, file: undefined });
      }
      if (!first) {
        this.store.upsertEdge({ id: idFor(keys.edge('CONTAINS', id, child)), kind: 'CONTAINS', source: id, target: child, confidence: 1, owner: '#structure' });
      }
      first = false;
      if (dir === '') break;
      child = id;
      dir = dirname(dir);
    }
  }

  private externalNode(p: ExternalProvider): string {
    const key = keys.external(p.id);
    const id = idFor(key);
    this.store.ensureNode({ id, key, kind: 'external_service', name: p.label, qualifiedName: p.id, meta: { provider: p.id, category: p.category } });
    return id;
  }

  private modelNode(ctx: Ctx, name: string, orm: string): string {
    this.modelUsers.add(ctx.path);
    const key = keys.model(name);
    const id = idFor(key);
    this.store.ensureNode({ id, key, kind: 'database_model', name, qualifiedName: name, meta: { orm } });
    return id;
  }

  private missingRouteNode(method: string, path: string): string {
    const key = `route:missing:${method} ${path}`;
    const id = idFor(key);
    this.store.ensureNode({ id, key, kind: 'api_route', name: `${method} ${path}`, qualifiedName: `${method} ${path}`, meta: { method, path, missing: true } });
    return id;
  }

  private refreshRoutes(): void {
    this.routes = [...this.fileRoutes.values()].flat();
  }

  private refreshRouterMounts(changed: Set<string>, affected: Set<string>): void {
    const incoming = new Map<string, { parent: string; prefix: string }[]>();
    for (const [path, facts] of this.facts) {
      for (const mount of facts.routeMounts ?? []) {
        const ctx: Ctx = { path, facts, fileId: fileId(path), consulted: new Set(), edges: new Map() };
        const target = this.resolveName(ctx, path, mount.target);
        if (target?.kind !== 'symbol') continue;
        const key = `${target.file}#${target.symbol.qualifiedName}`;
        const list = incoming.get(key) ?? [];
        list.push({ parent: `${path}#${mount.router}`, prefix: mount.prefix });
        incoming.set(key, list);
      }
    }
    const prefixesOf = (key: string, visiting = new Set<string>()): string[] => {
      if (visiting.has(key)) return [];
      const mounts = incoming.get(key);
      if (!mounts) return [''];
      const next = new Set(visiting).add(key);
      return [...new Set(mounts.flatMap((mount) => prefixesOf(mount.parent, next).map((prefix) => mountedPath(prefix, mount.prefix))))].sort();
    };
    const prefixes = new Map([...incoming.keys()].map((key) => [key, prefixesOf(key)]));
    for (const [path, facts] of this.facts) {
      if (facts.routes.some((route) => {
        const key = `${path}#${route.router}`;
        return JSON.stringify(prefixes.get(key) ?? ['']) !== JSON.stringify(this.routerMountPrefixes.get(key) ?? ['']);
      })) { changed.add(path); affected.add(path); }
    }
    this.routerMountPrefixes = prefixes;
  }

  private routeSignature(): string {
    return this.routes
      .map((r) => r.id)
      .sort()
      .join(',');
  }

  private modelSignature(): string {
    return this.store
      .nodeIdsOfKind('database_model')
      .filter((id) => this.store.getNode(id)?.file)
      .sort()
      .join(',');
  }

  private collectGarbage(): void {
    for (const kind of ['external_service', 'database_model', 'api_route'] as const) {
      for (const id of this.store.nodeIdsOfKind(kind)) {
        const node = this.store.getNode(id);
        if (node && !node.file && this.store.degree(id) === 0) this.store.dropNode(id);
      }
    }
    let dropped = true;
    while (dropped) {
      dropped = false;
      for (const id of this.store.nodeIdsOfKind('folder')) {
        if (this.store.outEdges(id).length === 0) {
          this.store.dropNode(id);
          dropped = true;
        }
      }
    }
  }

  // ── relationships ────────────────────────────────────────────────────────

  private resolveFile(path: string): void {
    this.store.dropEdgesOwnedBy(path);
    this.setConsulted(path, new Set());
    this.unresolvedLocal.delete(path);
    this.httpCallers.delete(path);
    this.modelUsers.delete(path);
    const facts = this.facts.get(path);
    if (!facts) return;

    const ctx: Ctx = { path, facts, fileId: fileId(path), consulted: new Set(), edges: new Map() };
    this.structuralEdges(ctx);
    this.importEdges(ctx);
    this.heritageEdges(ctx);
    for (const ref of facts.references) this.referenceEdge(ctx, ref);
    for (const e of ctx.edges.values()) this.store.upsertEdge(e);
    ctx.consulted.delete(path);
    this.setConsulted(path, ctx.consulted);
  }

  private setConsulted(path: string, files: Set<string>): void {
    for (const f of this.consulted.get(path) ?? []) this.consultedBy.get(f)?.delete(path);
    this.consulted.set(path, files);
    for (const f of files) {
      let set = this.consultedBy.get(f);
      if (!set) this.consultedBy.set(f, (set = new Set()));
      set.add(path);
    }
  }

  private addEdge(ctx: Ctx, kind: CodeEdgeKind, source: string, target: string, line: number | undefined, confidence: number, meta?: Record<string, unknown>): void {
    if (!source || !target || source === target) return;
    const id = idFor(keys.edge(kind, source, target));
    const prev = ctx.edges.get(id);
    if (prev) {
      const merged: Record<string, unknown> = { ...prev.meta, count: ((prev.meta?.count as number | undefined) ?? 1) + 1 };
      // Several import statements of one file share an edge. The edge is as strong as the
      // strongest of them and points at its line, so a runtime import that follows a
      // type-only one is never hidden.
      if (importStrength(meta) > importStrength(prev.meta)) {
        delete merged.typeOnly;
        delete merged.dynamic;
        if (meta?.dynamic) merged.dynamic = true;
        if (line) prev.line = line;
      }
      if (Array.isArray(prev.meta?.names) && Array.isArray(meta?.names)) merged.names = [...new Set([...(prev.meta.names as string[]), ...(meta.names as string[])])];
      prev.meta = merged;
      prev.confidence = Math.max(prev.confidence, confidence);
      return;
    }
    const edge: CodeEdge = { id, kind, source, target, confidence: Math.round(confidence * 100) / 100, owner: ctx.path };
    if (line) edge.line = line;
    if (meta && Object.keys(meta).length) edge.meta = meta;
    ctx.edges.set(id, edge);
  }

  private structuralEdges(ctx: Ctx): void {
    const { path, facts, fileId: fid } = ctx;
    const dir = dirname(path);
    this.addEdge(ctx, 'CONTAINS', dir === '' ? this.repoId : idFor(keys.folder(dir)), fid, undefined, 1);
    const idx = symbolIndex(facts);
    for (const s of facts.symbols) {
      const sid = symbolId(path, s);
      const parent = s.parent ? idx.get(s.parent) : undefined;
      this.addEdge(ctx, 'CONTAINS', parent ? symbolId(path, parent) : fid, sid, undefined, 1);
      if (s.exported && !s.parent) this.addEdge(ctx, 'EXPORTS', fid, sid, undefined, 1);
    }
    for (const r of this.fileRoutes.get(path) ?? []) {
      this.addEdge(ctx, 'CONTAINS', fid, r.id, undefined, 1);
      for (const h of r.handlers) {
        const [head, ...rest] = h.split('.');
        const own = idx.get(head!);
        const byName: Target | null = own ? { kind: 'symbol', file: path, symbol: own } : this.resolveName(ctx, path, [head!]);
        // `export { GET } from '...'` has no local symbol; resolve it as an export.
        const t = byName ?? this.resolveExport(ctx, path, h);
        const res = t ? this.resolveMember(ctx, t, byName ? rest : [], undefined, 1) : null;
        if (res) this.addEdge(ctx, 'CALLS', r.id, res.target, r.line, res.confidence);
      }
    }
    for (const m of facts.models ?? []) {
      const mid = idFor(keys.model(m.name));
      this.addEdge(ctx, 'CONTAINS', fid, mid, undefined, 1);
      for (const rel of m.relations) {
        const target = idFor(keys.model(rel));
        if (this.store.hasNode(target)) this.addEdge(ctx, 'DEPENDS_ON', mid, target, m.line, 1, { via: 'relation' });
      }
    }
  }

  private importEdges(ctx: Ctx): void {
    const { path, facts, fileId: fid } = ctx;
    const sources: { source: string; line: number; typeOnly: boolean; dynamic?: boolean; names: string[]; sideEffect: boolean }[] = facts.imports.map((i) => ({
      source: i.source,
      line: i.line,
      typeOnly: i.typeOnly || (i.specifiers.length > 0 && i.specifiers.every((s) => s.typeOnly)),
      dynamic: i.dynamic,
      names: i.specifiers.map((s) => s.imported),
      sideEffect: i.specifiers.length === 0,
    }));
    for (const e of facts.exports) {
      if (e.kind === 'local') continue;
      sources.push({ source: e.source, line: e.line, typeOnly: false, names: [e.kind === 'reexport' ? e.imported : '*'], sideEffect: false });
    }
    const importFile = (target: string, imp: (typeof sources)[number], names: string[]) => {
      ctx.consulted.add(target);
      const meta: Record<string, unknown> = { names };
      if (imp.typeOnly) meta.typeOnly = true;
      if (imp.dynamic) meta.dynamic = true;
      this.addEdge(ctx, 'IMPORTS', fid, fileId(target), imp.line, 1, meta);
    };
    for (const imp of sources) {
      const res = this.resolver.resolve(path, imp.source);
      // `from pkg import sub` / `use crate::a::sub`: a name may itself be a module.
      const children: string[] = [];
      for (const name of imp.names) {
        const spec = this.resolver.childSpecifier(path, imp.source, name);
        const child = spec ? this.resolver.resolve(path, spec) : null;
        if (child?.kind === 'file' && (res.kind !== 'file' || child.path !== res.path)) {
          importFile(child.path, imp, [name]);
          children.push(name);
        }
      }
      if (res.kind === 'file') {
        const names = imp.names.filter((n) => !children.includes(n));
        if (names.length || imp.sideEffect || !children.length) importFile(res.path, imp, names);
      } else if (res.kind === 'files') {
        for (const f of this.packageFiles(ctx, res.paths, imp.source)) importFile(f, imp, imp.names);
      } else if (children.length) {
        continue;
      } else if (res.kind === 'unresolved' && res.local) {
        this.unresolvedLocal.add(path);
      } else if (res.kind === 'package' && !imp.typeOnly) {
        const p = providerForPackage(res.name);
        if (p) this.addEdge(ctx, 'USES', fid, this.externalNode(p), imp.line, 0.6, { via: 'import' });
      }
    }
  }

  /**
   * Files of a multi-file package an import actually depends on: the ones
   * declaring names this file uses from it. Falls back to every file when
   * nothing more specific is known.
   */
  private packageFiles(ctx: Ctx, paths: string[], source: string): string[] {
    const wanted = new Set<string>();
    // Names bound to this import (`order` in Go) and whether it is a wildcard (`using A.B;`).
    const bound = new Set<string>();
    let wildcard = false;
    for (const imp of ctx.facts.imports) {
      if (imp.source !== source) continue;
      if (imp.wildcard) wildcard = true;
      for (const s of imp.specifiers) {
        if (s.imported === '*') bound.add(s.local);
        else wanted.add(s.imported);
      }
    }
    // A Swift module import exposes every Uppercase name, like a wildcard.
    const wholeModule = wildcard || languageOfPath(ctx.path) === 'swift';
    const use = (chain: string[]) => {
      const [first, second] = chain;
      if (bound.has(first!) && second) wanted.add(second);
      else if (wholeModule && /^[A-Z]/.test(first!)) wanted.add(first!);
    };
    for (const ref of ctx.facts.references) use(ref.callee.map(strip));
    for (const s of ctx.facts.symbols) {
      const types = [...(s.extends ?? []), ...(s.implements ?? []), s.typeName, s.instanceOf, ...(s.fields ?? []).map((f) => f.type ?? f.instanceOf), ...Object.values(s.locals ?? {})];
      for (const t of types) if (t && !t.startsWith('call:')) use(t.split('.'));
    }
    const hits = paths.filter((f) => {
      const facts = this.facts.get(f);
      return !!facts && facts.symbols.some((s) => !s.parent && wanted.has(s.name));
    });
    // A wildcard import nothing is used from is noise (`using Acme.Shared;` out of habit),
    // but a named package import is a real dependency even when we cannot see what it uses.
    if (hits.length || wildcard || wholeModule) return hits;
    return paths.length <= 3 ? paths : paths.slice(0, 1);
  }

  private heritageEdges(ctx: Ctx): void {
    for (const s of ctx.facts.symbols) {
      if (!s.extends && !s.implements) continue;
      const sid = symbolId(ctx.path, s);
      for (const [list, kind] of [
        [s.extends, 'EXTENDS'],
        [s.implements, 'IMPLEMENTS'],
      ] as const) {
        for (const name of list ?? []) {
          const t = this.resolveName(ctx, ctx.path, name.split('.'));
          const r = t ? this.resolveMember(ctx, t, [], undefined, 1) : null;
          if (r) this.addEdge(ctx, kind, sid, r.target, s.startLine, r.confidence);
        }
      }
    }
  }

  private referenceEdge(ctx: Ctx, ref: ReferenceFact): void {
    const from = this.scopeNodeId(ctx, ref.from);
    if (ref.kind === 'call' && this.httpCall(ctx, ref, from)) return;
    const r = this.resolveRef(ctx, ref);
    if (!r) return;
    const kind = r.edgeKind ?? (ref.kind === 'call' || ref.kind === 'new' ? 'CALLS' : 'USES');
    const meta: Record<string, unknown> = { ...r.meta };
    if (ref.kind === 'jsx') meta.via = 'render';
    else if (ref.kind === 'new') meta.via = 'new';
    else if (ref.kind === 'ref') meta.via = 'ref';
    this.addEdge(ctx, kind, from, r.target, ref.line, r.confidence, meta);
  }

  private scopeNodeId(ctx: Ctx, from: string): string {
    if (from === '') return ctx.fileId;
    if (from.startsWith('route:')) return this.fileRoutes.get(ctx.path)?.find((r) => r.scope === from)?.id ?? ctx.fileId;
    const s = this.enclosingSymbol(ctx.facts, from);
    return s ? symbolId(ctx.path, s) : ctx.fileId;
  }

  private enclosingSymbol(facts: FileFacts, from: string): SymbolFact | undefined {
    const idx = symbolIndex(facts);
    let q = from;
    while (q) {
      const s = idx.get(q);
      if (s) return s;
      const dot = q.lastIndexOf('.');
      if (dot === -1) break;
      q = q.slice(0, dot);
    }
    return undefined;
  }

  private lookupLocal(facts: FileFacts, from: string, name: string): string | undefined {
    const idx = symbolIndex(facts);
    let q = from;
    while (q) {
      const v = idx.get(q)?.locals?.[name];
      if (v) return v;
      const dot = q.lastIndexOf('.');
      if (dot === -1) break;
      q = q.slice(0, dot);
    }
    return undefined;
  }

  private resolveRef(ctx: Ctx, ref: ReferenceFact): Resolved | null {
    const chain = ref.callee;
    const root = strip(chain[0]!);
    if (root === 'this' || root === 'super') return this.resolveThis(ctx, ref, root === 'super');
    const local = this.lookupLocal(ctx.facts, ref.from, root);
    if (local) {
      if (local.startsWith('call:')) {
        const t = this.resolveName(ctx, ctx.path, local.slice(5).split('.'));
        return t?.kind === 'external' ? this.memberOfExternal(ctx, t.provider, chain.slice(1), ref) : null;
      }
      const t = this.resolveName(ctx, ctx.path, local.split('.'));
      return t ? this.resolveMember(ctx, t, chain.slice(1), ref, 0.85) : null;
    }
    const t = this.resolveName(ctx, ctx.path, [root]);
    return t ? this.resolveMember(ctx, t, chain.slice(1), ref, 1) : null;
  }

  private resolveThis(ctx: Ctx, ref: ReferenceFact, isSuper: boolean): Resolved | null {
    const idx = symbolIndex(ctx.facts);
    const enclosing = this.enclosingSymbol(ctx.facts, ref.from);
    const ownerName = enclosing?.kind === 'class' ? enclosing.qualifiedName : enclosing?.parent;
    let owner = ownerName ? idx.get(ownerName) : undefined;
    let file = ctx.path;
    if (!owner && ownerName && languageOfPath(ctx.path) !== 'js') {
      // Go methods can live in a different file from their struct.
      const t = this.resolveName(ctx, ctx.path, [ownerName]);
      if (t?.kind === 'symbol') {
        owner = t.symbol;
        file = t.file;
      }
    }
    if (!owner) return null;
    const chain = ref.callee;
    if (isSuper) {
      const base = owner.extends?.[0];
      const t = base ? this.resolveName(ctx, file, base.split('.')) : null;
      if (t?.kind !== 'symbol') return null;
      owner = t.symbol;
      file = t.file;
    }
    if (chain.length === 1) return { target: symbolId(file, owner), confidence: 0.9 };
    const member = strip(chain[1]!);
    if (owner.kind === 'variable') {
      const m = idx.get(`${owner.qualifiedName}.${member}`);
      return m ? { target: symbolId(file, m), confidence: 0.9 } : null;
    }
    const method = this.findMethod(ctx, file, owner.qualifiedName, member);
    if (method && chain.length === 2) return { target: symbolId(method.file, method.symbol), confidence: 1 };
    const field = owner.fields?.find((f) => f.name === member);
    const typeRef = field?.instanceOf ?? field?.type;
    if (typeRef) {
      const t = this.resolveName(ctx, file, typeRef.split('.'));
      if (t) return this.resolveMember(ctx, t, chain.slice(2), ref, 0.95);
    }
    return method ? { target: symbolId(method.file, method.symbol), confidence: 0.8 } : null;
  }

  /** Resolves a name chain in `file`'s module scope (symbols, then imports). */
  private resolveName(ctx: Ctx, file: string, chain: string[]): Target | null {
    const facts = this.facts.get(file);
    if (!facts) return null;
    if (file !== ctx.path) ctx.consulted.add(file);
    const name = strip(chain[0]!);
    let t: Target | null = null;
    const sym = symbolIndex(facts).get(name);
    if (sym && !sym.parent) t = { kind: 'symbol', file, symbol: sym };
    else {
      const b = importBinding(facts, name);
      if (b) t = this.resolveImport(ctx, file, b.source, b.spec.imported);
      else if (languageOfPath(file) !== 'js') t = this.resolveImplicit(ctx, file, facts, name);
    }
    for (const part of chain.slice(1)) {
      if (t?.kind === 'package') t = this.packageExport(ctx, t.files, strip(part));
      else if (t?.kind === 'module') t = this.resolveExport(ctx, t.file, strip(part));
      else break;
    }
    return t;
  }

  /**
   * Names visible without a binding import: wildcard imports, other files
   * of the same Go package / Java or C# namespace / Swift target, names
   * from a whole-module Swift import, and repo-wide type names (Rails
   * autoloading, PHP / C# / Java fallback).
   */
  private resolveImplicit(ctx: Ctx, file: string, facts: FileFacts, name: string): Target | null {
    for (const imp of facts.imports) {
      if (!imp.wildcard) continue;
      const t = this.resolveImport(ctx, file, imp.source, name);
      if (!t || t.kind === 'module') continue;
      // `using Stripe;` cannot tell us which names are Stripe's; only trust `Stripe.X` itself.
      if (t.kind === 'external' && !namesPackage(name, imp.source)) continue;
      return t;
    }
    for (const mate of this.resolver.matesOf(file)) {
      const s = this.facts.get(mate) && symbolIndex(this.facts.get(mate)!).get(name);
      if (s && !s.parent) {
        ctx.consulted.add(mate);
        return { kind: 'symbol', file: mate, symbol: s };
      }
    }
    // Swift imports name whole modules: `import Shop` exposes its target's types.
    if (languageOfPath(file) === 'swift') {
      for (const imp of facts.imports) {
        const res = this.resolver.resolve(file, imp.source);
        if (res.kind !== 'files') continue;
        const t = this.packageExport(ctx, res.paths, name);
        if (t) return t;
      }
    }
    if (/^[A-Z]/.test(name)) {
      const files = this.resolver.globalType(file, name);
      // Only an unambiguous name; two `OrderService` classes would be a guess.
      if (files.length === 1) {
        const s = symbolIndex(this.facts.get(files[0]!)!).get(name);
        if (s) {
          ctx.consulted.add(files[0]!);
          return { kind: 'symbol', file: files[0]!, symbol: s };
        }
      }
    }
    return null;
  }

  /** `name` exported by any file of a multi-file package. */
  private packageExport(ctx: Ctx, files: string[], name: string): Target | null {
    for (const f of files) {
      const t = this.resolveExport(ctx, f, name);
      if (t) return t;
    }
    return null;
  }

  private resolveImport(ctx: Ctx, file: string, source: string, imported: string): Target | null {
    const res = this.resolver.resolve(file, source);
    if (res.kind === 'package') {
      const p = providerForPackage(res.name);
      return p ? { kind: 'external', provider: p } : null;
    }
    if (res.kind === 'files') {
      for (const f of res.paths) if (f !== ctx.path) ctx.consulted.add(f);
      return imported === '*' ? { kind: 'package', files: res.paths } : this.packageExport(ctx, res.paths, imported);
    }
    if (res.kind !== 'file') {
      // `from . import models` where the package has no __init__.py.
      const spec = this.resolver.childSpecifier(file, source, imported);
      const child = spec ? this.resolver.resolve(file, spec) : null;
      return child?.kind === 'file' ? { kind: 'module', file: child.path } : null;
    }
    if (res.path !== ctx.path) ctx.consulted.add(res.path);
    if (imported === '*') return { kind: 'module', file: res.path };
    return this.resolveExport(ctx, res.path, imported) ?? (imported === 'default' ? { kind: 'module', file: res.path } : null);
  }

  private resolveExport(ctx: Ctx, file: string, name: string): Target | null {
    const key = `${file}#${name}`;
    const cached = this.exportCache.get(key);
    if (cached) {
      for (const f of cached.files) if (f !== ctx.path) ctx.consulted.add(f);
      return cached.target;
    }
    if (this.exportVisiting.has(key)) return null;
    this.exportVisiting.add(key);
    const sub: Ctx = { ...ctx, consulted: new Set() };
    let target: Target | null = null;
    try {
      target = this.computeExport(sub, file, name);
    } finally {
      this.exportVisiting.delete(key);
    }
    sub.consulted.add(file);
    this.exportCache.set(key, { target, files: [...sub.consulted] });
    for (const f of sub.consulted) if (f !== ctx.path) ctx.consulted.add(f);
    return target;
  }

  private computeExport(ctx: Ctx, file: string, name: string): Target | null {
    const facts = this.facts.get(file);
    if (!facts) return null;
    for (const e of facts.exports) {
      if (e.kind === 'local' && e.exported === name) {
        const s = symbolIndex(facts).get(e.local);
        if (s) return { kind: 'symbol', file, symbol: s };
        const b = importBinding(facts, e.local);
        return b ? this.resolveImport(ctx, file, b.source, b.spec.imported) : null;
      }
      if (e.kind === 'reexport' && e.exported === name) return this.resolveImport(ctx, file, e.source, e.imported);
      if (e.kind === 'reexport-namespace' && e.exported === name) return this.resolveImport(ctx, file, e.source, '*');
    }
    if (name !== 'default') {
      for (const e of facts.exports) {
        if (e.kind !== 'reexport-all') continue;
        const r = this.resolver.resolve(file, e.source);
        if (r.kind !== 'file') continue;
        const t = this.resolveImport(ctx, file, e.source, name);
        if (t) return t;
      }
    }
    if (languageOfPath(file) !== 'js') return this.implicitExport(ctx, file, facts, name);
    return null;
  }

  /**
   * Languages without export statements: every top-level name is visible
   * (`Strings.trim` reaches a static method), names a module imported are
   * re-exported (Python `__init__.py`), and a missing name may be a
   * submodule (`pkg.sub`).
   */
  private implicitExport(ctx: Ctx, file: string, facts: FileFacts, name: string): Target | null {
    const s = symbolIndex(facts).get(name);
    if (s) return { kind: 'symbol', file, symbol: s };
    const b = importBinding(facts, name);
    if (b) return this.resolveImport(ctx, file, b.source, b.spec.imported);
    if (languageOfPath(file) === 'python') {
      for (const imp of facts.imports) {
        if (!imp.wildcard) continue;
        const t = this.resolveImport(ctx, file, imp.source, name);
        if (t) return t;
      }
    }
    const child = this.resolver.childModule(file, name);
    if (child) {
      ctx.consulted.add(child);
      return { kind: 'module', file: child };
    }
    return null;
  }

  private findMethod(ctx: Ctx, file: string, owner: string, member: string, depth = 0): { file: string; symbol: SymbolFact } | null {
    const facts = this.facts.get(file);
    if (!facts) return null;
    if (file !== ctx.path) ctx.consulted.add(file);
    const idx = symbolIndex(facts);
    const m = idx.get(`${owner}.${member}`);
    if (m) return { file, symbol: m };
    if (depth >= 5) return null;
    // Go methods and Swift extension members attach to a type from any file of their package / module.
    const lang = languageOfPath(file);
    const mates = lang === 'go' || lang === 'swift' ? this.resolver.matesOf(file) : [];
    for (const mate of mates) {
      const mm = symbolIndex(this.facts.get(mate)!).get(`${owner}.${member}`);
      if (mm) {
        ctx.consulted.add(mate);
        return { file: mate, symbol: mm };
      }
    }
    for (const base of idx.get(owner)?.extends ?? []) {
      const t = this.resolveName(ctx, file, base.split('.'));
      if (t?.kind === 'symbol') {
        const found = this.findMethod(ctx, t.file, t.symbol.qualifiedName, member, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  private resolveMember(ctx: Ctx, t: Target, rest: string[], ref: ReferenceFact | undefined, conf: number): Resolved | null {
    switch (t.kind) {
      case 'external':
        return this.memberOfExternal(ctx, t.provider, rest, ref);
      case 'package': {
        const e = rest.length ? this.packageExport(ctx, t.files, strip(rest[0]!)) : null;
        if (e) return this.resolveMember(ctx, e, rest.slice(1), ref, conf);
        return t.files.length === 1 ? { target: fileId(t.files[0]!), confidence: conf * 0.5 } : null;
      }
      case 'module': {
        if (rest.length === 0) return { target: fileId(t.file), confidence: conf * 0.9 };
        const e = this.resolveExport(ctx, t.file, strip(rest[0]!));
        if (e) return this.resolveMember(ctx, e, rest.slice(1), ref, conf);
        const d = this.resolveExport(ctx, t.file, 'default');
        if (d?.kind === 'symbol') return this.resolveMember(ctx, d, rest, ref, conf * 0.8);
        return { target: fileId(t.file), confidence: 0.5 };
      }
      case 'symbol':
        return this.memberOfSymbol(ctx, t.file, t.symbol, rest, ref, conf);
    }
  }

  private memberOfSymbol(ctx: Ctx, file: string, s: SymbolFact, rest: string[], ref: ReferenceFact | undefined, conf: number): Resolved | null {
    const sid = symbolId(file, s);
    if (rest.length === 0) {
      // `select(User)`, `new Order()`: code naming an ORM entity uses its model.
      const model = ref && s.kind === 'class' ? modelOf(this.facts.get(file), s.qualifiedName) : undefined;
      if (model) return { target: this.modelNode(ctx, model.name, model.orm), confidence: conf * 0.8 };
      return { target: sid, confidence: conf };
    }
    const member = strip(rest[0]!);
    const facts = this.facts.get(file)!;
    if (s.kind === 'interface') {
      // Java / C# / Go / Rust interfaces declare their methods; TypeScript ones carry no member symbols.
      const m = this.findMethod(ctx, file, s.qualifiedName, member);
      return { target: m ? symbolId(m.file, m.symbol) : sid, confidence: conf };
    }
    if (s.kind === 'class') {
      const m = this.findMethod(ctx, file, s.qualifiedName, member);
      // `db.Orders.Add(o)`: an EF Core DbSet property stands for its model.
      const viaProperty = m && modelOf(this.facts.get(m.file), m.symbol.qualifiedName);
      if (viaProperty) return this.modelAccess(ctx, viaProperty, rest.slice(1), conf);
      if (m) return { target: symbolId(m.file, m.symbol), confidence: conf };
      // `Order.objects.filter(...)`, `Order.where(...)`, `order.save()` on an ORM entity.
      const model = modelOf(facts, s.qualifiedName);
      if (model) return this.modelAccess(ctx, model, rest, conf);
      return { target: sid, confidence: conf * 0.7 };
    }
    if (s.kind !== 'variable') return { target: sid, confidence: conf };

    const direct = symbolIndex(facts).get(`${s.qualifiedName}.${member}`);
    if (direct) return { target: symbolId(file, direct), confidence: conf };
    if (this.store.getNode(sid)?.kind === 'database_model') {
      if (MODEL_WRITE.test(member)) return { target: sid, confidence: conf, edgeKind: 'WRITES_TO', meta: { op: member } };
      if (MODEL_READ.test(member)) return { target: sid, confidence: conf, edgeKind: 'READS_FROM', meta: { op: member } };
      return { target: sid, confidence: conf };
    }
    const typeRef = s.instanceOf ?? s.typeName;
    if (typeRef) {
      const t = this.resolveName(ctx, file, typeRef.split('.'));
      if (t?.kind === 'symbol' && (t.symbol.kind === 'class' || t.symbol.kind === 'interface')) {
        const m = this.findMethod(ctx, t.file, t.symbol.qualifiedName, member);
        return m ? { target: symbolId(m.file, m.symbol), confidence: conf * 0.95 } : { target: symbolId(t.file, t.symbol), confidence: conf * 0.7 };
      }
      if (t?.kind === 'external') return this.memberOfExternal(ctx, t.provider, rest, ref);
    }
    if (s.initCall) {
      const t = this.resolveName(ctx, file, s.initCall.split('.'));
      if (t?.kind === 'external') return this.memberOfExternal(ctx, t.provider, rest, ref);
    }
    return { target: sid, confidence: conf * 0.8 };
  }

  /** A read or write on an ORM model, judged by the last operation in the chain that looks like one. */
  private modelAccess(ctx: Ctx, model: ModelFact, rest: string[], conf: number): Resolved {
    const target = this.modelNode(ctx, model.name, model.orm);
    const ops = rest.map(strip).reverse();
    const write = ops.find((op) => MODEL_WRITE.test(op));
    if (write) return { target, confidence: conf * 0.9, edgeKind: 'WRITES_TO', meta: { op: write } };
    const read = ops.find((op) => MODEL_READ.test(op));
    if (read) return { target, confidence: conf * 0.9, edgeKind: 'READS_FROM', meta: { op: read } };
    return { target, confidence: conf * 0.8 };
  }

  private memberOfExternal(ctx: Ctx, p: ExternalProvider, rest: string[], ref: ReferenceFact | undefined): Resolved {
    const parts = rest.map(strip);
    if (p.id === 'prisma' && parts.length >= 2 && !parts[0]!.startsWith('$')) {
      const op = parts[1]!;
      const write = PRISMA_WRITE.has(op);
      if (write || PRISMA_READ.has(op)) {
        return { target: this.modelNode(ctx, pascal(parts[0]!), 'prisma'), confidence: 0.9, edgeKind: write ? 'WRITES_TO' : 'READS_FROM', meta: { op } };
      }
    }
    if (p.id === 'supabase' && parts[0] === 'from' && typeof ref?.args?.[0] === 'string') {
      return { target: this.modelNode(ctx, ref.args[0], 'supabase'), confidence: 0.7, edgeKind: 'READS_FROM', meta: { op: 'from' } };
    }
    const meta = parts.length ? { op: parts.join('.') } : undefined;
    return { target: this.externalNode(p), confidence: 0.9, edgeKind: 'USES', meta };
  }

  private httpCall(ctx: Ctx, ref: ReferenceFact, from: string): boolean {
    const chain = ref.callee;
    const head = strip(chain[0]!);
    const args = ref.args;
    const str = (a: ArgFact | undefined) => (typeof a === 'string' ? a : undefined);
    const obj = (a: ArgFact | undefined) => (a && typeof a === 'object' ? a : undefined);
    let url: string | undefined;
    let method: string | undefined;
    if (chain.length === 1 && FETCH_FUNCS.has(head) && !this.isShadowed(ctx, ref.from, head)) {
      url = str(args?.[0]);
      method = obj(args?.[1])?.method;
    } else if (chain.length === 2 && GLOBAL_OBJECTS.has(head) && chain[1] === 'fetch') {
      url = str(args?.[0]);
      method = obj(args?.[1])?.method;
    } else if (chain.length === 1 && head === 'axios') {
      const o = obj(args?.[0]);
      url = o?.url;
      method = o?.method;
    } else if (chain.length === 2 && HTTP_VERBS.has(chain[1]!.toLowerCase()) && this.isHttpClient(ctx, ref.from, head)) {
      url = str(args?.[0]);
      method = chain[1];
    } else if (languageOfPath(ctx.path) !== 'js') {
      const verb = FOREIGN_HTTP_VERB.exec(strip(chain[chain.length - 1]!))?.[1];
      if (verb && this.isForeignHttpClient(ctx, ref.from, chain.slice(0, -1).map(strip))) {
        url = str(args?.[0]);
        method = verb;
      }
    }
    if (!url) return false;
    this.httpCallers.add(ctx.path);
    const m = (method ?? 'GET').toUpperCase();
    if (/^https?:\/\//.test(url)) {
      const p = providerForUrl(url);
      if (p) this.addEdge(ctx, 'HTTP_CALL', from, this.externalNode(p), ref.line, 0.9, { method: m, url: url.slice(0, 200) });
      return true;
    }
    const path = normalizeUrlPath(url);
    if (!path) return true;
    const appRoot = this.appRootOf(ctx.path);
    const route = this.matchRoute(path, m, appRoot);
    if (route) this.addEdge(ctx, 'HTTP_CALL', from, route.id, ref.line, route.confidence, { method: m, url: path });
    // Only call a route "missing" where we know how routes are declared (this app has some).
    else if (path.startsWith('/api/') && this.routes.some((r) => r.appRoot === appRoot))
      this.addEdge(ctx, 'HTTP_CALL', from, this.missingRouteNode(m, path), ref.line, 0.5, { method: m, url: path, missing: true });
    return true;
  }

  /** A local or module symbol named like a global (e.g. a custom `fetch`) wins. */
  private isShadowed(ctx: Ctx, from: string, name: string): boolean {
    return !!symbolIndex(ctx.facts).get(name) || !!importBinding(ctx.facts, name) || !!this.lookupLocal(ctx.facts, from, name);
  }

  private isHttpClient(ctx: Ctx, from: string, name: string): boolean {
    const binding = importBinding(ctx.facts, name);
    if (HTTP_CLIENTS.has(name)) return !binding || HTTP_CLIENTS.has(packageName(binding.source));
    const local = this.lookupLocal(ctx.facts, from, name);
    if (local?.startsWith('call:')) return HTTP_FACTORIES.has(local.slice(5));
    const t = this.resolveName(ctx, ctx.path, [name]);
    return t?.kind === 'symbol' && !!t.symbol.initCall && HTTP_FACTORIES.has(t.symbol.initCall);
  }

  /**
   * HTTP clients outside JavaScript: modules (`requests`, Go `net/http`,
   * Laravel `Http`), Ruby / Rust globals (`HTTParty`, `reqwest`) and client
   * instances held in locals or fields (`HttpClient`, `RestTemplate`).
   */
  private isForeignHttpClient(ctx: Ctx, from: string, receiver: string[]): boolean {
    const lang = languageOfPath(ctx.path);
    if (receiver.length === 1) {
      const name = receiver[0]!;
      const binding = importBinding(ctx.facts, name);
      if (binding) return FOREIGN_HTTP_MODULES.has(binding.source);
      if (lang === 'ruby' || lang === 'rust') return FOREIGN_HTTP_GLOBALS.has(name);
      const local = this.lookupLocal(ctx.facts, from, name);
      return !!local && this.isHttpClientType(ctx, local);
    }
    if (receiver.length === 2 && receiver[0] === 'this') {
      const enclosing = this.enclosingSymbol(ctx.facts, from);
      const owner = enclosing?.kind === 'class' ? enclosing : enclosing?.parent ? symbolIndex(ctx.facts).get(enclosing.parent) : undefined;
      const field = owner?.fields?.find((f) => f.name === receiver[1]);
      const type = field?.instanceOf ?? field?.type;
      return !!type && this.isHttpClientType(ctx, type);
    }
    return false;
  }

  private isHttpClientType(ctx: Ctx, type: string): boolean {
    if (type.startsWith('call:')) return false;
    if (FOREIGN_HTTP_TYPES.has(type) || FOREIGN_HTTP_TYPES.has(type.split('.').pop()!)) return true;
    const binding = importBinding(ctx.facts, type.split('.')[0]!);
    return !!binding && /^(GuzzleHttp|System\.Net\.Http|org\.springframework\.web\.(client|reactive))/.test(binding.source);
  }

  private matchRoute(path: string, method: string, appRoot: string): { id: string; confidence: number } | null {
    let best: { id: string; score: number; exact: boolean } | null = null;
    for (const r of this.routes) {
      // A relative URL inside one Next.js app is served by that app, never by a sibling app.
      // Callers outside any Next.js app (an SPA behind a dev proxy) may still reach any server.
      if (appRoot && r.appRoot && r.appRoot !== appRoot) continue;
      const s = matchRoutePath(path, r.path);
      if (!s) continue;
      let score = s;
      if (r.appRoot === appRoot) score += 2;
      if (r.method === method) score += 2;
      else if (r.method === 'ANY') score += 1;
      else score -= 1;
      if (!best || score > best.score) best = { id: r.id, score, exact: r.method === method && !r.path.includes(':') && !r.path.includes('*') };
    }
    if (!best) return null;
    return { id: best.id, confidence: best.exact ? 0.95 : 0.8 };
  }
}
