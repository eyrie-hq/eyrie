/**
 * Dart language adapter.
 *
 * Records `dart:` / `package:` / relative imports (with `as` prefixes and
 * show/hide combinators), `export` and `part` directives, classes with
 * named / factory / const constructors, typed fields, methods, getters,
 * setters and operators, mixins, enums, extensions (whose members attach
 * to the extended type, as in Swift), extension types, typedefs, top-level
 * functions and variables, and call / construction / reference facts.
 * StatefulWidget / State subclasses are recorded plainly, like any class.
 * Dart has no declarative routes or ORM models, so none are recorded.
 *
 * Grammar quirks (@plurnk/plurnk-mimetypes-grammar-dart): a declaration
 * and its body are adjacent siblings (`method_signature` + `function_body`),
 * top-level variables are flat siblings (type nodes, then the identifier
 * list) with no wrapper, and expressions are flat runs of a base node plus
 * `selector` siblings. `covariant`, the `[]` operator, labels, three-part
 * qualified types (`a.b.C`) and `final`/`var` in `if-case` patterns do not
 * parse. Explicit type arguments on a method call (`o.m<int>()`) silently
 * misparse as comparisons with no parse error.
 */
import type { Node } from 'web-tree-sitter';
import type { ArgFact, FieldFact, ImportFact, SourceLanguage, SymbolFact } from '@eyrie/core';
import { BaseExtractor, line, unquote } from './base.js';

const MAX_CHAIN = 6;

/** Signatures that can hide inside a `declaration` or `method_signature`. */
const SIGNATURES = new Set([
  'constructor_signature',
  'constant_constructor_signature',
  'factory_constructor_signature',
  'redirecting_factory_constructor_signature',
  'function_signature',
  'getter_signature',
  'setter_signature',
  'operator_signature',
]);
const VAR_LISTS = new Set(['initialized_identifier_list', 'static_final_declaration_list', 'identifier_list']);

/** A leading underscore makes a Dart declaration library-private. */
function isPrivateName(name: string): boolean {
  return name.startsWith('_');
}

/** Nodes that trail an expression base: `.x`, `?.x`, `[i]`, `(args)`, `..x`. */
function isFollower(n: Node): boolean {
  return n.type === 'selector' || n.type === 'cascade_section' || n.type === 'unconditional_assignable_selector' || n.type === 'conditional_assignable_selector';
}

/**
 * The type in a single-type position: leading `type_identifier` siblings
 * joined with dots (`p.Order` is two nodes), type arguments dropped for
 * resolution. Function types become 'Function'.
 */
function singleType(kids: readonly Node[]): string | undefined {
  const parts: string[] = [];
  let started = false;
  for (const k of kids) {
    if (k.type === 'type_identifier') {
      parts.push(k.text);
      started = true;
    } else if (!started) continue;
    else break;
  }
  if (parts.length) return parts.join('.');
  if (kids.some((k) => k.type === 'function_type')) return 'Function';
  return undefined;
}

/**
 * Names in a type list (`with` / `implements` / `on` clauses), where one
 * qualified name and two plain names look identical. A lowercase segment
 * continues the previous name: `with p.M` is one mixin, `with M1, M2`
 * is two.
 */
function qualifiedNames(tis: readonly Node[]): string[] {
  const out: string[] = [];
  for (const t of tis) {
    const prev = out[out.length - 1];
    if (prev !== undefined && /^[a-z_]/.test(prev.split('.').pop()!)) out[out.length - 1] = `${prev}.${t.text}`;
    else out.push(t.text);
  }
  return out;
}

function stringValue(n: Node | null | undefined): string | null {
  if (!n || n.type !== 'string_literal') return null;
  let text = n.text;
  for (const sub of n.namedChildren) {
    if (sub && sub.type === 'template_substitution') text = text.replace(sub.text, ':param');
  }
  return unquote(text);
}

function literal(n: Node | null | undefined): ArgFact {
  const s = stringValue(n);
  if (s !== null) return s;
  if (n && n.type === 'additive_expression' && n.text.includes('+')) {
    const head = literal(n.namedChildren[0]);
    return typeof head === 'string' ? `${head}:param` : null;
  }
  return null;
}

/** A named parameter's local name and type; `this.x` / `super.x` bind the name with no type. */
function paramNameType(p: Node): { name?: string; type?: string } {
  const kids = p.namedChildren.filter((c): c is Node => !!c);
  const ctor = kids.find((c) => c.type === 'constructor_param' || c.type === 'super_formal_parameter');
  if (ctor) return { name: ctor.namedChildren.find((c) => c?.type === 'identifier')?.text };
  const name = p.childForFieldName('name')?.text ?? kids.find((c) => c.type === 'identifier')?.text;
  const type = kids.some((c) => c.type === 'formal_parameter_list') ? 'Function' : singleType(kids);
  return { name, type };
}

interface ClassCtx {
  sym: SymbolFact;
  fields: Set<string>;
  methods: Set<string>;
}

export class DartExtractor extends BaseExtractor {
  private cls: ClassCtx | null = null;
  private declared: Set<string>[] = [];
  /** Simple names of every type declared in the file, collected before visiting. */
  private typeNames = new Set<string>();
  private readonly text: string;

  constructor(path: string, language: SourceLanguage, hash: string, source: string) {
    super(path, language, hash, source);
    this.text = source;
  }

  protected visitRoot(root: Node): void {
    this.collectTypeNames(root);
    this.topLevel(root.namedChildren.filter((c): c is Node => !!c));
  }

