/**
 * TypeScript / JavaScript language adapter.
 *
 * Walks a tree-sitter syntax tree once and records syntactic facts:
 * imports, exports, declared symbols, call/new/JSX references with their
 * enclosing symbol, literal call arguments, and Express-style route
 * registrations. No cross-file resolution happens here.
 */
import type { Node } from 'web-tree-sitter';
import type {
  ArgFact,
  FieldFact,
  FileFacts,
  ImportFact,
  ImportSpecifier,
  SourceLanguage,
  SymbolFact,
  SymbolKind,
} from '@eyrie/core';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const TRANSPARENT = new Set([
  'await_expression',
  'parenthesized_expression',
  'non_null_expression',
  'as_expression',
  'satisfies_expression',
  'type_assertion',
]);
const FUNCTION_NODES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const LAZY_WRAPPERS = new Set(['dynamic', 'lazy', 'React.lazy', 'loadable']);
const MAX_CHAIN = 6;

interface Scope {
  name: string;
  locals?: Record<string, string>;
}

const line = (n: Node) => n.startPosition.row + 1;
const endLine = (n: Node) => n.endPosition.row + 1;

function unwrap(n: Node): Node {
  let cur = n;
  while (TRANSPARENT.has(cur.type)) {
    const inner = cur.namedChildren.find(
      (c) => c && c.type !== 'type_annotation' && c.type !== 'type_arguments' && !c.type.endsWith('_type'),
    );
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

function isFunctionNode(n: Node | null | undefined): boolean {
  return !!n && FUNCTION_NODES.has(n.type);
}

function unquote(n: Node): string {
  const t = n.text;
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'" || t[0] === '`')) return t.slice(1, -1);
  return t;
}

/** `import('./x')`: the specifier of a dynamic import call, or null. */
function dynamicImportSource(n: Node | null): string | null {
  if (n?.type !== 'call_expression' || n.childForFieldName('function')?.type !== 'import') return null;
  const first = n.childForFieldName('arguments')?.namedChildren[0];
  return first && (first.type === 'string' || first.type === 'template_string') ? unquote(first) : null;
}

/**
 * The names a binding pattern takes from a module: `m` is the whole module
 * (`import * as m`), `{ a, b: c }` takes `a` and `b` (as `c`).
 */
function moduleBindings(pattern: Node | null): ImportSpecifier[] {
  if (pattern?.type === 'identifier') return [{ imported: '*', local: pattern.text }];
  if (pattern?.type !== 'object_pattern') return [];
  const specifiers: ImportSpecifier[] = [];
  for (const p of pattern.namedChildren) {
    if (p?.type === 'shorthand_property_identifier_pattern') specifiers.push({ imported: p.text, local: p.text });
    else if (p?.type === 'pair_pattern') {
      const k = p.childForFieldName('key')?.text;
      const v = p.childForFieldName('value')?.text;
      if (k && v) specifiers.push({ imported: k, local: v });
    }
  }
  return specifiers;
}

/** The first parameter's binding pattern of an arrow or function expression. */
function firstParameter(fn: Node): Node | null {
  const single = fn.childForFieldName('parameter');
  if (single) return single;
  const p = fn.childForFieldName('parameters')?.namedChildren[0] ?? null;
  return p && (p.type === 'required_parameter' || p.type === 'optional_parameter') ? p.childForFieldName('pattern') : p;
}

function templateText(n: Node): string {
  return n.text.slice(1, -1).replace(/\$\{[^}]*\}/g, ':param');
}

function hasToken(n: Node, token: string): boolean {
  return n.children.some((c) => c?.type === token);
}

/** Root type name of a type annotation: `Repo<User>` → 'Repo', `Prisma.Client` → 'Prisma.Client'. */
function typeRoot(n: Node | null): string | undefined {
  if (!n) return undefined;
  let t: Node | null | undefined = n;
  if (t.type === 'type_annotation') t = t.namedChildren[0];
  if (!t) return undefined;
  switch (t.type) {
    case 'type_identifier':
    case 'nested_type_identifier':
    case 'identifier':
      return t.text;
    case 'generic_type':
      return t.childForFieldName('name')?.text ?? t.namedChildren[0]?.text;
    default:
      return undefined;
  }
}

/** Member chain of an expression: `this.repo.save` → ['this', 'repo', 'save']. */
function memberChain(node: Node | null): string[] | null {
  if (!node) return null;
  const n = unwrap(node);
  switch (n.type) {
    case 'identifier':
    case 'this':
    case 'super':
    case 'property_identifier':
    case 'private_property_identifier':
    case 'shorthand_property_identifier':
      return [n.text];
    case 'member_expression': {
      const obj = memberChain(n.childForFieldName('object'));
      const prop = n.childForFieldName('property');
      if (!obj || !prop || obj.length >= MAX_CHAIN) return null;
      return [...obj, prop.text];
    }
    case 'call_expression': {
      const inner = memberChain(n.childForFieldName('function'));
      if (!inner) return null;
      return [...inner.slice(0, -1), `${inner[inner.length - 1]}()`];
    }
    case 'subscript_expression': {
      const obj = memberChain(n.childForFieldName('object'));
      return obj ? [...obj, '[]'] : null;
    }
    default:
      return null;
  }
}

function literal(node: Node): ArgFact {
  const n = unwrap(node);
  if (n.type === 'string') return unquote(n);
  if (n.type === 'template_string') return templateText(n);
  if (n.type === 'binary_expression' && hasToken(n, '+')) {
    // 'https://api.example.com' + path  →  'https://api.example.com:param'
    const left = n.childForFieldName('left');
    const head = left ? literal(left) : null;
    return typeof head === 'string' ? `${head}:param` : null;
  }
  if (n.type === 'object') {
    const out: Record<string, string> = {};
    for (const pair of n.namedChildren) {
      if (pair?.type !== 'pair') continue;
      const key = pair.childForFieldName('key');
      const value = pair.childForFieldName('value');
      if (!key || !value) continue;
      const v = unwrap(value);
      if (v.type === 'string' || v.type === 'template_string') {
        out[key.type === 'string' ? unquote(key) : key.text] = v.type === 'string' ? unquote(v) : templateText(v);
      }
      if (Object.keys(out).length >= 6) break;
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

function cleanComment(raw: string): string | undefined {
  const text = raw
    .replace(/^\/\*\*?/gm, '')
    .replace(/\*\/$/gm, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(\*|\/\/)\s?/, '').trimEnd())
    .filter((l) => !/^\s*@/.test(l));
  const paragraph: string[] = [];
  for (const l of text) {
    if (l.trim() === '') {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(l.trim());
  }
  const out = paragraph.join(' ').trim();
  if (out.length < 3 || /^(eslint|@ts-|prettier|biome|istanbul|tslint|global )/i.test(out)) return undefined;
  return out.length > 320 ? `${out.slice(0, 317)}...` : out;
}

export class TypeScriptExtractor {
  readonly facts: FileFacts;
  private scopes: Scope[] = [{ name: '' }];
  private symbolsByName = new Map<string, SymbolFact>();
  private currentClass: SymbolFact | null = null;
  private declaratorName: string | null = null;

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
    for (const child of root.namedChildren) {
      if (!child) continue;
      if (child.type === 'expression_statement' && child.namedChildren[0]?.type === 'string') {
        this.facts.directives.push(unquote(child.namedChildren[0]));
        continue;
      }
      if (child.type !== 'comment') break;
    }
    for (const child of root.namedChildren) if (child) this.topLevel(child);
    for (const exp of this.facts.exports) {
      if (exp.kind === 'local') {
        const sym = this.symbolsByName.get(exp.local);
        if (sym) sym.exported = true;
      }
    }
    for (const sym of this.facts.symbols) {
      if (sym.locals && Object.keys(sym.locals).length === 0) delete sym.locals;
      if (sym.fields && sym.fields.length === 0) delete sym.fields;
    }
    return this.facts;
  }

  // ── top level ────────────────────────────────────────────────────────────

  private topLevel(node: Node): void {
    switch (node.type) {
      case 'comment':
        return;
      case 'import_statement':
        return this.importStatement(node);
      case 'export_statement':
        return this.exportStatement(node);
      case 'expression_statement':
        return this.moduleExpression(node);
      case 'ambient_declaration':
        return;
      default:
        if (this.declaration(node, false, false) === null) this.walk(node);
    }
  }

  /** Returns declared names, or null when the node is not a declaration. */
  private declaration(node: Node, exported: boolean, isDefault: boolean): string[] | null {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function_expression':
      case 'function':
        return [this.functionDecl(node, exported, isDefault ? 'default' : undefined)];
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class':
        return [this.classDecl(node, exported, isDefault ? 'default' : undefined)];
      case 'lexical_declaration':
      case 'variable_declaration':
        return this.variableDecl(node, exported);
      case 'interface_declaration':
        return [this.typeDecl(node, 'interface', exported)];
      case 'type_alias_declaration':
        return [this.typeDecl(node, 'type', exported)];
      case 'enum_declaration':
        return [this.typeDecl(node, 'enum', exported)];
      case 'ambient_declaration':
      case 'internal_module':
      case 'module':
        return [];
      default:
        return null;
    }
  }

  private importStatement(node: Node): void {
    const sourceNode = node.childForFieldName('source');
    const typeOnly = hasToken(node, 'type') || hasToken(node, 'typeof');
    const specifiers: ImportSpecifier[] = [];
    let source = sourceNode ? unquote(sourceNode) : '';
    for (const c of node.namedChildren) {
      if (c?.type === 'import_clause') {
        for (const part of c.namedChildren) {
          if (!part) continue;
          if (part.type === 'identifier') specifiers.push({ imported: 'default', local: part.text });
          else if (part.type === 'namespace_import') {
            const id = part.namedChildren.find((x) => x?.type === 'identifier');
            if (id) specifiers.push({ imported: '*', local: id.text });
          } else if (part.type === 'named_imports') {
            for (const spec of part.namedChildren) {
              if (spec?.type !== 'import_specifier') continue;
              const name = spec.childForFieldName('name');
              const alias = spec.childForFieldName('alias');
              if (!name) continue;
              const imported = name.type === 'string' ? unquote(name) : name.text;
              const s: ImportSpecifier = { imported, local: alias?.text ?? imported };
              if (hasToken(spec, 'type')) s.typeOnly = true;
              specifiers.push(s);
            }
          }
        }
      } else if (c?.type === 'import_require_clause') {
        const id = c.namedChildren.find((x) => x?.type === 'identifier');
        const src = c.childForFieldName('source') ?? c.namedChildren.find((x) => x?.type === 'string');
        if (src) source = unquote(src);
        if (id) specifiers.push({ imported: '*', local: id.text });
      }
    }
    if (source) this.facts.imports.push({ source, line: line(node), typeOnly, specifiers });
  }

  private exportStatement(node: Node): void {
    const sourceNode = node.childForFieldName('source');
    const l = line(node);
    if (sourceNode) {
      const source = unquote(sourceNode);
      let handled = false;
      for (const c of node.namedChildren) {
        if (c?.type === 'export_clause') {
          handled = true;
          for (const spec of c.namedChildren) {
            if (spec?.type !== 'export_specifier') continue;
            const name = spec.childForFieldName('name');
            const alias = spec.childForFieldName('alias');
            if (!name) continue;
            const imported = name.type === 'string' ? unquote(name) : name.text;
            const exported = alias ? (alias.type === 'string' ? unquote(alias) : alias.text) : imported;
            this.facts.exports.push({ kind: 'reexport', exported, imported, source, line: l });
          }
        } else if (c?.type === 'namespace_export') {
          handled = true;
          const id = c.namedChildren[0];
          if (id) this.facts.exports.push({ kind: 'reexport-namespace', exported: id.type === 'string' ? unquote(id) : id.text, source, line: l });
        }
      }
      if (!handled) this.facts.exports.push({ kind: 'reexport-all', source, line: l });
      return;
    }

    const isDefault = hasToken(node, 'default');
    const decl = node.childForFieldName('declaration');
    if (decl) {
      const names = this.declaration(decl, true, isDefault) ?? [];
      for (const name of names) this.facts.exports.push({ kind: 'local', exported: isDefault ? 'default' : name, local: name, line: l });
      return;
    }

    const value = node.childForFieldName('value');
    if (value && isDefault) {
      this.defaultExpression(value, node);
      return;
    }

    for (const c of node.namedChildren) {
      if (c?.type !== 'export_clause') continue;
      for (const spec of c.namedChildren) {
        if (spec?.type !== 'export_specifier') continue;
        const name = spec.childForFieldName('name');
        const alias = spec.childForFieldName('alias');
        if (!name) continue;
        this.facts.exports.push({ kind: 'local', exported: alias?.text ?? name.text, local: name.text, line: l });
      }
    }
  }

  /** `export default <expression>` */
  private defaultExpression(value: Node, statement: Node): void {
    const v = unwrap(value);
    const l = line(statement);
    if (v.type === 'identifier') {
      this.facts.exports.push({ kind: 'local', exported: 'default', local: v.text, line: l });
      return;
    }
    if (isFunctionNode(v)) {
      const name = v.childForFieldName('name')?.text ?? 'default';
      this.addFunction(name, statement, v, true);
      this.facts.exports.push({ kind: 'local', exported: 'default', local: name, line: l });
      return;
    }
    if (v.type === 'class') {
      const name = this.classDecl(v, true, 'default');
      this.facts.exports.push({ kind: 'local', exported: 'default', local: name, line: l });
      return;
    }
    this.bindValue('default', statement, v, true);
    this.facts.exports.push({ kind: 'local', exported: 'default', local: 'default', line: l });
  }

  /** CommonJS exports and module-scope expressions. */
  private moduleExpression(node: Node): void {
    const expr = node.namedChildren[0];
    if (expr?.type === 'assignment_expression') {
      const left = memberChain(expr.childForFieldName('left'));
      const right = expr.childForFieldName('right');
      if (left && right) {
        const r = unwrap(right);
        const l = line(node);
        if (left.length === 2 && left[0] === 'module' && left[1] === 'exports') {
          if (r.type === 'identifier') {
            this.facts.exports.push({ kind: 'local', exported: 'default', local: r.text, line: l });
            return;
          }
          if (r.type === 'object') {
            for (const member of r.namedChildren) {
              if (!member) continue;
              if (member.type === 'shorthand_property_identifier') {
                this.facts.exports.push({ kind: 'local', exported: member.text, local: member.text, line: l });
              } else if (member.type === 'pair') {
                const key = member.childForFieldName('key')?.text;
                const val = member.childForFieldName('value');
                if (!key || !val) continue;
                const uv = unwrap(val);
                if (uv.type === 'identifier') this.facts.exports.push({ kind: 'local', exported: key, local: uv.text, line: l });
                else if (isFunctionNode(uv)) {
                  this.addFunction(key, member, uv, true);
                  this.facts.exports.push({ kind: 'local', exported: key, local: key, line: l });
                }
              } else if (member.type === 'method_definition') {
                const key = member.childForFieldName('name')?.text;
                if (!key) continue;
                this.addFunction(key, member, member, true);
                this.facts.exports.push({ kind: 'local', exported: key, local: key, line: l });
              }
            }
            return;
          }
          const req = this.requireSource(r);
          if (req) {
            this.facts.exports.push({ kind: 'reexport-all', source: req, line: l });
            return;
          }
          if (isFunctionNode(r)) {
            this.addFunction('default', node, r, true);
            this.facts.exports.push({ kind: 'local', exported: 'default', local: 'default', line: l });
            return;
          }
          if (r.type === 'class') {
            const name = this.classDecl(r, true, 'default');
            this.facts.exports.push({ kind: 'local', exported: 'default', local: name, line: l });
            return;
          }
        }
        const isNamed =
          (left.length === 2 && left[0] === 'exports') || (left.length === 3 && left[0] === 'module' && left[1] === 'exports');
        if (isNamed) {
          const key = left[left.length - 1]!;
          if (r.type === 'identifier') this.facts.exports.push({ kind: 'local', exported: key, local: r.text, line: l });
          else {
            this.bindValue(key, node, r, true);
            this.facts.exports.push({ kind: 'local', exported: key, local: key, line: l });
          }
          return;
        }
      }
    }
    this.walk(node);
  }

  // ── declarations ─────────────────────────────────────────────────────────

  private functionDecl(node: Node, exported: boolean, fallbackName?: string): string {
    const name = node.childForFieldName('name')?.text ?? fallbackName ?? 'default';
    this.addFunction(name, node, node, exported);
    return name;
  }

  private addFunction(name: string, declNode: Node, fnNode: Node, exported: boolean, parent?: string): SymbolFact {
    const body = fnNode.childForFieldName('body');
    const returnsJsx = !!body && body.descendantsOfType(['jsx_element', 'jsx_self_closing_element']).length > 0;
    let kind: SymbolKind = 'function';
    if (parent) kind = 'method';
    else if (/^use[A-Z0-9]/.test(name)) kind = 'hook';
    else if (/^[A-Z]/.test(name) && returnsJsx) kind = 'react_component';
    const qualifiedName = parent ? `${parent}.${name}` : name;
    const sym: SymbolFact = {
      name,
      qualifiedName,
      kind,
      startLine: line(this.rangeStart(declNode)),
      endLine: endLine(declNode),
      exported,
      locals: {},
    };
    if (parent) sym.parent = parent;
    if (hasToken(fnNode, 'async')) sym.async = true;
    if (returnsJsx) sym.returnsJsx = true;
    this.decorate(sym, declNode);
    this.addSymbol(sym);
    this.collectParams(fnNode, sym.locals!);
    if (body) this.withScope({ name: qualifiedName, locals: sym.locals }, () => this.walk(body));
    return sym;
  }

  private classDecl(node: Node, exported: boolean, fallbackName?: string): string {
    const name = node.childForFieldName('name')?.text ?? fallbackName ?? 'default';
    const sym: SymbolFact = {
      name,
      qualifiedName: name,
      kind: 'class',
      startLine: line(this.rangeStart(node)),
      endLine: endLine(node),
      exported,
      fields: [],
    };
    const ext: string[] = [];
    const impl: string[] = [];
    const heritage = node.namedChildren.find((c) => c?.type === 'class_heritage');
    if (heritage) {
      for (const c of heritage.namedChildren) {
        if (!c) continue;
        if (c.type === 'extends_clause') {
          for (const v of c.childrenForFieldName('value')) {
            const chain = v && memberChain(v);
            if (chain) ext.push(chain.join('.'));
          }
        } else if (c.type === 'implements_clause') {
          for (const t of c.namedChildren) {
            const r = t && typeRoot(t);
            if (r) impl.push(r);
          }
        } else {
          const chain = memberChain(c);
          if (chain) ext.push(chain.join('.'));
        }
      }
    }
    if (ext.length) sym.extends = ext;
    if (impl.length) sym.implements = impl;
    this.decorate(sym, node);
    this.addSymbol(sym);

    const prevClass = this.currentClass;
    this.currentClass = sym;
    const body = node.childForFieldName('body');
    for (const m of body?.namedChildren ?? []) {
      if (!m) continue;
      if (m.type === 'method_definition') {
        const mname = m.childForFieldName('name')?.text;
        if (!mname) continue;
        if (mname === 'constructor') this.collectParams(m, {}, sym.fields);
        this.addFunction(mname, m, m, false, name);
      } else if (m.type === 'public_field_definition' || m.type === 'field_definition') {
        const fname = (m.childForFieldName('name') ?? m.childForFieldName('property'))?.text;
        if (!fname) continue;
        const value = m.childForFieldName('value');
        const v = value ? unwrap(value) : null;
        if (v && isFunctionNode(v)) {
          this.addFunction(fname, m, v, false, name);
          continue;
        }
        const field: FieldFact = { name: fname };
        const t = typeRoot(m.childForFieldName('type'));
        if (t) field.type = t;
        if (v?.type === 'new_expression') {
          const ctor = memberChain(v.childForFieldName('constructor'));
          if (ctor) field.instanceOf = ctor.join('.');
        }
        sym.fields!.push(field);
        if (value) this.withScope({ name }, () => this.walk(value));
      } else if (m.type === 'class_static_block') {
        this.withScope({ name }, () => this.walk(m));
      }
    }
    this.currentClass = prevClass;
    return name;
  }

  private variableDecl(node: Node, exported: boolean): string[] {
    const names: string[] = [];
    for (const d of node.namedChildren) {
      if (d?.type !== 'variable_declarator') continue;
      const nameNode = d.childForFieldName('name');
      const value = d.childForFieldName('value');
      if (!nameNode) continue;
      // `const m = await import('./x')` / `const { a } = await import('./x')`: an import binding, not a variable.
      if (this.dynamicImportBinding(nameNode, value, d)) continue;
      if (nameNode.type !== 'identifier') {
        // Destructuring: `const { a, b } = require('./x')`
        const req = value ? this.requireSource(unwrap(value)) : null;
        if (req && nameNode.type === 'object_pattern') {
          this.facts.imports.push({ source: req, line: line(d), typeOnly: false, specifiers: moduleBindings(nameNode) });
        } else if (value) this.walk(value);
        continue;
      }
      const name = nameNode.text;
      if (value) {
        const req = this.requireSource(unwrap(value));
        if (req) {
          this.facts.imports.push({ source: req, line: line(d), typeOnly: false, specifiers: [{ imported: '*', local: name }] });
          continue;
        }
      }
      names.push(name);
      const declNode = d.parent ?? d;
      this.bindValue(name, declNode, value ? unwrap(value) : null, exported, typeRoot(d.childForFieldName('type')), d);
    }
    return names;
  }

  /** Create a symbol for `name = value` at module scope. */
  private bindValue(name: string, declNode: Node, v: Node | null, exported: boolean, typeName?: string, rangeNode?: Node): void {
    if (v && isFunctionNode(v)) {
      this.addFunction(name, declNode, v, exported);
      return;
    }
    if (v?.type === 'class') {
      this.classDecl(v, exported, name);
      return;
    }
    if (v?.type === 'call_expression') {
      const fnChain = memberChain(v.childForFieldName('function'));
      const fnName = fnChain?.join('.');
      const args = v.childForFieldName('arguments');
      if (fnName && LAZY_WRAPPERS.has(fnName)) {
        const prev = this.declaratorName;
        this.declaratorName = name;
        this.walk(v);
        this.declaratorName = prev;
        return;
      }
      const inner = args?.namedChildren.map((a) => (a ? unwrap(a) : null)).find((a) => isFunctionNode(a));
      if (inner) {
        // Wrapped function: withAuth(async (req) => ...), memo(() => <div/>), forwardRef(...)
        const sym = this.addFunction(name, declNode, inner, exported);
        if (fnName) sym.initCall = fnName;
        this.withScope({ name, locals: sym.locals }, () => {
          if (fnChain) this.addRef('call', fnChain, v, this.literalArgs(args));
          for (const a of args?.namedChildren ?? []) {
            if (!a || unwrap(a).equals(inner)) continue;
            this.argument(a);
          }
        });
        return;
      }
    }
    const sym: SymbolFact = {
      name,
      qualifiedName: name,
      kind: 'variable',
      startLine: line(this.rangeStart(declNode)),
      endLine: endLine(rangeNode ?? declNode),
      exported,
    };
    if (typeName) sym.typeName = typeName;
    if (v?.type === 'new_expression') {
      const ctor = memberChain(v.childForFieldName('constructor'));
      if (ctor) sym.instanceOf = ctor.join('.');
    } else if (v?.type === 'call_expression') {
      const fn = memberChain(v.childForFieldName('function'));
      if (fn) sym.initCall = fn.join('.');
    }
    this.decorate(sym, declNode);
    this.addSymbol(sym);
    if (!v) return;
    if (v.type === 'object') {
      this.objectMembers(name, v);
      return;
    }
    this.withScope({ name }, () => this.walk(v));
  }

  /** Object-literal services: `export const resumeService = { generate() {} }`. */
  private objectMembers(owner: string, obj: Node): void {
    for (const member of obj.namedChildren) {
      if (!member) continue;
      if (member.type === 'method_definition') {
        const key = member.childForFieldName('name')?.text;
        if (key) this.addFunction(key, member, member, false, owner);
      } else if (member.type === 'pair') {
        const keyNode = member.childForFieldName('key');
        const val = member.childForFieldName('value');
        if (!keyNode || !val) continue;
        const key = keyNode.type === 'string' ? unquote(keyNode) : keyNode.text;
        const v = unwrap(val);
        if (isFunctionNode(v)) this.addFunction(key, member, v, false, owner);
        else this.withScope({ name: owner }, () => this.argument(v));
      } else if (member.type === 'shorthand_property_identifier') {
        this.withScope({ name: owner }, () => this.addRef('ref', [member.text], member));
      } else {
        this.withScope({ name: owner }, () => this.walk(member));
      }
    }
  }

  private typeDecl(node: Node, kind: SymbolKind, exported: boolean): string {
    const name = node.childForFieldName('name')?.text ?? 'default';
    const sym: SymbolFact = {
      name,
      qualifiedName: name,
      kind,
      startLine: line(this.rangeStart(node)),
      endLine: endLine(node),
      exported,
    };
    if (kind === 'interface') {
      const ext = node.namedChildren.find((c) => c?.type === 'extends_type_clause');
      const names = ext?.namedChildren.map((t) => (t ? typeRoot(t) : undefined)).filter((x): x is string => !!x);
      if (names?.length) sym.extends = names;
    }
    this.decorate(sym, node);
    this.addSymbol(sym);
    return name;
  }

  // ── references ───────────────────────────────────────────────────────────

  private walk(node: Node): void {
    switch (node.type) {
      case 'comment':
      case 'string':
      case 'regex':
      case 'number':
      case 'type_annotation':
      case 'type_arguments':
      case 'type_parameters':
        return;
      case 'call_expression':
        return this.callExpression(node);
      case 'new_expression':
        return this.newExpression(node);
      case 'jsx_opening_element':
      case 'jsx_self_closing_element':
        return this.jsxElement(node);
      case 'jsx_expression': {
        const inner = node.namedChildren[0];
        if (inner && (inner.type === 'identifier' || inner.type === 'member_expression')) {
          const chain = memberChain(inner);
          if (chain && chain[0] !== 'props') this.addRef('ref', chain, inner);
          return;
        }
        break;
      }
      case 'lexical_declaration':
      case 'variable_declaration':
        return this.localDeclaration(node);
      case 'assignment_expression':
        return this.assignment(node);
      case 'arrow_function':
      case 'function_expression':
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'method_definition': {
        const locals = this.scope().locals;
        if (locals) this.collectParams(node, locals);
        const body = node.childForFieldName('body');
        if (body) this.walk(body);
        return;
      }
    }
    for (const c of node.namedChildren) if (c) this.walk(c);
  }

  private argument(a: Node): void {
    const u = unwrap(a);
    if (u.type === 'identifier') this.addRef('ref', [u.text], u);
    else this.walk(a);
  }

  /**
   * Records `pattern = await import('./x')` as the import it is: the whole
   * module for an identifier, named imports for an object pattern. Returns
   * false when `value` is not a dynamic import.
   */
  private dynamicImportBinding(pattern: Node | null, value: Node | null, at: Node): boolean {
    const source = dynamicImportSource(value ? unwrap(value) : null);
    if (source === null) return false;
    this.facts.imports.push({ source, line: line(at), typeOnly: false, specifiers: moduleBindings(pattern), dynamic: true });
    return true;
  }

  private callExpression(node: Node): void {
    const fn = node.childForFieldName('function');
    const args = node.childForFieldName('arguments');
    if (!fn) return;
    // `import('./x').then((m) => m.run())`: the callback's parameter is the module.
    if (fn.type === 'member_expression' && fn.childForFieldName('property')?.text === 'then') {
      const callback = args?.namedChildren[0];
      if (callback && isFunctionNode(unwrap(callback)) && this.dynamicImportBinding(firstParameter(unwrap(callback)), fn.childForFieldName('object'), node)) {
        for (const a of args!.namedChildren) if (a) this.argument(a);
        return;
      }
    }
    if (fn.type === 'import') {
      const first = args?.namedChildren[0];
      if (first && (first.type === 'string' || first.type === 'template_string')) {
        const imp: ImportFact = { source: unquote(first), line: line(node), typeOnly: false, specifiers: [], dynamic: true };
        if (this.declaratorName) imp.specifiers.push({ imported: 'default', local: this.declaratorName });
        this.facts.imports.push(imp);
      }
      return;
    }
    const chain = memberChain(fn);
    if (chain) {
      if (chain.length === 1 && chain[0] === 'require') {
        const src = this.requireSource(node);
        if (src) this.facts.imports.push({ source: src, line: line(node), typeOnly: false, specifiers: [], dynamic: true });
        return;
      }
      const argFacts = this.literalArgs(args);
      const method = chain.length === 2 ? chain[1]!.toLowerCase() : '';
      const path = argFacts?.[0];
      if (HTTP_METHODS.has(method) && typeof path === 'string' && path.startsWith('/') && args) {
        const m = method.toUpperCase();
        const scope = `route:${m} ${path}`;
        const handlers: string[] = [];
        for (const a of args.namedChildren.slice(1)) {
          const c = a && memberChain(a);
          if (c) handlers.push(c.join('.'));
        }
        this.facts.routes.push({ method: m, path, line: line(node), router: chain[0]!, scope, handlers });
        this.addRef('call', chain, node, argFacts);
        this.withScope({ name: scope, locals: {} }, () => {
          for (const a of args.namedChildren.slice(1)) if (a) this.argument(a);
        });
        return;
      }
      this.addRef('call', chain, node, argFacts);
      if (fn.type === 'member_expression') {
        const obj = fn.childForFieldName('object');
        if (obj) this.walk(obj);
      }
    } else {
      this.walk(fn);
    }
    for (const a of args?.namedChildren ?? []) if (a) this.argument(a);
  }

  private newExpression(node: Node): void {
    const chain = memberChain(node.childForFieldName('constructor'));
    const args = node.childForFieldName('arguments');
    if (chain) this.addRef('new', chain, node, this.literalArgs(args));
    for (const a of args?.namedChildren ?? []) if (a) this.argument(a);
  }

  private jsxElement(node: Node): void {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      const text = nameNode.text;
      if (/^[A-Z]/.test(text) || text.includes('.')) this.addRef('jsx', text.split('.'), nameNode);
    }
    for (const c of node.namedChildren) if (c && !(nameNode && c.equals(nameNode))) this.walk(c);
  }

  private localDeclaration(node: Node): void {
    const locals = this.scope().locals;
    for (const d of node.namedChildren) {
      if (d?.type !== 'variable_declarator') continue;
      const nameNode = d.childForFieldName('name');
      const value = d.childForFieldName('value');
      if (this.dynamicImportBinding(nameNode, value, d)) continue;
      if (nameNode?.type === 'identifier' && locals) {
        const v = value ? unwrap(value) : null;
        const t = typeRoot(d.childForFieldName('type'));
        if (v?.type === 'new_expression') {
          const ctor = memberChain(v.childForFieldName('constructor'));
          if (ctor) locals[nameNode.text] = ctor.join('.');
        } else if (t) {
          locals[nameNode.text] = t;
        } else if (v?.type === 'call_expression') {
          const fn = memberChain(v.childForFieldName('function'));
          if (fn) locals[nameNode.text] = `call:${fn.join('.')}`;
        }
      }
      if (!value) continue;
      const prev = this.declaratorName;
      this.declaratorName = nameNode?.type === 'identifier' ? nameNode.text : null;
      this.walk(value);
      this.declaratorName = prev;
    }
  }

  private assignment(node: Node): void {
    const left = memberChain(node.childForFieldName('left'));
    const right = node.childForFieldName('right');
    if (!right) return;
    const r = unwrap(right);
    if (left && left[0] === 'this' && left.length === 2 && this.currentClass && r.type === 'new_expression') {
      const ctor = memberChain(r.childForFieldName('constructor'));
      const fields = (this.currentClass.fields ??= []);
      if (ctor && !fields.some((f) => f.name === left[1])) fields.push({ name: left[1]!, instanceOf: ctor.join('.') });
    }
    this.walk(right);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private scope(): Scope {
    return this.scopes[this.scopes.length - 1]!;
  }

  private withScope(scope: Scope, fn: () => void): void {
    this.scopes.push(scope);
    try {
      fn();
    } finally {
      this.scopes.pop();
    }
  }

  private addRef(kind: 'call' | 'new' | 'jsx' | 'ref', callee: string[], node: Node, args?: ArgFact[]): void {
    const ref: FileFacts['references'][number] = { from: this.scope().name, kind, callee, line: line(node) };
    if (args) ref.args = args;
    this.facts.references.push(ref);
  }

  private literalArgs(args: Node | null | undefined): ArgFact[] | undefined {
    if (!args) return undefined;
    const out = args.namedChildren.slice(0, 3).map((a) => (a ? literal(a) : null));
    return out.some((x) => x !== null) ? out : undefined;
  }

  private requireSource(n: Node): string | null {
    if (n.type !== 'call_expression') return null;
    const fn = n.childForFieldName('function');
    if (fn?.type !== 'identifier' || fn.text !== 'require') return null;
    const first = n.childForFieldName('arguments')?.namedChildren[0];
    return first?.type === 'string' ? unquote(first) : null;
  }

  private collectParams(fnNode: Node, locals: Record<string, string>, fields?: FieldFact[]): void {
    const params = fnNode.childForFieldName('parameters');
    if (!params) return;
    for (const p of params.namedChildren) {
      if (!p || (p.type !== 'required_parameter' && p.type !== 'optional_parameter')) continue;
      const pattern = p.childForFieldName('pattern');
      if (pattern?.type !== 'identifier') continue;
      const t = typeRoot(p.childForFieldName('type'));
      if (t) locals[pattern.text] = t;
      if (fields && p.namedChildren.some((c) => c?.type === 'accessibility_modifier')) {
        const field: FieldFact = { name: pattern.text };
        if (t) field.type = t;
        fields.push(field);
      }
    }
  }

  /** Statements wrapped in `export` start at the export keyword. */
  private rangeStart(node: Node): Node {
    let cur = node;
    if (cur.type === 'variable_declarator' && cur.parent) cur = cur.parent;
    if (cur.parent?.type === 'export_statement') cur = cur.parent;
    return cur;
  }

  private decorate(sym: SymbolFact, declNode: Node): void {
    const start = this.rangeStart(declNode);
    const first = start.text.split('\n', 1)[0]?.trim();
    if (first) sym.signature = first.length > 160 ? `${first.slice(0, 157)}...` : first;
    const comments: string[] = [];
    let expectRow = start.startPosition.row;
    let prev = start.previousSibling;
    while (prev && prev.type === 'comment' && prev.endPosition.row >= expectRow - 1) {
      comments.unshift(prev.text);
      expectRow = prev.startPosition.row;
      prev = prev.previousSibling;
    }
    if (comments.length) {
      const doc = cleanComment(comments.join('\n'));
      if (doc) sym.doc = doc;
    }
  }

  private addSymbol(sym: SymbolFact): void {
    if (this.symbolsByName.has(sym.qualifiedName)) return;
    this.symbolsByName.set(sym.qualifiedName, sym);
    this.facts.symbols.push(sym);
  }
}

