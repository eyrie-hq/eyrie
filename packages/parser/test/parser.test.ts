import { describe, expect, it } from 'vitest';
import { SourceParser } from '../src/index.js';

const parser = new SourceParser();
const parse = async (path: string, src: string) => (await parser.parse(path, src))!;

describe('TypeScript adapter', () => {
  it('extracts imports, exports and re-exports', async () => {
    const f = await parse(
      'src/index.ts',
      `import def, { a, b as c, type T } from './mod';\nimport * as ns from '@/lib/ns';\nimport type { X } from './types';\nexport { a as alias };\nexport * from './all';\nexport { y as z } from './y';\nexport * as group from './group';\nexport default def;\n`,
    );
    expect(f.imports.map((i) => [i.source, i.typeOnly, i.specifiers.map((s) => `${s.imported}>${s.local}${s.typeOnly ? ':type' : ''}`)])).toEqual([
      ['./mod', false, ['default>def', 'a>a', 'b>c', 'T>T:type']],
      ['@/lib/ns', false, ['*>ns']],
      ['./types', true, ['X>X']],
    ]);
    expect(f.exports.map(({ line: _l, ...e }) => e)).toEqual([
      { kind: 'local', exported: 'alias', local: 'a' },
      { kind: 'reexport-all', source: './all' },
      { kind: 'reexport', exported: 'z', imported: 'y', source: './y' },
      { kind: 'reexport-namespace', exported: 'group', source: './group' },
      { kind: 'local', exported: 'default', local: 'def' },
    ]);
  });

  it('binds dynamic imports as the module or the names they take', async () => {
    const f = await parse(
      'src/load.ts',
      `const mod = await import('./a');
const { b, c: see } = await import('./b');
export async function load() {
  const m = await import('./c');
  const { d } = await import('./d');
  await import('./side');
  return import('./e').then(({ e }) => e(m, d));
}
export const Lazy = lazy(() => import('./f'));
`,
    );
    expect(f.imports.map((i) => [i.source, i.dynamic, i.specifiers.map((s) => `${s.imported}>${s.local}`)])).toEqual([
      ['./a', true, ['*>mod']],
      ['./b', true, ['b>b', 'c>see']],
      ['./c', true, ['*>m']],
      ['./d', true, ['d>d']],
      ['./side', true, []],
      ['./e', true, ['e>e']],
      ['./f', true, ['default>Lazy']],
    ]);
    expect(f.symbols.map((s) => s.name)).toEqual(['load']);
  });

  it('records classes with fields, constructor parameter properties and method scopes', async () => {
    const f = await parse(
      'src/a.ts',
      `/** Does things. */\nexport class Svc extends Base implements Port {\n  private ai = new AIService();\n  constructor(private readonly repo: Repo<User>) { super(); }\n  async run(input: Input) {\n    const local = new Helper();\n    local.go();\n    this.repo.save(input);\n  }\n}\n`,
    );
    const cls = f.symbols.find((s) => s.name === 'Svc')!;
    expect(cls).toMatchObject({ kind: 'class', exported: true, extends: ['Base'], implements: ['Port'], doc: 'Does things.' });
    expect(cls.fields).toEqual([
      { name: 'ai', instanceOf: 'AIService' },
      { name: 'repo', type: 'Repo' },
    ]);
    const run = f.symbols.find((s) => s.qualifiedName === 'Svc.run')!;
    expect(run).toMatchObject({ kind: 'method', parent: 'Svc', async: true, locals: { input: 'Input', local: 'Helper' } });
    expect(f.references.filter((r) => r.from === 'Svc.run').map((r) => `${r.kind}:${r.callee.join('.')}`)).toEqual(['new:Helper', 'call:local.go', 'call:this.repo.save', 'ref:input']);
  });

  it('classifies components and hooks and captures fetch arguments', async () => {
    const f = await parse(
      'src/C.tsx',
      `export function useThing(id: string) {\n  return fetch(\`/api/things/\${id}\`, { method: 'DELETE' });\n}\nexport const Card = memo(function Card() { return <div><Button onClick={save} /></div>; });\n`,
    );
    expect(f.symbols.map((s) => [s.name, s.kind])).toEqual([
      ['useThing', 'hook'],
      ['Card', 'react_component'],
    ]);
    const fetchRef = f.references.find((r) => r.callee[0] === 'fetch')!;
    expect(fetchRef.args).toEqual(['/api/things/:param', { method: 'DELETE' }]);
    expect(f.references.some((r) => r.kind === 'jsx' && r.callee[0] === 'Button' && r.from === 'Card')).toBe(true);
    expect(f.references.some((r) => r.kind === 'ref' && r.callee[0] === 'save')).toBe(true);
  });

  it('detects object-literal services and Express routes', async () => {
    const f = await parse(
      'server/routes.js',
      `const express = require('express');\nconst { getUser } = require('./users');\nconst app = express();\napp.get('/users/:id', auth, async (req, res) => { res.json(await getUser(req.params.id)); });\nmodule.exports = { app };\n`,
    );
    expect(f.imports.map((i) => [i.source, i.specifiers.map((s) => s.local)])).toEqual([
      ['express', ['express']],
      ['./users', ['getUser']],
    ]);
    expect(f.routes).toEqual([{ method: 'GET', path: '/users/:id', line: 4, router: 'app', scope: 'route:GET /users/:id', handlers: ['auth'] }]);
    expect(f.references.some((r) => r.from === 'route:GET /users/:id' && r.callee[0] === 'getUser')).toBe(true);
    expect(f.exports).toEqual([{ kind: 'local', exported: 'app', local: 'app', line: 5 }]);
  });

  it('parses Prisma models', async () => {
    const f = await parse('prisma/schema.prisma', `enum Role { USER ADMIN }\nmodel User {\n  id String @id\n  role Role\n  posts Post[]\n}\nmodel Post {\n  id String @id\n  author User @relation(fields: [authorId], references: [id])\n  authorId String\n}\n`);
    expect(f.models).toEqual([
      { name: 'User', line: 2, endLine: 6, fields: ['id', 'role', 'posts'], relations: ['Post'], orm: 'prisma' },
      { name: 'Post', line: 7, endLine: 11, fields: ['id', 'author', 'authorId'], relations: ['User'], orm: 'prisma' },
    ]);
  });
});

describe('call arguments', () => {
  it('keeps the literal prefix of concatenated URLs', async () => {
    const f = await parse('src/a.ts', `fetch('https://api.github.com/repos/' + name);\nfetch(\`https://api.stripe.com\${path}\`);\n`);
    expect(f.references.map((r) => r.args?.[0])).toEqual(['https://api.github.com/repos/:param', 'https://api.stripe.com:param']);
  });
});
