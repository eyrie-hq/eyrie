import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import JSON5 from 'json5';
import type { AliasConfig, GoModule, ProjectConfig, WorkspacePackage } from '@eyrie/graph';

const toPosix = (p: string) => p.split(sep).join('/');
const rel = (root: string, abs: string) => toPosix(relative(root, abs));

const FRAMEWORK_DEPS: Record<string, string> = {
  next: 'next',
  react: 'react',
  vue: 'vue',
  astro: 'astro',
  svelte: 'svelte',
  express: 'express',
  fastify: 'fastify',
  hono: 'hono',
  koa: 'koa',
  '@nestjs/core': 'nestjs',
  '@prisma/client': 'prisma',
  prisma: 'prisma',
  'drizzle-orm': 'drizzle',
  mongoose: 'mongoose',
  '@trpc/server': 'trpc',
};

const PY_MANIFEST = /(pyproject\.toml|requirements(-\w+)?\.txt|Pipfile)$/;

/** A Python requirement, whether one per line, in a PEP 621 list or a Poetry table. */
function pyDep(name: string): RegExp {
  return new RegExp(`(^|["'\\s,\\[])${name}([<>=~!\\[\\s"',;\\]]|$)`, 'im');
}

/** Frameworks recognised in other ecosystems' manifests, by a dependency name found in the file. */
const MANIFEST_FRAMEWORKS: [RegExp, RegExp, string][] = [
  // [manifest file, dependency pattern, framework]
  [PY_MANIFEST, pyDep('django'), 'django'],
  [PY_MANIFEST, pyDep('flask'), 'flask'],
  [PY_MANIFEST, pyDep('fastapi'), 'fastapi'],
  [PY_MANIFEST, pyDep('sqlalchemy'), 'sqlalchemy'],
  [/go\.mod$/, /github\.com\/gin-gonic\/gin\b/, 'gin'],
  [/go\.mod$/, /github\.com\/labstack\/echo\b/, 'echo'],
  [/go\.mod$/, /github\.com\/go-chi\/chi\b/, 'chi'],
  [/go\.mod$/, /github\.com\/gofiber\/fiber\b/, 'fiber'],
  [/go\.mod$/, /gorm\.io\/gorm\b/, 'gorm'],
  [/(pom\.xml|build\.gradle(\.kts)?)$/, /spring-boot/, 'spring'],
  [/(pom\.xml|build\.gradle(\.kts)?)$/, /io\.quarkus/, 'quarkus'],
  [/(pom\.xml|build\.gradle(\.kts)?)$/, /io\.micronaut/, 'micronaut'],
  [/(pom\.xml|build\.gradle(\.kts)?)$/, /hibernate|spring-boot-starter-data-jpa/, 'jpa'],
  [/\.csproj$/, /Sdk="Microsoft\.NET\.Sdk\.Web"|Microsoft\.AspNetCore/, 'aspnet'],
  [/\.csproj$/, /Microsoft\.EntityFrameworkCore/, 'efcore'],
  [/composer\.json$/, /"laravel\/framework"/, 'laravel'],
  [/composer\.json$/, /"symfony\/framework-bundle"/, 'symfony'],
  [/Gemfile$/, /^\s*gem\s+["']rails["']/m, 'rails'],
  [/Gemfile$/, /^\s*gem\s+["']sinatra["']/m, 'sinatra'],
  [/Cargo\.toml$/, /^\s*axum\s*=/m, 'axum'],
  [/Cargo\.toml$/, /^\s*actix-web\s*=/m, 'actix'],
  [/Cargo\.toml$/, /^\s*rocket\s*=/m, 'rocket'],
  [/Cargo\.toml$/, /^\s*diesel\s*=/m, 'diesel'],
  [/Cargo\.toml$/, /^\s*sea-orm\s*=/m, 'sea-orm'],
];

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

interface TsconfigPaths {
  baseUrl?: string;
  paths?: Record<string, string[]>;
  pathsBase?: string;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON5.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readTsconfig(root: string, file: string, depth = 0): TsconfigPaths {
  const json = readJson(file);
  if (!json || depth > 8) return {};
  let merged: TsconfigPaths = {};
  const ext = json.extends;
  for (const parent of Array.isArray(ext) ? ext : ext ? [ext] : []) {
    if (typeof parent !== 'string') continue;
    const candidates = parent.startsWith('.')
      ? [resolve(dirname(file), parent), resolve(dirname(file), `${parent}.json`)]
      : [join(root, 'node_modules', parent), join(root, 'node_modules', `${parent}.json`), join(root, 'node_modules', parent, 'tsconfig.json')];
    const found = candidates.find((c) => existsSync(c) && c.endsWith('.json'));
    if (found) merged = { ...merged, ...readTsconfig(root, found, depth + 1) };
  }
  const co = (json.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
  if (typeof co.baseUrl === 'string') merged.baseUrl = resolve(dirname(file), co.baseUrl);
  if (co.paths && typeof co.paths === 'object') {
    merged.paths = co.paths;
    merged.pathsBase = dirname(file);
  }
  if (merged.paths && merged.baseUrl) merged.pathsBase = merged.baseUrl;
  return merged;
}

function packageEntry(pkg: Record<string, unknown>): string | undefined {
  const exp = pkg.exports as unknown;
  let entry: unknown;
  if (typeof exp === 'string') entry = exp;
  else if (exp && typeof exp === 'object') {
    const dot = (exp as Record<string, unknown>)['.'] ?? exp;
    if (typeof dot === 'string') entry = dot;
    else if (dot && typeof dot === 'object') {
      const d = dot as Record<string, unknown>;
      entry = d.types ?? d.import ?? d.default ?? d.require;
      if (entry && typeof entry === 'object') entry = (entry as Record<string, unknown>).default;
    }
  }
  entry ??= pkg.module ?? pkg.main ?? pkg.types;
  return typeof entry === 'string' ? entry.replace(/^\.\//, '') : undefined;
}

export interface LoadedConfig {
  name: string;
  config: ProjectConfig;
}

/** Reads tsconfig/jsconfig path aliases, workspace packages, Go modules and frameworks (from every ecosystem's manifest). */
export function loadProjectConfig(root: string, configFiles: string[]): LoadedConfig {
  const rootPkg = readJson(join(root, 'package.json'));
  const name = (typeof rootPkg?.name === 'string' && rootPkg.name) || basename(root);
  const frameworks = new Set<string>();
  const workspaces: WorkspacePackage[] = [];
  const aliasByScope = new Map<string, AliasConfig>();

  const goModules: GoModule[] = [];

  for (const file of configFiles) {
    const abs = join(root, file);
    const base = basename(file);
    if (base === 'go.mod') {
      const path = /^module\s+"?([^\s"]+)"?/m.exec(readText(abs) ?? '')?.[1];
      const dir = toPosix(dirname(file));
      if (path) goModules.push({ dir: dir === '.' ? '' : dir, path });
    }
    const manifest = MANIFEST_FRAMEWORKS.filter(([pattern]) => pattern.test(base));
    if (manifest.length) {
      const text = readText(abs) ?? '';
      for (const [, dep, fw] of manifest) if (dep.test(text)) frameworks.add(fw);
      continue;
    }
    if (base === 'package.json') {
      const pkg = readJson(abs);
      if (!pkg) continue;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const dep of Object.keys((pkg[field] as Record<string, string> | undefined) ?? {})) {
          const fw = FRAMEWORK_DEPS[dep];
          if (fw) frameworks.add(fw);
        }
      }
      const dir = toPosix(dirname(file));
      if (dir !== '.' && typeof pkg.name === 'string') workspaces.push({ name: pkg.name, dir, entry: packageEntry(pkg) });
      continue;
    }
    const ts = readTsconfig(root, abs);
    if (!ts.paths && !ts.baseUrl) continue;
    const scope = toPosix(dirname(file)) === '.' ? '' : toPosix(dirname(file));
    const alias = aliasByScope.get(scope) ?? { scope, paths: [] };
    if (ts.baseUrl && alias.baseUrl === undefined) alias.baseUrl = rel(root, ts.baseUrl);
    for (const [pattern, targets] of Object.entries(ts.paths ?? {})) {
      if (alias.paths.some((p) => p.pattern === pattern)) continue;
      alias.paths.push({ pattern, targets: targets.map((t) => rel(root, resolve(ts.pathsBase!, t))) });
    }
    aliasByScope.set(scope, alias);
  }

  return {
    name,
    config: {
      aliases: [...aliasByScope.values()],
      workspaces: workspaces.sort((a, b) => b.name.length - a.name.length),
      frameworks: [...frameworks].sort(),
      goModules: goModules.sort((a, b) => b.path.length - a.path.length),
    },
  };
}
