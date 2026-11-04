/**
 * Swift language adapter.
 *
 * Records imports, classes / structs / actors / enums (all one grammar
 * node) with typed fields, extensions as members of the extended type,
 * protocols, initializers, function call references, Vapor (and
 * Hummingbird-shaped) routes, and SwiftData / Fluent / CoreData / Realm
 * models. Bare field and method names inside a type become `this.x` so
 * the graph resolves them through field types.
 *
 * Swift has no `new`: `Order(x)` is a call, treated as construction when
 * its name is a declared type, an imported Uppercase name, or any other
 * Uppercase name (same-module types need no import).
 */
import type { Node } from 'web-tree-sitter';
import type { ArgFact, FieldFact, ImportFact, ModelFact, SymbolFact, SymbolKind } from '@eyrie/core';
import { BaseExtractor, joinRoute, line } from './base.js';

const MAX_CHAIN = 6;
const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const ROUTE_BUILDERS = new Set(['routes', 'app', 'router']);
const GROUP_CALLS = new Set(['group', 'grouped']);
const FLUENT_FIELDS = new Set(['ID', 'Field', 'Timestamp', 'OptionalField', 'Group', 'Enum']);
const FLUENT_PARENTS = new Set(['Parent', 'OptionalParent']);
const FLUENT_CHILDREN = new Set(['Children', 'OptionalChild', 'Siblings']);
const FOUNDATION_TYPES = new Set([
  'String',
  'Int',
  'Int8',
  'Int16',
  'Int32',
  'Int64',
  'UInt',
  'UInt8',
  'UInt16',
  'UInt32',
  'UInt64',
  'Double',
  'Float',
  'Bool',
  'Date',
  'Data',
  'UUID',
  'Decimal',
  'URL',
  'Character',
]);

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'line_string_literal' || n.type === 'multi_line_string_literal') {
    let out = '';
    for (const c of n.namedChildren) {
      if (!c) continue;
      if (c.type === 'line_str_text' || c.type === 'multi_line_str_text') out += c.text;
      else if (c.type === 'interpolation' || c.type === 'interpolated_expression') out += ':param';
      else if (c.type === 'str_escaped_char') out += c.text;
    }
    return out;
  }
  if (n.type === 'raw_string_literal') {
    const m = /^#*"([^]*?)"#*$/.exec(n.text);
    return m ? m[1]! : n.text;
  }
  return null;
}

/** `Order` → 'Order', `a.Order` → 'a.Order', `[Item]` → element when unwrapping. */
function typeRoot(n: Node | null | undefined, unwrap = false): string | undefined {
  if (!n) return undefined;
  switch (n.type) {
    case 'type_identifier':
    case 'simple_identifier':
      return n.text;
    case 'identifier':
      return n.namedChildren.find((c) => c?.type === 'simple_identifier')?.text ?? n.text;
    case 'user_type':
      return (
        n.namedChildren
          .filter((c) => !!c && (c.type === 'type_identifier' || c.type === 'simple_identifier'))
          .map((c) => c!.text)
          .join('.') || undefined
      );
    case 'optional_type':
      return typeRoot(
        n.namedChildren.find((c) => !!c && c.type !== 'type_identifier' && c.type !== 'simple_identifier') ?? n.namedChildren[0],
        unwrap,
      );
    case 'array_type': {
      const el = n.namedChildren.find((c) => !!c);
      if (unwrap) return typeRoot(el, true);
      return 'Array';
    }
    case 'dictionary_type':
      return 'Dictionary';
    case 'type_annotation':
      return typeRoot(
        n.namedChildren.find((c) => !!c),
        unwrap,
      );
    case 'opaque_type':
    case 'existential_type':
      return typeRoot(
        n.namedChildren.find((c) => !!c && (c.type === 'user_type' || c.type === 'type_identifier')),
        unwrap,
      );
    default:
      return undefined;
  }
}

/** `@Field(key: "total")` → 'Field'. Arguments are irrelevant to the graph. */
function attributeName(attr: Node): string | null {
  const t = attr.namedChildren.find((c) => c?.type === 'user_type' || c?.type === 'type_identifier' || c?.type === 'simple_identifier');
  const name = t ? typeRoot(t) : null;
  return name ? (name.split('.').pop() ?? null) : null;
}

function attributesOf(modifiers: Node | null | undefined): string[] {
  if (!modifiers || modifiers.type !== 'modifiers') return [];
  const out: string[] = [];
  for (const a of modifiers.namedChildren) {
    if (a?.type !== 'attribute') continue;
    const name = attributeName(a);
    if (name) out.push(name);
  }
  return out;
}

function isPrivate(modifiers: Node | null | undefined): boolean {
  return !!modifiers && /\b(private|fileprivate)\b/.test(modifiers.text);
}

/** Property name bindings: `let x` and `let (a, b)` alike. */
function boundNames(pattern: Node | null | undefined): string[] {
  if (!pattern) return [];
  return pattern.descendantsOfType('simple_identifier').map((i) => i?.text ?? '').filter(Boolean);
}

/** A parameter's local name (`from` in `move(from: Point)`), skipping its label. */
function parameterName(p: Node): string | undefined {
  const named = p.childForFieldName('name');
  if (named?.type === 'simple_identifier') return named.text;
  return p.namedChildren.find((c) => c?.type === 'simple_identifier')?.text;
}

function parameterType(p: Node): string | undefined {
  return typeRoot(p.namedChildren.find((c) => !!c && c.type !== 'simple_identifier' && !c.type.includes('label') && !c.type.includes('modifier')));
}

