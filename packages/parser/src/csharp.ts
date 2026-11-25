/**
 * C# language adapter.
 *
 * Records the namespace, `using` directives (namespace imports are
 * wildcards; aliases bind a name), classes / interfaces / structs /
 * records with typed fields and properties, call references, ASP.NET
 * controller and minimal-API routes, and EF Core `DbSet<T>` models.
 * Bare field and method names inside a class become `this.x`.
 */
import type { Node } from 'web-tree-sitter';
import { ownValue, type ArgFact, type FieldFact, type ImportFact, type ModelFact, type SymbolFact, type SymbolKind } from '@eyrie/core';
import { BaseExtractor, joinRoute, line } from './base.js';

const MAX_CHAIN = 6;
const TYPE_DECLS: Record<string, SymbolKind> = {
  class_declaration: 'class',
  struct_declaration: 'class',
  record_declaration: 'class',
  record_struct_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
};
const VERB_ATTRS: Record<string, string> = {
  HttpGet: 'GET',
  HttpPost: 'POST',
  HttpPut: 'PUT',
  HttpDelete: 'DELETE',
  HttpPatch: 'PATCH',
  HttpHead: 'HEAD',
};
const MAP_VERBS: Record<string, string> = { MapGet: 'GET', MapPost: 'POST', MapPut: 'PUT', MapDelete: 'DELETE', MapPatch: 'PATCH', MapMethods: 'ANY' };
const DB_CONTEXTS = /(^|\.)(DbContext|IdentityDbContext|ApiAuthorizationDbContext)$/;

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'string_literal' || n.type === 'verbatim_string_literal' || n.type === 'raw_string_literal') {
    const content = n.namedChildren.filter((c) => c?.type === 'string_literal_content' || c?.type === 'escape_sequence' || c?.type === 'raw_string_content');
    if (content.length) return content.map((c) => c!.text).join('');
    return n.text.replace(/^@?"+|"+$/g, '');
  }
  if (n.type === 'interpolated_string_expression') {
    let out = '';
    for (const c of n.namedChildren) {
      if (!c) continue;
      if (c.type === 'interpolation') out += ':param';
      else if (c.type.includes('content') || c.type === 'string_content') out += c.text;
    }
    return out;
  }
  return null;
}

function literal(n: Node): ArgFact {
  const inner = n.type === 'argument' ? n.namedChildren[n.namedChildren.length - 1] : n;
  if (!inner) return null;
  const s = stringValue(inner);
  if (s !== null) return s;
  if (inner.type === 'binary_expression' && inner.childForFieldName('operator')?.text === '+') {
    const left = inner.childForFieldName('left');
    const head = left ? literal(left) : null;
    return typeof head === 'string' ? `${head}:param` : null;
  }
  return null;
}

/** `Task<Order>` → 'Task', `IRepo?` → 'IRepo', `Acme.Repo` → 'Acme.Repo'. */
function typeRoot(n: Node | null | undefined, unwrapGeneric = false): string | undefined {
  if (!n) return undefined;
  switch (n.type) {
    case 'identifier':
    case 'qualified_name':
    case 'predefined_type':
      return n.text;
    case 'generic_name': {
      if (unwrapGeneric) return typeRoot(n.namedChildren[1]?.namedChildren[0]);
      return n.namedChildren[0]?.text;
    }
    case 'nullable_type':
    case 'array_type':
    case 'pointer_type':
      return typeRoot(n.namedChildren[0], unwrapGeneric);
    default:
      return undefined;
  }
}

function attributes(decl: Node): { name: string; args: Node[] }[] {
  const out: { name: string; args: Node[] }[] = [];
  for (const list of decl.namedChildren) {
    if (list?.type !== 'attribute_list') continue;
    for (const a of list.namedChildren) {
      if (a?.type !== 'attribute') continue;
      const name = (a.childForFieldName('name')?.text ?? '').split('.').pop()!.replace(/Attribute$/, '');
      const argList = a.namedChildren.find((c) => c?.type === 'attribute_argument_list');
      out.push({ name, args: (argList?.namedChildren ?? []).filter((x): x is Node => x?.type === 'attribute_argument') });
    }
  }
  return out;
}

