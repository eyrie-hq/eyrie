/**
 * The health rules against the real engine on fixtures/unsafe-app: every
 * planted case is found, no safe variant is flagged, and findings never
 * carry secret values.
 *
 * The planted secret literals are built at runtime so no secret-shaped
 * string exists in this repository; the fixture at rest holds only the
 * safe placeholder variant.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphEngine } from '@eyrie/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHealthCheck, type HealthSummary } from '../src/check.js';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/unsafe-app', import.meta.url));
/** A fake secret, assembled so the literal never appears in this file. */
const fake = (prefix: string, n: number, ch: string): string => prefix + ch.repeat(n);
const AWS_KEY = fake('AKIA', 16, 'X');
const ASSIGNED = fake('k9', 14, 'x');

const SAFE_PREFIXES = ['src/routes/safe-', 'src/ui/SafePanel', 'src/leak-safe.ts', 'supabase/migrations/0002_posts.sql', 'storage.rules', '.env.example'];

function fixtureRepo(dir: string): string {
  const root = join(dir, 'unsafe');
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(
    join(root, 'src/leak.ts'),
    ['/** A committed secret: the planted hardcoded-secret case. */', `export const awsKey = "${AWS_KEY}";`, `export const apiKey = "${ASSIGNED}";`, ''].join('\n'),
  );
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Ada');
  git('config', 'user.email', 'ada@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: unsafe app');
  return root;
}

describe('health check on unsafe-app', () => {
  let dir: string;
  let engine: GraphEngine;
  let summary: HealthSummary;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eyrie-check-'));
    engine = new GraphEngine({ root: fixtureRepo(dir), dataDir: join(dir, 'data'), watch: false });
    await engine.start();
    summary = await runHealthCheck(engine);
  });

  afterAll(async () => {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds every planted case', () => {
    const rules = new Set(summary.findings.map((f) => f.rule));
    expect([...rules].sort()).toEqual([
      'client-env-leak',
      'env-file-exposed',
      'firebase-test-mode',
      'hardcoded-secret',
      'public-env-secret',
      'supabase-no-rls',
      'unguarded-write',
      'unverified-webhook',
    ]);
  });

  it('pins each finding to its planted location', () => {
    const byRule = (rule: string) => summary.findings.filter((f) => f.rule === rule);
    expect(byRule('hardcoded-secret').map((f) => f.files[0])).toEqual([
      { path: 'src/leak.ts', line: 2 },
      { path: 'src/leak.ts', line: 3 },
    ]);
    expect(byRule('public-env-secret').map((f) => f.files[0])).toEqual([{ path: 'src/config.ts', line: 5 }]);
    expect(byRule('env-file-exposed').map((f) => f.files[0])).toEqual([{ path: '.env' }]);
    expect(byRule('supabase-no-rls').map((f) => f.files[0])).toEqual([{ path: 'supabase/migrations/0001_profiles.sql', line: 1 }]);
    expect(byRule('firebase-test-mode').map((f) => f.files[0])).toEqual([{ path: 'firestore.rules', line: 5 }]);
    expect(byRule('unguarded-write').map((f) => f.evidence)).toHaveLength(1);
    expect(byRule('unguarded-write')[0]!.evidence).toContain('/api/notes');
    expect(byRule('client-env-leak').map((f) => f.files[0])).toEqual([{ path: 'src/ui/LeakPanel.tsx', line: 3 }]);
    expect(byRule('unverified-webhook').map((f) => f.files[0])).toEqual([{ path: 'src/routes/webhook.ts', line: 6 }]);
  });

  it('flags no safe variant', () => {
    const touched = summary.findings.flatMap((f) => f.files.map((file) => file.path));
    for (const path of touched) {
      expect(SAFE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix)), `${path} should be clean`).toBe(false);
    }
    // The public URL beside the flagged key stays clean, and the guarded
    // route beside the open one is not an unguarded write.
    expect(summary.findings.filter((f) => f.rule === 'public-env-secret')).toHaveLength(1);
    expect(summary.findings.filter((f) => f.rule === 'unguarded-write')).toHaveLength(1);
  });

  it('never carries secret values', () => {
    const serialised = JSON.stringify(summary.findings);
    expect(serialised).not.toContain(AWS_KEY);
    expect(serialised).not.toContain(ASSIGNED);
  });

  it('limits findings to changed files when asked', async () => {
    const scoped = await runHealthCheck(engine, { onlyFiles: ['src/routes/notes.ts'] });
    expect(scoped.findings.length).toBeGreaterThan(0);
    for (const finding of scoped.findings) {
      expect(finding.files.some((f) => f.path === 'src/routes/notes.ts')).toBe(true);
    }
  });
});
