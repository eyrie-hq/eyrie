import { beforeEach, describe, expect, it } from 'vitest';
import { FixtureRepo, memoryIndex } from './fixture.js';

const R = 'src/services/order.service.ts';

describe('code graph: full build', () => {
  let repo: FixtureRepo;
  beforeEach(async () => {
    repo = await FixtureRepo.load();
  });

  it('resolves calls through imports, instances, aliases and this-fields', () => {
    const edges = repo.edgeStrings();
    expect(edges).toContain('CALLS src/app/api/order/checkout/route.ts#POST -> src/services/order.service.ts#OrderService.checkout');
    expect(edges).toContain('CALLS src/services/order.service.ts#OrderService.checkout -> src/services/payment-router.service.ts#PaymentRouterService.charge');
    expect(edges).toContain('CALLS src/services/order.service.ts#OrderService.checkout -> src/repositories/order.repository.ts#OrderRepository.save');
    expect(edges).toContain('CALLS src/services/order.service.ts#OrderService.checkout -> src/lib/summary.ts#buildOrderSummary');
    expect(edges).toContain('CALLS src/app/api/order/[id]/route.ts#GET -> src/repositories/order.repository.ts#OrderRepository.findById');
    expect(edges).toContain('CALLS src/services/auth.service.ts#requireCustomer -> src/services/auth.service.ts#getSession');
  });

  it('links route nodes to handlers and frontend fetches to routes', () => {
    const edges = repo.edgeStrings();
    expect(edges).toContain('CALLS api_route:POST /api/order/checkout -> src/app/api/order/checkout/route.ts#POST');
    expect(edges).toContain('HTTP_CALL src/components/book/BookBrowser.tsx#BookBrowser -> api_route:POST /api/order/checkout');
    expect(edges).toContain('HTTP_CALL src/components/order/OrderViewer.tsx#OrderViewer -> api_route:GET /api/order/:id');
    expect(edges).toContain('HTTP_CALL src/hooks/useOrders.ts#useOrders -> api_route:GET /api/order');
  });

  it('detects database reads/writes and external services', () => {
    const edges = repo.edgeStrings();
    expect(edges).toContain('WRITES_TO src/repositories/order.repository.ts#OrderRepository.save -> database_model:Order');
    expect(edges).toContain('WRITES_TO src/repositories/order.repository.ts#OrderRepository.save -> database_model:OrderItem');
    expect(edges).toContain('READS_FROM src/services/auth.service.ts#getSession -> database_model:Customer');
    expect(edges).toContain('READS_FROM src/services/catalog.service.ts#CatalogService.browse -> database_model:Book');
    expect(edges).toContain('USES src/services/recommender.service.ts#RecommenderService.suggest -> external_service:OpenAI');
    expect(edges).toContain('USES src/services/catalog.service.ts#CatalogService.find -> external_service:Algolia');
    expect(edges).toContain('USES src/services/webhook.service.ts#webhookService.handleWebhook -> external_service:Stripe');
  });

  it('marks Next.js middleware and resolves next/dynamic imports', () => {
    const mw = [...repo.index.store.nodes()].find((n) => n.file === 'src/middleware.ts' && n.name === 'middleware');
    expect(mw?.kind).toBe('middleware');
    expect(repo.edgeStrings()).toContain('USES src/app/order/[id]/page.tsx#OrderPage -> src/components/order/OrderViewer.tsx#OrderViewer');
  });
});