function attrString(args: Node[]): string | undefined {
  for (const a of args) {
    if (a.namedChildren.some((c) => c?.type === 'identifier' && a.text.includes('='))) continue;
    const s = stringValue(a.namedChildren[a.namedChildren.length - 1]);
    if (s !== null) return s;
  }
  return undefined;
}

const modifiers = (decl: Node) => decl.namedChildren.filter((c) => c?.type === 'modifier').map((c) => c!.text);

interface ClassCtx {
  sym: SymbolFact;
  fields: Set<string>;
  methods: Set<string>;
}

export class CSharpExtractor extends BaseExtractor {
  private cls: ClassCtx | null = null;
  private declared: Set<string>[] = [];
  /** `var api = app.MapGroup("/api")` → api: '/api'. */
  private groups = new Map<string, string>();

  protected visitRoot(root: Node): void {
    this.members(root.namedChildren, undefined);
  }

  private members(nodes: (Node | null)[], parent: ClassCtx | undefined): void {
    for (const child of nodes) {
      if (!child) continue;
      switch (child.type) {
        case 'using_directive':
          this.using(child);
          break;
        case 'file_scoped_namespace_declaration':
        case 'namespace_declaration': {
          const name = child.childForFieldName('name')?.text;
          if (name && !this.facts.namespace) this.facts.namespace = name;
          const body = child.childForFieldName('body');
          if (body) this.members(body.namedChildren, parent);
          break;
        }
        case 'global_statement':
          this.walk(child);
          break;
        default:
          if (TYPE_DECLS[child.type]) this.typeDecl(child, parent);
      }
    }
  }

  private using(node: Node): void {
    const alias = node.childForFieldName('name');
    const target = node.namedChildren.find((c) => c && !(alias && c.equals(alias)) && (c.type === 'qualified_name' || c.type === 'identifier' || c.type === 'generic_name'));
    if (!target) return;
    const imp: ImportFact = { source: target.text, line: line(node), typeOnly: false, specifiers: [] };
    // `using A.B;` and `using static A.B.C;` bring names into scope; `using X = A.B;` binds one.
    if (alias) imp.specifiers.push({ imported: target.text.split('.').pop()!, local: alias.text });
    else imp.wildcard = true;
    this.facts.imports.push(imp);
  }

  private typeDecl(node: Node, parent: ClassCtx | undefined): void {
    const name = node.childForFieldName('name')?.text;
    if (!name) return;
    const kind = TYPE_DECLS[node.type]!;
    const mods = modifiers(node);
    const sym = this.symbol(name, kind, node, !mods.includes('private'), parent?.sym.qualifiedName);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    const bases = (node.namedChildren.find((c) => c?.type === 'base_list')?.namedChildren ?? [])
      .map((b) => typeRoot(b?.type === 'primary_constructor_base_type' ? b.namedChildren[0] : b))
      .filter((b): b is string => !!b);
    const isIface = (b: string) => /^I[A-Z]/.test(b.split('.').pop()!);
    if (kind === 'interface') {
      if (bases.length) sym.extends = bases;
    } else {
      const ext = bases.filter((b) => !isIface(b));
      const impl = bases.filter(isIface);
      if (ext.length) sym.extends = ext.slice(0, 1);
      if (impl.length) sym.implements = impl;
    }
    sym.fields = [];
    this.addSymbol(sym);

    const ctx: ClassCtx = { sym, fields: new Set(), methods: new Set() };
    // Primary constructor / record parameters are fields.
    const primary = node.namedChildren.find((c) => c?.type === 'parameter_list');
    for (const p of primary?.namedChildren ?? []) {
      if (p?.type !== 'parameter') continue;
      const pn = p.childForFieldName('name')?.text;
      const t = typeRoot(p.childForFieldName('type'));
      if (!pn) continue;
      sym.fields.push(t ? { name: pn, type: t } : { name: pn });
      ctx.fields.add(pn);
    }
    const body = node.childForFieldName('body');
    for (const m of body?.namedChildren ?? []) {
      if (m?.type === 'field_declaration') {
        for (const d of m.descendantsOfType('variable_declarator')) {
          const n = d?.childForFieldName('name')?.text ?? d?.namedChildren[0]?.text;
          if (n) ctx.fields.add(n);
        }
      } else if (m?.type === 'property_declaration') {
        const n = m.childForFieldName('name')?.text;
        if (n) ctx.fields.add(n);
      } else if (m?.type === 'method_declaration') {
        const n = m.childForFieldName('name')?.text;
        if (n) ctx.methods.add(n);
      }
    }

    const attrs = attributes(node);
    const routeAttr = attrs.find((a) => a.name === 'Route');
    const controller = name.replace(/Controller$/, '');
    const prefix = routeAttr ? attrString(routeAttr.args)?.replace(/\[controller\]/gi, controller.toLowerCase()) : undefined;
    const isDbContext = bases.some((b) => DB_CONTEXTS.test(b));
    const entity: ModelFact | null = attrs.some((a) => a.name === 'Table')
      ? ({ name, line: sym.startLine, endLine: sym.endLine, fields: [], relations: [], orm: 'efcore', symbol: sym.qualifiedName })
      : null;

    const prev = this.cls;
    this.cls = ctx;
    for (const m of body?.namedChildren ?? []) {
      if (!m) continue;
      if (TYPE_DECLS[m.type]) this.typeDecl(m, ctx);
      else if (m.type === 'field_declaration') this.field(m, sym, entity);
      else if (m.type === 'property_declaration') this.property(m, sym, isDbContext, entity);
      else if (m.type === 'method_declaration' || m.type === 'constructor_declaration') this.method(m, sym, prefix, controller, !!routeAttr || attrs.some((a) => a.name === 'ApiController'));
      else this.withScope({ name: sym.qualifiedName }, () => this.walk(m));
    }
    this.cls = prev;
    if (entity) (this.facts.models ??= []).push(entity);
  }

