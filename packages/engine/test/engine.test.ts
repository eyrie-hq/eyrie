import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphEngine, type EngineBatch } from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/bookstore-app', import.meta.url));

/** The next update, or a failure if none arrives. The wait is generous; a watcher that never reports still fails. */
function nextBatch(engine: GraphEngine, timeoutMs = 15_000): Promise<EngineBatch> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for a graph update')), timeoutMs);
    engine.once('batch', (b) => {
      clearTimeout(t);
      resolve(b);
    });
  });
}

describe('GraphEngine', () => {
  let dir: string;
  let dataDir: string;
  let engine: GraphEngine | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eyrie-repo-'));
    dataDir = mkdtempSync(join(tmpdir(), 'eyrie-data-'));
    cpSync(FIXTURE, dir, { recursive: true });
  });

  afterEach(async () => {
    await engine?.stop();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('indexes the repo and reads tsconfig path aliases', async () => {
    engine = new GraphEngine({ root: dir, dataDir, watch: false });
    await engine.start();
    expect(engine.repo.frameworks).toEqual(expect.arrayContaining(['next', 'prisma', 'react']));
    expect(engine.stats.files).toBe(38);
    expect(engine.architecture.nodes.map((n) => n.label)).toEqual(expect.arrayContaining(['OrderService', 'Order Checkout API', 'OpenAI']));
  });

  it('updates the architecture live when a file is created and edited', async () => {
    engine = new GraphEngine({ root: dir, dataDir, watch: true, debounceMs: 30 });
    await engine.start();

    let batch = nextBatch(engine);
    writeFileSync(
      join(dir, 'src/services/shipping.service.ts'),
      `import { PaymentService } from './payment.service';\nexport class ShippingService {\n  private payments = new PaymentService();\n  quote(a: number) { return this.payments.charge(a); }\n}\n`,
    );
    let b = await batch;
    expect(b.files).toEqual([{ file: 'src/services/shipping.service.ts', change: 'add' }]);
    expect(b.architecture.addedNodes.map((n) => n.label)).toEqual(['ShippingService']);

    const servicePath = join(dir, 'src/services/order.service.ts');
    batch = nextBatch(engine);
    writeFileSync(
      servicePath,
      readFileSync(servicePath, 'utf8')
        .replace("import { PaymentService } from './payment.service';", "import { PaymentService } from './payment.service';\nimport { ShippingService } from './shipping.service';")
        .replace('const reference', 'new ShippingService().quote(totalCents);\n    const reference'),
    );
    b = await batch;
    const label = new Map(engine.architecture.nodes.map((n) => [n.id, n.label]));
    expect(b.architecture.addedEdges.map((e) => `${label.get(e.source)} -> ${label.get(e.target)}`)).toContain('OrderService -> ShippingService');
    expect(b.reresolved).toBeLessThan(5);

    batch = nextBatch(engine);
    unlinkSync(join(dir, 'src/services/shipping.service.ts'));
    b = await batch;
    expect(b.files).toEqual([{ file: 'src/services/shipping.service.ts', change: 'unlink' }]);
    expect(b.architecture.removedNodes).toHaveLength(1);
  }, 60_000); // three updates in a row, each allowed nextBatch's wait

  it('follows .eyrieignore edits without a restart', async () => {
    engine = new GraphEngine({ root: dir, dataDir, watch: true, debounceMs: 30 });
    await engine.start();
    expect(engine.index.files.has('src/lib/summary.ts')).toBe(true);

    let batch = nextBatch(engine);
    writeFileSync(join(dir, '.eyrieignore'), 'src/lib/summary.ts\n');
    let b = await batch;
    expect(b.files).toEqual([{ file: 'src/lib/summary.ts', change: 'unlink' }]);
    expect(engine.index.files.has('src/lib/summary.ts')).toBe(false);
    expect(engine.isIgnored('src/lib/summary.ts')).toBe(true);

    batch = nextBatch(engine);
    unlinkSync(join(dir, '.eyrieignore'));
    b = await batch;
    expect(b.files).toEqual([{ file: 'src/lib/summary.ts', change: 'add' }]);
    expect(engine.index.files.has('src/lib/summary.ts')).toBe(true);
  }, 60_000);

  it('keeps nested ignore rules when the root .gitignore changes, and watches folders a rule no longer hides', async () => {
    writeFileSync(join(dir, '.gitignore'), 'drafts/\n');
    mkdirSync(join(dir, 'drafts'));
    writeFileSync(join(dir, 'drafts/idea.ts'), 'export const idea = 1;\n');
    writeFileSync(join(dir, 'src/lib/.gitignore'), '*.gen.ts\n');
    writeFileSync(join(dir, 'src/lib/client.gen.ts'), 'export const generated = 1;\n');
    engine = new GraphEngine({ root: dir, dataDir, watch: true, debounceMs: 30 });
    await engine.start();
    expect(engine.index.files.has('src/lib/client.gen.ts')).toBe(false);
    expect(engine.index.files.has('drafts/idea.ts')).toBe(false);

    // Un-ignoring drafts/ brings its file in; the nested *.gen.ts rule still holds.
    let batch = nextBatch(engine);
    writeFileSync(join(dir, '.gitignore'), 'coverage/\n');
    let b = await batch;
    expect(b.files).toEqual([{ file: 'drafts/idea.ts', change: 'add' }]);
    expect(engine.isIgnored('src/lib/client.gen.ts')).toBe(true);
    expect(engine.index.files.has('src/lib/client.gen.ts')).toBe(false);

    // drafts/ was never watched before the rule changed; it is now.
    batch = nextBatch(engine);
    writeFileSync(join(dir, 'drafts/plan.ts'), 'export const plan = 2;\n');
    b = await batch;
    expect(b.files).toEqual([{ file: 'drafts/plan.ts', change: 'add' }]);
  }, 60_000);

  it('reuses cached facts on restart', async () => {
    const logs: string[] = [];
    engine = new GraphEngine({ root: dir, dataDir, watch: false });
    await engine.start();
    await engine.stop();
    engine = new GraphEngine({ root: dir, dataDir, watch: false, log: (m) => logs.push(m) });
    await engine.start();
    expect(logs[0]).toMatch(/0 parsed, 38 from cache/);
  });

  it('never serves files outside the index', async () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    engine = new GraphEngine({ root: dir, dataDir, watch: false });
    await engine.start();
    expect(engine.readSource('.env')).toBeNull();
    expect(engine.readSource('../etc/passwd')).toBeNull();
    expect(engine.readSource('src/lib/prisma.ts')?.lines[0]).toContain('PrismaClient');
  });

  it('starts several engines on one cache without locking it out', async () => {
    // The desktop app and one MCP server per agent share the project's cache.
    const logs: string[] = [];
    const engines = Array.from({ length: 6 }, () => new GraphEngine({ root: dir, dataDir, watch: false, log: (m) => logs.push(m) }));
    try {
      await Promise.all(engines.map((e) => e.start()));
      const shapes = engines.map((e) => `${e.stats.files}/${e.stats.archNodes}/${e.stats.archEdges}`);
      expect(new Set(shapes).size).toBe(1);
      expect(engines[0]!.stats.files).toBe(38);
      expect(logs.join('\n')).not.toMatch(/database is locked|Cache disabled|Could not (read|write) cache/);
    } finally {
      await Promise.all(engines.map((e) => e.stop()));
    }
  }, 60_000);
});
