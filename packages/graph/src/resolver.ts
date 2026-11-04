import { basename, dirname, join, normalize, type FileFacts, type SourceLanguage } from '@eyrie/core';

/** Path aliases from one tsconfig/jsconfig. All paths are repo-relative. */
export interface AliasConfig {
  /** Directory the config applies to ('' = repo root). */
  scope: string;
  baseUrl?: string;
  paths: { pattern: string; targets: string[] }[];
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  /** Entry file relative to `dir`, from package.json. */
  entry?: string;
}

/** A Go module from go.mod: imports under `path` live in `dir`. */
export interface GoModule {
  dir: string;
  path: string;
}

export interface ProjectConfig {
  aliases: AliasConfig[];
  workspaces: WorkspacePackage[];
  frameworks: string[];
  goModules?: GoModule[];
}

export const emptyProjectConfig = (): ProjectConfig => ({ aliases: [], workspaces: [], frameworks: [], goModules: [] });

export type Resolution =
  | { kind: 'file'; path: string }
  /** A package spanning several files: a Go package directory, a Java / C# namespace. */
  | { kind: 'files'; paths: string[] }
  | { kind: 'package'; name: string }
  | { kind: 'asset' }
  /** `local` = relative or aliased; it may resolve once the file exists. */
  | { kind: 'unresolved'; local: boolean };

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'];
const ASSET = /\.(json|css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|md|mdx|txt|html|wasm|graphql|gql|yaml|yml)$/i;

const LANGUAGE_BY_EXT: Record<string, SourceLanguage> = {
  py: 'python',
  go: 'go',
  java: 'java',
  rs: 'rust',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  rake: 'ruby',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  c: 'c',
  h: 'cpp',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  m: 'objc',
  lua: 'lua',
};
/** Languages whose imports name a type or namespace rather than a file. */
const QUALIFIED = new Set<string>(['java', 'csharp', 'php', 'kotlin']);
/** Languages where a bare type name can be visible repo-wide (Rails autoloading, PHP / C# / Java / Kotlin fallbacks). */
const GLOBAL_TYPES = new Set<string>(['ruby', 'php', 'csharp', 'java', 'kotlin']);
const TYPE_KINDS = new Set(['class', 'interface', 'enum', 'type']);
const PY_SOURCE_ROOTS = new Set(['', 'src', 'lib', 'app']);

/** The language family a path's imports follow; 'js' covers TypeScript and JavaScript. */
export function languageOfPath(path: string): SourceLanguage | 'js' {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? 'js';
}

/** Lookups over every file's path and facts; rebuilt lazily after `invalidate()`. */
interface Indexes {
  /** Python dotted module name → files, nearest source root first. */
  pyModules: Map<string, string[]>;
  /** Directory → its non-test Go files. */
  goDirs: Map<string, string[]>;
  /** `lang:ns.Type` → file (Java, C#, PHP). */
  qualified: Map<string, string>;
  /** `lang:namespace` → files. */
  namespaces: Map<string, string[]>;
  /** `lang:Type` → files that declare a top-level type with that simple name. */
  types: Map<string, string[]>;
  /** `lang:a.b` — leading namespace segments declared in this repo. */
  nsRoots: Set<string>;
  /** Directory → its Swift files. */
  swiftDirs: Map<string, string[]>;
  /** `Sources/<Target>` → the target's Swift files. */
  swiftTargets: Map<string, string[]>;
}

/**
 * A Swift file's target root: everything under `Sources/<Target>` (or
 * `Tests/<Target>`) is one module whose files see each other.
 */
function swiftTargetRoot(file: string): string | null {
  const m = /(Sources|Tests)\/[^/]+/.exec(file);
  return m ? m[0]! : null;
}

const push = (map: Map<string, string[]>, key: string, value: string) => {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else map.set(key, [value]);
};

export class ModuleResolver {
  private cache = new Map<string, Resolution>();
  private aliases: AliasConfig[] = [];
  private indexes: Indexes | null = null;

  constructor(
    private readonly files: ReadonlySet<string>,
    private config: ProjectConfig,
    private readonly factsOf: (path: string) => FileFacts | undefined = () => undefined,
  ) {
    this.setConfig(config);
  }

  setConfig(config: ProjectConfig): void {
    this.config = config;
    this.aliases = [...config.aliases].sort((a, b) => b.scope.length - a.scope.length);
    this.invalidate();
  }

  /** Call when files are added or removed, or a namespace / type declaration changes. */
  invalidate(): void {
    this.cache.clear();
    this.indexes = null;
  }

