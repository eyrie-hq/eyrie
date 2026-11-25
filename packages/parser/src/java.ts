/**
 * Java language adapter.
 *
 * Records the package, imports (single-type, wildcard and static),
 * classes / interfaces / enums / records with typed fields, method call
 * references, Spring MVC / JAX-RS / Micronaut routes and JPA entities.
 * Bare field and method names inside a class become `this.x` so the
 * graph resolves them through field types.
 */
import type { Node } from 'web-tree-sitter';
import { ownValue, type ArgFact, type FieldFact, type ImportFact, type ModelFact, type SymbolFact, type SymbolKind } from '@eyrie/core';
import { BaseExtractor, joinRoute, line } from './base.js';

const MAX_CHAIN = 6;
const TYPE_DECLS: Record<string, SymbolKind> = {
  class_declaration: 'class',
  record_declaration: 'class',
  interface_declaration: 'interface',
  annotation_type_declaration: 'interface',
  enum_declaration: 'enum',
};
const SPRING_VERBS: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
  // Micronaut
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Delete: 'DELETE',
  Patch: 'PATCH',
};
const JAXRS_VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
// `@MappedSuperclass` (BaseEntity) shares columns but is not a table itself.
const ENTITY = new Set(['Entity', 'Document', 'Table']);
const RELATION = new Set(['ManyToOne', 'OneToMany', 'OneToOne', 'ManyToMany', 'DBRef']);
const WRAPPERS = new Set(['List', 'Set', 'Collection', 'Optional', 'Iterable', 'Mono', 'Flux', 'CompletableFuture', 'Page']);

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'string_literal') return n.namedChildren.map((c) => (c?.type === 'string_fragment' || c?.type === 'escape_sequence' ? c.text : '')).join('');
  if (n.type === 'element_value_array_initializer') return stringValue(n.namedChildren[0]);
  return null;
}

function literal(n: Node): ArgFact {
  const s = stringValue(n);
  if (s !== null) return s;
  if (n.type === 'binary_expression' && n.childForFieldName('operator')?.text === '+') {
    const left = n.childForFieldName('left');
    const head = left ? literal(left) : null;
    return typeof head === 'string' ? `${head}:param` : null;
  }
  return null;
}

/** `List<Order>` → 'List' (or 'Order' with `unwrap`), `a.b.C` → 'a.b.C'. */
function typeRoot(n: Node | null | undefined, unwrap = false): string | undefined {
  if (!n) return undefined;
  switch (n.type) {
    case 'type_identifier':
    case 'identifier':
    case 'scoped_type_identifier':
      return n.text;
    case 'generic_type': {
      const base = n.namedChildren[0];
      if (unwrap && base && WRAPPERS.has(base.text)) return typeRoot(n.namedChildren[1]?.namedChildren[0], true);
      return base ? typeRoot(base) : undefined;
    }
    case 'array_type':
      return typeRoot(n.childForFieldName('element'), unwrap);
    default:
      return undefined;
  }
}

interface Annotation {
  name: string;
  args: Node | null;
}

function annotations(decl: Node): Annotation[] {
  const mods = decl.namedChildren.find((c) => c?.type === 'modifiers');
  return (mods?.namedChildren ?? [])
    .filter((a): a is Node => a?.type === 'annotation' || a?.type === 'marker_annotation')
    .map((a) => ({ name: (a.childForFieldName('name')?.text ?? '').split('.').pop()!, args: a.childForFieldName('arguments') }));
}

/** `@X("/a")`, `@X(value = "/a")`, `@X(path = {"/a"})` → '/a'. */
function annotationString(args: Node | null, keys = ['value', 'path']): string | undefined {
  for (const a of args?.namedChildren ?? []) {
    if (!a) continue;
    const direct = stringValue(a);
    if (direct !== null) return direct;
    if (a.type === 'element_value_pair' && keys.includes(a.childForFieldName('key')?.text ?? '')) {
      const v = stringValue(a.childForFieldName('value'));
      if (v !== null) return v;
    }
  }
  return undefined;
}

function hasModifier(decl: Node, word: string): boolean {
  const mods = decl.namedChildren.find((c) => c?.type === 'modifiers');
  return !!mods && mods.children.some((c) => c?.text === word);
}

interface ClassCtx {
  sym: SymbolFact;
  fields: Set<string>;
  methods: Set<string>;
}

