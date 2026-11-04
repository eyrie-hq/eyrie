/**
 * Lua language adapter.
 *
 * Records `require('...')` imports (a plain call in the grammar, so the
 * adapter derives the import from string-literal calls and emits no call
 * ref for `require` itself), global / local / `M.func` / `M:method`
 * functions, table-constructor modules (`local M = {} ... return M`,
 * whose members are recorded as exports), `self` fields and `this` call
 * chains, for-loop locals, and string literal call arguments.
 */
import type { Node } from 'web-tree-sitter';
import type { ArgFact, SymbolFact } from '@eyrie/core';
import { BaseExtractor, cleanComment, line } from './base.js';

const MAX_CHAIN = 6;

function stringValue(n: Node | null | undefined): string | null {
  if (!n || n.type !== 'string') return null;
  let out = '';
  for (const c of n.namedChildren) {
    if (!c) continue;
    if (c.type === 'string_content' || c.type === 'escape_sequence') out += c.text;
    else return null;
  }
  return out;
}

function literal(n: Node): ArgFact {
  const s = stringValue(n);
  if (s !== null) return s;
  if (n.type === 'binary_expression' && n.childForFieldName('operator')?.text === '..') {
    const left = n.childForFieldName('left');
    const head = left ? literal(left) : null;
    return typeof head === 'string' ? `${head}:param` : null;
  }
  if (n.type === 'table_constructor') {
    const out: Record<string, string> = {};
    for (const f of n.namedChildren) {
      if (f?.type !== 'field') continue;
      const k = f.childForFieldName('name');
      const v = f.childForFieldName('value');
      const vs = v && stringValue(v);
      if (k?.type === 'identifier' && vs !== null && vs !== undefined) out[k.text] = vs;
      if (Object.keys(out).length >= 6) break;
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

/** Member chain: `self.repo.save` → ['this', 'repo', 'save']. */
function chain(node: Node | null | undefined): string[] | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier': {
      const t = node.text;
      return [t === 'self' ? 'this' : t];
    }
    case 'dot_index_expression': {
      const obj = chain(node.childForFieldName('table'));
      const field = node.childForFieldName('field');
      if (!obj || !field || obj.length >= MAX_CHAIN) return null;
      return [...obj, field.text];
    }
    case 'method_index_expression': {
      const obj = chain(node.childForFieldName('table'));
      const method = node.childForFieldName('method');
      if (!obj || !method || obj.length >= MAX_CHAIN) return null;
      return [...obj, method.text];
    }
    case 'bracket_index_expression': {
      const obj = chain(node.childForFieldName('table'));
      return obj ? [...obj, '[]'] : null;
    }
    case 'function_call': {
      const inner = chain(node.childForFieldName('name'));
      if (!inner) return null;
      return [...inner.slice(0, -1), `${inner[inner.length - 1]}()`];
    }
    case 'parenthesized_expression': {
      const inner = node.namedChildren[0];
      return inner ? chain(inner) : null;
    }
    default:
      return null;
  }
}

/** Chains with computed segments cannot name a symbol. */
function definable(c: string[] | null): c is string[] {
  return !!c && c.length > 0 && c.every((s) => s !== '[]' && !s.endsWith('()'));
}

export class LuaExtractor extends BaseExtractor {
  /** Module table symbol collecting `self.x` fields, while inside one of its methods. */
  private owner: SymbolFact | null = null;
  /** Table the file returns (`return M`), whose members become exports. */
  private returned = '';

  protected visitRoot(root: Node): void {
    const kids = root.namedChildren.filter((c): c is Node => !!c);
    for (const k of kids) {
      if (k.type !== 'return_statement') continue;
      const list = k.namedChildren[0];
      const first = list?.type === 'expression_list' ? list.namedChildren[0] : list;
      if (first?.type === 'identifier') this.returned = first.text;
    }
    for (const child of kids) this.statement(child);
  }

  private statement(node: Node): void {
    switch (node.type) {
      case 'comment':
        return;
      case 'function_declaration':
        this.functionDecl(node, node, node.children[0]?.type === 'local');
        return;
      case 'variable_declaration': {
        const assign = node.namedChildren.find((c) => c?.type === 'assignment_statement');
        if (assign) this.assignStmt(assign, node, node.children[0]?.type === 'local', true);
        return;
      }
      case 'assignment_statement':
        this.assignStmt(node, node, false, true);
        return;
      default:
        this.walk(node);
    }
  }

  private functionDecl(node: Node, outer: Node, isLocal: boolean): void {
    const nameNode = node.childForFieldName('name');
    const c = nameNode?.type === 'identifier' ? [nameNode.text] : chain(nameNode);
    this.emitFunction(
      c,
      node.childForFieldName('parameters'),
      node.childForFieldName('body'),
      outer,
      isLocal,
    );
  }

