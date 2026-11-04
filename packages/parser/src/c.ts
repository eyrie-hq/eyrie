/**
 * C language adapter, and the shared base for C++.
 *
 * Records `#include`s (quoted and angle-bracket), structs / unions / enums
 * with typed fields, typedefs, globals, function-like macros, function
 * call references, and CivetWeb / Mongoose route registrations. Function
 * prototypes only become symbols in headers, where they are the link
 * targets for calls; in implementation files the definition that follows
 * (or owns the file) is the symbol.
 *
 * Both conditional-compilation branches are walked: the map shows the
 * code as written, not one configuration of it.
 */
import type { Node } from 'web-tree-sitter';
import type { ArgFact, FieldFact, ImportFact, ModelFact, SourceLanguage, SymbolFact, SymbolKind } from '@eyrie/core';
import { BaseExtractor, joinRoute, line } from './base.js';

const MAX_CHAIN = 6;
/** `mg_set_request_handler(ctx, "/api/*", handler, NULL)` registers every method. */
const HTTP_REGISTRARS: Record<string, string> = { mg_set_request_handler: 'civetweb', mg_register_http_endpoint: 'mongoose' };
const HEADER_EXTS = new Set(['.h', '.hpp', '.hh', '.hxx', '.h++', '.hcc']);

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'string_literal') {
    const parts: string[] = [];
    for (const c of n.namedChildren) {
      if (c?.type === 'string_content') parts.push(c.text);
    }
    if (parts.length) return parts.join('');
    const m = /^"(.*)"$/s.exec(n.text);
    return m ? m[1]! : null;
  }
  return null;
}

export interface DeclaratorName {
  /** Simple name, or the full dotted scope for `Order::count_`. */
  name: string;
  /** Scope segments for a qualified declarator (`Order::count_` → ['Order']). */
  scope: string[];
  /** True for `~Order` and `operator==`. */
  special: 'destructor' | 'operator' | null;
}

/**
 * The name a declarator binds, following the declarator spine through
 * pointers, arrays, functions, initializers and parentheses.
 */
export function declaratorName(decl: Node | null | undefined): DeclaratorName | null {
  let current = decl;
  while (current) {
    switch (current.type) {
      case 'identifier':
      case 'field_identifier':
      case 'type_identifier':
        return { name: current.text, scope: [], special: null };
      case 'destructor_name':
        return { name: current.namedChildren.find((c) => !!c)?.text ?? '', scope: [], special: 'destructor' };
      case 'operator_name': {
        const t = current.text;
        return { name: t.startsWith('operator') ? t : `operator${t}`, scope: [], special: 'operator' };
      }
      case 'qualified_identifier': {
        const kids = current.namedChildren.filter((c): c is Node => !!c);
        const nameNode = kids[kids.length - 1];
        if (!nameNode) return null;
        if (nameNode.type === 'operator_name' || nameNode.type === 'destructor_name') {
          const inner = declaratorName(nameNode);
          const scope = kids.slice(0, -1).map((c) => c.text.replace(/<[^]*>$/, ''));
          return inner ? { ...inner, scope } : null;
        }
        const scope = kids.slice(0, -1).map((c) => c.text.replace(/<[^]*>$/, ''));
        return { name: nameNode.text, scope, special: null };
      }
      case 'operator_cast': {
        const t = current.namedChildren.find((c) => !!c && c.type !== 'abstract_function_declarator');
        return { name: `operator ${t?.text ?? ''}`.trim(), scope: [], special: 'operator' };
      }
      default: {
        const next = current.childForFieldName('declarator') ?? current.namedChildren.find((c) => !!c && /declarator$/.test(c.type));
        if (!next || next === current) return null;
        current = next;
      }
    }
  }
  return null;
}

/** All names a declarator binds (`auto [a, b]` binds two). */
export function declaratorNames(decl: Node | null | undefined): string[] {
  if (decl?.type === 'structured_binding_declarator') {
    return decl.namedChildren.filter((c) => !!c && c.type === 'identifier').map((c) => c!.text);
  }
  const single = declaratorName(decl);
  return single ? [single.name] : [];
}