export class JavaExtractor extends BaseExtractor {
  private cls: ClassCtx | null = null;
  private declared: Set<string>[] = [];

  protected visitRoot(root: Node): void {
    for (const child of root.namedChildren) {
      if (!child) continue;
      if (child.type === 'package_declaration') {
        const id = child.namedChildren.find((c) => c?.type === 'scoped_identifier' || c?.type === 'identifier');
        if (id) this.facts.namespace = id.text;
      } else if (child.type === 'import_declaration') this.importDecl(child);
      else if (TYPE_DECLS[child.type]) this.typeDecl(child, undefined);
    }
  }

  private importDecl(node: Node): void {
    const id = node.namedChildren.find((c) => c?.type === 'scoped_identifier' || c?.type === 'identifier');
    if (!id) return;
    const isStatic = node.children.some((c) => c?.type === 'static');
    const wildcard = node.namedChildren.some((c) => c?.type === 'asterisk');
    const name = id.text;
    const imp: ImportFact = { source: name, line: line(node), typeOnly: false, specifiers: [] };
    if (wildcard) {
      if (isStatic) return;
      imp.wildcard = true;
    } else if (isStatic) {
      const dot = name.lastIndexOf('.');
      const owner = name.slice(0, dot);
      const member = name.slice(dot + 1);
      imp.source = owner;
      imp.specifiers.push({ imported: `${owner.split('.').pop()}.${member}`, local: member });
    } else {
      const simple = name.split('.').pop()!;
      imp.specifiers.push({ imported: simple, local: simple });
    }
    this.facts.imports.push(imp);
  }

  private typeDecl(node: Node, parent: ClassCtx | undefined): void {
    const name = node.childForFieldName('name')?.text;
    if (!name) return;
    const kind = TYPE_DECLS[node.type]!;
    const sym = this.symbol(name, kind, node, !hasModifier(node, 'private'), parent?.sym.qualifiedName);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    const superclass = typeRoot(node.childForFieldName('superclass')?.namedChildren[0]);
    const ifaceList = node.childForFieldName('interfaces') ?? node.namedChildren.find((c) => c?.type === 'extends_interfaces');
    const ifaces = (ifaceList?.descendantsOfType('type_list')[0]?.namedChildren ?? []).map((t) => typeRoot(t)).filter((t): t is string => !!t);
    if (kind === 'interface') {
      if (ifaces.length) sym.extends = ifaces;
    } else {
      if (superclass) sym.extends = [superclass];
      if (ifaces.length) sym.implements = ifaces;
    }
    sym.fields = [];
    this.addSymbol(sym);

    const anns = annotations(node);
    const body = node.childForFieldName('body');
    const ctx: ClassCtx = { sym, fields: new Set(), methods: new Set() };
    // Record components are fields.
    for (const p of node.childForFieldName('parameters')?.namedChildren ?? []) {
      if (p?.type !== 'formal_parameter') continue;
      const pn = p.childForFieldName('name')?.text;
      const t = typeRoot(p.childForFieldName('type'));
      if (pn) {
        sym.fields.push(t ? { name: pn, type: t } : { name: pn });
        ctx.fields.add(pn);
      }
    }
    for (const m of body?.namedChildren ?? []) {
      if (m?.type === 'field_declaration' || m?.type === 'constant_declaration') {
        for (const d of m.childrenForFieldName('declarator')) {
          const n = d?.childForFieldName('name')?.text;
          if (n) ctx.fields.add(n);
        }
      } else if (m?.type === 'method_declaration') {
        const n = m.childForFieldName('name')?.text;
        if (n) ctx.methods.add(n);
      }
    }

    const prefix = this.classRoutePrefix(anns);
    const model: ModelFact | null = anns.some((a) => ENTITY.has(a.name))
      ? ({ name, line: sym.startLine, endLine: sym.endLine, fields: [], relations: [], orm: 'jpa', symbol: sym.qualifiedName })
      : null;

    const prev = this.cls;
    this.cls = ctx;
    for (const m of body?.namedChildren ?? []) {
      if (!m) continue;
      if (TYPE_DECLS[m.type]) this.typeDecl(m, ctx);
      else if (m.type === 'field_declaration' || m.type === 'constant_declaration') this.field(m, sym, model);
      else if (m.type === 'method_declaration' || m.type === 'constructor_declaration' || m.type === 'compact_constructor_declaration') this.method(m, sym, prefix);
      else if (m.type === 'enum_body_declarations') {
        for (const e of m.namedChildren) if (e && (e.type === 'method_declaration' || e.type === 'constructor_declaration')) this.method(e, sym, prefix);
      } else this.withScope({ name: sym.qualifiedName }, () => this.walk(m));
    }
    this.cls = prev;
    if (model) (this.facts.models ??= []).push(model);
  }