  resolve(importer: string, specifier: string): Resolution {
    const fromDir = dirname(importer);
    const lang = languageOfPath(importer);
    // Relative JS specifiers depend on the importer's directory; other languages may depend on the file itself.
    const cacheKey = lang === 'js' ? `${fromDir}\0${specifier}` : `${importer}\0${specifier}`;
    let hit = this.cache.get(cacheKey);
    if (!hit) {
      hit = this.compute(importer, fromDir, specifier);
      this.cache.set(cacheKey, hit);
    }
    return hit;
  }

  /**
   * The module a name inside another module refers to, when modules nest:
   * Python `from pkg import sub` and `pkg.sub`, Rust `use crate::a::b` where
   * `b` is a module. Null for languages without nested modules.
   */
  childModule(file: string, name: string): string | null {
    const lang = languageOfPath(file);
    if (lang === 'python') {
      const base = basename(file) === '__init__.py' ? dirname(file) : null;
      if (base === null) return null;
      return this.probeWith(join(base, name), ['.py', '/__init__.py']);
    }
    if (lang === 'rust') return this.probeWith(join(rustModDir(file), name), ['.rs', '/mod.rs']);
    return null;
  }

  /** Specifier for `name` imported from `source`, when it might be a submodule (Python, Rust). */
  childSpecifier(importer: string, source: string, name: string): string | null {
    if (name === '*' || name === 'default') return null;
    const lang = languageOfPath(importer);
    if (lang === 'python') return source.endsWith('.') ? `${source}${name}` : `${source}.${name}`;
    if (lang === 'rust') return `${source}::${name}`;
    return null;
  }

  /** Other files whose top-level names are visible without an import (same Go package, same namespace). */
  matesOf(file: string): string[] {
    const lang = languageOfPath(file);
    const idx = this.index();
    if (lang === 'go') return (idx.goDirs.get(dirname(file)) ?? []).filter((f) => f !== file);
    if (lang === 'swift') {
      const target = swiftTargetRoot(file);
      const files = target ? (idx.swiftTargets.get(target) ?? []) : (idx.swiftDirs.get(dirname(file)) ?? []);
      return files.filter((f) => f !== file);
    }
    if (!QUALIFIED.has(lang)) return [];
    const ns = this.factsOf(file)?.namespace;
    const same = idx.namespaces.get(`${lang}:${ns ?? ''}`) ?? [];
    // Without a namespace declaration, fall back to the directory.
    return (ns ? same : same.filter((f) => dirname(f) === dirname(file))).filter((f) => f !== file);
  }

  /** Files declaring a top-level type `name` that the importer's language can see without an import. */
  globalType(importer: string, name: string): string[] {
    const lang = languageOfPath(importer);
    if (!GLOBAL_TYPES.has(lang)) return [];
    return this.index().types.get(`${lang}:${name}`) ?? [];
  }

  private index(): Indexes {
    if (this.indexes) return this.indexes;
    const idx: Indexes = { pyModules: new Map(), goDirs: new Map(), qualified: new Map(), namespaces: new Map(), types: new Map(), nsRoots: new Set(), swiftDirs: new Map(), swiftTargets: new Map() };
    const pyPackages = new Set<string>();
    for (const f of this.files) if (f.endsWith('/__init__.py') || f === '__init__.py') pyPackages.add(dirname(f));
    for (const f of this.files) {
      const lang = languageOfPath(f);
      if (lang === 'python') this.indexPython(idx, f, pyPackages);
      else if (lang === 'go' && !f.endsWith('_test.go')) push(idx.goDirs, dirname(f), f);
      else if (lang === 'swift') {
        push(idx.swiftDirs, dirname(f), f);
        const target = swiftTargetRoot(f);
        if (target) push(idx.swiftTargets, target, f);
      }
      if (!GLOBAL_TYPES.has(lang)) continue;
      const facts = this.factsOf(f);
      if (!facts) continue;
      const ns = facts.namespace ?? '';
      push(idx.namespaces, `${lang}:${ns}`, f);
      if (ns) idx.nsRoots.add(`${lang}:${ns.split('.').slice(0, 2).join('.')}`);
      for (const s of facts.symbols) {
        if (s.parent || !TYPE_KINDS.has(s.kind)) continue;
        push(idx.types, `${lang}:${s.name}`, f);
        idx.qualified.set(`${lang}:${ns ? `${ns}.` : ''}${s.name}`, f);
      }
    }
    for (const list of idx.pyModules.values()) list.sort((a, b) => a.split('/').length - b.split('/').length);
    this.indexes = idx;
    return idx;
  }