interface ClassCtx {
  sym: SymbolFact;
  fields: Set<string>;
  methods: Set<string>;
}

export class SwiftExtractor extends BaseExtractor {
  private cls: ClassCtx | null = null;
  private declared: Set<string>[] = [];
  /** Local names bound to a route builder and their path prefix. */
  private grouped = new Map<string, string>();
  /** Simple names of every type declared in the file, collected before visiting. */
  private typeNames = new Set<string>();
  private readonly text: string;

  constructor(path: string, language: import('@eyrie/core').SourceLanguage, hash: string, source: string) {
    super(path, language, hash, source);
    this.text = source;
  }

  protected visitRoot(root: Node): void {
    this.collectTypeNames(root);
    for (const child of root.namedChildren) {
      if (!child) continue;
      if (child.type === 'import_declaration') this.importDecl(child);
      else if (child.type === 'class_declaration') this.nominalDecl(child, undefined);
      else if (child.type === 'protocol_declaration') this.protocolDecl(child, undefined);
      else if (child.type === 'function_declaration') this.functionDecl(child, undefined);
      else if (child.type === 'property_declaration') this.topProperty(child);
      else if (child.type === 'typealias_declaration') this.typealiasDecl(child, undefined);
      else if (child.type === 'operator_declaration' || child.type === 'precedence_group_declaration' || child.type === 'shebang_line') continue;
      else this.withScope({ name: '' }, () => this.walk(child));
    }
  }

  private collectTypeNames(node: Node): void {
    for (const c of node.namedChildren) {
      if (!c) continue;
      if (c.type === 'class_declaration' || c.type === 'protocol_declaration') {
        const n = this.declName(c);
        if (n) this.typeNames.add(n);
      } else if (c.type === 'typealias_declaration') {
        const n = c.childForFieldName('name')?.text;
        if (n) this.typeNames.add(n);
      }
      this.collectTypeNames(c);
    }
  }

  private importDecl(node: Node): void {
    const id = node.namedChildren.find((c) => c?.type === 'identifier' || c?.type === 'simple_identifier');
    const name = id?.type === 'identifier' ? (id.namedChildren.find((c) => c?.type === 'simple_identifier')?.text ?? id.text) : id?.text;
    if (!name) return;
    this.facts.imports.push({ source: name, line: line(node), typeOnly: false, specifiers: [] });
  }

  /** The declared name: `class A`, `protocol P`, `extension Array where ...`. */
  private declName(node: Node): string | undefined {
    const name = node.childForFieldName('name');
    if (!name) return undefined;
    if (name.type === 'type_identifier' || name.type === 'simple_identifier') return name.text;
    return typeRoot(name)?.split('<')[0];
  }

  /** Last keyword before the name: struct/class/actor/enum collapse to kinds. */
  private nominalKind(node: Node): 'class' | 'enum' | 'extension' {
    const name = node.childForFieldName('name');
    const head = this.text.slice(node.startIndex, name ? name.startIndex : node.endIndex);
    const keywords = head.match(/\b(class|struct|actor|enum|extension)\b/g);
    const last = keywords?.[keywords.length - 1];
    if (last === 'extension') return 'extension';
    if (last === 'enum') return 'enum';
    return 'class';
  }

  private nominalDecl(node: Node, parent: ClassCtx | undefined): void {
    const kind = this.nominalKind(node);
    if (kind === 'extension') return this.extensionDecl(node);
    const name = this.declName(node);
    if (!name) return;
    const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
    const sym = this.symbol(name, kind, node, !isPrivate(mods), parent?.sym.qualifiedName);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    const supers = node.namedChildren.filter((c) => c?.type === 'inheritance_specifier').map((s) => typeRoot(s.namedChildren.find((c) => !!c && c.type !== 'type_identifier') ?? s.namedChildren[0])).filter((t): t is string => !!t);
    // Value types cannot inherit; for classes the superclass comes first by convention.
    if (kind === 'enum' || this.isValueType(node)) {
      if (supers.length) sym.implements = supers;
    } else if (supers.length) {
      sym.extends = [supers[0]!];
      if (supers.length > 1) sym.implements = supers.slice(1);
    }
    sym.fields = [];
    this.addSymbol(sym);

    const anns = attributesOf(mods);
    const body = node.namedChildren.find((c) => c?.type === 'class_body' || c?.type === 'enum_class_body');
    const ctx: ClassCtx = { sym, fields: new Set(), methods: new Set() };
    const members = body?.namedChildren.filter((c): c is Node => !!c) ?? [];
    for (const m of members) {
      if (m.type === 'property_declaration') {
        for (const n of boundNames(m.namedChildren.find((c) => c?.type === 'pattern'))) ctx.fields.add(n);
      } else if (m.type === 'function_declaration' || m.type === 'subscript_declaration') {
        const n = m.childForFieldName('name')?.text ?? (m.type === 'subscript_declaration' ? 'subscript' : undefined);
        if (n) ctx.methods.add(n);
      } else if (m.type === 'init_declaration' || m.type === 'deinit_declaration') {
        ctx.methods.add(m.type === 'init_declaration' ? 'init' : 'deinit');
      }
    }

    const model = this.classModel(sym, anns, supers, ctx);
    const prev = this.cls;
    this.cls = ctx;
    for (const m of members) this.member(m, ctx, model);
    this.cls = prev;
    if (model) (this.facts.models ??= []).push(model);
  }