/** Function-pointer declarators have parens between the function and its name. */
function isPlainFunctionSpine(decl: Node | null | undefined): boolean {
  let current = decl;
  let paren = false;
  while (current) {
    if (current.type === 'parenthesized_declarator' || current.type === 'parenthesized_declarator_expression') paren = true;
    if (current.type === 'identifier' || current.type === 'field_identifier' || current.type === 'type_identifier') return !paren;
    if (!/declarator$/.test(current.type)) return !paren;
    current = current.childForFieldName('declarator') ?? current.namedChildren.find((c) => !!c && /declarator$/.test(c.type));
  }
  return false;
}

function isStatic(node: Node): boolean {
  return node.namedChildren.some((c) => c?.type === 'storage_class_specifier' && /\bstatic\b/.test(c.text));
}

export interface ClassCtx {
  sym: SymbolFact;
  fields: Set<string>;
  methods: Set<string>;
}

export class CExtractor extends BaseExtractor {
  protected cls: ClassCtx | null = null;
  protected declared: Set<string>[] = [];
  /** Prototype symbols awaiting their definition (headers and in-class declarations). */
  private prototypes = new Set<string>();
  /** Simple names of every type declared in the file, collected before visiting. */
  protected typeNames = new Set<string>();

  protected get isHeader(): boolean {
    const dot = this.facts.path.lastIndexOf('.');
    return HEADER_EXTS.has(this.facts.path.slice(dot));
  }

  protected visitRoot(root: Node): void {
    this.collectTypeNames(root);
    for (const child of root.namedChildren) {
      if (child) this.topLevel(child);
    }
  }

  protected collectTypeNames(node: Node): void {
    for (const c of node.namedChildren) {
      if (!c) continue;
      if (c.type === 'struct_specifier' || c.type === 'union_specifier' || c.type === 'enum_specifier' || c.type === 'class_specifier') {
        const n = c.childForFieldName('name')?.text;
        if (n) this.typeNames.add(n);
      } else if (c.type === 'type_definition' || c.type === 'alias_declaration') {
        const n = c.namedChildren.find((k) => k?.type === 'type_identifier')?.text;
        if (n) this.typeNames.add(n);
      }
      this.collectTypeNames(c);
    }
  }

  protected topLevel(node: Node): void {
    switch (node.type) {
      case 'preproc_include':
        return this.importDecl(node);
      case 'preproc_def': {
        // Valueless defines are include guards and feature flags, not values.
        const name = node.childForFieldName('name')?.text;
        if (name && node.childForFieldName('value')) this.addSymbol(this.symbol(name, 'variable', node, true));
        return;
      }
      case 'preproc_function_def': {
        // Bodies are opaque preprocessor text: the symbol is the link target.
        const name = node.childForFieldName('name')?.text;
        if (!name) return;
        const sym = this.symbol(name, 'function', node, true);
        sym.locals = {};
        this.addSymbol(sym);
        return;
      }
      case 'function_definition':
        return this.functionDef(node, undefined, undefined);
      case 'declaration':
        return this.globalDecl(node, undefined);
      case 'type_definition':
        return this.typedefDecl(node, undefined);
      case 'struct_specifier':
      case 'union_specifier':
      case 'enum_specifier':
        return this.specifierDecl(node, undefined);
      case 'linkage_specification': {
        const body = node.namedChildren.find((c) => c?.type === 'declaration_list');
        for (const c of body?.namedChildren ?? []) if (c) this.topLevel(c);
        return;
      }
      case 'preproc_if':
      case 'preproc_ifdef':
      case 'preproc_ifndef':
        // Both branches are walked: the map shows the code as written.
        for (const c of node.namedChildren) {
          if (!c || c.type === 'preproc_directive') continue;
          if (c.type === 'preproc_else' || c.type === 'preproc_elif') {
            for (const alt of c.namedChildren) if (alt && alt.type !== 'preproc_directive') this.topLevel(alt);
          } else this.topLevel(c);
        }
        return;
      default:
        return;
    }
  }

  protected importDecl(node: Node): void {
    const path = node.namedChildren.find((c) => !!c);
    if (!path) return;
    const angle = path.type === 'system_lib_string';
    const raw = path.text;
    const name = angle ? raw.replace(/^<|>$/g, '') : (stringValue(path) ?? raw.replace(/^"|"$/g, ''));
    if (!name) return;
    const imp: ImportFact = {
      // Angle brackets survive into the source so the resolver probes them differently.
      source: angle ? `<${name}>` : name,
      line: line(node),
      typeOnly: false,
      specifiers: [],
      wildcard: true,
    };
    this.facts.imports.push(imp);
  }