describe('code graph: incremental updates', () => {
  let repo: FixtureRepo;
  beforeEach(async () => {
    repo = await FixtureRepo.load();
  });

  it('keeps ids stable and only re-resolves the edited file for body-only edits', async () => {
    const before = new Set([...repo.index.store.nodes()].map((n) => n.id));
    const src = repo.files.get(R)!;
    const result = await repo.write(R, `// a new leading comment\n\n${src.replace('return this.repo.findByCustomer(customerId);', 'const all = await this.repo.findByCustomer(customerId);\n    return all;')}`);
    expect(result.reresolved).toEqual([R]);
    expect(result.diff.addedNodes).toHaveLength(0);
    expect(result.diff.removedNodes).toHaveLength(0);
    expect(result.diff.updatedNodes.length).toBeGreaterThan(0);
    expect(new Set([...repo.index.store.nodes()].map((n) => n.id))).toEqual(before);
  });

  it('adds a new service and its dependency edges (the Shipping demo)', async () => {
    await repo.write(
      'src/services/shipping.service.ts',
      `import { PaymentService } from './payment.service';\n\n/** Prices delivery for an order. */\nexport class ShippingService {\n  private payments = new PaymentService();\n  async quote(weightGrams: number) {\n    return this.payments.charge(weightGrams);\n  }\n}\n`,
    );
    const src = repo.files.get(R)!;
    const result = await repo.write(
      R,
      src
        .replace("import { buildOrderSummary } from '@/lib/summary';", "import { buildOrderSummary } from '@/lib/summary';\nimport { ShippingService } from './shipping.service';")
        .replace('const reference', 'await new ShippingService().quote(totalCents);\n    const reference'),
    );
    const edges = repo.edgeStrings();
    expect(edges).toContain('CALLS src/services/shipping.service.ts#ShippingService.quote -> src/services/payment.service.ts#PaymentService.charge');
    expect(edges).toContain('CALLS src/services/order.service.ts#OrderService.checkout -> src/services/shipping.service.ts#ShippingService');
    expect(result.diff.addedEdges.some((e) => repo.name(e.target) === 'src/services/shipping.service.ts#ShippingService')).toBe(true);
  });

  it('invalidates dependents when an export changes and restores them when it comes back', async () => {
    const path = 'src/repositories/order.repository.ts';
    const original = repo.files.get(path)!;
    const result = await repo.write(path, original.replace('async save(', 'async persist('));
    expect(result.reresolved).toContain(R);
    expect(repo.edgeStrings()).not.toContain('CALLS src/services/order.service.ts#OrderService.checkout -> src/repositories/order.repository.ts#OrderRepository.save');
    // Falls back to the class with lower confidence.
    expect(repo.edgeStrings()).toContain('CALLS src/services/order.service.ts#OrderService.checkout -> src/repositories/order.repository.ts#OrderRepository');

    await repo.write(path, original);
    expect(repo.edgeStrings()).toContain('CALLS src/services/order.service.ts#OrderService.checkout -> src/repositories/order.repository.ts#OrderRepository.save');
  });

  it('handles deleting and re-adding a file', async () => {
    const path = 'src/services/payment.service.ts';
    const content = repo.files.get(path)!;
    const removed = await repo.remove(path);
    expect(removed.diff.removedNodes.length).toBeGreaterThan(0);
    expect(repo.edgeStrings().some((e) => e.includes('src/services/payment.service.ts'))).toBe(false);
    // Stripe is no longer charged from the service layer, only from the webhook handler.
    expect(repo.edgeStrings()).not.toContain('USES src/services/payment.service.ts#PaymentService.charge -> external_service:Stripe');

    await repo.write(path, content);
    // OrderService reaches PaymentService by constructing it into its strategy array, so that
    // reference is what has to come back; the router owns the .charge call itself.
    expect(repo.edgeStrings()).toContain('CALLS src/services/order.service.ts#OrderService -> src/services/payment.service.ts#PaymentService');
  });

  it('flags calls to missing API routes and re-links them when the route appears', async () => {
    const browser = 'src/components/book/BookBrowser.tsx';
    await repo.write(browser, repo.files.get(browser)!.replace("'/api/order/checkout'", "'/api/basket/pay'"));
    expect(repo.edgeStrings()).toContain('HTTP_CALL src/components/book/BookBrowser.tsx#BookBrowser -> api_route:POST /api/basket/pay');
    const missing = [...repo.index.store.nodes()].find((n) => n.kind === 'api_route' && n.meta?.missing);
    expect(missing).toBeDefined();

    await repo.write('src/app/api/basket/pay/route.ts', 'export async function POST() {\n  return Response.json({ ok: true });\n}\n');
    expect(repo.index.store.getNode(missing!.id)).toBeUndefined();
    const route = [...repo.index.store.nodes()].find((n) => n.kind === 'api_route' && n.name === 'POST /api/basket/pay' && n.file);
    expect(route).toBeDefined();
    expect(repo.edgeStrings()).toContain('HTTP_CALL src/components/book/BookBrowser.tsx#BookBrowser -> api_route:POST /api/basket/pay');
  });
});

describe('external services by URL', () => {
  it('maps API hosts in fetch calls to known providers', async () => {
    const { providerForUrl } = await import('../src/index.js');
    expect(providerForUrl('https://api.stripe.com:param')?.label).toBe('Stripe');
    expect(providerForUrl('https://api.github.com/repos/:param')?.label).toBe('GitHub API');
    expect(providerForUrl('https://:param/v1')).toBeNull();
  });
});