  private isValueType(node: Node): boolean {
    const name = node.childForFieldName('name');
    const head = this.text.slice(node.startIndex, name ? name.startIndex : node.endIndex);
    const keywords = head.match(/\b(class|struct|actor|enum|extension)\b/g);
    const last = keywords?.[keywords.length - 1];
    return last === 'struct' || last === 'actor' || last === 'enum';
  }

  /** Extension members belong to the extended type; the extension itself is not a symbol. */
  private extensionDecl(node: Node): void {
    const extended = this.declName(node)?.split('.').pop();
    if (!extended) return;
    // `extension Order: Codable` conforms the type when it lives in this file.
    const target = this.symbolsByName.get(extended);
    if (target) {
      for (const s of node.namedChildren.filter((c) => c?.type === 'inheritance_specifier')) {
        const t = typeRoot(s.namedChildren[0]);
        if (t && !(target.implements ?? []).includes(t)) (target.implements ??= []).push(t);
      }
    }
    const body = node.namedChildren.find((c) => c?.type === 'class_body');
    const members = body?.namedChildren.filter((c): c is Node => !!c) ?? [];
    const sym: SymbolFact = { name: extended, qualifiedName: extended, kind: 'class', startLine: line(node), endLine: line(node), exported: true, fields: [] };
    const ctx: ClassCtx = { sym, fields: new Set(), methods: new Set() };
    for (const m of members) {
      if (m.type === 'property_declaration') {
        for (const n of boundNames(m.namedChildren.find((c) => c?.type === 'pattern'))) ctx.fields.add(n);
      } else if (m.type === 'function_declaration' || m.type === 'subscript_declaration') {
        const n = m.childForFieldName('name')?.text ?? (m.type === 'subscript_declaration' ? 'subscript' : undefined);
        if (n) ctx.methods.add(n);
      }
    }
    const prev = this.cls;
    this.cls = ctx;
    for (const m of members) {
      if (m.type === 'property_declaration') this.extensionProperty(m, extended);
      else this.member(m, ctx, null);
    }
    this.cls = prev;
  }

  private member(node: Node, ctx: ClassCtx, model: ModelFact | null): void {
    switch (node.type) {
      case 'property_declaration':
        return this.memberProperty(node, ctx, model);
      case 'function_declaration':
        return this.functionDecl(node, ctx);
      case 'subscript_declaration':
        return this.subscriptDecl(node, ctx);
      case 'init_declaration':
      case 'deinit_declaration':
        return this.initDecl(node, ctx);
      case 'class_declaration':
        return this.nominalDecl(node, ctx);
      case 'protocol_declaration':
        return this.protocolDecl(node, ctx);
      case 'typealias_declaration':
        return this.typealiasDecl(node, ctx.sym.qualifiedName);
      case 'associatedtype_declaration': {
        const n = node.namedChildren.find((c) => c?.type === 'type_identifier' || c?.type === 'simple_identifier')?.text;
        if (n) this.addSymbol(this.symbol(n, 'type', node, true, ctx.sym.qualifiedName));
        return;
      }
      case 'enum_entry':
        return;
      default:
        return this.withScope({ name: ctx.sym.qualifiedName }, () => this.walk(node));
    }
  }

  private protocolDecl(node: Node, parent: ClassCtx | undefined): void {
    const name = this.declName(node);
    if (!name) return;
    const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
    const sym = this.symbol(name, 'interface', node, !isPrivate(mods), parent?.sym.qualifiedName);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    const supers = node.namedChildren.filter((c) => c?.type === 'inheritance_specifier').map((s) => typeRoot(s.namedChildren[0])).filter((t): t is string => !!t);
    if (supers.length) sym.extends = supers;
    sym.fields = [];
    this.addSymbol(sym);
    const body = node.namedChildren.find((c) => c?.type === 'protocol_body');
    for (const m of body?.namedChildren ?? []) {
      if (!m) continue;
      if (m.type === 'protocol_function_declaration') {
        const n = m.childForFieldName('name')?.text ?? m.namedChildren.find((c) => c?.type === 'simple_identifier')?.text;
        if (!n) continue;
        const msym = this.symbol(n, 'method', m, true, sym.qualifiedName);
        msym.locals = {};
        this.addSymbol(msym);
      } else if (m.type === 'protocol_property_declaration') {
        const n = m.namedChildren.find((c) => c?.type === 'pattern') ? boundNames(m.namedChildren.find((c) => c?.type === 'pattern'))[0] : m.namedChildren.find((c) => c?.type === 'simple_identifier')?.text;
        if (!n) continue;
        const t = typeRoot(m.namedChildren.find((c) => c?.type === 'type_annotation'));
        sym.fields!.push(t ? { name: n, type: t } : { name: n });
      } else if (m.type === 'associatedtype_declaration') {
        const n = m.namedChildren.find((c) => c?.type === 'type_identifier' || c?.type === 'simple_identifier')?.text;
        if (n) this.addSymbol(this.symbol(n, 'type', m, true, sym.qualifiedName));
      }
    }
  }

  private typealiasDecl(node: Node, parent: string | undefined): void {
    const name = node.childForFieldName('name')?.text;
    if (!name) return;
    const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
    const sym = this.symbol(name, 'type', node, !isPrivate(mods), parent);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    this.addSymbol(sym);
  }