  /**
   * Registers a Python file under the dotted names it can be imported as:
   * relative to the directory above its top-most package, and to every
   * ancestor directory above that (namespace packages, `src.` prefixes).
   */
  private indexPython(idx: Indexes, file: string, packages: Set<string>): void {
    const isInit = basename(file) === '__init__.py';
    const modPath = isInit ? dirname(file) : file.slice(0, -3);
    if (!modPath) return;
    const parts = modPath.split('/');
    let top = dirname(modPath);
    while (top && packages.has(top)) top = dirname(top);
    const rootDepth = top ? top.split('/').length : 0;
    for (let i = rootDepth; i >= 0; i--) {
      const name = parts.slice(i).join('.');
      if (name) push(idx.pyModules, name, file);
    }
  }

  // ── per-language resolution ──────────────────────────────────────────────

  private probeWith(base: string, suffixes: string[]): string | null {
    for (const s of suffixes) if (this.files.has(base + s)) return base + s;
    return null;
  }

  private resolveRelative(fromDir: string, specifier: string, suffixes: string[]): Resolution {
    const found = this.probeWith(join(fromDir, specifier), suffixes);
    if (found) return { kind: 'file', path: found };
    return ASSET.test(specifier) ? { kind: 'asset' } : { kind: 'unresolved', local: true };
  }

  private resolvePython(importer: string, specifier: string): Resolution {
    const dots = /^\.*/.exec(specifier)![0].length;
    const rest = specifier.slice(dots);
    if (dots > 0) {
      let dir = dirname(importer);
      for (let i = 1; i < dots; i++) dir = dirname(dir);
      const base = rest ? join(dir, rest.replace(/\./g, '/')) : dir;
      const found = rest ? this.probeWith(base, ['.py', '/__init__.py']) : this.probeWith(base, ['/__init__.py']);
      return found ? { kind: 'file', path: found } : { kind: 'unresolved', local: true };
    }
    const candidates = this.index().pyModules.get(rest) ?? [];
    const depth = rest.split('.').length;
    /** Directory the dotted name is relative to: `app.models` in `src/app/models.py` → 'src'. */
    const rootOf = (c: string) => {
      const parts = (c.endsWith('__init__.py') ? dirname(c) : c.slice(0, -3)).split('/');
      return parts.slice(0, parts.length - depth).join('/');
    };
    const sameProject = (c: string) => rootOf(c) === '' || importer.startsWith(`${rootOf(c)}/`);
    // A single segment shadows the standard library only from the same directory or a source root.
    const pick = depth > 1
      ? (candidates.find(sameProject) ?? candidates[0])
      : candidates.find((c) => rootOf(c) === dirname(importer) || PY_SOURCE_ROOTS.has(rootOf(c)));
    if (pick) return { kind: 'file', path: pick };
    return { kind: 'package', name: rest };
  }

  private resolveGo(specifier: string): Resolution {
    const idx = this.index();
    for (const m of this.config.goModules ?? []) {
      if (specifier !== m.path && !specifier.startsWith(`${m.path}/`)) continue;
      const dir = join(m.dir, specifier.slice(m.path.length + 1));
      const files = idx.goDirs.get(dir);
      return files?.length ? { kind: 'files', paths: files } : { kind: 'unresolved', local: true };
    }
    // No go.mod: match the longest directory suffix of at least two segments.
    const segs = specifier.split('/');
    if (segs[0]?.includes('.')) {
      for (let i = 1; i <= segs.length - 2; i++) {
        const suffix = segs.slice(i).join('/');
        for (const [dir, files] of idx.goDirs) {
          if (dir === suffix || dir.endsWith(`/${suffix}`)) return { kind: 'files', paths: files };
        }
      }
    }
    return { kind: 'package', name: specifier };
  }

  private resolveRust(importer: string, specifier: string): Resolution {
    const segs = specifier.split('::');
    let dir: string;
    let i = 1;
    if (segs[0] === 'crate') dir = rustCrateRoot(importer, this.files);
    else if (segs[0] === 'self') dir = rustModDir(importer);
    else if (segs[0] === 'super') {
      dir = dirname(rustModDir(importer));
      while (segs[i] === 'super') {
        dir = dirname(dir);
        i++;
      }
    } else {
      // `use foo::x` reaches a local module from its parent or the crate root, otherwise an external crate.
      const local = [rustModDir(importer), rustCrateRoot(importer, this.files)].find((d) => this.probeWith(join(d, segs[0]!), ['.rs', '/mod.rs']));
      if (local === undefined) return { kind: 'package', name: segs[0]! };
      dir = local;
      i = 0;
    }
    let file: string | null = null;
    if (i >= segs.length) file = ['lib.rs', 'main.rs', 'mod.rs'].map((f) => join(dir, f)).find((f) => this.files.has(f)) ?? null;
    for (; i < segs.length; i++) {
      file = this.probeWith(join(dir, segs[i]!), ['.rs', '/mod.rs']);
      if (!file) return { kind: 'unresolved', local: true };
      dir = join(dir, segs[i]!);
    }
    return file ? { kind: 'file', path: file } : { kind: 'unresolved', local: true };
  }