  private emitFunction(c: string[] | null, params: Node | null, body: Node | null, outer: Node, isLocal: boolean): void {
    if (!definable(c)) {
      if (body) this.walk(body);
      return;
    }
    const name = c[c.length - 1]!;
    const parent = c.length > 1 ? c.slice(0, -1).join('.') : undefined;
    const sym = this.symbol(name, parent ? 'method' : 'function', outer, parent ? !name.startsWith('_') : !isLocal && !name.startsWith('_'), parent);
    const doc = this.luaDoc(outer);
    if (doc) sym.doc = doc;
    sym.locals = {};
    this.addSymbol(sym);
    if (parent && parent === this.returned && !name.startsWith('_')) this.addExport(name, sym.qualifiedName, outer);
    const prev = this.owner;
    if (parent) this.owner = this.symbolsByName.get(parent) ?? null;
    if (body) this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => this.walk(body));
    this.owner = prev;
  }

  private addExport(name: string, local: string, node: Node): void {
    if (this.facts.exports.some((e) => e.kind === 'local' && e.exported === name)) return;
    this.facts.exports.push({ kind: 'local', exported: name, local, line: line(node) });
  }

  private assignStmt(a: Node, outer: Node, isLocal: boolean, topLevel: boolean): void {
    const varList = a.namedChildren.find((c) => c?.type === 'variable_list');
    const expList = a.namedChildren.find((c) => c?.type === 'expression_list');
    const vars = varList?.namedChildren ?? [];
    const vals = expList?.namedChildren ?? [];
    const locals = this.scope().locals;
    vars.forEach((varNode, i) => {
      if (!varNode) return;
      const val = vals[i] ?? null;
      // `local m = require("x")` binds an import; never a call ref or symbol.
      if (val && this.isRequire(val)) {
        const src = stringValue(val.childForFieldName('arguments')?.namedChildren[0]);
        if (src !== null) {
          this.facts.imports.push({ source: src, line: line(a), typeOnly: false, specifiers: varNode.type === 'identifier' ? [{ imported: '*', local: varNode.text }] : [] });
          const args = val.childForFieldName('arguments')?.namedChildren ?? [];
          for (const extra of args.slice(1)) if (extra) this.walk(extra);
        } else {
          // Dynamic `require(name)`: still a call to the global.
          this.walk(val);
        }
        return;
      }
      const c = chain(varNode);
      if (val?.type === 'function_definition') {
        if (topLevel && definable(c) && c[0] !== 'this') {
          this.emitFunction(c, val.childForFieldName('parameters'), val.childForFieldName('body'), outer, isLocal);
        } else {
          const body = val.childForFieldName('body');
          if (body) this.walk(body);
        }
        return;
      }
      if (topLevel) {
        if (varNode.type === 'identifier' && val?.type === 'table_constructor') {
          const sym = this.symbol(varNode.text, 'variable', outer, !isLocal && !varNode.text.startsWith('_'));
          const doc = this.luaDoc(outer);
          if (doc) sym.doc = doc;
          this.addSymbol(sym);
          for (const f of val.namedChildren) {
            if (!f) continue;
            if (f.type !== 'field') {
              this.withScope({ name: sym.qualifiedName }, () => this.walk(f));
              continue;
            }
            const fname = f.childForFieldName('name');
            const fval = f.childForFieldName('value');
            if (fname?.type === 'identifier' && fval?.type === 'function_definition') {
              this.emitFunction([varNode.text, fname.text], fval.childForFieldName('parameters'), fval.childForFieldName('body'), f, false);
            } else if (fval) {
              this.withScope({ name: sym.qualifiedName }, () => this.walk(fval));
            }
          }
          return;
        }
        if (val && definable(c) && c.length >= 2 && c[0] === this.returned) {
          const name = c[c.length - 1]!;
          const parent = c.slice(0, -1).join('.');
          const sym = this.symbol(name, 'variable', outer, !name.startsWith('_'), parent);
          this.addSymbol(sym);
          if (!name.startsWith('_')) this.addExport(name, sym.qualifiedName, outer);
          this.withScope({ name: sym.qualifiedName }, () => this.walk(val));
          return;
        }
        if (varNode.type === 'identifier' && val) {
          const sym = this.symbol(varNode.text, 'variable', outer, !isLocal && !varNode.text.startsWith('_'));
          const doc = this.luaDoc(outer);
          if (doc) sym.doc = doc;
          if (val.type === 'function_call') {
            const cc = chain(val.childForFieldName('name'));
            if (cc) {
              const last = cc[cc.length - 1]!.replace(/\(\)$/, '');
              if (/^[A-Z]/.test(last)) sym.instanceOf = cc.join('.');
              else sym.initCall = cc.join('.');
            }
          }
          this.addSymbol(sym);
          this.withScope({ name: varNode.text }, () => this.walk(val));
          return;
        }
        if (val) this.walk(val);
        return;
      }
      // Inside a function: `self.x = ...` declares a field on the module table.
      if (c && c.length === 2 && c[0] === 'this' && this.owner) {
        const fields = (this.owner.fields ??= []);
        if (!fields.some((f) => f.name === c[1])) fields.push({ name: c[1]! });
      } else if (varNode.type === 'identifier' && locals && val?.type === 'function_call') {
        const cc = chain(val.childForFieldName('name'));
        if (cc) {
          const flat = cc.join('.').replace(/\(\)/g, '');
          locals[varNode.text] = /^[A-Z]/.test(cc[cc.length - 1]!.replace(/\(\)$/, '')) ? flat : `call:${flat}`;
        }
      }
      if (val) this.walk(val);
    });
  }

  private isRequire(val: Node): boolean {
    if (val.type !== 'function_call') return false;
    const name = val.childForFieldName('name');
    return name?.type === 'identifier' && name.text === 'require';
  }

  private forStmt(node: Node): void {
    const clause = node.childForFieldName('clause');
    const body = node.childForFieldName('body');
    const locals = this.scope().locals;
    if (clause?.type === 'for_numeric_clause') {
      const name = clause.childForFieldName('name')?.text;
      if (name && locals) locals[name] = 'number';
      for (const f of ['start', 'end', 'step'] as const) {
        const n = clause.childForFieldName(f);
        if (n) this.walk(n);
      }
    } else if (clause?.type === 'for_generic_clause') {
      const varList = clause.namedChildren.find((c) => c?.type === 'variable_list');
      const expList = clause.namedChildren.find((c) => c?.type === 'expression_list');
      const iter = expList?.namedChildren[0];
      if (locals && iter?.type === 'function_call') {
        const cc = chain(iter.childForFieldName('name'));
        if (cc) for (const v of varList?.namedChildren ?? []) if (v?.type === 'identifier') locals[v.text] = `call:${cc.join('.')}`;
      }
      if (expList) for (const e of expList.namedChildren) if (e) this.walk(e);
    }
    if (body) this.walk(body);
  }

  // ── references ───────────────────────────────────────────────────────────

  private walk(node: Node): void {
    switch (node.type) {
      case 'comment':
      case 'string':
      case 'number':
      case 'true':
      case 'false':
      case 'nil':
        return;
      case 'function_call':
        return this.call(node);
      case 'assignment_statement':
        return this.assignStmt(node, node, false, false);
      case 'variable_declaration': {
        const assign = node.namedChildren.find((c) => c?.type === 'assignment_statement');
        if (assign) this.assignStmt(assign, node, false, false);
        return;
      }
      case 'function_declaration':
      case 'function_definition': {
        // Nested functions contribute their calls to the enclosing symbol.

        const body = node.childForFieldName('body');
        if (body) this.walk(body);
        return;
      }
      case 'for_statement':
        return this.forStmt(node);
    }
    for (const c of node.namedChildren) if (c) this.walk(c);
  }

  private call(node: Node): void {
    const nameNode = node.childForFieldName('name');
    const argsNode = node.childForFieldName('arguments');
    // Bare `require("x")` (or nested in an expression) records an import.
    if (nameNode?.type === 'identifier' && nameNode.text === 'require') {
      const src = stringValue(argsNode?.namedChildren[0]);
      if (src !== null) {
        this.facts.imports.push({ source: src, line: line(node), typeOnly: false, specifiers: [] });
        for (const extra of argsNode?.namedChildren.slice(1) ?? []) if (extra) this.walk(extra);
        return;
      }
    }
    const c = chain(nameNode);
    if (c) {
      const positional = argsNode?.namedChildren ?? [];
      this.addRef('call', c, node, positional.slice(0, 3).map(literal));
      const root = nameNode?.type === 'dot_index_expression' || nameNode?.type === 'method_index_expression' ? nameNode.childForFieldName('table') : nameNode?.type === 'identifier' ? null : nameNode;
      if (root && root.type !== 'identifier') this.walk(root);
    } else if (nameNode) {
      this.walk(nameNode);
    }
    for (const a of argsNode?.namedChildren ?? []) {
      if (!a) continue;
      if (a.type === 'identifier' || a.type === 'dot_index_expression' || a.type === 'bracket_index_expression') {
        const ac = chain(a);
        if (ac && ac[0] !== 'this') this.addRef('ref', ac, a);
      } else this.walk(a);
    }
  }

  /** Doc text from the `--` comments directly above `node`. */
  private luaDoc(node: Node): string | undefined {
    const comments: string[] = [];
    let expectRow = node.startPosition.row;
    let prev = node.previousSibling;
    while (prev && prev.type === 'comment' && prev.endPosition.row >= expectRow - 1) {
      const stripped = prev.text
        .replace(/^\s*--+\s?/, '')
        .replace(/^\[=*\[\s?/, '')
        .replace(/\s?\]=*\]$/, '');
      comments.unshift(stripped);
      expectRow = prev.startPosition.row;
      prev = prev.previousSibling;
    }
    return comments.length ? cleanComment(comments.join('\n')) : undefined;
  }
}