  private field(node: Node, owner: SymbolFact, entity: ModelFact | null): void {
    const decl = node.namedChildren.find((c) => c?.type === 'variable_declaration');
    const t = typeRoot(decl?.childForFieldName('type'));
    for (const d of decl?.namedChildren ?? []) {
      if (d?.type !== 'variable_declarator') continue;
      const n = (d.childForFieldName('name') ?? d.namedChildren[0])?.text;
      if (!n) continue;
      const f: FieldFact = { name: n };
      if (t && t !== 'var') f.type = t;
      const v = d.namedChildren.find((c) => c?.type === 'object_creation_expression');
      const ct = v ? typeRoot(v.childForFieldName('type')) : undefined;
      if (ct) f.instanceOf = ct;
      owner.fields!.push(f);
      if (entity) entity.fields.push(n);
      for (const c of d.namedChildren.slice(1)) if (c) this.withScope({ name: owner.qualifiedName }, () => this.walk(c));
    }
  }

  private property(node: Node, owner: SymbolFact, isDbContext: boolean, entity: ModelFact | null): void {
    const n = node.childForFieldName('name')?.text;
    const typeNode = node.childForFieldName('type');
    if (!n) return;
    const t = typeRoot(typeNode);
    const f: FieldFact = { name: n };
    if (t) f.type = t;
    const v = node.childForFieldName('value');
    if (v?.type === 'object_creation_expression') {
      const ct = typeRoot(v.childForFieldName('type'));
      if (ct) f.instanceOf = ct;
    }
    owner.fields!.push(f);
    if (entity) entity.fields.push(n);
    if (isDbContext && t === 'DbSet') {
      // `DbSet<Order> Orders` → model Order, reached through `db.Orders`.
      const entityName = typeRoot(typeNode, true);
      if (entityName) {
        const prop = this.symbol(n, 'variable', node, true, owner.qualifiedName);
        prop.typeName = entityName;
        this.addSymbol(prop);
        (this.facts.models ??= []).push({ name: entityName.split('.').pop()!, line: line(node), endLine: line(node), fields: [], relations: [], orm: 'efcore', symbol: prop.qualifiedName });
      }
    }
    if (v) this.withScope({ name: owner.qualifiedName }, () => this.walk(v));
  }