  private resolveRuby(fromDir: string, specifier: string): Resolution {
    if (specifier.startsWith('.')) return this.resolveRelative(fromDir, specifier, ['.rb', '']);
    for (const root of ['lib', '', 'app']) {
      const found = this.probeWith(join(root, specifier), ['.rb']);
      if (found) return { kind: 'file', path: found };
    }
    return { kind: 'package', name: specifier };
  }

  /**
   * Swift: `import Shop` → the `Sources/Shop` target's files, so cross-target
   * names resolve; anything else is an SDK or third-party module.
   */
  private resolveSwift(specifier: string): Resolution {
    const paths: string[] = [];
    for (const [root, files] of this.index().swiftTargets) {
      if (root.split('/').pop() === specifier) paths.push(...files);
    }
    if (paths.length) return { kind: 'files', paths: [...new Set(paths)].sort() };
    return { kind: 'package', name: specifier };
  }

  /**
   * Dart: relative URIs probe next to the importer; `package:` URIs map
   * under the nearest enclosing `lib/` (the same package), otherwise name
   * the external package; `dart:` libraries are the SDK.
   */
  private resolveDart(fromDir: string, specifier: string): Resolution {
    if (specifier.startsWith('dart:')) return { kind: 'package', name: specifier };
    const pkg = /^package:([^/]+)\/(.+)$/.exec(specifier);
    if (pkg) {
      const rest = pkg[2]!;
      const roots: string[] = [];
      let dir = fromDir;
      for (;;) {
        if (dir === 'lib' || dir.endsWith('/lib')) roots.push(dir);
        if (!dir) break;
        dir = dirname(dir);
      }
      roots.push('lib');
      for (const r of roots) {
        const candidate = join(r, rest);
        if (this.files.has(candidate)) return { kind: 'file', path: candidate };
      }
      return { kind: 'package', name: pkg[1]! };
    }
    return this.resolveRelative(fromDir, specifier, ['.dart', '']);
  }

