/**
 * One planted case and one safe variant per rule, over hand-built inputs.
 * The unsafe-app fixture exercises the same rules through the real engine.
 */
import type { ArchGraph, FileFacts, RouteFact, SecurityFacts } from '@eyrie/core';
import { describe, expect, it } from 'vitest';
import { RULES, runChecks, type CheckInput, type FileCheckFacts } from '@eyrie/checks';

function facts(partial: Partial<FileFacts> & { path: string }): FileFacts {
  return {
    language: 'typescript',
    hash: 'h',
    loc: 10,
    directives: [],
    imports: [],
    exports: [],
    symbols: [],
    references: [],
    routes: [],
    parseErrors: 0,
    ...partial,
  };
}

function security(partial: Partial<SecurityFacts> = {}): SecurityFacts {
  return { env: [], secrets: [], webhooks: [], guards: [], ...partial };
}

function file(partial: Partial<FileCheckFacts> & { path: string }): FileCheckFacts {
  return { ignored: false, tracked: true, ...partial };
}

function route(partial: Partial<RouteFact>): RouteFact {
  return { method: 'POST', path: '/api/notes', line: 3, router: 'app', scope: 's', handlers: [], ...partial };
}

const EMPTY_CODE = { calls: new Map(), nodeFile: new Map(), fileNodes: new Map() };

function input(arch: ArchGraph, files: FileCheckFacts[], extra?: Partial<CheckInput>): CheckInput {
  return { arch, files, code: EMPTY_CODE, ...extra };
}

const EMPTY_ARCH: ArchGraph = { nodes: [], edges: [] };

describe('per-file rules', () => {
  it('flags hardcoded secrets, one finding per location', () => {
    const findings = runChecks(
      input(EMPTY_ARCH, [
        file({ path: 'src/leak.ts', facts: facts({ path: 'src/leak.ts', security: security({ secrets: [{ line: 7, kind: 'assigned-secret' }] }) }) }),
        file({ path: 'src/clean.ts', facts: facts({ path: 'src/clean.ts', security: security() }) }),
      ]),
    );
    expect(findings.map((f) => f.rule)).toEqual(['hardcoded-secret']);
    expect(findings[0]).toMatchObject({ severity: 'high', files: [{ path: 'src/leak.ts', line: 7 }] });
    expect(findings[0]!.evidence).toContain('assigned-secret');
  });

  it('flags secret names in public env vars, not public or server names', () => {
    const findings = runChecks(
      input(EMPTY_ARCH, [
        file({
          path: 'src/config.ts',
          facts: facts({
            path: 'src/config.ts',
            security: security({
              env: [
                { name: 'NEXT_PUBLIC_API_KEY', line: 2 },
                { name: 'NEXT_PUBLIC_API_URL', line: 3 },
                { name: 'DATABASE_URL', line: 4 },
                { name: 'VITE_STRIPE_TOKEN', line: 5 },
              ],
            }),
          }),
        }),
      ]),
    );
    expect(findings.map((f) => f.id)).toEqual([
      'public-env-secret:src/config.ts:2:NEXT_PUBLIC_API_KEY',
      'public-env-secret:src/config.ts:5:VITE_STRIPE_TOKEN',
    ]);
  });

  it('flags tracked or unignored .env files, never templates', () => {
    const findings = runChecks(
      input(EMPTY_ARCH, [
        file({ path: '.env', tracked: true, ignored: false }),
        file({ path: '.env.local', tracked: false, ignored: false }),
        file({ path: '.env.staging', tracked: false, ignored: true }),
        file({ path: '.env.example', tracked: true, ignored: false }),
      ]),
    );
    expect(findings.map((f) => f.id).sort()).toEqual(['env-file-exposed:.env', 'env-file-exposed:.env.local']);
    expect(findings.find((f) => f.id.endsWith('.env'))!.evidence).toContain('tracked by git');
    expect(findings.find((f) => f.id.endsWith('.local'))!.evidence).toContain('not ignored');
  });

  it('flags Supabase tables without RLS in migrations', () => {
    const findings = runChecks(
      input(EMPTY_ARCH, [
        file({
          path: 'supabase/migrations/0001_profiles.sql',
          text: 'create table profiles (id uuid primary key);\n',
        }),
        file({
          path: 'supabase/migrations/0002_posts.sql',
          text: 'create table posts (id uuid primary key);\nalter table posts enable row level security;\n',
        }),
        file({ path: 'supabase/seed.sql', text: 'insert into profiles values (1);\n' }),
      ]),
    );
    expect(findings.map((f) => f.rule)).toEqual(['supabase-no-rls']);
    expect(findings[0]!.evidence).toContain('profiles');
    expect(findings[0]!.files).toEqual([{ path: 'supabase/migrations/0001_profiles.sql', line: 1 }]);
  });

  it('flags Firebase test-mode rules', () => {
    const findings = runChecks(
      input(EMPTY_ARCH, [
        file({ path: 'firestore.rules', text: 'match /notes/{id} {\n  allow read, write: if true;\n}\n' }),
        file({ path: 'storage.rules', text: 'match /avatars/{id} {\n  allow read: if request.auth != null;\n}\n' }),
        file({ path: 'database.rules.json', text: '{ "rules": { ".read": true, ".write": "auth != null" } }\n' }),
      ]),
    );
    expect(findings.map((f) => f.id).sort()).toEqual([
      'firebase-test-mode:database.rules.json:1',
      'firebase-test-mode:firestore.rules:2',
    ]);
  });
});

