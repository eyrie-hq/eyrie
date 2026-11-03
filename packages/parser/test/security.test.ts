/**
 * Security facts: env reads, secret-shaped literals, webhook verification and
 * auth guards, per language. Secret values are built at run time, so this file
 * holds no committable secret; the facts hold locations only, never values.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { FileFacts } from '@eyrie/core';
import { SourceParser } from '../src/index.js';

const parser = new SourceParser();
afterAll(() => parser.dispose());

async function parse(path: string, source: string): Promise<FileFacts> {
  const facts = await parser.parse(path, source);
  if (!facts?.security) throw new Error(`no facts for ${path}`);
  return facts;
}

// Built at run time: the shape matches, but no scanner takes the pieces.
const AWS_KEY = `AKIA${'X'.repeat(16)}`;
const fake = (prefix: string, n: number, ch = 'x') => `${prefix}${ch.repeat(n)}`;

describe('security facts', () => {
  it('reads env in every language', async () => {
    const ts = await parse('a.ts', 'const a = process.env.A;\nconst b = process.env["B"];\nconst c = import.meta.env.C;\n');
    expect(ts.security!.env).toEqual([
      { name: 'A', line: 1 },
      { name: 'B', line: 2 },
      { name: 'C', line: 3 },
    ]);
    const py = await parse('a.py', 'import os\na = os.environ["A"]\nb = os.getenv("B")\n');
    expect(py.security!.env).toEqual([
      { name: 'A', line: 2 },
      { name: 'B', line: 3 },
    ]);
    expect((await parse('a.go', 'package m\nimport "os"\nvar a = os.Getenv("A")\n')).security!.env).toEqual([{ name: 'A', line: 3 }]);
    expect((await parse('A.java', 'class A { String a = System.getenv("A"); }\n')).security!.env).toEqual([{ name: 'A', line: 1 }]);
    expect((await parse('A.cs', 'class A { string a = Environment.GetEnvironmentVariable("A"); }\n')).security!.env).toEqual([{ name: 'A', line: 1 }]);
    expect((await parse('a.php', '<?php $a = $_ENV["A"]; $b = getenv("B");\n')).security!.env).toEqual([
      { name: 'A', line: 1 },
      { name: 'B', line: 1 },
    ]);
    expect((await parse('a.rb', 'a = ENV["A"]\n')).security!.env).toEqual([{ name: 'A', line: 1 }]);
    expect((await parse('a.rs', 'fn f() { let a = env::var("A"); let b = env!("B"); }\n')).security!.env).toEqual([
      { name: 'A', line: 1 },
      { name: 'B', line: 1 },
    ]);
  });

  it('finds webhook verification, not mere handlers', async () => {
    const stripe = await parse('hook.ts', "import Stripe from 'stripe';\nconst e = stripe.webhooks.constructEvent(body, sig, key);\n");
    expect(stripe.security!.webhooks).toEqual([{ line: 2, callee: 'stripe.webhooks.constructEvent' }]);
    const svix = await parse('hook2.ts', "import { Webhook } from 'svix';\nconst wh = new Webhook(secret);\nwh.verify(payload, headers);\n");
    expect(svix.security!.webhooks).toEqual([{ line: 2, callee: 'new Webhook' }]);
    const plain = await parse('plain.ts', 'async function POST(req: Request) { return save(await req.json()); }\n');
    expect(plain.security!.webhooks).toEqual([]);
  });

  it('finds auth guards: calls, decorators, attributes, middleware', async () => {
    expect((await parse('a.ts', 'const s = await getServerSession(opts);\n')).security!.guards).toEqual([{ line: 1, kind: 'auth-call' }]);
    expect((await parse('a.py', '@login_required\ndef view(): pass\n')).security!.guards).toEqual([{ line: 1, kind: 'decorator' }]);
    expect((await parse('A.cs', '[Authorize]\npublic class C {}\n')).security!.guards).toEqual([{ line: 1, kind: 'attribute' }]);
    expect((await parse('a.php', "<?php Route::get('/x', $h)->middleware('auth');\n")).security!.guards).toEqual([{ line: 1, kind: 'route-middleware' }]);
    const mw = await parse('src/middleware.ts', "export const config = { matcher: ['/account/:path*'] };\n");
    expect(mw.security!.guards).toEqual([{ line: 1, kind: 'middleware-matcher', detail: "'/account/:path*'" }]);
    const other = await parse('src/other.ts', "export const config = { matcher: ['/x'] };\n");
    expect(other.security!.guards).toEqual([]);
  });

  it('finds secret-shaped literals by location only', async () => {
    const source = [`const aws = "${AWS_KEY}";`, `const stripe = "${fake('sk_live_', 24)}";`, `const gh = "${fake('ghp_', 36)}";`, `const slack = "${fake('xoxb-', 24)}";`, `const wh = "${fake('whsec_', 24)}";`].join('\n') + '\n';
    const facts = await parse('keys.ts', source);
    expect(facts.security!.secrets).toEqual([
      { line: 1, kind: 'aws-access-key' },
      { line: 2, kind: 'stripe-key' },
      { line: 3, kind: 'github-token' },
      { line: 4, kind: 'slack-token' },
      { line: 5, kind: 'stripe-webhook-secret' },
    ]);
    // The security facts carry the pattern name, never the value. (Symbol
    // signatures elsewhere in the facts quote source lines by design; they are
    // shown locally and never sent anywhere.)
    const serialised = JSON.stringify(facts.security);
    expect(serialised).not.toContain(AWS_KEY);
    expect(serialised).not.toContain(fake('sk_live_', 24));
    expect(serialised).toContain('aws-access-key');
  });

  it('flags assigned secrets but not placeholders or comments', async () => {
    const facts = await parse(
      'cfg.ts',
      ['const password = "correct-horse-battery-staple-9";', 'const apiKey = "test";', 'const other = "changeme";', `// const old = "${fake('sk_live_', 24)}";`, 'const url = "https://api.example.com/v1"; // trailing'].join('\n') + '\n',
    );
    expect(facts.security!.secrets).toEqual([{ line: 1, kind: 'assigned-secret' }]);
    const py = await parse('cfg.py', '# password = "hunter2-hunter2"\nkey = os.environ["K"]\n');
    expect(py.security!.secrets).toEqual([]);
    expect(py.security!.env).toEqual([{ name: 'K', line: 2 }]);
  });
});
