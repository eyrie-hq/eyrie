/**
 * Python language adapter.
 *
 * Records imports (relative and absolute dotted modules), functions,
 * classes with their fields (class annotations and `self.x = ...`),
 * call references, Flask / FastAPI / Django routes, and Django /
 * SQLAlchemy / SQLModel models. `self` and `cls` become `this` so the
 * graph resolves them like JavaScript classes.
 */
import type { Node } from 'web-tree-sitter';
import { ownValue, type ArgFact, type FieldFact, type ImportSpecifier, type ModelFact, type SymbolFact } from '@eyrie/core';
import { BaseExtractor, cleanComment, endLine, joinRoute, line, normalizeRoutePath } from './base.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const MAX_CHAIN = 6;
const ORM_BASES: Record<string, string> = {
  'models.Model': 'django',
  'db.Model': 'sqlalchemy',
  Base: 'sqlalchemy',
  DeclarativeBase: 'sqlalchemy',
  Model: 'sqlalchemy',
  SQLModel: 'sqlmodel',
  Document: 'mongoengine',
};
const RELATION_CALLS = /^(models\.)?(ForeignKey|OneToOneField|ManyToManyField)$|^relationship$|^(db\.)?relationship$/;
const WRAPPER_TYPES = new Set(['Optional', 'Annotated', 'Union', 'Final', 'ClassVar', 'Mapped', 'Type', 'type']);

const isClassName = (s: string) => /^_?[A-Z]/.test(s) && !/^[A-Z0-9_]+$/.test(s);

function stringValue(n: Node): string | null {
  if (n.type === 'concatenated_string') {
    const parts = n.namedChildren.map((c) => (c ? stringValue(c) : null));
    return parts.every((p) => p !== null) ? parts.join('') : null;
  }
  if (n.type !== 'string') return null;
  let out = '';
  for (const c of n.namedChildren) {
    if (!c) continue;
    if (c.type === 'string_content' || c.type === 'escape_sequence') out += c.text;
    else if (c.type === 'interpolation') out += ':param';
  }
  return out;
}

function literal(n: Node): ArgFact {
  const s = stringValue(n);
  if (s !== null) return s;
  if (n.type === 'binary_operator' && n.childForFieldName('operator')?.text === '+') {
    const left = n.childForFieldName('left');
    const head = left ? literal(left) : null;
    return typeof head === 'string' ? `${head}:param` : null;
  }
  if (n.type === 'dictionary') {
    const out: Record<string, string> = {};
    for (const pair of n.namedChildren) {
      if (pair?.type !== 'pair') continue;
      const k = pair.childForFieldName('key');
      const v = pair.childForFieldName('value');
      const ks = k && stringValue(k);
      const vs = v && stringValue(v);
      if (ks && vs !== null && vs !== undefined) out[ks] = vs;
      if (Object.keys(out).length >= 6) break;
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

/** Member chain: `self.repo.save` → ['this', 'repo', 'save']. */
function chain(node: Node | null): string[] | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier': {
      const t = node.text;
      return [t === 'self' || t === 'cls' ? 'this' : t];
    }
    case 'attribute': {
      const obj = chain(node.childForFieldName('object'));
      const attr = node.childForFieldName('attribute');
      if (!obj || !attr || obj.length >= MAX_CHAIN) return null;
      return [...obj, attr.text];
    }
    case 'call': {
      const inner = chain(node.childForFieldName('function'));
      if (!inner) return null;
      return [...inner.slice(0, -1), `${inner[inner.length - 1]}()`];
    }
    case 'subscript': {
      const obj = chain(node.childForFieldName('value'));
      return obj ? [...obj, '[]'] : null;
    }
    case 'parenthesized_expression':
    case 'await': {
      const inner = node.namedChildren[0];
      return inner ? chain(inner) : null;
    }
    default:
      return null;
  }
}