  /** A bare `struct S { ... };` at top level (bodies only; forward declarations bind nothing). */
  protected specifierDecl(node: Node, parent: string | undefined): void {
    const body = node.namedChildren.find((c) => c?.type === 'field_declaration_list' || c?.type === 'enumerator_list');
    if (!body) return;
    const name = node.childForFieldName('name')?.text;
    if (!name) return;
    const kind: SymbolKind = node.type === 'enum_specifier' ? 'enum' : 'class';
    const sym = this.symbol(name, kind, node, true, parent);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    sym.fields = [];
    this.addSymbol(sym);
    if (kind === 'class') this.typeMembers(node, { sym, fields: new Set(), methods: new Set() }, null);
  }

  /** `typedef struct { ... } Order;` names the anonymous type; otherwise an alias. */
  protected typedefDecl(node: Node, parent: string | undefined): void {
    const kids = node.namedChildren.filter((c): c is Node => !!c);
    const alias = [...kids].reverse().find((c) => c.type === 'type_identifier')?.text;
    const typeNode = kids.find((c) => this.isTypeNode(c));
    const target = this.typeOf(typeNode);
    const isRecord = !!typeNode && /_(specifier)$/.test(typeNode.type);
    if (isRecord && !typeNode!.childForFieldName('name') && alias) {
      const kind: SymbolKind = typeNode!.type === 'enum_specifier' ? 'enum' : 'class';
      const sym = this.symbol(alias, kind, node, true, parent);
      sym.fields = [];
      this.addSymbol(sym);
      if (kind === 'class') this.typeMembers(typeNode!, { sym, fields: new Set(), methods: new Set() }, null);
      return;
    }
    if (isRecord && typeNode!.childForFieldName('name')) this.specifierDecl(typeNode!, parent);
    if (!alias) return;
    const sym = this.symbol(alias, 'type', node, true, parent);
    if (target) sym.typeName = target;
    this.addSymbol(sym);
    // Members through an alias resolve when the aliased struct lives in this file.
    if (target) {
      const aliased = this.symbolsByName.get(target);
      if (aliased?.fields) sym.fields = aliased.fields.map((f) => ({ ...f }));
    }
  }

  protected globalDecl(node: Node, scope: string[] | undefined): void {
    const typeNode = node.namedChildren.find((c) => !!c && this.isTypeNode(c));
    // `struct S { ... } global;` declares a type and a variable at once.
    if (typeNode && /_specifier$/.test(typeNode.type) && typeNode.namedChildren.some((c) => c?.type === 'field_declaration_list' || c?.type === 'enumerator_list')) {
      this.specifierDecl(typeNode, scope?.join('.'));
    }
    const declarators = node.childrenForFieldName('declarator');
    const list = declarators.length ? declarators : node.namedChildren.filter((c) => !!c && /declarator$/.test(c.type) && c.type !== 'abstract_function_declarator');
    for (const decl of list) {
      if (!decl || decl.type === 'abstract_function_declarator') continue;
      if (this.isFunctionDeclarator(decl)) {
        this.functionProto(node, decl, scope, undefined);
        continue;
      }
      const named = declaratorName(decl);
      if (!named || !named.name) continue;
      const parent = this.scopeParent([...(scope ?? []), ...named.scope]);
      const sym = this.symbol(named.name, 'variable', node, !isStatic(node), parent || undefined);
      const doc = this.leadingDoc(node);
      if (doc) sym.doc = doc;
      const t = this.typeOf(typeNode);
      if (t) sym.typeName = t;
      const init = this.declaratorInit(decl);
      const inst = this.initInstance(init);
      if (inst) sym.instanceOf = inst;
      else if (init?.type === 'call_expression') {
        const c = this.chain(this.callCallee(init));
        if (c) sym.initCall = c.join('.');
      }
      this.addSymbol(sym);
      if (init?.type === 'argument_list' && t && /^[A-Z_]/.test(t)) {
        this.withScope({ name: sym.qualifiedName }, () => this.addRef('new', t.split('.'), node));
      }
      if (init) this.withScope({ name: sym.qualifiedName }, () => this.walk(init));
    }
  }

