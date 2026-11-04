/**
 * Kotlin language adapter.
 *
 * Records the package, imports (with aliases and wildcards), classes /
 * objects / interfaces / enums with primary-constructor fields, function
 * call references, Spring MVC / JAX-RS / Micronaut routes, Ktor routing
 * blocks, and JPA / Room / Exposed models. Bare field and method names
 * inside a class become `this.x` so the graph resolves them through
 * field types.
 *
 * Grammar quirk: @tree-sitter-grammars/tree-sitter-kotlin (inherited from
 * fwcd/tree-sitter-kotlin) misparses a top-level class, interface or enum
 * with two or more stacked annotations whenever another declaration
 * follows it. The annotations detach into `annotated_expression`
 * siblings — either leaving a bare declaration behind, or swallowing the
 * class into an `infix_expression` — with no parse error. Real Spring
 * files (`@RestController` + `@RequestMapping`) always hit this, so the
 * adapter re-attaches floating annotations to the declaration that
 * follows them, and re-parses a swallowed class from its own source span
 * (single declarations parse correctly) with lines shifted back.
 */
import type { Node } from 'web-tree-sitter';
import type { ArgFact, FieldFact, ImportFact, ModelFact, SourceLanguage, SymbolFact, SymbolKind } from '@eyrie/core';
import { BaseExtractor, joinRoute, line } from './base.js';

const MAX_CHAIN = 6;
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
const KTOR_VERBS: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', patch: 'PATCH', head: 'HEAD', options: 'OPTIONS' };
// `@MappedSuperclass` (BaseEntity) shares columns but is not a table itself.
const ENTITY = new Set(['Entity', 'Document', 'Table']);
const RELATION = new Set(['ManyToOne', 'OneToMany', 'OneToOne', 'ManyToMany', 'DBRef']);
const WRAPPERS = new Set(['List', 'Set', 'Collection', 'Optional', 'Iterable', 'Mono', 'Flux', 'CompletableFuture', 'Page', 'MutableList', 'MutableSet', 'Array']);
const EXPOSED_TABLES = new Set(['Table', 'IdTable', 'LongIdTable', 'IntIdTable', 'UUIDTable']);
const EXPOSED_REFS = new Set(['reference', 'optReference']);

/** Strip one layer of quotes (single, double or triple-double) from a literal. */
function unquoteLiteral(text: string): string {
  const t = text.trim();
  if (t.startsWith('"""') && t.endsWith('"""') && t.length >= 6) return t.slice(3, -3);
  if (((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) && t.length >= 2) return t.slice(1, -1);
  return t;
}

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'string_literal') return unquoteLiteral(n.text);
  if (n.type === 'collection_literal') {
    for (const c of n.namedChildren) {
      const s = stringValue(c);
      if (s !== null) return s;
    }
  }
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

/** `List<Order>` → 'List' (or 'Order' with `unwrap`), `a.Order?` → 'a.Order'. */
function typeRoot(n: Node | null | undefined, unwrap = false): string | undefined {
  if (!n) return undefined;
  switch (n.type) {
    case 'identifier':
      return n.text;
    case 'user_type': {
      const kids = n.namedChildren.filter((c): c is Node => !!c);
      // Qualified names are sibling identifiers: `a.Order` → 'a.Order'.
      const segments = kids.filter((c) => c.type === 'identifier').map((c) => c.text);
      if (unwrap && segments.length === 1 && WRAPPERS.has(segments[0]!)) {
        const args = kids.find((c) => c.type === 'type_arguments');
        const proj = args?.namedChildren.find((c) => c?.type === 'type_projection');
        return typeRoot(proj?.namedChildren.find((c) => !!c && c.type !== 'identifier') ?? proj?.namedChildren[0], true);
      }
      return segments.length ? segments.join('.') : undefined;
    }
    case 'nullable_type':
    case 'parenthesized_type':
      return typeRoot(
        n.namedChildren.find((c) => !!c && c.type !== 'identifier') ?? n.namedChildren[0],
        unwrap,
      );
    case 'type':
      return typeRoot(n.namedChildren[0], unwrap);
    default:
      return undefined;
  }
}

interface Annotation {
  name: string;
  args: Node | null;
}

function annotationOf(node: Node): Annotation | null {
  const inner = node.namedChildren.find((c): c is Node => !!c && (c.type === 'constructor_invocation' || c.type === 'user_type' || c.type === 'type'));
  if (!inner) return null;
  if (inner.type === 'constructor_invocation') {
    const t = inner.namedChildren.find((c) => c?.type === 'user_type' || c?.type === 'type' || c?.type === 'identifier');
    const name = (typeRoot(t) ?? t?.text ?? '').split('.').pop();
    if (!name) return null;
    return { name, args: inner.namedChildren.find((c) => c?.type === 'value_arguments') ?? null };
  }
  const name = (typeRoot(inner) ?? inner.text).split('.').pop()!;
  return { name, args: null };
}

function annotationsOf(modifiers: Node | null | undefined): Annotation[] {
  if (!modifiers || modifiers.type !== 'modifiers') return [];
  const out: Annotation[] = [];
  for (const a of modifiers.namedChildren) {
    if (a?.type !== 'annotation') continue;
    const ann = annotationOf(a);
    if (ann) out.push(ann);
  }
  return out;
}