/** `Optional[Repo]` → 'Repo', `db.Session` → 'db.Session', `"Order"` → 'Order'. */
function typeRoot(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  let n: Node | null | undefined = node;
  if (n.type === 'type') n = n.namedChildren[0];
  if (!n) return undefined;
  switch (n.type) {
    case 'identifier':
    case 'attribute':
      return n.text;
    case 'string':
      return stringValue(n)?.trim() || undefined;
    case 'subscript':
    case 'generic_type': {
      const base = n.type === 'subscript' ? n.childForFieldName('value') : n.namedChildren[0];
      if (!base) return undefined;
      if (WRAPPER_TYPES.has(base.text)) {
        const arg = n.type === 'subscript' ? n.childForFieldName('subscript') : n.namedChildren[1]?.namedChildren[0];
        return typeRoot(arg);
      }
      return base.text;
    }
    case 'binary_operator':
      return typeRoot(n.childForFieldName('left'));
    default:
      return undefined;
  }
}

function docstring(body: Node | null): string | undefined {
  const first = body?.namedChildren[0];
  if (first?.type !== 'expression_statement') return undefined;
  const s = first.namedChildren[0];
  const text = s && stringValue(s);
  return text ? cleanComment(text) : undefined;
}

export class PythonExtractor extends BaseExtractor {
  private currentClass: SymbolFact | null = null;
  /** Router variables with a URL prefix: `router = APIRouter(prefix="/orders")`. */
  private routerPrefix = new Map<string, string>();

  protected visitRoot(root: Node): void {
    for (const child of root.namedChildren) if (child) this.statement(child, true);
  }

  private statement(node: Node, topLevel: boolean): void {
    switch (node.type) {
      case 'comment':
        return;
      case 'import_statement':
        return this.importStatement(node);
      case 'import_from_statement':
      case 'future_import_statement':
        return this.importFrom(node);
      case 'function_definition':
        this.functionDef(node, node, []);
        return;
      case 'class_definition':
        this.classDef(node, node, []);
        return;
      case 'decorated_definition':
        return this.decorated(node);
      case 'expression_statement':
        if (topLevel) return this.moduleAssignment(node);
        return this.walk(node);
      case 'if_statement':
      case 'try_statement':
      case 'with_statement':
      case 'block':
      case 'else_clause':
      case 'elif_clause':
      case 'except_clause':
      case 'finally_clause':
        // Imports guarded by `try:` / `if TYPE_CHECKING:` still count.
        for (const c of node.namedChildren) {
          if (!c) continue;
          if (node.type === 'block' || c.type === 'block' || c.type.endsWith('_clause')) this.statement(c, topLevel);
          else this.walk(c);
        }
        return;
      default:
        this.walk(node);
    }
  }

  // ── imports ──────────────────────────────────────────────────────────────

  private importStatement(node: Node): void {
    for (const c of node.namedChildren) {
      if (!c) continue;
      if (c.type === 'dotted_name') {
        // `import a.b.c` binds `a`; the graph walks `a.b.c` through submodules.
        this.facts.imports.push({ source: c.text, line: line(node), typeOnly: false, specifiers: [{ imported: '*', local: c.text.split('.')[0]! }] });
      } else if (c.type === 'aliased_import') {
        const name = c.childForFieldName('name')?.text;
        const alias = c.childForFieldName('alias')?.text;
        if (name && alias) this.facts.imports.push({ source: name, line: line(node), typeOnly: false, specifiers: [{ imported: '*', local: alias }] });
      }
    }
  }

  private importFrom(node: Node): void {
    const mod = node.childForFieldName('module_name');
    const source = node.type === 'future_import_statement' ? '__future__' : (mod?.text ?? '');
    if (!source) return;
    const specifiers: ImportSpecifier[] = [];
    let wildcard = false;
    for (const c of node.namedChildren) {
      if (!c || (mod && c.equals(mod))) continue;
      if (c.type === 'wildcard_import') wildcard = true;
      else if (c.type === 'dotted_name') specifiers.push({ imported: c.text, local: c.text });
      else if (c.type === 'aliased_import') {
        const name = c.childForFieldName('name')?.text;
        const alias = c.childForFieldName('alias')?.text;
        if (name) specifiers.push({ imported: name, local: alias ?? name });
      }
    }
    const inTypeCheck = this.insideTypeChecking(node);
    const imp = { source, line: line(node), typeOnly: inTypeCheck, specifiers } as (typeof this.facts.imports)[number];
    if (wildcard) imp.wildcard = true;
    this.facts.imports.push(imp);
  }