  protected isTypeNode(node: Node): boolean {
    return /^(primitive_type|sized_type_specifier|type_identifier|struct_specifier|union_specifier|enum_specifier|class_specifier|qualified_identifier|template_type|placeholder_type_specifier|atomic_specifier|typeof_specifier)$/.test(node.type);
  }

  /** Whether the declarator declares a function rather than a function pointer. */
  protected isFunctionDeclarator(decl: Node): boolean {
    let current: Node | null | undefined = decl;
    while (current) {
      if (current.type === 'function_declarator') return isPlainFunctionSpine(current.childForFieldName('declarator') ?? current.namedChildren.find((c) => !!c && /declarator$/.test(c.type)));
      if (current.type === 'abstract_function_declarator') return false;
      if (!/declarator$/.test(current.type)) return false;
      current = current.childForFieldName('declarator') ?? current.namedChildren.find((c) => !!c && /declarator$/.test(c.type));
    }
    return false;
  }

  /** `struct Order *` → 'Order', `shop::Order` → 'Order', function types → undefined. */
  protected typeOf(typeNode: Node | null | undefined): string | undefined {
    if (!typeNode) return undefined;
    switch (typeNode.type) {
      case 'primitive_type':
      case 'sized_type_specifier':
        return typeNode.text;
      case 'type_identifier':
        return typeNode.text;
      case 'struct_specifier':
      case 'union_specifier':
      case 'enum_specifier':
      case 'class_specifier': {
        const name = typeNode.childForFieldName('name')?.text;
        return name && name.includes('::') ? this.stripQualifiers(name.split('::')).join('.') : name;
      }
      case 'qualified_identifier': {
        const parts = typeNode.text.split('::').map((p) => p.replace(/<[^]*>$/, '').trim()).filter(Boolean);
        return parts.length ? this.stripQualifiers(parts).join('.') : undefined;
      }
      case 'template_type': {
        return typeNode.namedChildren.find((c) => c?.type === 'type_identifier' || c?.type === 'primitive_type')?.text;
      }
      case 'placeholder_type_specifier':
        return undefined;
      case 'atomic_specifier':
        return this.typeOf(typeNode.namedChildren.find((c) => !!c && c.type !== 'type_identifier') ?? typeNode.namedChildren[0]);
      default:
        return undefined;
    }
  }

  /** A prototype is a link target in headers; in implementation files the definition owns the name. */
  protected functionProto(node: Node, decl: Node, scope: string[] | undefined, owner: ClassCtx | undefined): void {
    const named = declaratorName(decl);
    if (!named || !named.name) return;
    if (!owner && !this.isHeader) return;
    const parent = owner?.sym.qualifiedName ?? this.scopeParent([...(scope ?? []), ...named.scope]);
    const name = this.methodName(named, parent ? parent.split('.').pop() : undefined);
    const sym = this.symbol(name, parent ? 'method' : 'function', node, owner ? true : !isStatic(node), parent);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    sym.locals = {};
    this.bindDeclaratorParams(decl, sym, new Set<string>());
    this.addSymbol(sym);
    this.prototypes.add(sym.qualifiedName);
  }

  /** Bind (type, declarator) parameter pairs onto `sym.locals`. */
  protected bindDeclaratorParams(decl: Node | null | undefined, sym: SymbolFact, declared: Set<string>): void {
    for (const p of this.declaratorParams(decl)) {
      const pn = declaratorNames(p.declarator)[0];
      const t = this.typeOf(p.type);
      if (!pn) continue;
      declared.add(pn);
      if (t) sym.locals![pn] = t;
    }
  }

  /** Constructor and destructor spellings collapse to fixed names. */
  protected methodName(named: DeclaratorName, ownerSimple: string | undefined): string {
    if (named.special === 'destructor') return 'destructor';
    if (named.special === 'operator') return named.name;
    if (ownerSimple && named.name === ownerSimple) return 'constructor';
    return named.name;
  }