/** The value of a `value_argument`: the expression, skipping a `name =` prefix. */
function argumentValue(arg: Node): Node | null {
  const kids = arg.namedChildren.filter((c): c is Node => !!c);
  if (kids.length === 2 && kids[0]!.type === 'identifier' && arg.text.includes('=')) return kids[1]!;
  return kids[0] ?? null;
}

/** `@X("/a")`, `@X(value = "/a")`, `@X(path = ["/a"])` → '/a'. */
function annotationString(args: Node | null, keys = ['value', 'path']): string | undefined {
  for (const a of args?.namedChildren ?? []) {
    if (!a || a.type !== 'value_argument') continue;
    const kids = a.namedChildren.filter((c): c is Node => !!c);
    const named = kids.length === 2 && kids[0]!.type === 'identifier' && a.text.includes('=');
    if (!named) {
      const direct = stringValue(kids[0]);
      if (direct !== null) return direct;
    } else if (keys.includes(kids[0]!.text)) {
      const v = stringValue(kids[1]);
      if (v !== null) return v;
    }
  }
  return undefined;
}

function isPrivate(modifiers: Node | null | undefined): boolean {
  return !!modifiers && /\bprivate\b/.test(modifiers.text);
}

/** `Ktor "/orders/{id}"` and `"/orders/$id"` → '/orders/:id'. */
function ktorPath(path: string): string {
  return path.replace(/\$\{(\w+)\}|\$(\w+)/g, ':$1$2');
}

interface ClassCtx {
  sym: SymbolFact;
  fields: Set<string>;
  methods: Set<string>;
  exposedTable: boolean;
}

export class KotlinExtractor extends BaseExtractor {
  private cls: ClassCtx | null = null;
  private declared: Set<string>[] = [];
  private ktorPrefixes: string[] = [];
  private routePrefix: string | undefined;
  private readonly text: string;
  /** Simple names of every type declared in the file, collected before visiting. */
  private typeNames = new Set<string>();

  constructor(path: string, language: SourceLanguage, hash: string, source: string) {
    super(path, language, hash, source);
    this.text = source;
  }