// Plain-object tables inherit `toString`, `constructor`, `hasOwnProperty` … from
// Object.prototype; a name from user code must never pick one of those up.
describe('names that Object.prototype also has', () => {
  it('indexes a module-level call chain ending in toString() on an imported binding', async () => {
    const index = await memoryIndex({
      'src/a.ts': `import * as fs from 'fs';
export const text = fs.readFileSync('a.txt').toString();
export const hex = fs.readFileSync('b.bin').valueOf();
`,
    });
    const kinds = [...index.store.nodes()].filter((n) => n.file === 'src/a.ts' && n.kind !== 'file').map((n) => `${n.kind}:${n.name}`);
    expect(kinds.sort()).toEqual(['variable:hex', 'variable:text']);
  });

  it('resolves a call to a local named hasOwnProperty without crashing', async () => {
    const index = await memoryIndex({
      'src/has.ts': `const hasOwnProperty = Object.prototype.hasOwnProperty;
export function has(o: object, k: string): boolean {
  const seen = new Map();
  seen.set(k, 1);
  return hasOwnProperty.call(o, k) && toString() !== '';
}
`,
    });
    expect(index.files.has('src/has.ts')).toBe(true);
  });

  it('knows no external service or framework by a prototype name', async () => {
    const { providerForPackage, providerForUrl } = await import('../src/index.js');
    expect(providerForPackage('constructor')).toBeNull();
    expect(providerForPackage('toString')).toBeNull();
    expect(providerForUrl('https://constructor/v1')).toMatchObject({ id: 'host:constructor', label: 'constructor' });
  });
});

describe('HTTP calls in a monorepo with several Next.js apps', () => {
  const files = {
    'apps/admin/src/app/api/products/route.ts': `export async function POST() { return Response.json({}); }`,
    'apps/admin/src/app/products/page.tsx': `export default function ProductsPage() { fetch('/api/products', { method: 'POST' }); return null; }`,
    'apps/store/src/app/api/cart/route.ts': `export async function GET() { return Response.json({}); }`,
    'apps/store/src/app/account/page.tsx': `export default function AccountPage() { fetch('/api/products', { method: 'POST' }); return null; }`,
    'apps/spa/src/main.ts': `export function load() { return fetch('/api/products', { method: 'POST' }); }`,
  };

  it('links each app to its own routes and reports calls to a sibling app as missing', async () => {
    const index = await memoryIndex(files);
    const s = index.store;
    const calls = [...s.edges()]
      .filter((e) => e.kind === 'HTTP_CALL')
      .map((e) => `${s.getNode(e.source)?.file} -> ${s.getNode(e.target)?.file ?? 'missing'}`);
    expect(calls).toContain('apps/admin/src/app/products/page.tsx -> apps/admin/src/app/api/products/route.ts');
    // The store app serves its own /api and has no /api/products; it cannot reach the admin app's route.
    expect(calls).toContain('apps/store/src/app/account/page.tsx -> missing');
    // A frontend outside any Next.js app may be proxied to any server, so it still links.
    expect(calls).toContain('apps/spa/src/main.ts -> apps/admin/src/app/api/products/route.ts');
  });
});

describe('import edges merged from several statements', () => {
  const importOf = async (a: string) => {
    const index = await memoryIndex({
      'src/a.ts': a,
      'src/b.ts': `export interface Thing { id: string }\nexport function make(): Thing { return { id: '1' }; }\n`,
    });
    const s = index.store;
    const edges = [...s.edges()].filter((e) => e.kind === 'IMPORTS' && s.getNode(e.source)?.file === 'src/a.ts' && s.getNode(e.target)?.file === 'src/b.ts');
    expect(edges).toHaveLength(1);
    return edges[0]!;
  };

  it('keeps a runtime import that follows a type-only one', async () => {
    const e = await importOf(`import type { Thing } from './b';\nimport { make } from './b';\nexport const x: Thing = make();\n`);
    expect(e.meta?.typeOnly).toBeUndefined();
    expect(e.line).toBe(2);
    expect(e.meta?.names).toEqual(['Thing', 'make']);
    expect(e.meta?.count).toBe(2);
  });

  it('stays a runtime import when a type-only import follows it', async () => {
    const e = await importOf(`import { make } from './b';\nimport type { Thing } from './b';\nexport const x: Thing = make();\n`);
    expect(e.meta?.typeOnly).toBeUndefined();
    expect(e.line).toBe(1);
  });

  it('becomes a dynamic import, not a static one, when a dynamic import follows a type-only one', async () => {
    const e = await importOf(`import type { Thing } from './b';\nexport async function load(): Promise<Thing> { const m = await import('./b'); return m.make(); }\n`);
    expect(e.meta?.typeOnly).toBeUndefined();
    expect(e.meta?.dynamic).toBe(true);
    expect(e.line).toBe(2);
  });

  it('stays type-only while every statement is', async () => {
    const e = await importOf(`import type { Thing } from './b';\nimport type { Thing as T2 } from './b';\nexport type X = Thing | T2;\n`);
    expect(e.meta?.typeOnly).toBe(true);
    expect(e.line).toBe(1);
  });
});