  private classModel(sym: SymbolFact, anns: string[], supers: string[], _ctx: ClassCtx): ModelFact | null {
    void _ctx;
    if (anns.includes('Model')) {
      return { name: sym.name, line: sym.startLine, endLine: sym.endLine, fields: [], relations: [], orm: 'swiftdata', symbol: sym.qualifiedName };
    }
    if (supers.some((s) => s.split('.').pop() === 'NSManagedObject')) {
      return { name: sym.name, line: sym.startLine, endLine: sym.endLine, fields: [], relations: [], orm: 'coredata', symbol: sym.qualifiedName };
    }
    return null;
  }

  /** A Fluent model announces itself per property; create it on first sight. */
  private fluentModel(sym: SymbolFact): ModelFact {
    let model = this.facts.models?.find((m) => m.symbol === sym.qualifiedName);
    if (!model) {
      model = { name: sym.name, line: sym.startLine, endLine: sym.endLine, fields: [], relations: [], orm: 'fluent', symbol: sym.qualifiedName };
      (this.facts.models ??= []).push(model);
    }
    return model;
  }

  private memberProperty(node: Node, ctx: ClassCtx, model: ModelFact | null): void {
    const owner = ctx.sym;
    const pattern = node.namedChildren.find((c) => c?.type === 'pattern');
    const names = boundNames(pattern);
    const typeNode = node.namedChildren.find((c) => c?.type === 'type_annotation');
    const t = typeRoot(typeNode);
    const init = node.namedChildren.find((c) => c?.type === 'call_expression' || c?.type === 'constructor_expression') ?? node.namedChildren.find((c) => !!c && c.type !== 'pattern' && c.type !== 'type_annotation' && c.type !== 'modifiers' && c.type !== 'value_binding_pattern' && c.type !== 'computed_property' && !c.type.includes('setter') && !c.type.includes('getter') && c.type !== 'willset_didset_block' && c.type !== 'attribute');
    const anns = attributesOf(node.namedChildren.find((c) => c?.type === 'modifiers'));
    let activeModel = model;
    if (!activeModel && anns.some((a) => FLUENT_FIELDS.has(a) || FLUENT_PARENTS.has(a) || FLUENT_CHILDREN.has(a))) activeModel = this.fluentModel(owner);
    if (!activeModel && owner && anns.includes('Persisted')) {
      activeModel = { name: owner.name, line: owner.startLine, endLine: owner.endLine, fields: [], relations: [], orm: 'realm', symbol: owner.qualifiedName };
      (this.facts.models ??= []).push(activeModel);
    }
    for (const n of names) {
      const f: FieldFact = { name: n };
      if (t) f.type = t;
      const inst = this.initInstance(init);
      if (inst) f.instanceOf = inst;
      owner.fields!.push(f);
      if (activeModel) {
        activeModel.fields.push(n);
        const rel = this.propertyRelation(activeModel.orm, anns, typeNode, t);
        if (rel && !activeModel.relations.includes(rel)) activeModel.relations.push(rel);
      }
    }
    this.withScope({ name: owner.qualifiedName }, () => {
      if (init) this.walk(init);
      for (const c of node.namedChildren) {
        if (c && (c.type === 'computed_property' || c.type === 'willset_didset_block' || c.type === 'computed_getter' || c.type === 'computed_setter')) this.walk(c);
      }
    });
  }

  private propertyRelation(orm: string, anns: string[], typeNode: Node | undefined, type: string | undefined): string | undefined {
    if (orm === 'swiftdata') {
      if (!anns.includes('Relationship')) return undefined;
      return typeRoot(typeNode, true) ?? type;
    }
    if (orm === 'fluent') {
      if (anns.some((a) => FLUENT_PARENTS.has(a))) return type;
      if (anns.some((a) => FLUENT_CHILDREN.has(a))) return typeRoot(typeNode, true) ?? type;
      return undefined;
    }
    if (orm === 'coredata') {
      if (!type || FOUNDATION_TYPES.has(type.split('.').pop() ?? '')) return undefined;
      return typeRoot(typeNode, true) ?? type;
    }
    if (orm === 'realm') {
      if (!type || FOUNDATION_TYPES.has(type.split('.').pop() ?? '')) return undefined;
      return typeRoot(typeNode, true) ?? type;
    }
    return undefined;
  }

  /** Extension computed properties are symbols: there is no stored field to hang them on. */
  private extensionProperty(node: Node, extended: string): void {
    for (const n of boundNames(node.namedChildren.find((c) => c?.type === 'pattern'))) {
      const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
      const sym = this.symbol(n, 'variable', node, !isPrivate(mods), extended);
      const typeNode = node.namedChildren.find((c) => c?.type === 'type_annotation');
      const t = typeRoot(typeNode);
      if (t) sym.typeName = t;
      this.addSymbol(sym);
      this.withScope({ name: sym.qualifiedName }, () => {
        for (const c of node.namedChildren) {
          if (c && (c.type === 'computed_property' || c.type === 'willset_didset_block')) this.walk(c);
        }
      });
    }
  }