  private method(node: Node, owner: SymbolFact, prefix: string | undefined, controller: string, isController: boolean): void {
    const isCtor = node.type === 'constructor_declaration';
    const name = isCtor ? 'constructor' : node.childForFieldName('name')?.text;
    if (!name) return;
    const mods = modifiers(node);
    const sym = this.symbol(name, 'method', node, mods.includes('public') || mods.includes('internal') || owner.kind === 'interface', owner.qualifiedName);
    if (mods.includes('async')) sym.async = true;
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    sym.locals = {};
    this.addSymbol(sym);
    const declared = new Set<string>();
    for (const p of node.childForFieldName('parameters')?.namedChildren ?? []) {
      if (p?.type !== 'parameter') continue;
      const pn = p.childForFieldName('name')?.text;
      const t = typeRoot(p.childForFieldName('type'));
      if (!pn) continue;
      declared.add(pn);
      if (t) sym.locals[pn] = t;
    }
    if (!isCtor && isController) this.actionRoutes(node, sym, prefix, controller, name);
    const body = node.childForFieldName('body');
    if (body) {
      this.declared.push(declared);
      this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => this.walk(body));
      this.declared.pop();
    }
  }

  private actionRoutes(node: Node, sym: SymbolFact, prefix: string | undefined, controller: string, action: string): void {
    const attrs = attributes(node);
    const routeAttr = attrs.find((a) => a.name === 'Route');
    const expand = (p: string) => p.replace(/\[controller\]/gi, controller.toLowerCase()).replace(/\[action\]/gi, action.toLowerCase());
    for (const a of attrs) {
      const method = ownValue(VERB_ATTRS, a.name);
      if (!method) continue;
      const own = attrString(a.args) ?? (routeAttr ? attrString(routeAttr.args) : undefined) ?? '';
      const path = own.startsWith('/') || own.startsWith('~/') ? own.replace(/^~/, '') : joinRoute(prefix, own);
      this.addRoute({ method, path: joinRoute(undefined, expand(path)), line: line(node), router: 'aspnet', handlers: [sym.qualifiedName], framework: 'aspnet' });
    }
  }

  // ── references ───────────────────────────────────────────────────────────

  private isDeclared(name: string): boolean {
    return this.declared.some((s) => s.has(name));
  }

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
      case 'this_expression':
        return ['this'];
      case 'base':
      case 'base_expression':
        return ['super'];
      case 'generic_name':
        return this.rootName(node.namedChildren[0]?.text ?? node.text);
      case 'member_access_expression': {
        const exprNode = node.childForFieldName('expression');
        const first = node.child(0);
        const obj = exprNode ? this.chain(exprNode) : first?.type === 'this' ? ['this'] : first?.type === 'base' ? ['super'] : null;
        const name = node.childForFieldName('name');
        const nameText = name?.type === 'generic_name' ? name.namedChildren[0]?.text : name?.text;
        if (!obj || !nameText || obj.length >= MAX_CHAIN) return null;
        return [...obj, nameText];
      }
      case 'conditional_access_expression': {
        const obj = this.chain(node.childForFieldName('condition') ?? node.namedChildren[0]);
        const binding = node.namedChildren.find((c) => c?.type === 'member_binding_expression');
        const nm = binding?.childForFieldName('name')?.text;
        return obj && nm ? [...obj, nm] : obj;
      }
      case 'invocation_expression': {
        const inner = this.chain(node.childForFieldName('function'));
        if (!inner) return null;
        return [...inner.slice(0, -1), `${inner[inner.length - 1]}()`];
      }
      case 'element_access_expression': {
        const obj = this.chain(node.childForFieldName('expression'));
        return obj ? [...obj, '[]'] : null;
      }
      case 'parenthesized_expression':
      case 'await_expression':
        return this.chain(node.namedChildren[0]);
      default:
        return null;
    }
  }

  private walk(node: Node): void {
    switch (node.type) {
      case 'comment':
      case 'string_literal':
      case 'verbatim_string_literal':
      case 'integer_literal':
      case 'attribute_list':
        return;
      case 'invocation_expression':
        return this.invocation(node);
      case 'object_creation_expression': {
        const t = typeRoot(node.childForFieldName('type'));
        const args = node.childForFieldName('arguments')?.namedChildren.filter((a): a is Node => !!a) ?? [];
        if (t) this.addRef('new', t.split('.'), node, args.slice(0, 3).map(literal));
        for (const a of args) this.argument(a);
        const init = node.childForFieldName('initializer');
        if (init) this.walk(init);
        return;
      }
      case 'local_declaration_statement':
        return this.localDecl(node);
      case 'lambda_expression':
      case 'anonymous_method_expression': {
        const names = (node.childForFieldName('parameters')?.descendantsOfType('identifier') ?? []).map((p) => p?.text ?? '');
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

  private localDecl(node: Node): void {
    const decl = node.namedChildren.find((c) => c?.type === 'variable_declaration');
    if (!decl) return;
    const locals = this.scope().locals;
    const t = typeRoot(decl.childForFieldName('type'));
    for (const d of decl.namedChildren) {
      if (d?.type !== 'variable_declarator') continue;
      const n = (d.childForFieldName('name') ?? d.namedChildren[0])?.text;
      if (!n) continue;
      this.declared[this.declared.length - 1]?.add(n);
      const v = d.namedChildren[d.namedChildren.length - 1];
      const value = v && !v.equals(d.namedChildren[0]!) ? (v.type === 'await_expression' ? v.namedChildren[0] : v) : null;
      if (locals) {
        if (t && t !== 'var') locals[n] = t;
        else if (value?.type === 'object_creation_expression') {
          const ct = typeRoot(value.childForFieldName('type'));
          if (ct) locals[n] = ct;
        } else if (value?.type === 'invocation_expression') {
          const c = this.chain(value.childForFieldName('function'));
          if (c) {
            locals[n] = `call:${c.join('.')}`;
            const group = this.mapGroup(c, value);
            if (group !== undefined) this.groups.set(n, group);
          }
        }
      } else if (value?.type === 'invocation_expression') {
        const c = this.chain(value.childForFieldName('function'));
        const group = c ? this.mapGroup(c, value) : undefined;
        if (group !== undefined) this.groups.set(n, group);
      }
      if (value) this.walk(value);
    }
  }

  private mapGroup(c: string[], call: Node): string | undefined {
    if (c[c.length - 1] !== 'MapGroup') return undefined;
    const first = call.childForFieldName('arguments')?.namedChildren[0];
    const s = first ? literal(first) : null;
    if (typeof s !== 'string') return undefined;
    return joinRoute(this.groups.get(c[0]!), s);
  }

  private invocation(node: Node): void {
    const fn = node.childForFieldName('function');
    const c = this.chain(fn);
    const args = node.childForFieldName('arguments')?.namedChildren.filter((a): a is Node => !!a) ?? [];
    if (c) {
      if (this.minimalApi(node, c, args)) return;
      this.addRef('call', c, node, args.slice(0, 3).map(literal));
    }
    if (fn?.type === 'member_access_expression') {
      const obj = fn.childForFieldName('expression');
      if (obj && obj.type !== 'identifier') this.walk(obj);
    } else if (fn && !c) this.walk(fn);
    for (const a of args) this.argument(a);
  }

  /** `app.MapGet("/x", Handler)` / `group.MapPost(...)`. */
  private minimalApi(node: Node, c: string[], args: Node[]): boolean {
    if (c.length !== 2) return false;
    const method = ownValue(MAP_VERBS, c[1]!);
    const path = args[0] ? literal(args[0]) : null;
    if (!method || typeof path !== 'string') return false;
    const full = joinRoute(this.groups.get(c[0]!), path);
    const scope = `route:${method} ${full}`;
    const handlers: string[] = [];
    for (const a of args.slice(1)) {
      const h = this.chain(a.namedChildren[a.namedChildren.length - 1]);
      if (h) handlers.push(h.join('.'));
    }
    this.addRoute({ method, path: full, line: line(node), router: c[0]!, handlers, framework: 'aspnet', scope });
    this.addRef('call', c, node, [path]);
    this.withScope({ name: scope, locals: {} }, () => {
      for (const a of args.slice(1)) this.argument(a);
    });
    return true;
  }

  private argument(a: Node): void {
    const v = a.type === 'argument' ? a.namedChildren[a.namedChildren.length - 1] : a;
    if (!v) return;
    if (v.type === 'identifier' || v.type === 'member_access_expression') {
      const c = this.chain(v);
      if (c) this.addRef('ref', c, v);
    } else this.walk(v);
  }
}