  protected visitRoot(root: Node): void {
    this.collectTypeNames(root);
    const kids = root.namedChildren.filter((c): c is Node => !!c);
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]!;
      if (child.type === 'package_header') {
        const id = child.namedChildren.find((c) => c?.type === 'qualified_identifier' || c?.type === 'identifier');
        if (id) this.facts.namespace = id.text;
      } else if (child.type === 'import') this.importDecl(child);
      else if (child.type === 'file_annotation' || child.type === 'shebang') continue;
      else if (child.type === 'annotated_expression') i = this.floatingAnnotations(kids, i);
      else this.topLevel(child, []);
    }
  }

  private collectTypeNames(node: Node): void {
    for (const c of node.namedChildren) {
      if (!c) continue;
      if (c.type === 'class_declaration' || c.type === 'object_declaration') {
        const n = c.childForFieldName('name')?.text;
        if (n) this.typeNames.add(n);
      } else if (c.type === 'type_alias') {
        const n = c.childForFieldName('type')?.text;
        if (n) this.typeNames.add(n);
      } else if (c.type === 'companion_object') {
        const n = c.childForFieldName('name')?.text;
        if (n) this.typeNames.add(n);
      }
      this.collectTypeNames(c);
    }
  }

  /**
   * Kotlin has no `new`: `Order(x)` is a call. A bare call constructs when
   * its name is a declared type, an imported (Uppercase) name, or — for
   * same-package types — any Uppercase name.
   */
  private isNewCall(name: string): boolean {
    if (this.typeNames.has(name)) return true;
    const sym = this.symbolsByName.get(name);
    if (sym) return sym.kind !== 'function' && sym.kind !== 'method' && sym.kind !== 'variable';
    if (this.facts.imports.some((i) => i.specifiers.some((s) => s.local === name))) return /^[A-Z]/.test(name);
    return /^[A-Z]/.test(name);
  }

  private topLevel(node: Node, extraAnns: Annotation[]): void {
    switch (node.type) {
      case 'class_declaration':
        return this.typeDecl(node, undefined, extraAnns);
      case 'object_declaration':
        return this.typeDecl(node, undefined, extraAnns);
      case 'function_declaration':
        return this.functionDecl(node, undefined, extraAnns);
      case 'property_declaration':
        return this.topProperty(node);
      case 'type_alias': {
        const name = node.childForFieldName('type')?.text ?? node.namedChildren.find((c) => c?.type === 'identifier')?.text;
        if (!name) return;
        const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
        const sym = this.symbol(name, 'type', node, !isPrivate(mods));
        const doc = this.leadingDoc(node);
        if (doc) sym.doc = doc;
        this.addSymbol(sym);
        return;
      }
      default:
        return;
    }
  }

  /**
   * A top-level `annotated_expression` is always the stacked-annotation
   * misparse (valid files attach annotations in `modifiers`). Either the
   * declaration survived as the next sibling (re-attach), or it dissolved
   * into an infix (re-parse its span). Returns the index consumed through.
   */
  private floatingAnnotations(kids: Node[], at: number): number {
    const spine: Annotation[] = [];
    let terminal: Node | null = kids[at]!;
    // Walk down the nested annotated_expression spine.
    while (terminal && terminal.type === 'annotated_expression') {
      const inner: Node[] = terminal.namedChildren.filter((c): c is Node => !!c);
      const ann = inner.find((c) => c.type === 'annotation');
      if (ann) {
        const parsed = annotationOf(ann);
        if (parsed) spine.push(parsed);
      }
      terminal = inner.find((c) => c.type !== 'annotation') ?? null;
    }
    if (!terminal) return at;
    // Swallowed declaration: `open class A { ... }` as infix operands + body.
    if (terminal.type === 'infix_expression') {
      this.recoverSwallowed(kids[at]!, terminal, spine);
      return at;
    }
    // Detached annotations: `@X("/a")` split, the declaration follows as sibling.
    if (terminal.type === 'parenthesized_expression') {
      const next = kids[at + 1];
      if (next && (next.type === 'class_declaration' || next.type === 'object_declaration' || next.type === 'function_declaration')) {
        const str = terminal.namedChildren.find((c) => c?.type === 'string_literal');
        if (str && spine.length && spine[spine.length - 1]!.args === null) {
          spine[spine.length - 1] = { name: spine[spine.length - 1]!.name, args: null, splitArg: unquoteLiteral(str.text) } as Annotation;
        }
        this.topLevel(next, spine);
        return at + 1;
      }
    }
    this.facts.parseErrors += 1;
    return at;
  }

  /**
   * Re-parse a swallowed declaration from its own source span: from the
   * first operand through the outermost lambda (the body braces). Slicing
   * preserves newlines, so shifting by the start row restores file lines.
   */
  private recoverSwallowed(floatNode: Node, infix: Node, spine: Annotation[]): void {
    if (!this.reparseSnippet) {
      this.facts.parseErrors += 1;
      return;
    }
    const start = infix.namedChildren.find((c): c is Node => !!c);
    const body = infix.descendantsOfType('lambda_literal')[0];
    if (!start || !body) {
      this.facts.parseErrors += 1;
      return;
    }
    const snippet = this.text.slice(start.startIndex, body.endIndex);
    if (!/^\s*(?:\w+\s+)*(class|interface|enum|object)\b/.test(snippet)) {
      this.facts.parseErrors += 1;
      return;
    }
    const startRow = start.startPosition.row;
    const reparse = this.reparseSnippet;
    const recovered = reparse(snippet, (root) => {
      const decl = root.namedChildren.find((c): c is Node => !!c && (c.type === 'class_declaration' || c.type === 'object_declaration'));
      if (!decl) return null;
      const sub = new KotlinExtractor(this.facts.path, this.facts.language, this.facts.hash, snippet);
      sub.reparseSnippet = reparse;
      sub.typeDecl(decl, undefined, spine);
      return sub.facts;
    });
    if (!recovered || !recovered.symbols.length) {
      this.facts.parseErrors += 1;
      return;
    }
    const doc = this.leadingDoc(floatNode);
    if (doc && !recovered.symbols[0]!.doc) recovered.symbols[0]!.doc = doc;
    this.mergeShifted(recovered, startRow);
  }

  private get sourceText(): string {
    return this.text;
  }

  /** Merge a re-parsed snippet's facts, shifting lines back to file rows. */
  private mergeShifted(facts: { symbols: SymbolFact[]; references: { line: number }[]; routes: { line: number }[]; models?: ModelFact[] | undefined }, deltaRow: number): void {
    for (const s of facts.symbols) {
      s.startLine += deltaRow;
      s.endLine += deltaRow;
      this.addSymbol(s);
    }
    for (const r of facts.references) {
      r.line += deltaRow;
      this.facts.references.push(r as (typeof this.facts.references)[number]);
    }
    for (const r of facts.routes) {
      r.line += deltaRow;
      this.facts.routes.push(r as (typeof this.facts.routes)[number]);
    }
    for (const m of facts.models ?? []) {
      m.line += deltaRow;
      m.endLine += deltaRow;
      (this.facts.models ??= []).push(m);
    }
  }

  private importDecl(node: Node): void {
    const kids = node.namedChildren.filter((c): c is Node => !!c);
    const path = kids.find((c) => c.type === 'qualified_identifier');
    if (!path) return;
    const name = path.text;
    const wildcard = node.text.trimEnd().endsWith('*');
    const imp: ImportFact = { source: name, line: line(node), typeOnly: false, specifiers: [] };
    if (wildcard) {
      imp.wildcard = true;
    } else {
      const alias = kids.length > 1 ? kids[kids.length - 1]!.text : undefined;
      const simple = name.split('.').pop()!;
      imp.specifiers.push({ imported: simple, local: alias ?? simple });
    }
    this.facts.imports.push(imp);
  }

  /** Keyword region between modifiers and name: `enum`, `interface`, `annotation`, or plain class. */
  private classKind(node: Node): SymbolKind {
    const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
    const nameNode = node.childForFieldName('name');
    const from = mods ? mods.endIndex : node.startIndex;
    const head = `${mods?.text ?? ''} ${this.sourceText.slice(from, nameNode ? nameNode.startIndex : node.endIndex)}`;
    if (/\benum\b/.test(head)) return 'enum';
    if (/\binterface\b/.test(head) || /\bannotation\b/.test(head)) return 'interface';
    return 'class';
  }

  private typeDecl(node: Node, parent: ClassCtx | undefined, extraAnns: Annotation[] = []): void {
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text;
    if (!name) return;
    const isObject = node.type === 'object_declaration';
    const kind = isObject ? 'class' : this.classKind(node);
    const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
    const sym = this.symbol(name, kind, node, !isPrivate(mods), parent?.sym.qualifiedName);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    const { superclass, ifaces } = this.supertypes(node);
    if (kind === 'interface') {
      if (ifaces.length) sym.extends = ifaces;
    } else {
      if (superclass) sym.extends = [superclass];
      if (ifaces.length) sym.implements = ifaces;
    }
    sym.fields = [];
    this.addSymbol(sym);

    const anns = [...extraAnns, ...annotationsOf(mods)];
    const body = node.namedChildren.find((c) => c?.type === 'class_body' || c?.type === 'enum_class_body');
    const ctx: ClassCtx = { sym, fields: new Set(), methods: new Set(), exposedTable: false };
    if (isObject && superclass && EXPOSED_TABLES.has(superclass.split('.').pop() ?? '')) ctx.exposedTable = true;
    const prefix = this.classRoutePrefix(anns);
    const model: ModelFact | null = this.classModel(node, name, sym, anns, ctx);

    // Primary-constructor `val`/`var` parameters are fields.
    const ctor = node.namedChildren.find((c) => c?.type === 'primary_constructor');
    const params = ctor?.namedChildren.find((c) => c?.type === 'class_parameters');
    for (const p of params?.namedChildren ?? []) {
      if (p?.type !== 'class_parameter') continue;
      const id = p.namedChildren.find((c) => c?.type === 'identifier');
      if (!id) continue;
      if (new RegExp(`\\b(val|var)\\s+${id.text}\\b`).test(p.text)) {
        const typeNode = p.namedChildren.find((c) => c?.type === 'type' || c?.type === 'user_type' || c?.type === 'nullable_type');
        const t = typeRoot(typeNode);
        sym.fields.push(t ? { name: id.text, type: t } : { name: id.text });
        ctx.fields.add(id.text);
        if (model) model.fields.push(id.text);
        const panns = annotationsOf(p.namedChildren.find((c) => c?.type === 'modifiers'));
        if (model && panns.some((a) => RELATION.has(a.name))) {
          const rel = t && WRAPPERS.has(t.split('.').pop() ?? '') ? typeRoot(typeNode, true) : t;
          if (rel && !model.relations.includes(rel)) model.relations.push(rel);
        }
      }
      const def = p.namedChildren.find((c) => c?.type === 'expression');
      if (def) this.withScope({ name: sym.qualifiedName }, () => this.walk(def));
    }

    // Collect fields and methods before walking bodies, so bare names resolve to `this.x`.
    const members = body?.namedChildren.filter((c): c is Node => !!c) ?? [];
    for (const m of members) {
      if (m.type === 'property_declaration') {
        for (const v of m.namedChildren.filter((c) => c?.type === 'variable_declaration')) {
          const n = v.namedChildren.find((c) => c?.type === 'identifier')?.text;
          if (n) ctx.fields.add(n);
        }
      } else if (m.type === 'function_declaration') {
        const n = m.childForFieldName('name')?.text;
        if (n) ctx.methods.add(n);
      } else if (m.type === 'companion_object') {
        for (const c of m.namedChildren.find((c) => c?.type === 'class_body')?.namedChildren ?? []) {
          if (c?.type === 'property_declaration') {
            for (const v of c.namedChildren.filter((c) => c?.type === 'variable_declaration')) {
              const n = v.namedChildren.find((c) => c?.type === 'identifier')?.text;
              if (n) ctx.fields.add(n);
            }
          } else if (c?.type === 'function_declaration') {
            const n = c.childForFieldName('name')?.text;
            if (n) ctx.methods.add(n);
          }
        }
      }
    }

    const prev = this.cls;
    const prevPrefix = this.routePrefix;
    this.cls = ctx;
    this.routePrefix = prefix ?? prevPrefix;
    for (const m of members) {
      if (m.type === 'class_declaration' || m.type === 'object_declaration') this.typeDecl(m, ctx);
      else if (m.type === 'property_declaration') this.memberProperty(m, sym, model, ctx);
      else if (m.type === 'function_declaration') this.functionDecl(m, ctx);
      else if (m.type === 'secondary_constructor') this.secondaryCtor(m, sym);
      else if (m.type === 'companion_object') this.companion(m, ctx);
      else if (m.type === 'anonymous_initializer') this.withScope({ name: sym.qualifiedName }, () => this.walk(m));
      else if (m.type === 'enum_entry') this.enumEntry(m, sym);
    }
    this.cls = prev;
    this.routePrefix = prevPrefix;
    if (model) (this.facts.models ??= []).push(model);
  }

  private supertypes(node: Node): { superclass?: string; ifaces: string[] } {
    let superclass: string | undefined;
    const ifaces: string[] = [];
    const specs = node.namedChildren.find((c) => c?.type === 'delegation_specifiers');
    for (const s of specs?.namedChildren ?? []) {
      if (s?.type !== 'delegation_specifier') continue;
      const ctor = s.namedChildren.find((c) => c?.type === 'constructor_invocation');
      if (ctor) {
        const t = typeRoot(ctor.namedChildren.find((c) => c?.type === 'user_type' || c?.type === 'type'));
        if (t && !superclass) superclass = t;
        continue;
      }
      const t = typeRoot(s.namedChildren.find((c) => c?.type === 'user_type' || c?.type === 'type'));
      if (t) ifaces.push(t);
    }
    return { superclass, ifaces };
  }

  private classRoutePrefix(anns: Annotation[]): string | undefined {
    for (const a of anns) {
      if (a.name === 'RequestMapping' || a.name === 'Path' || a.name === 'Controller') {
        const p = a.args ? annotationString(a.args) : (a as unknown as { splitArg?: string }).splitArg;
        if (p !== undefined) return p;
      }
    }
    return undefined;
  }

  private classModel(node: Node, name: string, sym: SymbolFact, anns: Annotation[], ctx: ClassCtx): ModelFact | null {
    if (anns.some((a) => ENTITY.has(a.name))) {
      const room = this.facts.imports.some((i) => i.source.startsWith('androidx.room'));
      return { name, line: sym.startLine, endLine: sym.endLine, fields: [], relations: [], orm: room ? 'room' : 'jpa', symbol: sym.qualifiedName };
    }
    if (ctx.exposedTable) {
      return { name, line: sym.startLine, endLine: sym.endLine, fields: [], relations: [], orm: 'exposed', symbol: sym.qualifiedName };
    }
    void node;
    return null;
  }

  private memberProperty(node: Node, owner: SymbolFact, model: ModelFact | null, ctx: ClassCtx): void {
    const vars = node.namedChildren.filter((c) => c?.type === 'variable_declaration');
    const init = node.namedChildren.find((c) => !!c && c.type !== 'variable_declaration' && c.type !== 'modifiers' && c.type !== 'getter' && c.type !== 'setter' && c.type !== 'property_delegate');
    const delegate = node.namedChildren.find((c) => c?.type === 'property_delegate');
    for (const v of vars) {
      const n = v.namedChildren.find((c) => c?.type === 'identifier')?.text;
      if (!n) continue;
      const t = typeRoot(v.namedChildren.find((c) => c?.type === 'type' || c?.type === 'user_type' || c?.type === 'nullable_type'));
      const f: FieldFact = { name: n };
      if (t) f.type = t;
      const inst = this.initInstance(init);
      if (inst) f.instanceOf = inst;
      owner.fields!.push(f);
      if (model && !ctx.exposedTable) model.fields.push(n);
      if (model && ctx.exposedTable) {
        model.fields.push(n);
        const ref = this.exposedReference(init);
        if (ref && !model.relations.includes(ref)) model.relations.push(ref);
      }
      const anns = annotationsOf(node.namedChildren.find((c) => c?.type === 'modifiers'));
      if (model && !ctx.exposedTable && anns.some((a) => RELATION.has(a.name))) {
        const rel = t && WRAPPERS.has(t.split('.').pop() ?? '') ? typeRoot(v.namedChildren.find((c) => c?.type === 'type' || c?.type === 'user_type' || c?.type === 'nullable_type'), true) : t;
        if (rel && !model.relations.includes(rel)) model.relations.push(rel);
      }
    }
    this.withScope({ name: owner.qualifiedName }, () => {
      if (init) this.walk(init);
      if (delegate) this.walk(delegate);
      for (const acc of node.namedChildren.filter((c) => c?.type === 'getter' || c?.type === 'setter')) {
        const param = acc.namedChildren.find((c) => c?.type === 'identifier');
        if (acc.type === 'setter' && param) {
          this.declared.push(new Set([param.text]));
          this.walk(acc);
          this.declared.pop();
        } else this.walk(acc);
      }
    });
  }

  /** `reference("col", OtherTable)` inside an Exposed table → relation to OtherTable. */
  private exposedReference(init: Node | undefined): string | undefined {
    if (init?.type !== 'call_expression') return undefined;
    const { callee } = this.callParts(init);
    const name = callee?.type === 'identifier' ? callee.text : undefined;
    if (!name || !EXPOSED_REFS.has(name)) return undefined;
    const args = init.namedChildren.find((c) => c?.type === 'value_arguments')?.namedChildren.filter((c): c is Node => !!c && c.type === 'value_argument') ?? [];
    const target = args.length >= 2 ? argumentValue(args[1]!) : null;
    return target?.type === 'identifier' ? target.text : undefined;
  }

  private secondaryCtor(node: Node, owner: SymbolFact): void {
    const sym = this.symbol('constructor', 'method', node, true, owner.qualifiedName);
    sym.locals = {};
    this.addSymbol(sym);
    const declared = new Set<string>();
    for (const p of node.namedChildren.find((c) => c?.type === 'function_value_parameters')?.namedChildren ?? []) {
      if (p?.type !== 'parameter') continue;
      const pn = p.namedChildren.find((c) => c?.type === 'identifier')?.text;
      const t = typeRoot(p.namedChildren.find((c) => c?.type === 'type' || c?.type === 'user_type' || c?.type === 'nullable_type'));
      if (!pn) continue;
      declared.add(pn);
      if (t) sym.locals[pn] = t;
    }
    const body = node.namedChildren.find((c) => c?.type === 'block');
    if (body) {
      this.declared.push(declared);
      this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => this.walk(body));
      this.declared.pop();
    }
  }

  private companion(node: Node, ctx: ClassCtx): void {
    const name = node.childForFieldName('name')?.text;
    const body = node.namedChildren.find((c) => c?.type === 'class_body');
    if (!body) return;
    if (name) {
      // A named companion is its own nested type: `Owner.Foo.member`.
      const sym = this.symbol(name, 'class', node, true, ctx.sym.qualifiedName);
      sym.fields = [];
      this.addSymbol(sym);
      const sub: ClassCtx = { sym, fields: new Set(), methods: new Set(), exposedTable: false };
      const prev = this.cls;
      this.cls = sub;
      for (const m of body.namedChildren) {
        if (!m) continue;
        if (m.type === 'property_declaration') this.memberProperty(m, sym, null, sub);
        else if (m.type === 'function_declaration') this.functionDecl(m, sub);
      }
      this.cls = prev;
      return;
    }
    // An unnamed companion's members are called on the owner directly.
    for (const m of body.namedChildren) {
      if (!m) continue;
      if (m.type === 'property_declaration') this.memberProperty(m, ctx.sym, null, ctx);
      else if (m.type === 'function_declaration') this.functionDecl(m, ctx);
    }
  }

  private enumEntry(node: Node, owner: SymbolFact): void {
    const body = node.namedChildren.find((c) => c?.type === 'class_body');
    if (!body) return;
    for (const m of body.namedChildren) {
      if (!m) continue;
      if (m.type === 'function_declaration') this.functionDecl(m, { sym: owner, fields: new Set(), methods: new Set(), exposedTable: false });
    }
  }

  private functionDecl(node: Node, owner: ClassCtx | undefined, extraAnns: Annotation[] = []): void {
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text;
    if (!name) return;
    const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
    // Extension function: the `user_type` before the name is the receiver.
    const kids = node.namedChildren.filter((c): c is Node => !!c);
    // Node wrappers are fresh objects: compare positions, not identity.
    const nameIdx = kids.findIndex((c) => c.startIndex === nameNode.startIndex && c.endIndex === nameNode.endIndex);
    const receiver = kids
      .slice(0, nameIdx === -1 ? 0 : nameIdx)
      .reverse()
      .find((c) => c.type === 'user_type' || c.type === 'nullable_type');
    const receiverRoot = typeRoot(receiver);
    const parent = receiverRoot ?? owner?.sym.qualifiedName;
    const sym = this.symbol(name, parent ? 'method' : 'function', node, !isPrivate(mods), parent);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    if (mods && /\bsuspend\b/.test(mods.text)) sym.async = true;
    sym.locals = {};
    this.addSymbol(sym);
    const declared = new Set<string>();
    for (const p of node.namedChildren.find((c) => c?.type === 'function_value_parameters')?.namedChildren ?? []) {
      if (p?.type !== 'parameter') continue;
      const pn = p.namedChildren.find((c) => c?.type === 'identifier')?.text;
      const t = typeRoot(p.namedChildren.find((c) => c?.type === 'type' || c?.type === 'user_type' || c?.type === 'nullable_type'));
      if (!pn) continue;
      declared.add(pn);
      if (t) sym.locals[pn] = t;
    }
    const anns = [...extraAnns, ...annotationsOf(mods)];
    this.methodRoutes(node, sym, owner ? this.routePrefix : undefined, anns);
    // `fun Route.orders() { get(...) }` is a Ktor routing scope without a `routing` call.
    const ktorScope = !owner && (receiverRoot === 'Route' || receiverRoot === 'Routing' || receiverRoot === 'RouteGroup');
    if (ktorScope) this.ktorPrefixes.push('');
    const body = node.namedChildren.find((c) => c?.type === 'function_body');
    if (body) {
      this.declared.push(declared);
      this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => this.walk(body));
      this.declared.pop();
    }
    if (ktorScope) this.ktorPrefixes.pop();
  }

  private methodRoutes(node: Node, sym: SymbolFact, prefix: string | undefined, anns: Annotation[]): void {
    let jaxPath: string | undefined;
    const jaxVerbs: string[] = [];
    for (const a of anns) {
      const verb = SPRING_VERBS[a.name];
      if (verb || a.name === 'RequestMapping') {
        const path = a.args ? (annotationString(a.args) ?? '') : ((a as unknown as { splitArg?: string }).splitArg ?? '');
        let methods = verb ? [verb] : [];
        if (!verb) {
          methods = (a.args?.text.match(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g) ?? ['ANY']) as string[];
        }
        for (const method of methods) {
          this.addRoute({ method, path: joinRoute(prefix, path), line: line(node), router: 'spring', handlers: [sym.qualifiedName], framework: 'spring' });
        }
      } else if (a.name === 'Path') jaxPath = a.args ? annotationString(a.args) : ((a as unknown as { splitArg?: string }).splitArg ?? undefined);
      else if (JAXRS_VERBS.has(a.name)) jaxVerbs.push(a.name);
    }
    for (const method of jaxVerbs) {
      this.addRoute({ method, path: joinRoute(prefix, jaxPath ?? ''), line: line(node), router: 'jaxrs', handlers: [sym.qualifiedName], framework: 'jaxrs' });
    }
  }

  private topProperty(node: Node): void {
    const multi = node.namedChildren.find((c) => c?.type === 'multi_variable_declaration');
    const vars = multi ? multi.namedChildren.filter((c) => c?.type === 'variable_declaration') : node.namedChildren.filter((c) => c?.type === 'variable_declaration');
    for (const v of vars) {
      const n = v.namedChildren.find((c) => c?.type === 'identifier')?.text;
      if (!n) continue;
      const mods = node.namedChildren.find((c) => c?.type === 'modifiers');
      const sym = this.symbol(n, 'variable', node, !isPrivate(mods));
      const doc = this.leadingDoc(node);
      if (doc) sym.doc = doc;
      const t = typeRoot(v.namedChildren.find((c) => c?.type === 'type' || c?.type === 'user_type' || c?.type === 'nullable_type'));
      if (t) sym.typeName = t;
      const init = node.namedChildren.find((c) => !!c && c.type !== 'variable_declaration' && c.type !== 'modifiers' && c.type !== 'getter' && c.type !== 'setter' && c.type !== 'property_delegate');
      const inst = this.initInstance(init);
      if (inst) sym.instanceOf = inst;
      else if (init?.type === 'call_expression') {
        const { callee } = this.callParts(init);
        const c = callee ? this.chain(callee) : null;
        if (c) sym.initCall = c.join('.').replace(/\(\)$/, '');
      }
      this.addSymbol(sym);
      this.withScope({ name: sym.qualifiedName }, () => {
        if (init) this.walk(init);
        const delegate = node.namedChildren.find((c) => c?.type === 'property_delegate');
        if (delegate) this.walk(delegate);
      });
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
      case 'this_expression':
        return ['this'];
      case 'super_expression':
        return ['super'];
      case 'navigation_expression': {
        const kids = node.namedChildren.filter((c): c is Node => !!c && c.type !== 'comment');
        const obj = this.chain(kids[0]);
        const field = kids[kids.length - 1];
        if (!obj || !field || field.type !== 'identifier' || obj.length >= MAX_CHAIN) return null;
        return [...obj, field.text];
      }
      case 'call_expression': {
        const { callee } = this.callParts(node);
        const inner = callee ? this.chain(callee) : null;
        if (!inner || inner.length >= MAX_CHAIN) return null;
        return [...inner.slice(0, -1), `${inner[inner.length - 1]}()`];
      }
      case 'parenthesized_expression':
        return this.chain(node.namedChildren.filter((c): c is Node => !!c)[0]);
      case 'unary_expression':
        return this.chain(node.childForFieldName('argument') ?? node.namedChildren[0]);
      case 'index_expression': {
        const obj = this.chain(node.namedChildren[0]);
        return obj ? [...obj, '[]'] : null;
      }
      default:
        return null;
    }
  }

  /**
   * A call's callee plus its argument and trailing-lambda nodes. Trailing
   * lambdas nest: `get("/h") { }` is a call wrapping a call plus a lambda.
   */
  private callParts(node: Node): { callee: Node | null; args: Node[]; lambdas: Node[] } {
    const args: Node[] = [];
    const lambdas: Node[] = [];
    let current: Node | null = node;
    let callee: Node | null = null;
    while (current && current.type === 'call_expression') {
      for (const c of current.namedChildren) {
        if (!c) continue;
        if (c.type === 'value_arguments') args.push(...c.namedChildren.filter((a): a is Node => !!a && a.type === 'value_argument'));
        else if (c.type === 'annotated_lambda' || c.type === 'lambda_literal') lambdas.push(c);
        else if (!callee) callee = c;
      }
      current = callee?.type === 'call_expression' ? callee : null;
      if (current) callee = null;
    }
    return { callee, args, lambdas };
  }

  private walk(node: Node): void {
    switch (node.type) {
      case 'line_comment':
      case 'block_comment':
      case 'shebang':
      case 'string_literal':
      case 'character_literal':
      case 'number_literal':
      case 'float_literal':
      case 'boolean_literal':
      case 'null_literal':
      case 'annotation':
      case 'modifiers':
      case 'file_annotation':
      case 'class_declaration':
      case 'object_declaration':
      case 'type_alias':
        return;
      case 'call_expression':
        return this.invocation(node);
      case 'constructor_invocation': {
        const t = typeRoot(node.namedChildren.find((c) => c?.type === 'type' || c?.type === 'user_type'));
        const args = node.namedChildren.find((c) => c?.type === 'value_arguments')?.namedChildren.filter((a): a is Node => !!a && a.type === 'value_argument') ?? [];
        if (t) this.addRef('new', t.split('.'), node, args.slice(0, 3).map((a) => literal(argumentValue(a) ?? a)));
        for (const a of args) this.argument(argumentValue(a) ?? a);
        return;
      }
      case 'property_declaration':
        return this.localProperty(node);
      case 'multi_variable_declaration':
        for (const v of node.namedChildren) {
          if (v?.type !== 'variable_declaration') continue;
          const n = v.namedChildren.find((c) => c?.type === 'identifier')?.text;
          if (n) this.declared[this.declared.length - 1]?.add(n);
        }
        return;
      case 'lambda_literal':
      case 'anonymous_function': {
        const names = node.namedChildren
          .find((c) => c?.type === 'lambda_parameters')
          ?.descendantsOfType('identifier')
          .map((p) => p?.text ?? '');
        this.declared.push(new Set(names ?? []));
        for (const c of node.namedChildren) {
          if (c && c.type !== 'lambda_parameters' && c.type !== 'function_value_parameters') this.walk(c);
        }
        this.declared.pop();
        return;
      }
      case 'catch_block': {
        const kids = node.namedChildren.filter((c): c is Node => !!c);
        const param = kids[0]?.type === 'identifier' ? kids[0].text : undefined;
        this.declared.push(new Set(param ? [param] : []));
        for (const c of kids.slice(param ? 1 : 0)) this.walk(c);
        this.declared.pop();
        return;
      }
      case 'callable_reference': {
        const ids = node.descendantsOfType('identifier').map((i) => i?.text ?? '').filter(Boolean);
        if (ids.length) {
          const [head, ...rest] = ids;
          this.addRef('ref', [...this.rootName(head!), ...rest], node);
        }
        return;
      }
    }
    for (const c of node.namedChildren) if (c) this.walk(c);
  }

  private localProperty(node: Node): void {
    const locals = this.scope().locals;
    const multi = node.namedChildren.find((c) => c?.type === 'multi_variable_declaration');
    const init = node.namedChildren.find((c) => !!c && c.type !== 'variable_declaration' && c.type !== 'multi_variable_declaration' && c.type !== 'modifiers' && c.type !== 'getter' && c.type !== 'setter' && c.type !== 'property_delegate');
    const vars = multi ? multi.namedChildren.filter((c) => c?.type === 'variable_declaration') : node.namedChildren.filter((c) => c?.type === 'variable_declaration');
    for (const v of vars) {
      const n = v.namedChildren.find((c) => c?.type === 'identifier')?.text;
      if (!n) continue;
      this.declared[this.declared.length - 1]?.add(n);
      if (!locals || multi) continue;
      const t = typeRoot(v.namedChildren.find((c) => c?.type === 'type' || c?.type === 'user_type' || c?.type === 'nullable_type'));
      if (t) locals[n] = t;
      else {
        const inst = this.initInstance(init);
        if (inst) locals[n] = inst;
        else if (init?.type === 'call_expression') {
          const { callee } = this.callParts(init);
          const c = callee ? this.chain(callee) : null;
          if (c) locals[n] = `call:${c.join('.').replace(/\(\)$/, '')}`;
        }
      }
    }
    if (init) this.walk(init);
    const delegate = node.namedChildren.find((c) => c?.type === 'property_delegate');
    if (delegate) this.walk(delegate);
  }

  private invocation(node: Node): void {
    const { callee, args, lambdas } = this.callParts(node);
    const bare = callee?.type === 'identifier' ? callee.text : null;
    // Ktor: `route("/api") { ... }` / `routing { ... }` nest a path prefix.
    if (bare === 'route' || bare === 'routing') {
      const first = args.length ? stringValue(argumentValue(args[0]!)) : null;
      this.ktorPrefixes.push(first ? ktorPath(first) : '');
      for (const l of lambdas) this.walk(l);
      for (const a of args) this.argument(argumentValue(a) ?? a);
      this.ktorPrefixes.pop();
      return;
    }
    // Ktor: `get("/orders/{id}") { ... }` inside a routing block. The block
    // is required: a bare `get("...")` elsewhere is an ordinary call. The
    // handler lambda runs in the route's scope, like Express and Go handlers.
    if (bare && KTOR_VERBS[bare] && args.length && this.ktorPrefixes.length) {
      const path = stringValue(argumentValue(args[0]!));
      if (path !== null) {
        const prefix = this.ktorPrefixes.filter(Boolean).join('');
        const method = KTOR_VERBS[bare]!;
        const full = joinRoute(prefix || undefined, ktorPath(path));
        const scope = `route:${method} ${full}`;
        const handlers: string[] = [];
        for (const a of args.slice(1)) {
          const h = this.chain(argumentValue(a) ?? a);
          if (h) handlers.push(h.join('.'));
        }
        this.addRoute({ method, path: full, line: line(node), router: 'ktor', handlers, framework: 'ktor', scope });
        this.withScope({ name: scope, locals: {} }, () => {
          for (const a of args) this.argument(argumentValue(a) ?? a);
          for (const l of lambdas) this.walk(l);
        });
        return;
      }
    }
    const c = callee ? this.chain(callee) : null;
    if (c) {
      const calleeParts = [...c.slice(0, -1), c[c.length - 1]!.replace(/\(\)$/, '')];
      this.addRef(this.callKind(calleeParts), calleeParts, node, args.slice(0, 3).map((a) => literal(argumentValue(a) ?? a)));
    }
    if (callee && callee.type !== 'identifier' && callee.type !== 'this_expression' && callee.type !== 'navigation_expression') this.walk(callee);
    for (const a of args) this.argument(argumentValue(a) ?? a);
    for (const l of lambdas) this.walk(l);
  }

  /** `Order(x)` and `Outer.Inner(x)` construct; `order.save(x)` calls. */
  private callKind(callee: string[]): 'call' | 'new' {
    const last = callee[callee.length - 1]!;
    if (!/^[A-Z]/.test(last)) return 'call';
    const root = callee[0]!;
    if (root === 'this' || root === 'super') return 'call';
    if (callee.length === 1) return this.isNewCall(root) ? 'new' : 'call';
    return this.typeNames.has(root) || this.isImported(root) || /^[A-Z]/.test(root) ? 'new' : 'call';
  }

  private isImported(name: string): boolean {
    return this.facts.imports.some((i) => i.specifiers.some((s) => s.local === name));
  }

  /** The constructed type of an initializer: `Order(x)` → 'Order'. */
  private initInstance(init: Node | undefined): string | undefined {
    if (init?.type === 'constructor_invocation') {
      return typeRoot(init.namedChildren.find((c) => c?.type === 'type' || c?.type === 'user_type'));
    }
    if (init?.type === 'call_expression') {
      const { callee } = this.callParts(init);
      const c = callee ? this.chain(callee) : null;
      if (c && this.callKind(c.map((s) => s.replace(/\(\)$/, ''))) === 'new') return c.map((s) => s.replace(/\(\)$/, '')).join('.');
    }
    return undefined;
  }

  private argument(a: Node): void {
    if (a.type === 'identifier' || a.type === 'navigation_expression' || a.type === 'index_expression') {
      const c = this.chain(a);
      if (c) this.addRef('ref', c, a);
    } else this.walk(a);
  }
}