  private functionDecl(node: Node, owner: ClassCtx | undefined): void {
    const name =
      node.childForFieldName('name')?.text ??
      node.namedChildren.find((c) => c?.type === 'simple_identifier' || c?.type === 'custom_operator')?.text ??
      /func\s+(\S+?)\s*\(/.exec(node.text)?.[1];
    if (!name) return;
    const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
    const sym = this.symbol(name, owner ? 'method' : 'function', node, !isPrivate(mods), owner?.sym.qualifiedName);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    const body = node.namedChildren.find((c) => c?.type === 'function_body');
    if (/\basync\b/.test(this.text.slice(node.startIndex, body ? body.startIndex : node.endIndex))) sym.async = true;
    sym.locals = {};
    this.addSymbol(sym);
    const declared = new Set<string>();
    for (const p of node.namedChildren.filter((c) => c?.type === 'parameter')) {
      const pn = parameterName(p);
      const t = parameterType(p);
      if (pn) {
        declared.add(pn);
        if (t) sym.locals[pn] = t;
      }
    }
    // Default values are fields of the declaration, not of their parameter.
    for (const def of node.childrenForFieldName('default_value')) {
      if (def) this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => this.walk(def));
    }
    const prevGrouped = this.grouped;
    this.grouped = new Map();
    if (body) {
      this.declared.push(declared);
      this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => this.walk(body));
      this.declared.pop();
    }
    this.grouped = prevGrouped;
  }

  private subscriptDecl(node: Node, owner: ClassCtx): void {
    const sym = this.symbol('subscript', 'method', node, true, owner.sym.qualifiedName);
    sym.locals = {};
    this.addSymbol(sym);
    const declared = new Set<string>();
    for (const p of node.namedChildren.filter((c) => c?.type === 'parameter')) {
      const pn = parameterName(p);
      if (!pn) continue;
      declared.add(pn);
      const t = parameterType(p);
      if (t) sym.locals[pn] = t;
    }
    this.declared.push(declared);
    this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => {
      for (const c of node.namedChildren) {
        if (c && (c.type === 'computed_property' || c.type === 'computed_getter' || c.type === 'computed_setter')) this.walk(c);
      }
    });
    this.declared.pop();
  }

  private initDecl(node: Node, owner: ClassCtx): void {
    const name = node.type === 'init_declaration' ? 'init' : 'deinit';
    const sym = this.symbol(name, 'method', node, true, owner.sym.qualifiedName);
    sym.locals = {};
    this.addSymbol(sym);
    const declared = new Set<string>();
    for (const p of node.namedChildren.filter((c) => c?.type === 'parameter')) {
      const pn = parameterName(p);
      const t = parameterType(p);
      if (!pn) continue;
      declared.add(pn);
      if (t) sym.locals[pn] = t;
    }
    const prevGrouped = this.grouped;
    this.grouped = new Map();
    const body = node.namedChildren.find((c) => c?.type === 'function_body');
    if (body) {
      this.declared.push(declared);
      this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => this.walk(body));
      this.declared.pop();
    }
    this.grouped = prevGrouped;
  }

  private topProperty(node: Node): void {
    const pattern = node.namedChildren.find((c) => c?.type === 'pattern');
    const typeNode = node.namedChildren.find((c) => c?.type === 'type_annotation');
    const t = typeRoot(typeNode);
    const init = node.namedChildren.find((c) => !!c && c.type !== 'pattern' && c.type !== 'type_annotation' && c.type !== 'modifiers' && c.type !== 'value_binding_pattern' && c.type !== 'computed_property' && !c.type.includes('setter') && !c.type.includes('getter') && c.type !== 'willset_didset_block');
    for (const n of boundNames(pattern)) {
      const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
      const sym = this.symbol(n, 'variable', node, !isPrivate(mods));
      const doc = this.leadingDoc(node);
      if (doc) sym.doc = doc;
      if (t) sym.typeName = t;
      const inst = this.initInstance(init);
      if (inst) sym.instanceOf = inst;
      else if (init?.type === 'call_expression') {
        const c = this.chain(this.callCallee(init));
        if (c) sym.initCall = c.join('.');
      }
      this.addSymbol(sym);
      this.withScope({ name: sym.qualifiedName }, () => {
        if (init) this.walk(init);
        for (const c of node.namedChildren) {
          if (c && (c.type === 'computed_property' || c.type === 'willset_didset_block')) this.walk(c);
        }
      });
    }
  }

  // ── references ───────────────────────────────────────────────────────────

  private isDeclared(name: string): boolean {
    return this.declared.some((s) => s.has(name));
  }

  /** Bare names that are fields or methods of the enclosing type become `this.x`. */
  private rootName(name: string): string[] {
    if (name === 'Self' && this.cls) return [this.cls.sym.qualifiedName.split('.').pop()!];
    if (this.cls && !this.isDeclared(name) && (this.cls.fields.has(name) || this.cls.methods.has(name))) return ['this', name];
    return [name];
  }

  private chain(node: Node | null | undefined): string[] | null {
    if (!node) return null;
    switch (node.type) {
      case 'simple_identifier':
        return this.rootName(node.text);
      case 'self_expression':
        return ['this'];
      case 'super_expression':
        return ['super'];
      case 'navigation_expression': {
        const target = node.childForFieldName('target');
        const suffix = node.namedChildren.find((c) => c?.type === 'navigation_suffix')?.namedChildren.find((c) => c?.type === 'simple_identifier');
        const obj = this.chain(target);
        if (!obj || !suffix || obj.length >= MAX_CHAIN) return null;
        return [...obj, suffix.text];
      }
      case 'call_expression': {
        const suffix = node.namedChildren.find((c) => c?.type === 'call_suffix');
        const target = this.callCallee(node);
        // `items[i]` is a subscript, not a call.
        if (suffix && /^\s*\[/.test(suffix.text)) {
          const obj = this.chain(target);
          return obj ? [...obj, '[]'] : null;
        }
        const inner = this.chain(target);
        if (!inner || inner.length >= MAX_CHAIN) return null;
        return [...inner.slice(0, -1), `${inner[inner.length - 1]}()`];
      }
      case 'constructor_expression': {
        const t = node.namedChildren.find((c) => c?.type === 'user_type' || c?.type === 'type_identifier');
        const name = t ? typeRoot(t) : undefined;
        return name ? [...name.split('.').slice(0, -1), `${name.split('.').pop()}()`] : null;
      }
      case 'try_expression':
      case 'await_expression':
      case 'check_expression':
        return this.chain(node.childForFieldName('expr') ?? node.namedChildren.find((c) => !!c && c.type !== 'try_operator'));
      case 'prefix_expression':
      case 'postfix_expression':
        return this.chain(node.childForFieldName('target') ?? node.namedChildren.find((c) => !!c && c.type !== 'bang' && !c.type.includes('operator')));
      case 'as_expression':
        return this.chain(node.namedChildren[0]);
      default:
        return null;
    }
  }

  private callCallee(node: Node): Node | null {
    return node.namedChildren.find((c) => !!c && c.type !== 'call_suffix' && c.type !== 'constructor_suffix' && c.type !== 'lambda_literal') ?? null;
  }

  private callArgs(node: Node): Node[] {
    const out: Node[] = [];
    for (const c of node.namedChildren) {
      if (!c) continue;
      if (c.type === 'call_suffix') out.push(...c.namedChildren.filter((a): a is Node => !!a && a.type === 'value_arguments').flatMap((v) => v.namedChildren.filter((a): a is Node => !!a && a.type === 'value_argument')));
      else if (c.type === 'value_arguments') out.push(...c.namedChildren.filter((a): a is Node => !!a && a.type === 'value_argument'));
    }
    return out;
  }

  private callLambdas(node: Node): Node[] {
    const out: Node[] = [];
    for (const c of node.namedChildren) {
      if (!c) continue;
      if (c.type === 'lambda_literal') out.push(c);
      else if (c.type === 'call_suffix') out.push(...c.namedChildren.filter((l): l is Node => !!l && l.type === 'lambda_literal'));
    }
    return out;
  }

  /** The value of a `value_argument`, skipping its `label:`. */
  private argumentValue(arg: Node): Node | null {
    return arg.namedChildren.find((c) => !!c && c.type !== 'value_argument_label') ?? null;
  }

  private isLabeled(arg: Node): boolean {
    return arg.namedChildren.some((c) => c?.type === 'value_argument_label');
  }

  private walk(node: Node): void {
    switch (node.type) {
      case 'comment':
      case 'multiline_comment':
      case 'shebang_line':
      case 'attribute':
      case 'modifiers':
      case 'integer_literal':
      case 'hex_literal':
      case 'oct_literal':
      case 'bin_literal':
      case 'real_literal':
      case 'boolean_literal':
      case 'nil_literal':
      case 'special_literal':
      case 'regex_literal':
        return;
      case 'call_expression':
        return this.invocation(node);
      case 'constructor_expression': {
        const c = this.chain(node);
        if (c) this.addRef('new', c.map((s) => s.replace(/\(\)$/, '')), node);
        for (const a of this.callArgs(node)) this.argument(this.argumentValue(a) ?? a);
        return;
      }
      case 'property_declaration':
        return this.localProperty(node);
      case 'lambda_literal': {
        const names: string[] = [];
        for (const p of node.descendantsOfType('lambda_parameter')) {
          const n = p?.descendantsOfType('simple_identifier')[0]?.text;
          if (n) names.push(n);
        }
        for (const cap of node.descendantsOfType('capture_list_item')) {
          const n = cap?.namedChildren.find((c) => c?.type === 'simple_identifier')?.text;
          if (n && n !== 'self') names.push(n);
        }
        this.declared.push(new Set(names));
        for (const c of node.namedChildren) if (c) this.walk(c);
        this.declared.pop();
        return;
      }
      case 'if_statement':
      case 'guard_statement':
      case 'while_statement':
      case 'catch_block':
      case 'switch_entry': {
        const names = this.patternBindings(node);
        this.declared.push(new Set(names));
        for (const c of node.namedChildren) if (c) this.walk(c);
        this.declared.pop();
        return;
      }
      case 'for_statement': {
        const item = node.childForFieldName('item') ?? node.namedChildren.find((c) => c?.type === 'pattern');
        const names = item ? item.descendantsOfType('simple_identifier').map((i) => i?.text ?? '').filter(Boolean) : [];
        this.declared.push(new Set(names));
        for (const c of node.namedChildren) if (c) this.walk(c);
        this.declared.pop();
        return;
      }
      case 'function_declaration': {
        // Local function: no symbol, its calls belong to the enclosing scope.
        const declared = new Set<string>();
        const locals = this.scope().locals;
        for (const p of node.namedChildren.filter((c) => c?.type === 'parameter')) {
          const pn = parameterName(p);
          if (pn) {
            declared.add(pn);
            if (locals && !locals[pn]) {
              const t = parameterType(p);
              if (t) locals[pn] = t;
            }
          }
        }
        this.declared.push(declared);
        const body = node.namedChildren.find((c) => c?.type === 'function_body');
        if (body) this.walk(body);
        this.declared.pop();
        return;
      }
      case 'class_declaration':
      case 'protocol_declaration':
      case 'typealias_declaration': {
        // Local type: no symbol, but initializers and bodies may hold calls.
        for (const c of node.namedChildren) {
          if (c && (c.type === 'class_body' || c.type === 'protocol_body' || c.type === 'enum_class_body')) this.walk(c);
        }
        return;
      }
    }
    for (const c of node.namedChildren) if (c) this.walk(c);
  }

  /** Names bound by `if/guard/case let` in a statement (excluding nested closures). */
  private patternBindings(node: Node): string[] {
    const names: string[] = [];
    const visit = (n: Node): void => {
      const kids = n.namedChildren;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (!c || c.type === 'lambda_literal' || c.type === 'function_declaration' || c.type === 'statements') continue;
        if (c.type === 'value_binding_pattern') {
          const next = kids[i + 1];
          if (next?.type === 'simple_identifier') names.push(next.text);
        }
        visit(c);
      }
    };
    visit(node);
    return names;
  }

  private localProperty(node: Node): void {
    const locals = this.scope().locals;
    const pattern = node.namedChildren.find((c) => c?.type === 'pattern');
    const names = boundNames(pattern);
    const typeNode = node.namedChildren.find((c) => c?.type === 'type_annotation');
    const t = typeRoot(typeNode);
    const init = node.namedChildren.find((c) => !!c && c.type !== 'pattern' && c.type !== 'type_annotation' && c.type !== 'modifiers' && c.type !== 'value_binding_pattern' && c.type !== 'computed_property' && !c.type.includes('setter') && !c.type.includes('getter') && c.type !== 'willset_didset_block');
    for (const n of names) {
      this.declared[this.declared.length - 1]?.add(n);
      if (!locals || names.length > 1) continue;
      if (t) locals[n] = t;
      else {
        const inst = this.initInstance(init);
        if (inst) locals[n] = inst;
        else if (init?.type === 'call_expression') {
          const c = this.chain(this.callCallee(init));
          if (c) locals[n] = `call:${c.join('.')}`;
        }
      }
    }
    // `let v1 = routes.grouped("v1")` binds a route builder for what follows.
    if (names.length === 1 && init?.type === 'call_expression') {
      const prefix = this.groupedPrefix(init);
      if (prefix !== null) this.grouped.set(names[0]!, prefix);
    }
    if (init) this.walk(init);
    for (const c of node.namedChildren) {
      if (c && (c.type === 'computed_property' || c.type === 'willset_didset_block')) this.walk(c);
    }
  }

  private invocation(node: Node): void {
    const callee = this.callCallee(node);
    const args = this.callArgs(node);
    const lambdas = this.callLambdas(node);
    // `items[i]` is a subscript read, not a call.
    const suffix = node.namedChildren.find((c) => c?.type === 'call_suffix');
    if (suffix && /^\s*\[/.test(suffix.text)) {
      const c = callee ? this.chain(callee) : null;
      if (c) this.addRef('ref', c, node);
      for (const a of args) this.argument(this.argumentValue(a) ?? a);
      for (const l of lambdas) this.walk(l);
      return;
    }
    const c = callee ? this.chain(callee) : null;
    // `X.group("v1") { v1 in ... }`: the closure parameter is a route builder.
    if (c && c.length === 2 && GROUP_CALLS.has(c[1]!.replace(/\(\)$/, '')) && (ROUTE_BUILDERS.has(c[0]!) || this.grouped.has(c[0]!))) {
      const prefix = this.pathParts(args).join('/');
      for (const l of lambdas) {
        const param = l.descendantsOfType('lambda_parameter')[0]?.descendantsOfType('simple_identifier')[0]?.text;
        const prev = param ? this.grouped.get(param) : undefined;
        if (param) this.grouped.set(param, prefix);
        this.walk(l);
        if (param) {
          if (prev === undefined) this.grouped.delete(param);
          else this.grouped.set(param, prev);
        }
      }
      for (const a of args) {
        const v = this.argumentValue(a) ?? a;
        if (!this.isLabeled(a) && (stringValue(v) !== null || this.pathComponent(v) !== null)) continue;
        this.argument(v);
      }
      return;
    }
    // `routes.get("orders", ":id", use: self.get)`: a Vapor/Hummingbird route.
    if (c && c.length >= 2 && ROUTE_VERBS.has(c[c.length - 1]!.replace(/\(\)$/, '')) && (ROUTE_BUILDERS.has(c[0]!) || this.grouped.has(c[0]!))) {
      const verb = c[c.length - 1]!.replace(/\(\)$/, '').toUpperCase();
      const parts = this.pathParts(args);
      if (parts.length || this.hasHandler(args, lambdas)) {
        const base = this.grouped.get(c[0]!);
        const full = joinRoute(base || undefined, parts.length ? `/${parts.join('/')}` : '/');
        const scope = `route:${verb} ${full}`;
        const handlers = this.routeHandlers(args);
        this.addRoute({ method: verb, path: full, line: line(node), router: c.slice(0, -1).join('.'), handlers, framework: 'vapor', scope });
        this.withScope({ name: scope, locals: {} }, () => {
          for (const a of args) {
            const v = this.argumentValue(a) ?? a;
            // Path parts are syntax, not references.
            if (!this.isLabeled(a) && (stringValue(v) !== null || this.pathComponent(v) !== null)) continue;
            this.argument(v);
          }
          for (const l of lambdas) this.walk(l);
        });
        return;
      }
    }
    if (c) {
      let calleeParts = [...c.slice(0, -1), c[c.length - 1]!.replace(/\(\)$/, '')];
      let kind = this.callKind(calleeParts);
      // `Order.init(x)` constructs.
      if (calleeParts[calleeParts.length - 1] === 'init' && calleeParts.length > 1 && this.isTypeRoot(calleeParts[0]!)) {
        kind = 'new';
        calleeParts = calleeParts.slice(0, -1);
      }
      this.addRef(kind, calleeParts, node, args.slice(0, 3).map((a) => this.argLiteral(this.argumentValue(a) ?? a)));
    }
    // A complex callee holds its own calls (`Order.query(x).first()` records both).
    if (callee && callee.type !== 'simple_identifier' && callee.type !== 'self_expression' && callee.type !== 'super_expression') this.walk(callee);
    for (const a of args) this.argument(this.argumentValue(a) ?? a);
    for (const l of lambdas) this.walk(l);
  }

  /** Positional leading path parts: strings and `.constant/.parameter` components. */
  private pathParts(args: Node[]): string[] {
    const parts: string[] = [];
    for (const a of args) {
      if (this.isLabeled(a)) break;
      const part = this.pathComponent(this.argumentValue(a));
      if (part === null) break;
      parts.push(part);
    }
    return parts;
  }

  private pathComponent(value: Node | null): string | null {
    if (!value) return null;
    const str = stringValue(value);
    if (str !== null) return str.replace(/^\/+/, '');
    let name: string | null = null;
    let arg: Node | null = null;
    if (value.type === 'call_expression') {
      const callee = this.callCallee(value);
      if (callee?.type === 'prefix_expression') name = callee.namedChildren.find((c) => c?.type === 'simple_identifier')?.text ?? null;
      const callArgs = this.callArgs(value);
      arg = callArgs.length ? (this.argumentValue(callArgs[0]!) ?? null) : null;
    } else if (value.type === 'prefix_expression') {
      name = value.namedChildren.find((c) => c?.type === 'simple_identifier')?.text ?? null;
    }
    if (name === 'constant' && arg) return stringValue(arg)?.replace(/^\/+/, '') ?? null;
    if (name === 'parameter' && arg) {
      const s = stringValue(arg);
      return s ? `:${s}` : null;
    }
    if (name === 'anything') return '*';
    if (name === 'catchall') return '**';
    return null;
  }

  private hasHandler(args: Node[], lambdas: Node[]): boolean {
    if (lambdas.length) return true;
    return args.some((a) => {
      if (!this.isLabeled(a)) return false;
      const label = a.namedChildren.find((c) => c?.type === 'value_argument_label')?.text;
      return label === 'use';
    });
  }

  private routeHandlers(args: Node[]): string[] {
    const handlers: string[] = [];
    const owner = this.cls?.sym.qualifiedName;
    for (const a of args) {
      const value = this.argumentValue(a);
      if (!value) continue;
      const labeled = this.isLabeled(a);
      const label = a.namedChildren.find((c) => c?.type === 'value_argument_label')?.text;
      if (labeled && label !== 'use') continue;
      if (value.type !== 'simple_identifier' && value.type !== 'navigation_expression') continue;
      const c = this.chain(value);
      if (!c) continue;
      if (c[0] === 'this' && c.length === 2) handlers.push(owner ? `${owner}.${c[1]}` : c[1]!);
      else if (c.length === 1 && owner) handlers.push(`${owner}.${c[0]}`);
      else handlers.push(c.join('.'));
    }
    return handlers;
  }

  /** `routes.grouped("v1", mw)` → 'v1', or null when this is not a grouping call. */
  private groupedPrefix(init: Node): string | null {
    const callee = this.callCallee(init);
    const c = callee ? this.chain(callee) : null;
    if (!c || c.length !== 2 || !GROUP_CALLS.has(c[1]!.replace(/\(\)$/, ''))) return null;
    if (!ROUTE_BUILDERS.has(c[0]!) && !this.grouped.has(c[0]!)) return null;
    return this.pathParts(this.callArgs(init)).join('/');
  }

  /** `Order(x)` and `Outer.Inner(x)` construct; `order.save(x)` calls. */
  private callKind(callee: string[]): 'call' | 'new' {
    const last = callee[callee.length - 1]!;
    if (!/^[A-Z]/.test(last)) return 'call';
    const root = callee[0]!;
    if (root === 'this' || root === 'super') return 'call';
    if (callee.length === 1) return this.isNewCall(root) ? 'new' : 'call';
    return this.isTypeRoot(root) ? 'new' : 'call';
  }

  private isTypeRoot(name: string): boolean {
    return this.typeNames.has(name) || /^[A-Z]/.test(name);
  }

  private isNewCall(name: string): boolean {
    if (this.typeNames.has(name)) return true;
    const sym = this.symbolsByName.get(name);
    if (sym) return sym.kind !== 'function' && sym.kind !== 'method' && sym.kind !== 'variable';
    // Same-module types need no import; only the Uppercase convention is left.
    return /^[A-Z]/.test(name);
  }

  /** The constructed type of an initializer: `Order(x)` → 'Order'. */
  private initInstance(init: Node | undefined): string | undefined {
    if (!init) return undefined;
    if (init.type === 'constructor_expression') {
      const c = this.chain(init);
      return c ? c.map((s) => s.replace(/\(\)$/, '')).join('.') : undefined;
    }
    if (init.type === 'call_expression') {
      const c = this.chain(this.callCallee(init));
      const parts = c?.map((s) => s.replace(/\(\)$/, ''));
      if (parts && this.callKind(parts) === 'new') return parts.join('.');
    }
    return undefined;
  }

  private argLiteral(n: Node): ArgFact {
    const s = stringValue(n);
    return s === null ? null : s;
  }

  private argument(a: Node): void {
    if (a.type === 'simple_identifier' || a.type === 'navigation_expression') {
      const c = this.chain(a);
      if (c) this.addRef('ref', c, a);
    } else this.walk(a);
  }
}