  protected functionDef(node: Node, scope: string[] | undefined, owner: ClassCtx | undefined): void {
    const decl = node.namedChildren.find((c) => !!c && /declarator$/.test(c.type));
    const named = declaratorName(decl);
    if (!named || !named.name) return;
    const parent = owner?.sym.qualifiedName ?? this.scopeParent([...(scope ?? []), ...named.scope]);
    const name = this.methodName(named, parent ? parent.split('.').pop() : undefined);
    let sym = this.symbol(name, parent ? 'method' : 'function', node, owner ? true : !isStatic(node), parent);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    sym.locals = {};
    // A definition replaces its prototype so bodies are walked once.
    const existing = this.symbolsByName.get(sym.qualifiedName);
    if (existing && this.prototypes.has(sym.qualifiedName)) {
      const at = this.facts.symbols.indexOf(existing);
      if (at !== -1) this.facts.symbols.splice(at, 1);
      this.symbolsByName.delete(sym.qualifiedName);
      this.prototypes.delete(sym.qualifiedName);
    }
    this.addSymbol(sym);
    sym = this.symbolsByName.get(sym.qualifiedName)!;
    const declared = new Set<string>();
    this.bindDeclaratorParams(decl, sym, declared);
    const body = node.namedChildren.find((c) => c?.type === 'compound_statement' || c?.type === 'function_try_block');
    const inits = node.namedChildren.find((c) => c?.type === 'field_initializer_list');
    if (body || inits) {
      this.declared.push(declared);
      this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => {
        if (inits) this.walk(inits);
        if (body) this.walk(body);
      });
      this.declared.pop();
    }
  }

  /** Parameter (type, declarator) pairs from a function declarator. */
  protected declaratorParams(decl: Node | null | undefined): { type: Node | null; declarator: Node | null }[] {
    const out: { type: Node | null; declarator: Node | null }[] = [];
    const params = decl?.namedChildren.find((c) => c?.type === 'parameter_list');
    for (const p of params?.namedChildren ?? []) {
      if (p?.type !== 'parameter_declaration') continue;
      out.push({
        type: p.namedChildren.find((c) => !!c && this.isTypeNode(c)) ?? null,
        // Simple parameters bind a bare identifier rather than a declarator node.
        declarator: p.namedChildren.find((c) => !!c && (/declarator$/.test(c.type) || c.type === 'identifier') && !c.type.startsWith('abstract')) ?? null,
      });
    }
    return out;
  }

  /** Expand `#if` branches into a flat member list. */
  protected flatMembers(body: Node | null | undefined): Node[] {
    const out: Node[] = [];
    const visit = (node: Node): void => {
      for (const c of node.namedChildren) {
        if (!c || c.type === 'preproc_directive') continue;
        if (c.type === 'preproc_if' || c.type === 'preproc_ifdef' || c.type === 'preproc_ifndef' || c.type === 'preproc_else' || c.type === 'preproc_elif') visit(c);
        else out.push(c);
      }
    };
    if (body) visit(body);
    return out;
  }

  /** Members of a struct/union/class body. C++ overrides this for methods and access. */
  protected typeMembers(node: Node, ctx: ClassCtx, _model: ModelFact | null): void {
    void _model;
    const body = node.namedChildren.find((c) => c?.type === 'field_declaration_list');
    for (const m of this.flatMembers(body)) {
      if (m.type !== 'field_declaration') continue;
      const typeNode = m.namedChildren.find((c) => !!c && this.isTypeNode(c));
      const hasDeclarator = m.namedChildren.some((c) => !!c && (c.type === 'field_identifier' || c.type === 'identifier' || /declarator$/.test(c.type)));
      if (typeNode && /_specifier$/.test(typeNode.type) && !typeNode.childForFieldName('name') && !hasDeclarator) {
        // Anonymous nested type: its members belong to the enclosing struct.
        for (const f of this.nestedFields(typeNode)) {
          ctx.sym.fields!.push(f);
          ctx.fields.add(f.name);
        }
      } else if (typeNode && /_specifier$/.test(typeNode.type) && typeNode.childForFieldName('name') && typeNode.namedChildren.some((c) => c?.type === 'field_declaration_list' || c?.type === 'enumerator_list')) {
        this.specifierDecl(typeNode, ctx.sym.qualifiedName);
      }
      for (const f of this.fieldDecls(m, typeNode)) {
        ctx.sym.fields!.push(f);
        ctx.fields.add(f.name);
      }
    }
  }

  protected nestedFields(spec: Node): FieldFact[] {
    const out: FieldFact[] = [];
    const body = spec.namedChildren.find((c) => c?.type === 'field_declaration_list');
    for (const m of body?.namedChildren ?? []) {
      if (m?.type !== 'field_declaration') continue;
      const typeNode = m.namedChildren.find((c) => !!c && this.isTypeNode(c));
      out.push(...this.fieldDecls(m, typeNode));
    }
    return out;
  }

  protected fieldDecls(node: Node, typeNode: Node | null | undefined): FieldFact[] {
    const out: FieldFact[] = [];
    const t = this.typeOf(typeNode);
    for (const d of node.namedChildren.filter((c) => !!c && (c.type === 'field_identifier' || c.type === 'identifier' || /declarator$/.test(c.type)))) {
      const name = d.type === 'field_identifier' || d.type === 'identifier' ? d.text : declaratorName(d)?.name;
      if (!name) continue;
      out.push(t ? { name, type: t } : { name });
    }
    return out;
  }

  // ── references ───────────────────────────────────────────────────────────

  protected isDeclared(name: string): boolean {
    return this.declared.some((s) => s.has(name));
  }

  protected rootName(name: string): string[] {
    return [name];
  }

  protected chain(node: Node | null | undefined): string[] | null {
    if (!node) return null;
    switch (node.type) {
      case 'identifier':
      case 'field_identifier':
      case 'type_identifier':
        return this.rootName(node.text);
      case 'this':
        return ['this'];
      case 'field_expression': {
        const obj = this.chain(node.childForFieldName('argument'));
        const field = node.childForFieldName('field');
        if (!obj || !field || obj.length >= MAX_CHAIN) return null;
        return [...obj, field.text];
      }
      case 'call_expression': {
        const inner = this.chain(this.callCallee(node));
        if (!inner || inner.length >= MAX_CHAIN) return null;
        return [...inner.slice(0, -1), `${inner[inner.length - 1]}()`];
      }
      case 'parenthesized_expression':
        return this.chain(node.namedChildren.filter((c): c is Node => !!c)[0]);
      case 'template_function':
        return this.chain(node.namedChildren.find((c) => !!c && c.type !== 'template_argument_list'));
      case 'pointer_expression':
      case 'unary_expression':
        return this.chain(node.childForFieldName('argument') ?? node.namedChildren[0]);
      case 'subscript_expression': {
        const obj = this.chain(node.childForFieldName('argument'));
        return obj ? [...obj, '[]'] : null;
      }
      case 'qualified_identifier': {
        const parts = node.text
          .split('::')
          .map((p) => p.replace(/<[^]*>$/, '').trim())
          .filter(Boolean);
        return parts.length && parts.length <= MAX_CHAIN ? this.stripQualifiers(parts) : null;
      }
      default:
        return null;
    }
  }

  /** Drops leading namespace segments (`shop::Order` → 'Order'); override-aware via typeNames. */
  protected stripQualifiers(parts: string[]): string[] {
    const kept = [...parts];
    while (kept.length > 1 && !this.typeNames.has(kept[0]!) && !this.symbolsByName.has(kept[0]!) && !this.isDeclared(kept[0]!)) kept.shift();
    return kept;
  }

  /**
   * A declarator scope becomes a parent when it names a declared type — or,
   * for out-of-class definitions whose class lives in a header, an
   * Uppercase name by convention.
   */
  protected scopeParent(parts: string[]): string | undefined {
    const kept = this.stripQualifiers(parts);
    if (!kept.length) return undefined;
    if (!this.typeNames.has(kept[0]!) && !/^[A-Z_]/.test(kept[0]!)) return undefined;
    return kept.join('.');
  }

  protected callCallee(node: Node): Node | null {
    return node.childForFieldName('function') ?? node.namedChildren.find((c) => !!c && c.type !== 'argument_list') ?? null;
  }

  protected callArgs(node: Node): Node[] {
    return node.namedChildren.find((c) => c?.type === 'argument_list')?.namedChildren.filter((a): a is Node => !!a) ?? [];
  }

  protected walk(node: Node): void {
    switch (node.type) {
      case 'string_literal':
      case 'string_content':
      case 'system_lib_string':
      case 'number_literal':
      case 'char_literal':
      case 'true':
      case 'false':
      case 'null':
      case 'nullptr':
      case 'comment':
        return;
      case 'call_expression':
        return this.invocation(node);
      case 'new_expression': {
        const t = this.typeOf(node.namedChildren.find((c) => !!c && this.isTypeNode(c)));
        const argLists = node.namedChildren.filter((c) => c?.type === 'argument_list');
        const args = (argLists[argLists.length - 1]?.namedChildren ?? []).filter((a): a is Node => !!a);
        if (t) this.addRef('new', t.split('.'), node, args.slice(0, 3).map((a) => this.argLiteral(a)));
        for (const list of argLists) for (const a of list.namedChildren) if (a) this.argument(a);
        for (const c of node.namedChildren) {
          if (c && c.type !== 'argument_list' && !this.isTypeNode(c)) this.walk(c);
        }
        return;
      }
      case 'compound_literal_expression': {
        const t = this.typeOf(node.namedChildren.find((c) => !!c && this.isTypeNode(c)));
        if (t && /^[A-Z_]/.test(t)) this.addRef('new', t.split('.'), node);
        for (const c of node.namedChildren) if (c && !this.isTypeNode(c)) this.walk(c);
        return;
      }
      case 'declaration':
        return this.localDecl(node);
      case 'lambda_expression': {
        const declared = new Set<string>();
        const params = node.namedChildren.find((c) => c?.type === 'abstract_function_declarator')?.namedChildren.find((c) => c?.type === 'parameter_list');
        for (const p of params?.namedChildren ?? []) {
          if (p?.type !== 'parameter_declaration') continue;
          const pn = declaratorNames(p.namedChildren.find((c) => !!c && /declarator$/.test(c.type) && !c.type.startsWith('abstract')))[0];
          if (pn) declared.add(pn);
        }
        this.declared.push(declared);
        for (const c of node.namedChildren) if (c) this.walk(c);
        this.declared.pop();
        return;
      }
      case 'for_range_loop': {
        const names = declaratorNames(node.namedChildren.find((c) => !!c && /declarator$/.test(c.type) && !c.type.startsWith('abstract')));
        this.declared.push(new Set(names));
        for (const c of node.namedChildren) if (c) this.walk(c);
        this.declared.pop();
        return;
      }
      case 'catch_clause': {
        const names: string[] = [];
        const params = node.namedChildren.find((c) => c?.type === 'parameter_list');
        for (const p of params?.namedChildren ?? []) {
          if (p?.type !== 'parameter_declaration') continue;
          names.push(...declaratorNames(p.namedChildren.find((c) => !!c && /declarator$/.test(c.type) && !c.type.startsWith('abstract'))));
        }
        this.declared.push(new Set(names));
        for (const c of node.namedChildren) if (c) this.walk(c);
        this.declared.pop();
        return;
      }
      case 'labeled_statement':
      case 'case_statement':
        for (const c of node.namedChildren) if (c) this.walk(c);
        return;
    }
    for (const c of node.namedChildren) if (c) this.walk(c);
  }

  protected localDecl(node: Node): void {
    const locals = this.scope().locals;
    const typeNode = node.namedChildren.find((c) => !!c && this.isTypeNode(c));
    const t = this.typeOf(typeNode);
    const declarators = node.childrenForFieldName('declarator');
    const list = declarators.length ? declarators : node.namedChildren.filter((c) => !!c && /declarator$/.test(c.type) && !c.type.startsWith('abstract'));
    for (const decl of list) {
      if (!decl || this.isFunctionDeclarator(decl)) continue;
      for (const n of declaratorNames(decl)) {
        this.declared[this.declared.length - 1]?.add(n);
        if (!locals) continue;
        if (t) locals[n] = t;
        else {
          const inst = this.initInstance(this.declaratorInit(decl));
          if (inst) locals[n] = inst;
        }
      }
      const init = this.declaratorInit(decl);
      // `Order q(2)` is construction; `Order q()` parses as a function declarator instead.
      if (init?.type === 'argument_list' && t && /^[A-Z_]/.test(t)) this.addRef('new', t.split('.'), node);
      if (init) this.walk(init);
    }
  }

  protected declaratorInit(decl: Node | null | undefined): Node | null {
    let current = decl;
    while (current) {
      if (current.type === 'init_declarator') return current.childForFieldName('value') ?? null;
      if (!/declarator$/.test(current.type)) return null;
      current = current.childForFieldName('declarator') ?? current.namedChildren.find((c) => !!c && /declarator$/.test(c.type));
    }
    return null;
  }

  protected initInstance(init: Node | null): string | undefined {
    if (!init) return undefined;
    if (init.type === 'call_expression') {
      const c = this.chain(this.callCallee(init));
      const parts = c?.map((s) => s.replace(/\(\)$/, ''));
      if (parts && this.callKind(parts) === 'new') return parts.join('.');
      return undefined;
    }
    if (init.type === 'new_expression') return this.typeOf(init.namedChildren.find((c) => !!c && this.isTypeNode(c)));
    if (init.type === 'compound_literal_expression') {
      const t = this.typeOf(init.namedChildren.find((c) => !!c && this.isTypeNode(c)));
      return t && /^[A-Z_]/.test(t) ? t : undefined;
    }
    return undefined;
  }

  /** Uppercase bare calls construct (`Order(x)`); everything else calls. */
  protected callKind(callee: string[]): 'call' | 'new' {
    const last = callee[callee.length - 1]!;
    if (!/^[A-Z_]/.test(last)) return 'call';
    const root = callee[0]!;
    if (root === 'this' || root === 'super') return 'call';
    if (callee.length === 1) return this.isNewCall(root) ? 'new' : 'call';
    return this.typeNames.has(root) || /^[A-Z_]/.test(root) ? 'new' : 'call';
  }

  protected isNewCall(name: string): boolean {
    if (this.typeNames.has(name)) return true;
    const sym = this.symbolsByName.get(name);
    if (sym) return sym.kind !== 'function' && sym.kind !== 'method' && sym.kind !== 'variable';
    return /^[A-Z_]/.test(name);
  }

  protected invocation(node: Node): void {
    const callee = this.callCallee(node);
    const args = this.callArgs(node);
    const c = callee ? this.chain(callee) : null;
    const calleeParts = c ? [...c.slice(0, -1), c[c.length - 1]!.replace(/\(\)$/, '')] : null;
    // Registrations record a route instead of a call, but their arguments still resolve.
    if (calleeParts && this.httpRegistrar(calleeParts, args, node)) {
      for (const a of args) this.argument(a);
      return;
    }
    if (calleeParts) {
      this.addRef(this.callKind(calleeParts), calleeParts, node, args.slice(0, 3).map((a) => this.argLiteral(a)));
    }
    if (callee && callee.type !== 'identifier' && callee.type !== 'field_identifier' && callee.type !== 'type_identifier') this.walk(callee);
    for (const a of args) this.argument(a);
  }

  /**
   * CivetWeb / Mongoose registrations: `mg_set_request_handler(ctx, "/api/*",
   * handler, NULL)`. The handler is a plain function reference.
   */
  protected httpRegistrar(callee: string[], args: Node[], node: Node): boolean {
    const last = callee[callee.length - 1]!;
    const framework = HTTP_REGISTRARS[last];
    if (!framework || args.length < 3) return false;
    const path = stringValue(args[1]);
    if (path === null) return false;
    const handler = args[2]!.type === 'identifier' ? args[2]!.text : this.chain(args[2]!)?.join('.');
    this.addRoute({ method: 'ANY', path: joinRoute(undefined, path), line: line(node), router: last, handlers: handler ? [handler] : [], framework });
    return true;
  }

  protected argLiteral(n: Node): ArgFact {
    const s = stringValue(n);
    return s === null ? null : s;
  }

  protected argument(a: Node): void {
    if (a.type === 'identifier' || a.type === 'field_expression' || a.type === 'subscript_expression') {
      const c = this.chain(a);
      if (c) this.addRef('ref', c, a);
    } else if (a.type === 'address_expression' || a.type === 'cast_expression') {
      const inner = a.namedChildren.filter((c): c is Node => !!c).pop();
      if (inner) this.argument(inner);
    } else this.walk(a);
  }
}