  private insideTypeChecking(node: Node): boolean {
    for (let p = node.parent; p; p = p.parent) {
      if (p.type === 'if_statement' && /TYPE_CHECKING/.test(p.childForFieldName('condition')?.text ?? '')) return true;
    }
    return false;
  }

  // ── declarations ─────────────────────────────────────────────────────────

  private decorated(node: Node): void {
    const def = node.childForFieldName('definition');
    if (!def) return;
    const decorators = node.namedChildren.filter((c): c is Node => c?.type === 'decorator');
    if (def.type === 'function_definition') this.functionDef(def, node, decorators);
    else if (def.type === 'class_definition') this.classDef(def, node, decorators);
  }

  private functionDef(node: Node, outer: Node, decorators: Node[], parent?: string): SymbolFact | null {
    const name = node.childForFieldName('name')?.text;
    if (!name) return null;
    const body = node.childForFieldName('body');
    const sym = this.symbol(name, parent ? 'method' : 'function', outer, !name.startsWith('_'), parent);
    sym.startLine = line(outer);
    sym.endLine = endLine(outer);
    const header = node.text.split('\n', 1)[0]?.trim();
    if (header) sym.signature = header.length > 160 ? `${header.slice(0, 157)}...` : header;
    if (node.children.some((c) => c?.type === 'async')) sym.async = true;
    const doc = docstring(body) ?? this.leadingDoc(outer);
    if (doc) sym.doc = doc;
    sym.locals = {};
    this.addSymbol(sym);
    this.params(node, sym.locals);

    for (const d of decorators) this.decorator(d, sym);
    if (body) this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => this.walk(body));
    return sym;
  }

  private params(fn: Node, locals: Record<string, string>): void {
    const params = fn.childForFieldName('parameters');
    for (const p of params?.namedChildren ?? []) {
      if (!p || (p.type !== 'typed_parameter' && p.type !== 'typed_default_parameter')) continue;
      const nameNode = p.childForFieldName('name') ?? p.namedChildren.find((c) => c?.type === 'identifier');
      const t = typeRoot(p.childForFieldName('type'));
      if (nameNode && t && nameNode.text !== 'self') locals[nameNode.text] = t;
    }
  }

  private classDef(node: Node, outer: Node, decorators: Node[]): void {
    const name = node.childForFieldName('name')?.text;
    if (!name) return;
    const body = node.childForFieldName('body');
    const sym = this.symbol(name, 'class', outer, !name.startsWith('_'));
    sym.startLine = line(outer);
    const doc = docstring(body) ?? this.leadingDoc(outer);
    if (doc) sym.doc = doc;
    sym.fields = [];
    const bases: string[] = [];
    let tableKw = false;
    for (const b of node.childForFieldName('superclasses')?.namedChildren ?? []) {
      if (!b) continue;
      if (b.type === 'keyword_argument') {
        if (b.childForFieldName('name')?.text === 'table' && b.childForFieldName('value')?.text === 'True') tableKw = true;
        continue;
      }
      const c = chain(b.type === 'subscript' ? b.childForFieldName('value') : b);
      if (c) bases.push(c.join('.'));
    }
    if (bases.length) sym.extends = bases;
    this.addSymbol(sym);
    for (const d of decorators) this.withScope({ name }, () => this.walk(d));

    const prev = this.currentClass;
    this.currentClass = sym;
    const model = this.modelOf(sym, bases, tableKw, body);
    for (const m of body?.namedChildren ?? []) {
      if (!m) continue;
      if (m.type === 'function_definition') this.functionDef(m, m, [], name);
      else if (m.type === 'decorated_definition') {
        const def = m.childForFieldName('definition');
        const decs = m.namedChildren.filter((c): c is Node => c?.type === 'decorator');
        if (def?.type === 'function_definition') this.functionDef(def, m, decs, name);
        else if (def?.type === 'class_definition') this.classDef(def, m, decs);
      } else if (m.type === 'expression_statement') {
        const a = m.namedChildren[0];
        if (a?.type === 'assignment') this.classField(sym, a, model);
        else this.withScope({ name }, () => this.walk(m));
      } else if (m.type === 'class_definition') {
        // Nested `class Meta:` and friends: not part of the graph.
      } else {
        this.withScope({ name }, () => this.walk(m));
      }
    }
    this.currentClass = prev;
    if (model) {
      model.endLine = sym.endLine;
      (this.facts.models ??= []).push(model);
    }
  }

  private modelOf(sym: SymbolFact, bases: string[], tableKw: boolean, body: Node | null): ModelFact | null {
    // SQLModel: `class User(UserBase, table=True)` is a table whatever its base.
    let orm: string | undefined = tableKw ? 'sqlmodel' : undefined;
    for (const b of bases) {
      const o = ownValue(ORM_BASES, b);
      if (!o) continue;
      if (o === 'sqlmodel' && !tableKw) continue;
      // `class Base(DeclarativeBase): pass` is the base, not a table.
      if (o === 'sqlalchemy' && !/\b(Column|mapped_column|Mapped\[|relationship)\b/.test(body?.text ?? '')) continue;
      orm = o;
    }
    if (!orm) return null;
    return { name: sym.name, line: sym.startLine, endLine: sym.endLine, fields: [], relations: [], orm, symbol: sym.qualifiedName };
  }

  private classField(owner: SymbolFact, a: Node, model: ModelFact | null): void {
    const left = a.childForFieldName('left');
    const right = a.childForFieldName('right');
    if (left?.type !== 'identifier') {
      if (right) this.withScope({ name: owner.qualifiedName }, () => this.walk(right));
      return;
    }
    const name = left.text;
    if (name.startsWith('__') && name.endsWith('__')) return;
    const field: FieldFact = { name };
    const t = typeRoot(a.childForFieldName('type'));
    if (t) field.type = t;
    const c = right?.type === 'call' ? chain(right.childForFieldName('function')) : null;
    if (c && isClassName(c[c.length - 1]!)) field.instanceOf = c.join('.');
    owner.fields!.push(field);
    if (model) {
      model.fields.push(name);
      const rel = this.relationTarget(a);
      if (rel && rel !== owner.name && !model.relations.includes(rel)) model.relations.push(rel);
    }
    if (right) this.withScope({ name: owner.qualifiedName }, () => this.walk(right));
  }

  /** `ForeignKey('Customer')`, `relationship("Item")`, `Mapped[List["Item"]]` → model name. */
  private relationTarget(a: Node): string | undefined {
    const right = a.childForFieldName('right');
    if (right?.type === 'call') {
      const fn = right.childForFieldName('function')?.text ?? '';
      if (RELATION_CALLS.test(fn)) {
        const first = right.childForFieldName('arguments')?.namedChildren[0];
        if (first) {
          const v = stringValue(first) ?? (first.type === 'identifier' || first.type === 'attribute' ? first.text : null);
          if (v && v !== 'self') return v.split('.').pop();
        }
      }
    }
    const typeText = a.childForFieldName('type')?.text ?? '';
    const m = /^Mapped\[(?:(?:List|list|Set|set|Optional)\[)?["']?(\w+)/.exec(typeText);
    if (m && isClassName(m[1]!)) return m[1];
    // SQLModel: `items: list["Item"] = Relationship(...)`, `owner: User | None = Relationship(...)`.
    const fn = right?.type === 'call' ? right.childForFieldName('function')?.text : undefined;
    if (fn === 'Relationship') {
      return typeText.match(/[A-Z]\w*/g)?.find((t) => !WRAPPER_TYPES.has(t) && !/^(List|Set|Dict|None|Sequence)$/.test(t));
    }
    return undefined;
  }

  private moduleAssignment(node: Node): void {
    const a = node.namedChildren[0];
    if (a?.type !== 'assignment') return this.walk(node);
    const left = a.childForFieldName('left');
    const right = a.childForFieldName('right');
    if (left?.type !== 'identifier') return this.walk(node);
    const name = left.text;
    if (name === 'urlpatterns' && right) {
      this.djangoUrls(right);
      return;
    }
    const sym = this.symbol(name, 'variable', node, !name.startsWith('_'));
    const t = typeRoot(a.childForFieldName('type'));
    if (t) sym.typeName = t;
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    if (right?.type === 'call') {
      const c = chain(right.childForFieldName('function'));
      if (c) {
        const fn = c.join('.');
        if (isClassName(c[c.length - 1]!)) sym.instanceOf = fn;
        else sym.initCall = fn;
        const prefix = this.keywordString(right, ['prefix', 'url_prefix']);
        if (prefix !== undefined) this.routerPrefix.set(name, prefix);
      }
    } else if (right?.type === 'lambda') {
      sym.kind = 'function';
    }
    this.addSymbol(sym);
    if (right) this.withScope({ name }, () => this.walk(right));
  }

  private keywordString(call: Node, names: string[]): string | undefined {
    for (const a of call.childForFieldName('arguments')?.namedChildren ?? []) {
      if (a?.type !== 'keyword_argument' || !names.includes(a.childForFieldName('name')?.text ?? '')) continue;
      const v = a.childForFieldName('value');
      const s = v && stringValue(v);
      if (s !== null && s !== undefined) return s;
    }
    return undefined;
  }

  // ── routes ───────────────────────────────────────────────────────────────

  /** `@app.get("/x")`, `@bp.route("/x", methods=["POST"])`, `@router.api_route(...)`. */
  private decorator(d: Node, fn: SymbolFact): void {
    const call = d.namedChildren[0];
    if (call?.type !== 'call') {
      if (call) this.withScope({ name: fn.qualifiedName }, () => this.walk(call));
      return;
    }
    const c = chain(call.childForFieldName('function'));
    const args = call.childForFieldName('arguments');
    const first = args?.namedChildren[0];
    const path = first ? stringValue(first) : null;
    if (c && c.length === 2 && path !== null) {
      const [router, verb] = c as [string, string];
      const v = verb.toLowerCase();
      let methods: string[] = [];
      if (HTTP_METHODS.has(v)) methods = [v.toUpperCase()];
      else if (v === 'route' || v === 'api_route') {
        const kw = args?.namedChildren.find((a) => a?.type === 'keyword_argument' && a.childForFieldName('name')?.text === 'methods');
        const list = kw?.childForFieldName('value');
        methods = (list?.namedChildren ?? []).map((m) => (m ? stringValue(m)?.toUpperCase() : undefined)).filter((m): m is string => !!m);
        if (!methods.length) methods = [v === 'route' ? 'GET' : 'ANY'];
      }
      if (methods.length) {
        const full = joinRoute(this.routerPrefix.get(router), path);
        for (const method of methods) {
          this.addRoute({ method, path: full, line: line(d), router, handlers: [fn.qualifiedName], framework: 'python' });
        }
        return;
      }
    }
    this.withScope({ name: fn.qualifiedName }, () => this.walk(call));
  }

  /** Django: `urlpatterns = [path("orders/<int:pk>/", views.detail), ...]`. */
  private djangoUrls(list: Node): void {
    for (const item of list.namedChildren) {
      if (item?.type !== 'call') {
        if (item) this.walk(item);
        continue;
      }
      const fn = item.childForFieldName('function')?.text;
      const args = item.childForFieldName('arguments')?.namedChildren ?? [];
      const route = args[0] ? stringValue(args[0]) : null;
      const view = args[1];
      if ((fn === 'path' || fn === 're_path' || fn === 'url') && route !== null && view && !/include/.test(view.text)) {
        const c = chain(view.type === 'call' ? view.childForFieldName('function') : view);
        const handler = c ? c.filter((p) => p !== 'as_view' && p !== 'as_view()').join('.') : undefined;
        this.addRoute({ method: 'ANY', path: normalizeRoutePath(route), line: line(item), router: 'urlpatterns', handlers: handler ? [handler] : [], framework: 'django' });
      }
      this.walk(item);
    }
  }

  // ── references ───────────────────────────────────────────────────────────

  private walk(node: Node): void {
    switch (node.type) {
      case 'comment':
      case 'string':
      case 'concatenated_string':
      case 'integer':
      case 'float':
      case 'type':
        return;
      case 'call':
        return this.call(node);
      case 'assignment':
      case 'augmented_assignment':
        return this.assignment(node);
      case 'function_definition': {
        // Nested function: its calls belong to the enclosing symbol.
        const locals = this.scope().locals;
        if (locals) this.params(node, locals);
        const body = node.childForFieldName('body');
        if (body) this.walk(body);
        return;
      }
      case 'class_definition':
        return;
    }
    for (const c of node.namedChildren) if (c) this.walk(c);
  }

  private call(node: Node): void {
    const fn = node.childForFieldName('function');
    const args = node.childForFieldName('arguments');
    if (!fn) return;
    const c = chain(fn);
    if (c?.length === 2 && c[1] === 'include_router') {
      const targetNode = args?.namedChildren.find((a) => a && a.type !== 'comment' && (a.type !== 'keyword_argument' || a.childForFieldName('name')?.text === 'router'));
      const target = targetNode ? chain(targetNode.type === 'keyword_argument' ? targetNode.childForFieldName('value') : targetNode) : null;
      const prefix = this.keywordString(node, ['prefix']);
      const dynamicPrefix = args?.namedChildren.some((a) => a?.type === 'keyword_argument' && a.childForFieldName('name')?.text === 'prefix') && prefix === undefined;
      if (target && !dynamicPrefix) (this.facts.routeMounts ??= []).push({ router: c[0]!, target, prefix: joinRoute(this.routerPrefix.get(c[0]!), prefix ?? ''), line: line(node) });
    }
    // A bare `super()` only matters through the member it reaches (`super().save()`).
    if (c && c.length === 1 && c[0] === 'super') return;
    if (c) {
      const positional =(args?.namedChildren ?? []).filter((a): a is Node => !!a && a.type !== 'keyword_argument' && a.type !== 'comment');
      const lits = positional.slice(0, 3).map(literal);
      this.addRef(isClassName(c[c.length - 1]!) ? 'new' : 'call', c, node, lits);
      if (fn.type === 'attribute') {
        const obj = fn.childForFieldName('object');
        if (obj) this.walk(obj);
      }
    } else {
      this.walk(fn);
    }
    for (const a of args?.namedChildren ?? []) {
      if (!a) continue;
      const v = a.type === 'keyword_argument' ? a.childForFieldName('value') : a;
      if (!v) continue;
      if (v.type === 'identifier' || v.type === 'attribute') {
        const ac = chain(v);
        if (ac && ac[0] !== 'this') this.addRef('ref', ac, v);
      } else this.walk(v);
    }
  }

  private assignment(node: Node): void {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    const locals = this.scope().locals;
    const t = typeRoot(node.childForFieldName('type'));
    const c = right?.type === 'call' ? chain(right.childForFieldName('function')) : null;
    const instance = c && isClassName(c[c.length - 1]!) ? c.join('.') : undefined;
    if (left?.type === 'identifier' && locals) {
      if (instance) locals[left.text] = instance;
      else if (t) locals[left.text] = t;
      else if (c) locals[left.text] = `call:${c.join('.')}`;
    }
    // `self.repo = OrderRepo()` / `self.repo = repo` inside a method.
    const lc = left?.type === 'attribute' ? chain(left) : null;
    if (lc && lc.length === 2 && lc[0] === 'this' && this.currentClass) {
      const fields = (this.currentClass.fields ??= []);
      if (!fields.some((f) => f.name === lc[1])) {
        const field: FieldFact = { name: lc[1]! };
        if (instance) field.instanceOf = instance;
        else if (t) field.type = t;
        else if (right?.type === 'identifier' && locals?.[right.text] && !locals[right.text]!.startsWith('call:')) field.type = locals[right.text];
        fields.push(field);
      }
    }
    if (right) this.walk(right);
  }
}