  private classRoutePrefix(anns: Annotation[]): string | undefined {
    for (const a of anns) {
      if (a.name === 'RequestMapping' || a.name === 'Path' || a.name === 'Controller') {
        const p = annotationString(a.args);
        if (p !== undefined) return p;
      }
    }
    return undefined;
  }

  private field(node: Node, owner: SymbolFact, model: ModelFact | null): void {
    const t = typeRoot(node.childForFieldName('type'));
    const anns = annotations(node);
    const relation = anns.some((a) => RELATION.has(a.name)) ? typeRoot(node.childForFieldName('type'), true) : undefined;
    for (const d of node.childrenForFieldName('declarator')) {
      const n = d?.childForFieldName('name')?.text;
      if (!d || !n) continue;
      const f: FieldFact = { name: n };
      if (t) f.type = t;
      const v = d.childForFieldName('value');
      if (v?.type === 'object_creation_expression') {
        const ct = typeRoot(v.childForFieldName('type'));
        if (ct) f.instanceOf = ct;
      }
      owner.fields!.push(f);
      if (model) model.fields.push(n);
      if (v) this.withScope({ name: owner.qualifiedName }, () => this.walk(v));
    }
    if (model && relation && !model.relations.includes(relation)) model.relations.push(relation);
  }

  private method(node: Node, owner: SymbolFact, prefix: string | undefined): void {
    const isCtor = node.type !== 'method_declaration';
    const name = isCtor ? '<init>' : node.childForFieldName('name')?.text;
    if (!name) return;
    const sym = this.symbol(isCtor ? 'constructor' : name, 'method', node, !hasModifier(node, 'private'), owner.qualifiedName);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    sym.locals = {};
    this.addSymbol(sym);
    const declared = new Set<string>();
    for (const p of node.childForFieldName('parameters')?.namedChildren ?? []) {
      if (p?.type !== 'formal_parameter' && p?.type !== 'spread_parameter') continue;
      const pn = (p.childForFieldName('name') ?? p.namedChildren.find((c) => c?.type === 'variable_declarator')?.childForFieldName('name'))?.text;
      const t = typeRoot(p.childForFieldName('type') ?? p.namedChildren.find((c) => c?.type?.endsWith('type') || c?.type === 'type_identifier'));
      if (!pn) continue;
      declared.add(pn);
      if (t) sym.locals[pn] = t;
    }
    if (!isCtor) this.methodRoutes(node, sym, prefix);
    const body = node.childForFieldName('body');
    if (body) {
      this.declared.push(declared);
      this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => this.walk(body));
      this.declared.pop();
    }
  }

  private methodRoutes(node: Node, sym: SymbolFact, prefix: string | undefined): void {
    let jaxPath: string | undefined;
    const jaxVerbs: string[] = [];
    for (const a of annotations(node)) {
      const verb = ownValue(SPRING_VERBS, a.name);
      if (verb || a.name === 'RequestMapping') {
        const path = annotationString(a.args) ?? '';
        let methods = verb ? [verb] : [];
        if (!verb) {
          const m = a.args?.namedChildren.find((p) => p?.type === 'element_value_pair' && p.childForFieldName('key')?.text === 'method');
          methods = (m?.childForFieldName('value')?.text.match(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g) ?? ['ANY']) as string[];
        }
        for (const method of methods) {
          this.addRoute({ method, path: joinRoute(prefix, path), line: line(node), router: 'spring', handlers: [sym.qualifiedName], framework: 'spring' });
        }
      } else if (a.name === 'Path') jaxPath = annotationString(a.args);
      else if (JAXRS_VERBS.has(a.name)) jaxVerbs.push(a.name);
    }
    for (const method of jaxVerbs) {
      this.addRoute({ method, path: joinRoute(prefix, jaxPath ?? ''), line: line(node), router: 'jaxrs', handlers: [sym.qualifiedName], framework: 'jaxrs' });
    }
  }

  // ── references ───────────────────────────────────────────────────────────

  private isDeclared(name: string): boolean {
    return this.declared.some((s) => s.has(name));
  }

  /** Bare names that are fields or methods of the enclosing class become `this.x`. */
  private rootName(name: string): string[] {
    if (this.cls && !this.isDeclared(name) && (this.cls.fields.has(name) || this.cls.methods.has(name))) return ['this', name];
    return [name];
  }

  private chain(node: Node | null | undefined): string[] | null {
    if (!node) return null;
    switch (node.type) {
      case 'identifier':
        return this.rootName(node.text);
      case 'this':
      case 'super':
        return [node.type];
      case 'field_access': {
        const obj = this.chain(node.childForFieldName('object'));
        const field = node.childForFieldName('field');
        if (!obj || !field || obj.length >= MAX_CHAIN) return null;
        return [...obj, field.text];
      }
      case 'method_invocation': {
        const obj = node.childForFieldName('object');
        const name = node.childForFieldName('name')?.text;
        if (!name) return null;
        const head = obj ? this.chain(obj) : this.rootName(name).slice(0, -1);
        if (!head || head.length >= MAX_CHAIN) return null;
        return [...head, `${name}()`];
      }
      case 'parenthesized_expression':
      case 'cast_expression':
        return this.chain(node.childForFieldName('value') ?? node.namedChildren[node.namedChildren.length - 1]);
      case 'array_access': {
        const obj = this.chain(node.childForFieldName('array'));
        return obj ? [...obj, '[]'] : null;
      }
      default:
        return null;
    }
  }

  private walk(node: Node): void {
    switch (node.type) {
      case 'line_comment':
      case 'block_comment':
      case 'string_literal':
      case 'decimal_integer_literal':
      case 'annotation':
      case 'marker_annotation':
        return;
      case 'method_invocation':
        return this.invocation(node);
      case 'object_creation_expression': {
        const t = typeRoot(node.childForFieldName('type'));
        const args = node.childForFieldName('arguments')?.namedChildren.filter((a): a is Node => !!a) ?? [];
        if (t) this.addRef('new', t.split('.'), node, args.slice(0, 3).map(literal));
        for (const a of args) this.argument(a);
        const body = node.namedChildren.find((c) => c?.type === 'class_body');
        if (body) this.walk(body);
        return;
      }
      case 'local_variable_declaration':
        return this.localVar(node);
      case 'lambda_expression': {
        const params = node.childForFieldName('parameters');
        const names = params?.type === 'identifier' ? [params.text] : (params?.descendantsOfType('identifier') ?? []).map((p) => p?.text ?? '');
        this.declared.push(new Set(names));
        const body = node.childForFieldName('body');
        if (body) this.walk(body);
        this.declared.pop();
        return;
      }
      case 'class_declaration':
        return;
    }
    for (const c of node.namedChildren) if (c) this.walk(c);
  }

  private localVar(node: Node): void {
    const locals = this.scope().locals;
    const t = typeRoot(node.childForFieldName('type'));
    for (const d of node.childrenForFieldName('declarator')) {
      const n = d?.childForFieldName('name')?.text;
      if (!d || !n) continue;
      this.declared[this.declared.length - 1]?.add(n);
      const v = d.childForFieldName('value');
      if (locals) {
        if (t && t !== 'var') locals[n] = t;
        else if (v?.type === 'object_creation_expression') {
          const ct = typeRoot(v.childForFieldName('type'));
          if (ct) locals[n] = ct;
        } else if (v?.type === 'method_invocation') {
          const c = this.chain(v);
          if (c) locals[n] = `call:${c.join('.').replace(/\(\)$/, '')}`;
        }
      }
      if (v) this.walk(v);
    }
  }

  private invocation(node: Node): void {
    const c = this.chain(node);
    const args = node.childForFieldName('arguments')?.namedChildren.filter((a): a is Node => !!a) ?? [];
    if (c) {
      const callee = [...c.slice(0, -1), c[c.length - 1]!.replace(/\(\)$/, '')];
      this.addRef('call', callee, node, args.slice(0, 3).map(literal));
    }
    const obj = node.childForFieldName('object');
    if (obj && obj.type !== 'identifier' && obj.type !== 'this') this.walk(obj);
    for (const a of args) this.argument(a);
  }

  private argument(a: Node): void {
    if (a.type === 'identifier' || a.type === 'field_access') {
      const c = this.chain(a);
      if (c) this.addRef('ref', c, a);
    } else this.walk(a);
  }
}
