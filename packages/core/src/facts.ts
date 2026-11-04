/**
 * Facts extracted from a single source file by a language adapter.
 *
 * Facts are a pure function of (path, content): they contain no cross-file
 * resolution. That makes them cacheable by content hash and lets the graph
 * layer re-resolve relationships without re-parsing.
 */

export type SourceLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'python'
  | 'go'
  | 'java'
  | 'rust'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'kotlin'
  | 'swift'
  | 'c'
  | 'cpp'
  | 'dart'
  | 'vue'
  | 'objc'
  | 'lua'
  | 'prisma';

/** A data model declared in a schema file (Prisma model, Drizzle table, ...). */
export interface ModelFact {
  name: string;
  line: number;
  endLine: number;
  fields: string[];
  /** Names of other models this model references. */
  relations: string[];
  /** 'prisma', 'django', 'sqlalchemy', 'jpa', 'activerecord', 'eloquent', 'gorm', 'efcore', 'diesel', ... */
  orm: string;
  /** Qualified name of the class that declares the model, when it is a class (ORM entities). */
  symbol?: string;
}

/** One environment variable read, with its name but never its value. */
export interface EnvReadFact {
  name: string;
  line: number;
}

/**
 * A string literal shaped like a secret. Location only: `kind` names the
 * pattern that matched (e.g. `aws-access-key`, `private-key`), never the value.
 */
export interface SecretFact {
  line: number;
  kind: string;
}

/** A call that verifies a webhook signature (Stripe's constructEvent, Svix verify, …). */
export interface WebhookVerifyFact {
  line: number;
  /** The callee as written, e.g. `stripe.webhooks.constructEvent`. */
  callee: string;
}

/** Something that guards a route: a session/auth call, a decorator or attribute, a middleware matcher. */
export interface AuthGuardFact {
  line: number;
  kind: string;
  /** The matcher patterns, for middleware matchers. */
  detail?: string;
}

export interface SecurityFacts {
  env: EnvReadFact[];
  secrets: SecretFact[];
  webhooks: WebhookVerifyFact[];
  guards: AuthGuardFact[];
}

export interface FileFacts {
  /** Repo-relative POSIX path. */
  path: string;
  language: SourceLanguage;
  /** Content hash of the file. */
  hash: string;
  loc: number;
  /** Declared package / namespace (Java package, C# or PHP namespace, Ruby module), dot-separated. */
  namespace?: string;
  /** Top-of-file directives such as 'use client' / 'use server'. */
  directives: string[];
  imports: ImportFact[];
  exports: ExportFact[];
  symbols: SymbolFact[];
  references: ReferenceFact[];
  /** Express/Hono/Fastify-style route registrations found in the file. */
  routes: RouteFact[];
  /** Security-relevant facts for the health check: env reads, secret-shaped literals, webhook verification and auth guards. */
  security?: SecurityFacts;
  /** Python router composition, resolved across imports by the graph index. */
  routeMounts?: { router: string; target: string[]; prefix: string; line: number }[];
  /** Data models declared by schema files. */
  models?: ModelFact[];
  parseErrors: number;
}

export interface ImportSpecifier {
  /** 'default', '*', or the exported name in the source module. */
  imported: string;
  local: string;
  typeOnly?: boolean;
}

export interface ImportFact {
  source: string;
  line: number;
  typeOnly: boolean;
  specifiers: ImportSpecifier[];
  /** `import('./x')` or `require('./x')`. */
  dynamic?: boolean;
  /**
   * Brings every public name of the module into scope: Python `from x import *`,
   * Java `import a.b.*`, C# `using A.B;`, Rust `use a::*`, Go dot-imports.
   */
  wildcard?: boolean;
}

export type ExportFact =
  /** `export function a`, `export { a as b }`, `export default a`. */
  | { kind: 'local'; exported: string; local: string; line: number }
  /** `export { a as b } from './x'`. */
  | { kind: 'reexport'; exported: string; imported: string; source: string; line: number }
  /** `export * from './x'`. */
  | { kind: 'reexport-all'; source: string; line: number }
  /** `export * as ns from './x'`. */
  | { kind: 'reexport-namespace'; exported: string; source: string; line: number };

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'react_component'
  | 'hook';

export interface FieldFact {
  name: string;
  /** Declared type name (root identifier), e.g. `OrderService`. */
  type?: string;
  /** Class instantiated in the initializer, e.g. `new OrderService()`. */
  instanceOf?: string;
}

export interface SymbolFact {
  name: string;
  /** Dotted name inside the file, e.g. `OrderService.checkout`. */
  qualifiedName: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  /** Declared with the `export` keyword or listed in an export clause. */
  exported: boolean;
  /** Qualified name of the containing class or object. */
  parent?: string;
  async?: boolean;
  returnsJsx?: boolean;
  extends?: string[];
  implements?: string[];
  /** For variables: `new X()` initializer → 'X'. */
  instanceOf?: string;
  /** For variables: `createClient(...)` initializer → 'createClient'. */
  initCall?: string;
  /** Declared type annotation root name. */
  typeName?: string;
  /** Class fields and constructor parameter properties. */
  fields?: FieldFact[];
  /** Local variables / parameters bound to a class instance or type. */
  locals?: Record<string, string>;
  /** First line of the declaration, trimmed. */
  signature?: string;
  /** Leading doc comment, first paragraph. */
  doc?: string;
}

/** A literal argument value captured at a call site. */
export type ArgFact = string | Record<string, string> | null;

export interface ReferenceFact {
  /** Qualified name of the enclosing symbol; '' for module scope; 'route:GET /x' for inline route handlers. */
  from: string;
  kind: 'call' | 'new' | 'jsx' | 'ref';
  /** Member chain, e.g. ['this', 'repo', 'save'] or ['fetch']. */
  callee: string[];
  line: number;
  /** Up to three literal arguments (strings, template strings with ':param', or small object literals). */
  args?: ArgFact[];
}

export interface RouteFact {
  method: string;
  path: string;
  line: number;
  /** Router object the route was registered on, e.g. 'app' or 'router'. */
  router: string;
  /** Scope name used for references inside inline handlers. */
  scope: string;
  /** Identifiers passed as handlers / middleware. */
  handlers: string[];
  /** Framework that registered the route; defaults to 'express'. */
  framework?: string;
}