  /**
   * Lua: `require('a.b.c')` probes `a/b/c.lua` then `a/b/c/init.lua`
   * next to the importer; anything else is an external rock (socket, cjson).
   */
  private resolveLua(fromDir: string, specifier: string): Resolution {
    const rel = specifier.replace(/^\.\//, '').replace(/\./g, '/');
    const found = this.probeWith(join(fromDir, rel), ['.lua', '/init.lua']);
    if (found) return { kind: 'file', path: found };
    return { kind: 'package', name: specifier };
  }

  /**
   * C / C++: angle includes are system headers; quoted includes probe
   * relative to the importer, then any unique same-suffix file (an `-I`
   * directory we cannot see). Bare names are `using` directives, not files.
   */
  private resolveC(fromDir: string, specifier: string): Resolution {
    const angle = /^<(.*)>$/.exec(specifier);
    if (angle) return { kind: 'package', name: angle[1]! };
    const direct = join(fromDir, specifier);
    if (this.files.has(direct)) return { kind: 'file', path: direct };
    const bare = !specifier.includes('.') && !specifier.includes('/');
    const suffix = `/${specifier}`;
    let match: string | null = null;
    for (const f of this.files) {
      if (!f.endsWith(suffix)) continue;
      if (match) return { kind: 'unresolved', local: !bare };
      match = f;
    }
    if (match) return { kind: 'file', path: match };
    return { kind: 'unresolved', local: !bare };
  }

  /** Java / C# / PHP / Kotlin: `a.b.Type` → its file, `a.b` (wildcard / using) → the namespace's files. */
  private resolveQualified(lang: string, specifier: string): Resolution {
    const name = specifier.replace(/^\\/, '').replace(/\\/g, '.');
    const idx = this.index();
    const parts = name.split('.');
    // Nested types: `a.b.Outer.Inner` lives in Outer's file.
    for (let n = parts.length; n >= 1; n--) {
      const file = idx.qualified.get(`${lang}:${parts.slice(0, n).join('.')}`);
      if (file) return { kind: 'file', path: file };
    }
    const nsFiles = idx.namespaces.get(`${lang}:${name}`);
    if (nsFiles?.length) return { kind: 'files', paths: nsFiles };
    if (idx.nsRoots.has(`${lang}:${parts.slice(0, 2).join('.')}`)) return { kind: 'unresolved', local: true };
    return { kind: 'package', name };
  }

  // ── JavaScript / TypeScript ──────────────────────────────────────────────

  private compute(importer: string, fromDir: string, specifier: string): Resolution {
    const lang = languageOfPath(importer);
    switch (lang) {
      case 'python':
        return this.resolvePython(importer, specifier);
      case 'go':
        return this.resolveGo(specifier);
      case 'rust':
        return this.resolveRust(importer, specifier);
      case 'ruby':
        return this.resolveRuby(fromDir, specifier);
      case 'swift':
        return this.resolveSwift(specifier);
      case 'c':
      case 'cpp':
      case 'objc':
        return this.resolveC(fromDir, specifier);
      case 'dart':
        return this.resolveDart(fromDir, specifier);
      case 'lua':
        return this.resolveLua(fromDir, specifier);
      case 'java':
      case 'csharp':
      case 'php':
      case 'kotlin':
        if (specifier.startsWith('.')) return this.resolveRelative(fromDir, specifier, ['']);
        return this.resolveQualified(lang, specifier);
      default:
        break;
    }

    const clean = specifier.split('?')[0]!;
    if (clean.startsWith('.')) {
      const found = this.probe(join(fromDir, clean));
      if (found) return { kind: 'file', path: found };
      return ASSET.test(clean) ? { kind: 'asset' } : { kind: 'unresolved', local: true };
    }
    if (clean.startsWith('/')) return { kind: 'unresolved', local: false };

    const scope = this.aliases.find((a) => a.scope === '' || importer.startsWith(`${a.scope}/`));
    if (scope) {
      let matchedAlias = false;
      for (const { pattern, targets } of scope.paths) {
        const captured = matchPattern(pattern, clean);
        if (captured === null) continue;
        matchedAlias = true;
        for (const target of targets) {
          const found = this.probe(normalize(target.replace('*', captured)));
          if (found) return { kind: 'file', path: found };
        }
      }
      if (scope.baseUrl !== undefined) {
        const found = this.probe(join(scope.baseUrl, clean));
        if (found) return { kind: 'file', path: found };
      }
      if (matchedAlias) return ASSET.test(clean) ? { kind: 'asset' } : { kind: 'unresolved', local: true };
    }

    for (const ws of this.config.workspaces) {
      if (clean !== ws.name && !clean.startsWith(`${ws.name}/`)) continue;
      const sub = clean.slice(ws.name.length + 1);
      const tries = sub
        ? [join(ws.dir, sub), join(ws.dir, 'src', sub)]
        : [
            ...(ws.entry ? [join(ws.dir, ws.entry), join(ws.dir, ws.entry.replace(/^(\.\/)?(dist|build|lib)\//, 'src/'))] : []),
            join(ws.dir, 'src/index'),
            join(ws.dir, 'index'),
          ];
      for (const t of tries) {
        const found = this.probe(t);
        if (found) return { kind: 'file', path: found };
      }
      return { kind: 'unresolved', local: true };
    }

    if (ASSET.test(clean)) return { kind: 'asset' };
    return { kind: 'package', name: clean };
  }

  private probe(base: string): string | null {
    if (this.files.has(base) && !base.endsWith('.d.ts')) return base;
    for (const ext of CODE_EXTENSIONS) if (this.files.has(base + ext)) return base + ext;
    const js = /\.[mc]?jsx?$/.exec(base);
    if (js) {
      const stem = base.slice(0, -js[0].length);
      for (const ext of ['.ts', '.tsx', '.mts', '.cts']) if (this.files.has(stem + ext)) return stem + ext;
    }
    for (const ext of CODE_EXTENSIONS) if (this.files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    return null;
  }
}

/** Directory holding a Rust file's child modules: `src/a.rs` → `src/a`, `src/a/mod.rs` → `src/a`. */
function rustModDir(file: string): string {
  const name = basename(file);
  if (name === 'lib.rs' || name === 'main.rs' || name === 'mod.rs') return dirname(file);
  return join(dirname(file), name.slice(0, -3));
}

/** Nearest ancestor directory with a lib.rs or main.rs. */
function rustCrateRoot(file: string, files: ReadonlySet<string>): string {
  let dir = dirname(file);
  for (;;) {
    if (files.has(join(dir, 'lib.rs')) || files.has(join(dir, 'main.rs'))) return dir;
    if (dir === '') return dirname(file);
    dir = dirname(dir);
  }
}

/** Returns the text captured by `*`, '' for an exact match, or null. */
function matchPattern(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  if (specifier.length < prefix.length + suffix.length) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}