describe('graph rules', () => {
  const routeNode = (over: Record<string, unknown> = {}) => ({
    id: 'route',
    key: 'route',
    kind: 'api_route' as const,
    category: 'api' as const,
    lane: 'api' as const,
    label: 'POST /api/notes',
    sublabel: 'POST /api/notes',
    members: [],
    files: ['src/routes/notes.ts'],
    ...over,
  });
  const dbNode = { id: 'db', key: 'db', kind: 'database_model' as const, category: 'data' as const, lane: 'data' as const, label: 'Note', members: [] as string[], files: [] as string[] };

  it('flags a route reaching a write with no guard, clears it when guarded', () => {
    const arch: ArchGraph = {
      nodes: [routeNode(), dbNode],
      edges: [{ id: 'e', source: 'route', target: 'db', kinds: ['WRITES_TO'], weight: 1 }],
    };
    const unguarded = runChecks(input(arch, [file({ path: 'src/routes/notes.ts', facts: facts({ path: 'src/routes/notes.ts', security: security() }) })]));
    expect(unguarded.map((f) => f.rule)).toEqual(['unguarded-write']);
    expect(unguarded[0]).toMatchObject({ componentIds: ['route', 'db'], path: [['route', 'db']] });
    expect(unguarded[0]!.evidence).toContain('POST /api/notes');

    const guarded = runChecks(
      input(arch, [file({ path: 'src/routes/notes.ts', facts: facts({ path: 'src/routes/notes.ts', security: security({ guards: [{ line: 1, kind: 'auth-call' }] }) }) })]),
    );
    expect(guarded).toEqual([]);
  });

  it('walks through services to the write', () => {
    const arch: ArchGraph = {
      nodes: [
        routeNode(),
        { id: 'svc', key: 'svc', kind: 'service' as const, category: 'service' as const, lane: 'logic' as const, label: 'NotesService', members: [], files: ['src/notes.ts'] },
        dbNode,
      ],
      edges: [
        { id: 'e1', source: 'route', target: 'svc', kinds: ['CALLS'], weight: 1 },
        { id: 'e2', source: 'svc', target: 'db', kinds: ['WRITES_TO'], weight: 1 },
      ],
    };
    const findings = runChecks(
      input(arch, [
        file({ path: 'src/routes/notes.ts', facts: facts({ path: 'src/routes/notes.ts', security: security() }) }),
        file({ path: 'src/notes.ts', facts: facts({ path: 'src/notes.ts', security: security() }) }),
      ]),
    );
    expect(findings.map((f) => f.rule)).toEqual(['unguarded-write']);
    expect(findings[0]!.componentIds).toEqual(['route', 'svc', 'db']);
  });

  it('flags server-only env reads in UI code', () => {
    const arch: ArchGraph = {
      nodes: [
        { id: 'panel', key: 'panel', kind: 'component' as const, category: 'frontend' as const, lane: 'ui' as const, label: 'LeakPanel', members: [], files: ['src/ui/LeakPanel.tsx', 'src/ui/SafePanel.tsx'] },
      ],
      edges: [],
    };
    const findings = runChecks(
      input(arch, [
        file({ path: 'src/ui/LeakPanel.tsx', facts: facts({ path: 'src/ui/LeakPanel.tsx', security: security({ env: [{ name: 'DATABASE_URL', line: 4 }] }) }) }),
        file({ path: 'src/ui/SafePanel.tsx', facts: facts({ path: 'src/ui/SafePanel.tsx', security: security({ env: [{ name: 'NEXT_PUBLIC_API_URL', line: 2 }] }) }) }),
      ]),
    );
    expect(findings.map((f) => f.id)).toEqual(['client-env-leak:src/ui/LeakPanel.tsx:4:DATABASE_URL']);
  });

  it('flags unverified webhooks, including verification through a helper', () => {
    const arch: ArchGraph = {
      nodes: [routeNode({ id: 'hook', label: 'POST /webhooks/stripe', sublabel: 'POST /webhooks/stripe', files: ['src/routes/webhook.ts'] })],
      edges: [],
    };
    const mkInput = (webhookFile: string | null) =>
      input(
        arch,
        [
          file({ path: 'src/routes/webhook.ts', facts: facts({ path: 'src/routes/webhook.ts', routes: [route({ method: 'POST', path: '/webhooks/stripe', line: 5 })], security: security() }) }),
          ...(webhookFile ? [file({ path: webhookFile, facts: facts({ path: webhookFile, security: security({ webhooks: [{ line: 2, callee: 'stripe.webhooks.constructEvent' }] }) }) })] : []),
        ],
        {
          code: {
            calls: new Map([['h1', ['h2']]]),
            nodeFile: new Map([['h1', 'src/routes/webhook.ts'], ['h2', webhookFile ?? 'src/other.ts']]),
            fileNodes: new Map([['src/routes/webhook.ts', ['h1']]]),
          },
        },
      );
    expect(runChecks(mkInput(null)).map((f) => f.rule)).toEqual(['unverified-webhook']);
    // Verification in a helper the handler calls clears the finding.
    expect(runChecks(mkInput('src/verify.ts'))).toEqual([]);
  });

  it('limits findings to changed files when asked', () => {
    const findings = runChecks(
      input(
        EMPTY_ARCH,
        [
          file({ path: 'src/a.ts', facts: facts({ path: 'src/a.ts', security: security({ secrets: [{ line: 1, kind: 'assigned-secret' }] }) }) }),
          file({ path: 'src/b.ts', facts: facts({ path: 'src/b.ts', security: security({ secrets: [{ line: 1, kind: 'assigned-secret' }] }) }) }),
        ],
        { onlyFiles: ['src/b.ts'] },
      ),
    );
    expect(findings.map((f) => f.id)).toEqual(['hardcoded-secret:src/b.ts:1:assigned-secret']);
  });
});

describe('rules metadata', () => {
  it('covers every rule the runner can emit', () => {
    expect(Object.keys(RULES).sort()).toEqual(
      ['client-env-leak', 'env-file-exposed', 'firebase-test-mode', 'hardcoded-secret', 'public-env-secret', 'supabase-no-rls', 'unguarded-write', 'unverified-webhook'],
    );
  });
});
