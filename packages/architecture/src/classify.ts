import type { ArchCategory, ArchKind, ArchLane, FileFacts, SymbolFact } from '@eyrie/core';
import type { NextFileInfo } from '@eyrie/graph';

/** What a source file is, architecturally. */
export type FileRole =
  | 'page'
  | 'layout'
  | 'component'
  | 'hook'
  | 'middleware'
  | 'api_route'
  | 'server_action'
  | 'service'
  | 'repository'
  | 'job'
  | 'module'
  /** Instantiates an SDK client (e.g. lib/openai.ts); folded into that external service. */
  | 'client'
  /** Declares data models only (schema.prisma, drizzle schema). */
  | 'schema'
  /** Tests, specs, fixtures and stories: never shown in the architecture. */
  | 'test'
  /** Only re-exports other modules (index.ts barrels). */
  | 'barrel';

const REPO_DIRS = /^(repositories|repository|repos|dal|dao|data-access|persistence)$/;
const SERVICE_DIRS = /^(services|service|controllers|controller|usecases|use-cases|server|handlers)$/;
const JOB_DIRS = /^(jobs|workers|queues|cron|tasks|inngest|trigger|consumers)$/;
const TEST_DIRS = /^(__tests__|__mocks__|tests?|spec|e2e|cypress|playwright|fixtures?|__fixtures__|stories|storybook|mocks?|testdata)$/;
const TEST_FILE = new RegExp(
  [
    String.raw`\.(test|spec|stories|story|e2e|cy|bench)\.[mc]?[jt]sx?$`,
    String.raw`(^|/)(test_[^/]*|[^/]*_test|conftest)\.py$`,
    String.raw`_test\.go$`,
    String.raw`(Tests?|IT|Spec)\.(java|cs|php|kt|kts)$`,
    String.raw`Tests?\.swift$`,
    String.raw`_(spec|test)\.rb$`,
    String.raw`(^|/)(test_[^/]*|[^/]*_test)\.(c|h|cpp|hpp|cc|cxx|hh|hxx)$`,
    String.raw`(Test|Tests)\.(c|cpp|cc|cxx)$`,
    String.raw`_test\.dart$`,
    String.raw`\.(spec|test)\.vue$`,
    String.raw`Tests?\.m$`,
    String.raw`(^|/)(test_[^/]*|[^/]*_spec)\.lua$`,
  ].join('|'),
);
/** Any source extension: `.ts`, `.py`, `.go`, `.java`, ... */
const SOURCE_EXT = String.raw`\.(?:[mc]?[jt]sx?|py|go|java|rs|cs|php|rb|kt|kts|swift|c|h|cpp|hpp|cc|cxx|hh|hxx|dart|vue|m|lua)$`;
const REPO_FILE = new RegExp(String.raw`[._-](repository|repo|dao)` + SOURCE_EXT, 'i');
// Celery `tasks.py` and Django `views.py` are conventions; elsewhere those names mean nothing.
const JOB_FILE = new RegExp(String.raw`[._-](job|worker)` + SOURCE_EXT + String.raw`|^tasks\.py$`, 'i');
const SERVICE_FILE = new RegExp(String.raw`[._-](service|controller|usecase|handler)s?` + SOURCE_EXT + String.raw`|^views\.py$`, 'i');
const SERVICE_NAME = /(Service|Client|Gateway|Manager|Provider|Adapter|Controller|Handler|Engine|Processor)$/;
const REPO_NAME = /(Repository|Repo|Dao|DAO)$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path) || path.split('/').slice(0, -1).some((d) => TEST_DIRS.test(d));
}

export interface ClassifyInput {
  path: string;
  facts: FileFacts;
  next: NextFileInfo | null;
  /** True when every exported symbol is an SDK client instance. */
  isClientWrapper: boolean;
  /** True when the file only declares data models. */
  isSchema: boolean;
}

export function exportedSymbols(facts: FileFacts): SymbolFact[] {
  return facts.symbols.filter((s) => s.exported && !s.parent);
}

export function classifyFile({ path, facts, next, isClientWrapper, isSchema }: ClassifyInput): FileRole {
  if (isTestFile(path)) return 'test';
  if (next?.role === 'page') return 'page';
  if (next?.role === 'layout') return 'layout';
  if (next?.role === 'route' || next?.role === 'api-page') return 'api_route';
  if (next?.role === 'middleware') return 'middleware';
  if (facts.routes.length) return 'api_route';
  if (facts.directives.includes('use server')) return 'server_action';
  if (isSchema) return 'schema';
  if (isClientWrapper) return 'client';
  if (facts.symbols.length === 0 && facts.exports.length > 0 && facts.exports.every((e) => e.kind !== 'local')) return 'barrel';

  const segs = path.split('/').slice(0, -1);
  const file = path.split('/').pop()!.toLowerCase();
  const exported = exportedSymbols(facts);
  // Name suffixes only count for classes and service objects, not functions like `scanRepository()`.
  // Outside TypeScript an interface is a real component (Spring Data `interface OrderRepository`).
  const isJs = facts.language === 'typescript' || facts.language === 'tsx' || facts.language === 'javascript' || facts.language === 'jsx';
  const isLogicSymbol = (s: SymbolFact) => s.kind === 'class' || s.kind === 'variable' || (s.kind === 'interface' && !isJs);

  if (exported.some((s) => isLogicSymbol(s) && REPO_NAME.test(s.name)) || segs.some((d) => REPO_DIRS.test(d)) || REPO_FILE.test(file)) {
    return 'repository';
  }
  if (segs.some((d) => JOB_DIRS.test(d)) || JOB_FILE.test(file)) return 'job';
  if (exported.some((s) => s.kind === 'react_component') || (facts.language === 'tsx' || facts.language === 'jsx') && facts.symbols.some((s) => s.kind === 'react_component')) {
    return 'component';
  }
  if (exported.some((s) => s.kind === 'hook') || segs.includes('hooks')) return 'hook';
  if (exported.some((s) => isLogicSymbol(s) && SERVICE_NAME.test(s.name)) || segs.some((d) => SERVICE_DIRS.test(d)) || SERVICE_FILE.test(file)) {
    return 'service';
  }
  return 'module';
}

