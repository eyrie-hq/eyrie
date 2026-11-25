import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { detectLanguage } from '@eyrie/parser';

/** Directories never worth indexing. */
export const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.vercel',
  '.netlify',
  '.cache',
  '.output',
  '.expo',
  '.eyrie',
  '.idea',
  'dist',
  'build',
  'out',
  'coverage',
  'storybook-static',
  'vendor',
  '__snapshots__',
]);

const IGNORED_FILES = /(\.min\.[cm]?js|\.bundle\.js|\.d\.[cm]?ts|\.map)$/;
const CONFIG_FILES =
  /(^|\/)(tsconfig(\.[\w-]+)?\.json|jsconfig\.json|package\.json|go\.mod|pyproject\.toml|requirements(-\w+)?\.txt|Pipfile|pom\.xml|build\.gradle(\.kts)?|[\w.-]+\.csproj|composer\.json|Gemfile|Cargo\.toml)$/;
export const MAX_FILE_BYTES = 1_000_000;

export function isConfigFile(rel: string): boolean {
  return CONFIG_FILES.test(rel);
}

/** `.gitignore` and `.eyrieignore`, at any depth. */
export function isIgnoreFile(rel: string): boolean {
  return /(^|\/)\.(git|eyrie)ignore$/.test(rel);
}

export function isSourceFile(rel: string): boolean {
  return !IGNORED_FILES.test(rel) && detectLanguage(rel) !== null;
}

/** `.gitignore` / `.eyrieignore` rules, including nested ignore files. */
export class IgnoreRules {
  private rules = new Map<string, Ignore>();

  constructor(private readonly root: string) {
    this.loadDir('');
  }

  private loadDir(dir: string): void {
    const ig = ignore();
    let found = false;
    for (const name of ['.gitignore', '.eyrieignore']) {
      const file = join(this.root, dir, name);
      if (existsSync(file)) {
        ig.add(readFileSync(file, 'utf8'));
        found = true;
      }
    }
    if (found) this.rules.set(dir, ig);
  }

  /** Called while walking so nested ignore files are picked up. */
  enterDir(dir: string): void {
    if (dir && !this.rules.has(dir)) this.loadDir(dir);
  }

  ignores(rel: string, isDir: boolean): boolean {
    const segments = rel.split('/');
    const dirSegments = isDir ? segments : segments.slice(0, -1);
    if (dirSegments.some((s) => DEFAULT_IGNORED_DIRS.has(s))) return true;
    for (const [dir, ig] of this.rules) {
      if (dir && !rel.startsWith(`${dir}/`)) continue;
      const sub = dir ? rel.slice(dir.length + 1) : rel;
      if (sub && ig.ignores(isDir ? `${sub}/` : sub)) return true;
    }
    return false;
  }
}

export interface ScannedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface ScanResult {
  sources: ScannedFile[];
  /** tsconfig/jsconfig/package.json and other ecosystems' manifests (repo-relative). */
  configs: string[];
}

export function scanRepository(root: string, rules: IgnoreRules): ScanResult {
  const sources: ScannedFile[] = [];
  const configs: string[] = [];
  const walk = (dir: string) => {
    rules.enterDir(dir);
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!rules.ignores(rel, true)) walk(rel);
      } else if (entry.isFile()) {
        if (isConfigFile(rel)) {
          if (!rules.ignores(rel, false)) configs.push(rel);
          continue;
        }
        if (!isSourceFile(rel) || rules.ignores(rel, false)) continue;
        const st = statSync(join(root, rel));
        if (st.size > MAX_FILE_BYTES) continue;
        sources.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk('');
  sources.sort((a, b) => a.path.localeCompare(b.path));
  configs.sort();
  return { sources, configs };
}
