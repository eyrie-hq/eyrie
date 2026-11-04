/**
 * Shared machinery for the tree-sitter language adapters.
 *
 * Each language walks its own syntax tree, but they all record the same
 * facts the same way: symbols keyed by qualified name, references tagged
 * with their enclosing scope, and doc comments taken from the comments
 * directly above a declaration.
 */
import type { Node } from 'web-tree-sitter';
import type { ArgFact, FileFacts, ReferenceFact, RouteFact, SourceLanguage, SymbolFact } from '@eyrie/core';

export const line = (n: Node) => n.startPosition.row + 1;
export const endLine = (n: Node) => n.endPosition.row + 1;

export interface Scope {
  name: string;
  locals?: Record<string, string>;
}

export function cleanComment(raw: string): string | undefined {
  const text = raw
    .replace(/^\s*\/\*[*!]?/gm, '')
    .replace(/\*\/\s*$/gm, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(\*|\/\/[/!]?|#)\s?/, '').trimEnd())
    .filter((l) => !/^\s*[@:]/.test(l) && !/^\s*<\/?\w+>\s*$/.test(l));
  const paragraph: string[] = [];
  for (const l of text) {
    if (l.trim() === '') {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(l.replace(/<\/?\w+[^>]*>/g, '').trim());
  }
  const out = paragraph.join(' ').trim();
  if (out.length < 3 || /^(eslint|@ts-|prettier|biome|istanbul|tslint|global |noqa|type:|pylint|nolint|rubocop|frozen_string_literal|-\*-)/i.test(out)) return undefined;
  return out.length > 320 ? `${out.slice(0, 317)}...` : out;
}

/** Strips quotes from a string literal's source text. */
export function unquote(text: string): string {
  const m = /^(?:[rbfuRBFU]{0,2}|@|\$|@\$|\$@)("""|'''|"|'|`)([\s\S]*)\1$/.exec(text);
  return m ? m[2]! : text;
}

/** `/users/{id}`, `/users/<int:id>`, `/users/:id` → `/users/:id`. */
export function normalizeRoutePath(path: string): string {
  let p = path
    .replace(/\{\*?(\w+)(:[^}]*)?\??\}/g, ':$1')
    .replace(/<(?:\w+:)?(\w+)>/g, ':$1')
    .replace(/\(\?P<(\w+)>[^)]*\)/g, ':$1')
    .replace(/[\^$]/g, '');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p.replace(/\/{2,}/g, '/');
}

export function joinRoute(prefix: string | undefined, path: string): string {
  if (!prefix) return normalizeRoutePath(path);
  return normalizeRoutePath(`${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
}

export abstract class BaseExtractor {
  readonly facts: FileFacts;
  protected scopes: Scope[] = [{ name: '' }];
  protected symbolsByName = new Map<string, SymbolFact>();
  /** Re-parse a snippet in isolation, for grammar-quirk recovery. Set by the adapter. */
  reparseSnippet: (<T>(text: string, fn: (root: Node) => T) => T) | null = null;

  constructor(path: string, language: SourceLanguage, hash: string, source: string) {
    this.facts = {
      path,
      language,
      hash,
      loc: source.split('\n').length,
      directives: [],
      imports: [],
      exports: [],
      symbols: [],
      references: [],
      routes: [],
      parseErrors: 0,
    };
  }

  run(root: Node): FileFacts {
    if (root.hasError) this.facts.parseErrors = root.descendantsOfType('ERROR').length;
    this.visitRoot(root);
    for (const sym of this.facts.symbols) {
      if (sym.locals && Object.keys(sym.locals).length === 0) delete sym.locals;
      if (sym.fields && sym.fields.length === 0) delete sym.fields;
    }
    return this.facts;
  }

  protected abstract visitRoot(root: Node): void;

  protected scope(): Scope {
    return this.scopes[this.scopes.length - 1]!;
  }

  protected withScope(scope: Scope, fn: () => void): void {
    this.scopes.push(scope);
    try {
      fn();
    } finally {
      this.scopes.pop();
    }
  }

  protected addRef(kind: ReferenceFact['kind'], callee: string[], node: Node, args?: ArgFact[]): void {
    if (callee.length === 0 || callee.some((c) => !c)) return;
    const ref: ReferenceFact = { from: this.scope().name, kind, callee, line: line(node) };
    if (args && args.some((a) => a !== null)) ref.args = args;
    this.facts.references.push(ref);
  }

  protected addSymbol(sym: SymbolFact): SymbolFact {
    const existing = this.symbolsByName.get(sym.qualifiedName);
    if (existing) return existing;
    this.symbolsByName.set(sym.qualifiedName, sym);
    this.facts.symbols.push(sym);
    return sym;
  }

  protected symbol(name: string, kind: SymbolFact['kind'], node: Node, exported: boolean, parent?: string): SymbolFact {
    const sym: SymbolFact = {
      name,
      qualifiedName: parent ? `${parent}.${name}` : name,
      kind,
      startLine: line(node),
      endLine: endLine(node),
      exported,
    };
    if (parent) sym.parent = parent;
    const first = node.text.split('\n', 1)[0]?.trim();
    if (first) sym.signature = first.length > 160 ? `${first.slice(0, 157)}...` : first;
    return sym;
  }

  protected addRoute(route: Omit<RouteFact, 'scope'> & { scope?: string }): void {
    this.facts.routes.push({ ...route, scope: route.scope ?? `route:${route.method} ${route.path}` });
  }

  /** Doc text from the comments directly above `node` (no blank line in between). */
  protected leadingDoc(node: Node, isComment: (n: Node) => boolean = (n) => n.type.includes('comment')): string | undefined {
    const comments: string[] = [];
    let expectRow = node.startPosition.row;
    let prev = node.previousSibling;
    while (prev && isComment(prev) && prev.endPosition.row >= expectRow - 1) {
      comments.unshift(prev.text);
      expectRow = prev.startPosition.row;
      prev = prev.previousSibling;
    }
    return comments.length ? cleanComment(comments.join('\n')) : undefined;
  }
}