export const ROLE_KIND: Record<Exclude<FileRole, 'client' | 'schema' | 'test' | 'barrel'>, ArchKind> = {
  page: 'page',
  layout: 'component',
  component: 'component',
  hook: 'hook',
  middleware: 'middleware',
  api_route: 'api_route',
  server_action: 'server_action',
  service: 'service',
  repository: 'repository',
  job: 'background_job',
  module: 'module',
};

export function laneOf(kind: ArchKind): ArchLane {
  switch (kind) {
    case 'page':
    case 'component':
    case 'hook':
      return 'ui';
    case 'middleware':
      return 'edge';
    case 'api_route':
    case 'server_action':
      return 'api';
    case 'service':
    case 'module':
    case 'background_job':
    case 'queue':
      return 'logic';
    case 'repository':
    case 'database_model':
      return 'data';
    case 'external_service':
      return 'external';
  }
}

export function categoryOf(kind: ArchKind, externalCategory?: string): ArchCategory {
  switch (kind) {
    case 'page':
    case 'component':
    case 'hook':
      return 'frontend';
    case 'middleware':
    case 'api_route':
    case 'server_action':
      return 'api';
    case 'service':
    case 'background_job':
    case 'queue':
      return 'service';
    case 'repository':
    case 'database_model':
      return 'data';
    case 'module':
      return 'utility';
    case 'external_service':
      if (externalCategory === 'ai') return 'ai';
      if (externalCategory === 'database') return 'data';
      return 'external';
  }
}

// ── naming ─────────────────────────────────────────────────────────────────

export const STRUCTURAL_DIRS = new Set([
  'src', 'app', 'apps', 'pages', 'api', 'lib', 'libs', 'utils', 'util', 'helpers', 'components', 'component', 'ui',
  'hooks', 'services', 'service', 'server', 'client', 'shared', 'common', 'core', 'features', 'feature', 'modules',
  'module', 'repositories', 'repository', 'controllers', 'routes', 'actions', 'models', 'db', 'data', 'packages',
  'internal', 'domain', 'jobs', 'workers', 'types', 'config', 'store', 'stores', 'context', 'providers',
]);

export function words(name: string): string[] {
  return name
    .replace(/\.(service|controller|repository|repo|route|routes|actions?|hooks?|utils?|helpers?|store|model|schema|client)$/i, ' $1')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._\-\[\]()]+/)
    .filter(Boolean);
}

export function titleCase(parts: string[]): string {
  return parts.map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

export function fileStem(path: string): string {
  const segs = path.split('/');
  const stem = segs.pop()!.replace(new RegExp(SOURCE_EXT), '');
  if (!['index', '__init__', 'mod', 'lib', 'main'].includes(stem)) return stem;
  // index.ts / __init__.py / mod.rs are named after their folder, skipping structural folders: packages/core/src/index.ts → core
  while (segs.length && ['src', 'lib', 'dist', 'source'].includes(segs[segs.length - 1]!)) segs.pop();
  return segs.pop() ?? stem;
}

export function routeLabel(path: string, suffix: string): string {
  const segs = path.split('/').filter(Boolean);
  const rest = segs[0] === 'api' ? segs.slice(1) : segs;
  const named = rest.filter((s) => !s.startsWith(':') && !s.startsWith('*'));
  const trailingParam = rest.length > 0 && (rest[rest.length - 1]!.startsWith(':') || rest[rest.length - 1]!.startsWith('*'));
  if (named.length === 0) return segs[0] === 'api' ? `Root ${suffix}` : `Home ${suffix}`;
  const base = titleCase(named.flatMap(words));
  return `${base}${trailingParam ? ' Detail' : ''} ${suffix}`;
}

/** Feature domain guessed from the path: `src/services/resume.service.ts` → 'resume'. */
export function domainOf(path: string, fallbackName?: string): string | undefined {
  const segs = path.split('/');
  const dirs = segs.slice(0, -1).filter((s) => !STRUCTURAL_DIRS.has(s.toLowerCase()) && !/^[[(@]/.test(s));
  const candidates = [...dirs, fileStem(path), fallbackName ?? ''];
  for (const c of candidates) {
    const w = words(c)
      .map((x) => x.toLowerCase())
      .filter((x) => !['use', 'page', 'route', 'layout', 'service', 'repository', 'repo', 'controller', 'index', 'api', 'client', 'provider', 'hook', 'utils', 'actions', 'action', 'list', 'editor', 'viewer', 'form', 'button', 'card', 'modal', 'table'].includes(x));
    const first = w[0];
    if (first && first.length > 1) return first.endsWith('s') && first.length > 3 && !first.endsWith('ss') ? first.slice(0, -1) : first;
  }
  return undefined;
}