  private collectTypeNames(node: Node): void {
    for (const c of node.namedChildren) {
      if (!c) continue;
      if (c.type === 'class_definition' || c.type === 'enum_declaration' || c.type === 'extension_type_declaration') {
        const n = c.childForFieldName('name')?.text;
        if (n) this.typeNames.add(n);
      } else if (c.type === 'mixin_declaration') {
        const n = c.namedChildren.find((k) => k?.type === 'identifier')?.text;
        if (n) this.typeNames.add(n);
      } else if (c.type === 'type_alias') {
        const n = c.namedChildren[0]?.text;
        if (n) this.typeNames.add(n);
      }
      this.collectTypeNames(c);
    }
  }

  // ── top level ──────────────────────────────────────────────────────────

  private topLevel(members: Node[]): void {
    // Top-level variables are flat: type-ish nodes, then the identifier list.
    let pending: Node[] = [];
    let runStart: Node | null = null;
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      switch (m.type) {
        case 'final_builtin':
        case 'const_builtin':
        case 'inferred_type':
        case 'type_identifier':
        case 'type_arguments':
        case 'nullable_type':
        case 'function_type':
        case 'void_type':
        case 'record_type':
          pending.push(m);
          continue;
        case 'initialized_identifier_list':
        case 'static_final_declaration_list':
        case 'identifier_list':
          this.topVariables(pending, m);
          pending = [];
          continue;
        case 'annotation':
          runStart ??= m;
          pending = [];
          continue;
      }
      pending = [];
      const docNode = runStart ?? m;
      runStart = null;
      if (m.type === 'import_or_export') this.importOrExport(m);
      else if (m.type === 'library_name') {
        this.facts.namespace = m.namedChildren.find((c) => c?.type === 'dotted_identifier_list')?.text ?? m.text;
      } else if (m.type === 'part_directive' || m.type === 'part_of_directive') {
        // `part of <name>` names a library, not a file, and has no URI.
        const lit = m.descendantsOfType('string_literal')[0]?.text;
        if (lit) this.facts.imports.push({ source: unquote(lit), line: line(m), typeOnly: false, specifiers: [] });
      } else if (m.type === 'class_definition') this.classDecl(m, undefined, docNode);
      else if (m.type === 'mixin_declaration') this.mixinDecl(m, undefined, docNode);
      else if (m.type === 'enum_declaration') this.enumDecl(m, undefined, docNode);
      else if (m.type === 'extension_declaration') this.extensionDecl(m);
      else if (m.type === 'extension_type_declaration') this.extensionTypeDecl(m, undefined, docNode);
      else if (m.type === 'type_alias') this.aliasDecl(m, undefined, docNode);
      else if (m.type === 'function_signature') {
        const next = members[i + 1];
        const body = next?.type === 'function_body' ? next : undefined;
        if (body) i++;
        this.topFunction(m, body, docNode);
      } else if (m.type === 'getter_signature' || m.type === 'setter_signature') {
        const next = members[i + 1];
        const body = next?.type === 'function_body' ? next : undefined;
        if (body) i++;
        this.topAccessor(m, body, docNode);
      } else if (m.type !== 'function_body') {
        this.withScope({ name: '' }, () => this.walk(m));
      }
    }
  }

  private importOrExport(node: Node): void {
    const lib = node.namedChildren.find((c): c is Node => !!c);
    if (!lib) return;
    if (lib.type === 'library_import') {
      const spec = lib.namedChildren.find((c) => c?.type === 'import_specification');
      if (!spec) return;
      const { uri, alias, shown } = this.directiveParts(spec);
      if (!uri) return;
      const imp: ImportFact = { source: uri, line: line(node), typeOnly: false, specifiers: [] };
      if (alias) {
        // Only the prefix is visible; a `show` clause merely narrows it.
        imp.specifiers.push({ imported: '*', local: alias });
      } else if (shown.length) {
        imp.specifiers.push(...shown.map((s) => ({ imported: s, local: s })));
      } else {
        // A bare or `hide`-only import brings every public name into scope.
        imp.wildcard = true;
      }
      this.facts.imports.push(imp);
    } else if (lib.type === 'library_export') {
      const { uri, shown } = this.directiveParts(lib);
      if (!uri) return;
      if (shown.length) {
        for (const s of shown) this.facts.exports.push({ kind: 'reexport', exported: s, imported: s, source: uri, line: line(node) });
      } else this.facts.exports.push({ kind: 'reexport-all', source: uri, line: line(node) });
    }
  }

  /** The default URI, `as` alias and show/hide names of an import or export directive. */
  private directiveParts(node: Node): { uri: string | null; alias?: string; shown: string[] } {
    const uriNode = node.namedChildren.find((c) => c?.type === 'configurable_uri' || c?.type === 'uri');
    // Conditional imports list fallbacks after the default URI; only it resolves.
    const firstUri = uriNode?.type === 'configurable_uri' ? (uriNode.namedChildren.find((c) => c?.type === 'uri') ?? uriNode) : uriNode;
    const lit = firstUri?.namedChildren.find((c) => c?.type === 'string_literal')?.text;
    const shown: string[] = [];
    for (const c of node.namedChildren) {
      if (c?.type !== 'combinator' || !c.text.startsWith('show')) continue;
      for (const k of c.namedChildren) if (k?.type === 'identifier') shown.push(k.text);
    }
    return { uri: lit ? unquote(lit) : null, alias: node.namedChildren.find((c) => c?.type === 'identifier')?.text, shown };
  }

  private topFunction(sig: Node, body: Node | undefined, docNode: Node): void {
    const name = sig.childForFieldName('name')?.text ?? sig.namedChildren.find((c) => c?.type === 'identifier')?.text;
    if (!name) {
      if (body) this.withScope({ name: '' }, () => this.walk(body));
      return;
    }
    const sym = this.symbol(name, 'function', sig, !isPrivateName(name));
    const doc = this.leadingDoc(docNode);
    if (doc) sym.doc = doc;
    if (body && this.isAsync(sig, body)) sym.async = true;
    sym.locals = {};
    this.addSymbol(sym);
    const declared = this.bindParams(sig, sym);
    if (body) {
      this.declared.push(declared);
      this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => this.walk(body));
      this.declared.pop();
    }
  }

  /** A top-level getter/setter is a computed variable: it is read, never called. */
  private topAccessor(sig: Node, body: Node | undefined, docNode: Node): void {
    const name = sig.childForFieldName('name')?.text ?? sig.namedChildren.find((c) => c?.type === 'identifier')?.text;
    if (!name) {
      if (body) this.withScope({ name: '' }, () => this.walk(body));
      return;
    }
    const sym = this.symbol(name, 'variable', sig, !isPrivateName(name));
    const doc = this.leadingDoc(docNode);
    if (doc) sym.doc = doc;
    const t = singleType(sig.namedChildren.filter((c): c is Node => !!c));
    if (t) sym.typeName = t;
    this.addSymbol(sym);
    if (body) {
      const declared = new Set<string>();
      this.eachParam(
        sig,
        (p) => {
          const pn = paramNameType(p).name;
          if (pn) declared.add(pn);
        },
        () => {},
      );
      this.declared.push(declared);
      this.withScope({ name: sym.qualifiedName }, () => this.walk(body));
      this.declared.pop();
    }
  }

  private topVariables(pending: Node[], list: Node): void {
    const type = singleType(pending);
    const docNode = pending[0] ?? list;
    for (const e of list.namedChildren) {
      if (!e) continue;
      let name: string | undefined;
      let vals: Node[] = [];
      if (e.type === 'identifier') name = e.text;
      else {
        const kids = e.namedChildren.filter((c): c is Node => !!c);
        const idx = kids.findIndex((c) => c.type === 'identifier');
        if (idx === -1) continue;
        name = kids[idx]!.text;
        vals = kids.slice(idx + 1);
      }
      if (!name) continue;
      const sym = this.symbol(name, 'variable', e, !isPrivateName(name));
      const doc = this.leadingDoc(docNode);
      if (doc) sym.doc = doc;
      if (type) sym.typeName = type;
      const inst = this.initInstance(vals);
      if (inst) sym.instanceOf = inst;
      else {
        const c = this.initCallTarget(vals);
        if (c) sym.initCall = c;
      }
      this.addSymbol(sym);
      if (vals.length) this.withScope({ name: sym.qualifiedName }, () => this.sequence(vals, false));
    }
  }

  private aliasDecl(node: Node, parent: string | undefined, docNode: Node): void {
    const name = node.namedChildren[0]?.text;
    if (!name) return;
    const sym = this.symbol(name, 'type', node, !isPrivateName(name), parent);
    const doc = this.leadingDoc(docNode);
    if (doc) sym.doc = doc;
    this.addSymbol(sym);
  }

  // ── types ──────────────────────────────────────────────────────────────

  private classDecl(node: Node, parent: string | undefined, docNode: Node): void {
    const name = node.childForFieldName('name')?.text;
    if (!name) return;
    const sym = this.symbol(name, 'class', node, !isPrivateName(name), parent);
    const doc = this.leadingDoc(docNode);
    if (doc) sym.doc = doc;
    const sup = node.namedChildren.find((c) => c?.type === 'superclass');
    const ext: string[] = [];
    const supTis = sup?.namedChildren.filter((c) => c?.type === 'type_identifier') ?? [];
    if (supTis.length) ext.push(supTis.map((t) => t!.text).join('.'));
    // Mixins contribute methods like a superclass, so method lookup follows them.
    const mixins = sup?.namedChildren.find((c) => c?.type === 'mixins')?.namedChildren.filter((c): c is Node => !!c && c.type === 'type_identifier') ?? [];
    ext.push(...qualifiedNames(mixins));
    if (ext.length) sym.extends = ext;
    const ifaces = node.namedChildren.find((c) => c?.type === 'interfaces')?.namedChildren.filter((c): c is Node => !!c && c.type === 'type_identifier') ?? [];
    if (ifaces.length) sym.implements = qualifiedNames(ifaces);
    sym.fields = [];
    this.addSymbol(sym);
    this.typeBody(
      node.namedChildren.find((c) => c?.type === 'class_body'),
      sym,
      null,
    );
  }

  private mixinDecl(node: Node, parent: string | undefined, docNode: Node): void {
    const name = node.namedChildren.find((c) => c?.type === 'identifier')?.text;
    if (!name) return;
    const sym = this.symbol(name, 'class', node, !isPrivateName(name), parent);
    const doc = this.leadingDoc(docNode);
    if (doc) sym.doc = doc;
    const on = node.namedChildren.filter((c): c is Node => !!c && c.type === 'type_identifier');
    if (on.length) sym.extends = qualifiedNames(on);
    sym.fields = [];
    this.addSymbol(sym);
    this.typeBody(
      node.namedChildren.find((c) => c?.type === 'class_body'),
      sym,
      null,
    );
  }

  private enumDecl(node: Node, parent: string | undefined, docNode: Node): void {
    const name = node.childForFieldName('name')?.text;
    if (!name) return;
    const sym = this.symbol(name, 'enum', node, !isPrivateName(name), parent);
    const doc = this.leadingDoc(docNode);
    if (doc) sym.doc = doc;
    const ifaces = node.namedChildren.find((c) => c?.type === 'interfaces')?.namedChildren.filter((c): c is Node => !!c && c.type === 'type_identifier') ?? [];
    if (ifaces.length) sym.implements = qualifiedNames(ifaces);
    sym.fields = [];
    this.addSymbol(sym);
    this.typeBody(
      node.namedChildren.find((c) => c?.type === 'enum_body'),
      sym,
      null,
    );
  }

  private extensionTypeDecl(node: Node, parent: string | undefined, docNode: Node): void {
    const name = node.childForFieldName('name')?.text;
    if (!name) return;
    const sym = this.symbol(name, 'class', node, !isPrivateName(name), parent);
    const doc = this.leadingDoc(docNode);
    if (doc) sym.doc = doc;
    const rep = node.namedChildren.find((c) => c?.type === 'representation_declaration');
    const repType = rep ? singleType(rep.namedChildren.filter((c): c is Node => !!c)) : undefined;
    if (repType) sym.extends = [repType];
    sym.fields = [];
    this.addSymbol(sym);
    this.typeBody(
      node.namedChildren.find((c) => c?.type === 'class_body'),
      sym,
      null,
    );
  }

  /** Extension members belong to the extended type; the extension itself is not a symbol. */
  private extensionDecl(node: Node): void {
    const tis = node.namedChildren.filter((c) => c?.type === 'type_identifier');
    const extended = tis[tis.length - 1]?.text;
    if (!extended) return;
    const sym: SymbolFact = { name: extended, qualifiedName: extended, kind: 'class', startLine: line(node), endLine: line(node), exported: true, fields: [] };
    this.typeBody(
      node.namedChildren.find((c) => c?.type === 'extension_body'),
      sym,
      extended,
    );
  }

  private typeBody(body: Node | null | undefined, sym: SymbolFact, extended: string | null): void {
    const members = body?.namedChildren.filter((c): c is Node => !!c) ?? [];
    const ctx: ClassCtx = { sym, fields: new Set(), methods: new Set() };
    // Collect fields and methods before walking bodies, so bare names resolve to `this.x`.
    this.collectMembers(members, ctx);
    const prev = this.cls;
    this.cls = ctx;
    let runStart: Node | null = null;
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      if (m.type === 'annotation') {
        runStart ??= m;
        continue;
      }
      const docNode = runStart ?? m;
      runStart = null;
      if (m.type === 'method_signature') {
        const sig = m.namedChildren.find((c): c is Node => !!c);
        const next = members[i + 1];
        const fbody = next?.type === 'function_body' ? next : undefined;
        if (fbody) i++;
        if (sig) this.memberSig(sig, fbody, ctx, m, docNode, extended);
        else if (fbody) this.withScope({ name: ctx.sym.qualifiedName }, () => this.walk(fbody));
        continue;
      }
      if (m.type === 'declaration') {
        const kids = m.namedChildren.filter((c): c is Node => !!c);
        const sig = kids.find((c) => SIGNATURES.has(c.type));
        if (sig) {
          const next = members[i + 1];
          const fbody = next?.type === 'function_body' ? next : undefined;
          if (fbody) i++;
          this.memberSig(sig, fbody, ctx, m, docNode, extended, kids);
        } else {
          this.memberFields(m, kids, ctx, extended);
        }
        continue;
      }
      if (m.type === 'class_definition') {
        this.classDecl(m, ctx.sym.qualifiedName, docNode);
        continue;
      }
      if (m.type === 'enum_declaration') {
        this.enumDecl(m, ctx.sym.qualifiedName, docNode);
        continue;
      }
      if (m.type === 'function_body' || m.type === 'enum_constant' || m.type === 'ERROR') {
        this.withScope({ name: ctx.sym.qualifiedName }, () => this.walk(m));
        continue;
      }
    }
    this.cls = prev;
  }

  private collectMembers(members: Node[], ctx: ClassCtx): void {
    for (const m of members) {
      if (m.type === 'method_signature') {
        const sig = m.namedChildren.find((c): c is Node => !!c);
        const n = sig ? this.signatureName(sig) : null;
        if (n) ctx.methods.add(n);
      } else if (m.type === 'declaration') {
        const kids = m.namedChildren.filter((c): c is Node => !!c);
        const sig = kids.find((c) => SIGNATURES.has(c.type));
        if (sig) {
          const n = this.signatureName(sig);
          if (n) ctx.methods.add(n);
        } else {
          for (const list of kids.filter((c) => VAR_LISTS.has(c.type))) {
            for (const e of list.namedChildren) {
              const n = e?.type === 'identifier' ? e.text : e?.namedChildren.find((k) => k?.type === 'identifier')?.text;
              if (n) ctx.fields.add(n);
            }
          }
        }
      }
    }
  }

  /**
   * The member name of a signature: `constructor` for an unnamed
   * constructor, the second name for `Order.named`, `operator==` for an
   * operator overload.
   */
  private signatureName(sig: Node): string | null {
    switch (sig.type) {
      case 'constructor_signature': {
        const names = sig.childrenForFieldName('name').filter((n): n is Node => !!n);
        return names.length >= 2 ? names[names.length - 1]!.text : 'constructor';
      }
      case 'constant_constructor_signature':
      case 'factory_constructor_signature':
      case 'redirecting_factory_constructor_signature': {
        const ids = sig.namedChildren.filter((c) => c?.type === 'identifier');
        return ids.length >= 2 ? ids[ids.length - 1]!.text : 'constructor';
      }
      case 'function_signature':
      case 'getter_signature':
      case 'setter_signature':
        return sig.childForFieldName('name')?.text ?? sig.namedChildren.find((c) => c?.type === 'identifier')?.text ?? null;
      case 'operator_signature': {
        const op = sig.namedChildren.find(
          (c) => !!c && c.type !== 'type_identifier' && c.type !== 'type_arguments' && c.type !== 'nullable_type' && c.type !== 'void_type' && c.type !== 'function_type' && c.type !== 'formal_parameter_list',
        );
        return `operator${op ? op.text : ''}`;
      }
      default:
        return null;
    }
  }

  private memberSig(sig: Node, body: Node | undefined, ctx: ClassCtx, scope: Node, docNode: Node, extended: string | null, declKids: Node[] = []): void {
    const name = this.signatureName(sig);
    if (!name) {
      if (body) this.withScope({ name: ctx.sym.qualifiedName }, () => this.walk(body));
      return;
    }
    const sym = this.symbol(name, 'method', scope, !isPrivateName(name), extended ?? ctx.sym.qualifiedName);
    const doc = this.leadingDoc(docNode);
    if (doc) sym.doc = doc;
    if (body && this.isAsync(sig, body)) sym.async = true;
    sym.locals = {};
    this.addSymbol(sym);
    const declared = this.bindParams(sig, sym);
    this.declared.push(declared);
    this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => {
      for (const k of declKids) {
        if (k.type === 'initializers') this.initializers(k);
        else if (k.type === 'redirection') {
          const args = k.namedChildren.find((c) => c?.type === 'arguments');
          this.addRef('call', ['this'], k);
          if (args) for (const a of args.namedChildren) if (a?.type === 'argument' || a?.type === 'named_argument') this.argument(a);
        }
      }
      if (sig.type === 'redirecting_factory_constructor_signature') {
        const plist = sig.namedChildren.findIndex((c) => c?.type === 'formal_parameter_list');
        const target = sig.namedChildren.filter((c, i) => c?.type === 'type_identifier' && i > plist).map((t) => t!.text);
        if (target.length) this.addRef('new', target, sig);
      }
      if (body) this.walk(body);
    });
    this.declared.pop();
  }

  private initializers(node: Node): void {
    for (const e of node.namedChildren) {
      if (!e || e.type !== 'initializer_list_entry') continue;
      const kids = e.namedChildren.filter((c): c is Node => !!c);
      if (kids.some((c) => c.type === 'super')) {
        this.addRef('call', ['super'], e);
        const args = e.namedChildren.find((c) => c?.type === 'arguments');
        if (args) for (const a of args.namedChildren) if (a?.type === 'argument' || a?.type === 'named_argument') this.argument(a);
        continue;
      }
      const field = kids.find((c) => c.type === 'field_initializer');
      if (field) {
        const fkids = field.namedChildren.filter((c): c is Node => !!c);
        if (fkids.length > 1) this.sequence(fkids.slice(1), false);
        continue;
      }
      this.walk(e);
    }
  }

  private memberFields(_decl: Node, kids: Node[], ctx: ClassCtx, extended: string | null): void {
    void _decl;
    const type = singleType(kids);
    for (const list of kids.filter((c) => VAR_LISTS.has(c.type))) {
      for (const e of list.namedChildren) {
        if (!e) continue;
        let name: string | undefined;
        let vals: Node[] = [];
        if (e.type === 'identifier') name = e.text;
        else {
          const ekids = e.namedChildren.filter((c): c is Node => !!c);
          const idx = ekids.findIndex((c) => c.type === 'identifier');
          if (idx === -1) continue;
          name = ekids[idx]!.text;
          vals = ekids.slice(idx + 1);
        }
        if (!name) continue;
        if (extended) {
          // Extension static fields are symbols: there is no stored field to hang them on.
          const sym = this.symbol(name, 'variable', e, !isPrivateName(name), extended);
          if (type) sym.typeName = type;
          const inst = this.initInstance(vals);
          if (inst) sym.instanceOf = inst;
          else {
            const c = this.initCallTarget(vals);
            if (c) sym.initCall = c;
          }
          this.addSymbol(sym);
          if (vals.length) this.withScope({ name: sym.qualifiedName }, () => this.sequence(vals, false));
        } else {
          const f: FieldFact = { name };
          if (type) f.type = type;
          const inst = this.initInstance(vals);
          if (inst) f.instanceOf = inst;
          ctx.sym.fields!.push(f);
          if (vals.length) this.withScope({ name: ctx.sym.qualifiedName }, () => this.sequence(vals, false));
        }
      }
    }
  }

  /** Bind a signature's parameters as locals, walking default values in the symbol's scope. */
  private bindParams(sig: Node, sym: SymbolFact): Set<string> {
    const declared = new Set<string>();
    this.eachParam(
      sig,
      (p) => {
        const { name, type } = paramNameType(p);
        if (name) {
          declared.add(name);
          if (type && sym.locals) sym.locals[name] = type;
        }
      },
      (d) => this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => this.walk(d)),
    );
    return declared;
  }

  /** `async` / `async*` open the body (`sync*` does not count); the marker sits inside `function_body`. */
  private isAsync(sig: Node, body: Node): boolean {
    return /\basync\b/.test(this.text.slice(sig.endIndex, body.startIndex + 8));
  }

  /** Every parameter plus default-value sibling of a signature's parameter lists. */
  private eachParam(sig: Node, param: (p: Node) => void, def: (d: Node) => void): void {
    for (const list of sig.namedChildren.filter((c) => c?.type === 'formal_parameter_list')) {
      for (const p of list!.namedChildren) {
        if (!p) continue;
        if (p.type === 'formal_parameter') param(p);
        else if (p.type === 'optional_formal_parameters') {
          for (const q of p.namedChildren) {
            if (!q) continue;
            if (q.type === 'formal_parameter') param(q);
            else def(q);
          }
        } else def(p);
      }
    }
  }

  // ── references ───────────────────────────────────────────────────────────

  private isDeclared(name: string): boolean {
    return this.declared.some((s) => s.has(name));
  }

  /** Bare names that are fields or methods of the enclosing type become `this.x`. */
  private rootName(name: string): string[] {
    if (this.cls && !this.isDeclared(name) && (this.cls.fields.has(name) || this.cls.methods.has(name))) return ['this', name];
    return [name];
  }

  /** `Order(x)` and `p.Order(x)` construct; `order.save(x)` calls. */
  private callKind(callee: string[]): 'call' | 'new' {
    const last = callee[callee.length - 1]!;
    if (!/^_?[A-Z]/.test(last)) return 'call';
    const root = callee[0]!;
    if (root === 'this' || root === 'super') return 'call';
    if (callee.length === 1) return this.isNewCall(root) ? 'new' : 'call';
    return this.isTypeRoot(root) ? 'new' : 'call';
  }

  private isTypeRoot(name: string): boolean {
    return this.typeNames.has(name) || /^_?[A-Z]/.test(name);
  }

  private isNewCall(name: string): boolean {
    if (this.typeNames.has(name)) return true;
    const sym = this.symbolsByName.get(name);
    if (sym) return sym.kind !== 'function' && sym.kind !== 'method' && sym.kind !== 'variable';
    return /^_?[A-Z]/.test(name);
  }

  /** The constructed type of `new` / `const` object expressions. */
  private constType(node: Node): string | undefined {
    const tis = node.namedChildren.filter((c) => c?.type === 'type_identifier');
    return tis.length ? tis.map((t) => t!.text).join('.') : undefined;
  }

  /** Property reads, index reads and the call of one trailing selector. */
  private selectorParts(f: Node): { ids: string[]; index: Node | null; argPart: Node | null } {
    const out = { ids: [] as string[], index: null as Node | null, argPart: null as Node | null };
    const kids = f.type === 'selector' ? f.namedChildren : [f];
    for (const k of kids) {
      if (!k) continue;
      if (k.type === 'argument_part') out.argPart = k;
      else if (k.type === 'unconditional_assignable_selector' || k.type === 'conditional_assignable_selector') {
        for (const g of k.namedChildren) {
          if (!g) continue;
          if (g.type === 'identifier') out.ids.push(g.text);
          else if (g.type === 'index_selector') out.index = g;
        }
      }
    }
    return out;
  }

  private argNodes(argPart: Node): Node[] {
    const args = argPart.namedChildren.find((c) => c?.type === 'arguments');
    // Positional arguments wrap in `argument`; named ones sit bare.
    return args?.namedChildren.filter((c): c is Node => !!c && (c.type === 'argument' || c.type === 'named_argument')) ?? [];
  }

  /** A single-node argument value for literal capture (`f('x')` → 'x'). */
  private argValue(a: Node): Node | null {
    let kids = a.namedChildren.filter((c): c is Node => !!c);
    if (a.type === 'named_argument') kids = kids.filter((c) => c.type !== 'label');
    else if (kids.length === 1 && kids[0]!.type === 'named_argument') {
      kids = kids[0]!.namedChildren.filter((c): c is Node => !!c && c.type !== 'label');
    }
    return kids.length === 1 ? kids[0]! : null;
  }

  /**
   * Emit refs for a flat base-plus-selectors run. A run ending without a
   * call emits nothing — except as an argument or interpolation, where the
   * chain is a genuine use and emits a `ref`.
   */
  private sequence(parts: Node[], asArgument: boolean): void {
    const base = parts[0];
    if (!base) return;
    const followers = parts.slice(1);
    let cur: string[] | null = null;
    let sawCall = false;
    if (base.type === 'new_expression' || base.type === 'const_object_expression') {
      const t = this.constType(base);
      const argPart = base.namedChildren.find((c) => c?.type === 'arguments');
      const args = argPart?.namedChildren.filter((c): c is Node => !!c && (c.type === 'argument' || c.type === 'named_argument')) ?? [];
      if (t) this.addRef('new', t.split('.'), base, args.slice(0, 3).map((a) => literal(this.argValue(a))));
      for (const a of args) this.argument(a);
      cur = t ? [...t.split('.').slice(0, -1), `${t.split('.').pop()}()`] : null;
      sawCall = true;
    } else if (base.type === 'identifier' || base.type === 'identifier_dollar_escaped') {
      cur = this.rootName(base.text.replace(/^\$/, ''));
    } else if (base.type === 'this') {
      cur = ['this'];
    } else if (base.type === 'super') {
      cur = ['super'];
    } else {
      this.walk(base);
    }
    for (const f of followers) {
      if (f.type === 'cascade_section') {
        this.cascade(f, cur);
        continue;
      }
      const parsed = this.selectorParts(f);
      if (cur && parsed.ids.length && cur.length < MAX_CHAIN) cur.push(...parsed.ids.slice(0, MAX_CHAIN - cur.length));
      if (parsed.index) {
        for (const g of parsed.index.namedChildren) if (g) this.walk(g);
        if (cur && cur.length < MAX_CHAIN) cur.push('[]');
      }
      if (parsed.argPart) {
        const args = this.argNodes(parsed.argPart);
        if (cur) {
          const callee = [...cur];
          this.addRef(this.callKind(callee.map((s) => s.replace(/\(\)$/, ''))), callee, f, args.slice(0, 3).map((a) => literal(this.argValue(a))));
          sawCall = true;
        }
        for (const a of args) this.argument(a);
        if (cur && cur.length) cur[cur.length - 1] = `${cur[cur.length - 1]}()`;
      }
    }
    if (asArgument && !sawCall && cur && cur.length) this.addRef('ref', [...cur], base);
  }

  /** A cascade section applies to the original receiver, not the running chain. */
  private cascade(sec: Node, receiver: string[] | null): void {
    const kids = sec.namedChildren.filter((c): c is Node => !!c);
    const sel = kids.find((c) => c.type === 'cascade_selector');
    const id = sel?.namedChildren.find((c) => c?.type === 'identifier')?.text;
    const idx = sel?.namedChildren.find((c) => c?.type === 'index_selector');
    if (idx) for (const g of idx.namedChildren) if (g) this.walk(g);
    const argPart = kids.find((c) => c.type === 'argument_part');
    if (argPart) {
      const args = this.argNodes(argPart);
      if (receiver && id) {
        const callee = [...receiver, id];
        this.addRef(this.callKind(callee.map((s) => s.replace(/\(\)$/, ''))), callee, sec, args.slice(0, 3).map((a) => literal(this.argValue(a))));
      }
      for (const a of args) this.argument(a);
    } else {
      if (receiver && id) this.addRef('ref', [...receiver, id], sec);
      for (const k of kids) if (k !== sel) this.walk(k);
    }
  }

  /** The constructed type of an initializer: `Order(x)` → 'Order'. */
  private initInstance(parts: Node[]): string | undefined {
    const c = this.staticChain(parts);
    if (!c || !c.called) return undefined;
    const callee = c.parts.map((s) => s.replace(/\(\)$/, ''));
    return this.callKind(callee) === 'new' ? callee.join('.') : undefined;
  }

  /** The call target of an initializer: `load()` → 'load'. */
  private initCallTarget(parts: Node[]): string | undefined {
    const c = this.staticChain(parts);
    if (!c || !c.called) return undefined;
    const callee = c.parts.map((s) => s.replace(/\(\)$/, ''));
    return this.callKind(callee) === 'call' ? callee.join('.') : undefined;
  }

  private staticChain(parts: Node[]): { parts: string[]; called: boolean } | null {
    if (!parts.length) return null;
    const base = parts[0]!;
    if (base.type === 'new_expression' || base.type === 'const_object_expression') {
      const t = this.constType(base);
      return t ? { parts: t.split('.'), called: true } : null;
    }
    let cur: string[] | null = null;
    if (base.type === 'identifier' || base.type === 'identifier_dollar_escaped') cur = this.rootName(base.text.replace(/^\$/, ''));
    else if (base.type === 'this') cur = ['this'];
    else if (base.type === 'super') cur = ['super'];
    else return null;
    let called = false;
    for (const f of parts.slice(1)) {
      if (cur.length >= MAX_CHAIN) return null;
      const parsed = this.selectorParts(f);
      cur.push(...parsed.ids);
      if (parsed.index) cur.push('[]');
      if (parsed.argPart) {
        called = true;
        cur[cur.length - 1] = `${cur[cur.length - 1]}()`;
      }
    }
    return { parts: cur, called };
  }

  private argument(a: Node): void {
    let kids = a.namedChildren.filter((c): c is Node => !!c);
    if (a.type === 'named_argument') kids = kids.filter((c) => c.type !== 'label');
    else if (kids.length === 1 && kids[0]!.type === 'named_argument') {
      kids = kids[0]!.namedChildren.filter((c): c is Node => !!c && c.type !== 'label');
    }
    if (kids.length) this.sequence(kids, true);
  }

  /** Walk children grouped into selector runs; local signatures pair with their body. */
  private walkSeq(node: Node): void {
    this.blockKids(node.namedChildren.filter((c): c is Node => !!c));
  }

  private blockKids(kids: Node[]): void {
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if (k.type === 'function_signature' || k.type === 'getter_signature' || k.type === 'setter_signature') {
        const next = kids[i + 1];
        const body = next?.type === 'function_body' ? next : undefined;
        if (body) i++;
        this.localFunction(k, body);
        continue;
      }
      let j = i + 1;
      while (j < kids.length && isFollower(kids[j]!)) j++;
      if (j > i + 1) {
        this.sequence(kids.slice(i, j), false);
        i = j - 1;
      } else this.walk(k);
    }
  }

  /** A local function or closure body shares the enclosing scope; only its parameters are new. */
  private localFunction(sig: Node, body: Node | undefined): void {
    const declared = new Set<string>();
    const locals = this.scope().locals;
    this.eachParam(
      sig,
      (p) => {
        const { name, type } = paramNameType(p);
        if (name) {
          declared.add(name);
          if (locals && type && !locals[name]) locals[name] = type;
        }
      },
      (d) => this.walk(d),
    );
    if (!body) return;
    this.declared.push(declared);
    this.walk(body);
    this.declared.pop();
  }

  private closure(node: Node): void {
    const declared = new Set<string>();
    const locals = this.scope().locals;
    this.eachParam(
      node,
      (p) => {
        const { name, type } = paramNameType(p);
        if (name) {
          declared.add(name);
          if (locals && type && !locals[name]) locals[name] = type;
        }
      },
      (d) => this.walk(d),
    );
    const body = node.namedChildren.find((c) => c?.type === 'function_expression_body');
    this.declared.push(declared);
    if (body) this.walk(body);
    this.declared.pop();
  }

  private localVar(def: Node): void {
    const kids = def.namedChildren.filter((c): c is Node => !!c);
    const nameNode = def.childForFieldName('name') ?? kids.find((c) => c.type === 'identifier');
    const values = def.childrenForFieldName('value').filter((v): v is Node => !!v);
    const vals = values.length ? values : nameNode ? kids.slice(kids.indexOf(nameNode) + 1) : [];
    const name = nameNode?.text;
    if (!name) {
      if (vals.length) this.sequence(vals, false);
      return;
    }
    this.declared[this.declared.length - 1]?.add(name);
    const locals = this.scope().locals;
    if (locals) {
      const t = singleType(kids);
      if (t) locals[name] = t;
      else {
        const inst = this.initInstance(vals);
        if (inst) locals[name] = inst;
        else {
          const c = this.initCallTarget(vals);
          if (c) locals[name] = `call:${c}`;
        }
      }
    }
    if (vals.length) this.sequence(vals, false);
  }

  private patternVar(decl: Node): void {
    const kids = decl.namedChildren.filter((c): c is Node => !!c);
    const pi = kids.findIndex((c) => c.type.endsWith('_pattern'));
    const pattern = pi === -1 ? undefined : kids[pi];
    if (pattern) {
      for (const id of pattern.descendantsOfType('identifier')) {
        if (id?.text) this.declared[this.declared.length - 1]?.add(id.text);
      }
    }
    const vals = pi === -1 ? [] : kids.slice(pi + 1);
    if (vals.length) this.sequence(vals, false);
  }

  private forStatement(node: Node): void {
    const parts = node.namedChildren.find((c) => c?.type === 'for_loop_parts');
    const declared = new Set<string>();
    this.declared.push(declared);
    if (parts) {
      for (const f of ['init', 'condition', 'update'] as const) {
        const n = parts.childForFieldName(f);
        if (n) this.walk(n);
      }
      const nm = parts.childForFieldName('name')?.text;
      if (nm) {
        declared.add(nm);
        const t = singleType(parts.namedChildren.filter((c): c is Node => !!c));
        const locals = this.scope().locals;
        if (t && locals) locals[nm] = t;
      }
      const values = parts.childrenForFieldName('value').filter((v): v is Node => !!v);
      if (values.length) this.sequence(values, false);
    }
    for (const c of node.namedChildren) if (c && c !== parts) this.walk(c);
    this.declared.pop();
  }

  /** Pattern bindings of an `if-case` or `switch` case, excluding nested closures and switches. */
  private caseBindings(node: Node): string[] {
    const names: string[] = [];
    const visit = (n: Node): void => {
      for (const c of n.namedChildren) {
        if (!c) continue;
        if (c.type === 'switch_statement' || c.type === 'function_expression' || c.type === 'function_body') continue;
        if (c.type === 'variable_pattern') {
          const id = c.namedChildren.find((k) => k?.type === 'identifier')?.text;
          if (id) names.push(id);
        }
        visit(c);
      }
    };
    visit(node);
    return names;
  }

  private walk(node: Node): void {
    switch (node.type) {
      case 'argument':
      case 'named_argument':
        return this.argument(node);
      case 'template_substitution': {
        const kids = node.namedChildren.filter((c): c is Node => !!c);
        if (kids.length) this.sequence(kids, true);
        return;
      }
      case 'function_expression':
        return this.closure(node);
      case 'function_signature':
      case 'getter_signature':
      case 'setter_signature':
        return;
      case 'local_variable_declaration':
        for (const c of node.namedChildren) {
          if (c?.type === 'initialized_variable_definition') this.localVar(c);
          else if (c?.type === 'pattern_variable_declaration') this.patternVar(c);
        }
        return;
      case 'for_statement':
        return this.forStatement(node);
      case 'catch_clause': {
        const names: string[] = [];
        for (const cp of node.namedChildren) {
          if (cp?.type !== 'catch_parameters') continue;
          for (const id of cp.namedChildren) if (id?.type === 'identifier') names.push(id.text);
        }
        this.declared.push(new Set(names));
        this.walkSeq(node);
        this.declared.pop();
        return;
      }
      case 'if_statement':
      case 'switch_statement_case': {
        this.declared.push(new Set(this.caseBindings(node)));
        this.walkSeq(node);
        this.declared.pop();
        return;
      }
      case 'class_definition':
      case 'mixin_declaration':
      case 'enum_declaration':
      case 'extension_declaration':
      case 'extension_type_declaration':
      case 'type_alias': {
        // Local type: no symbol, but bodies may hold calls.
        const body = node.namedChildren.find((c) => !!c && (c.type === 'class_body' || c.type === 'enum_body' || c.type === 'extension_body'));
        if (body) this.walk(body);
        return;
      }
      default:
        return this.walkSeq(node);
    }
  }
}
