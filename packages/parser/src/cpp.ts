/**
 * C++ language adapter: the C adapter plus namespaces, classes with
 * access-tracked members (constructors, destructors, operators, nested
 * types), templates, using-directives, and `new` / lambda / exception
 * references. Following Rust, symbols use simple names and `::`
 * qualifiers resolve to their innermost known segment.
 *
 * Two grammar limits are honest gaps: C++20 modules (`export module`,
 * `import x;`) do not parse in tree-sitter-cpp 0.23.4, so module files
 * keep their includes but lose most symbols; and member access through
 * a `using` alias resolves fields but not methods.
 */
import type { Node } from 'web-tree-sitter';
import type { SymbolKind } from '@eyrie/core';
import { line } from './base.js';
import { CExtractor, declaratorName, type ClassCtx } from './c.js';

export class CppExtractor extends CExtractor {
  /** Enclosing namespace segments (`namespace a::b` pushes two). */
  private nsScope: string[] = [];
  /** Depth inside anonymous namespaces, whose members are file-local. */
  private anonDepth = 0;

  protected override symbol(name: string, kind: SymbolKind, node: Node, exported: boolean, parent?: string) {
    return super.symbol(name, kind, node, exported && this.anonDepth === 0, parent);
  }

  protected override topLevel(node: Node): void {
    switch (node.type) {
      case 'namespace_definition':
        return this.namespaceDecl(node);
      case 'using_declaration':
        return this.usingDecl(node);
      case 'template_declaration': {
        const inner = node.namedChildren.find((c) => !!c && c.type !== 'template_parameter_list' && c.type !== 'requires_clause');
        if (inner) this.topLevel(inner);
        return;
      }
      case 'alias_declaration':
        return this.aliasDecl(node, undefined);
      case 'class_specifier':
        return this.cppClassDecl(node, undefined);
      default:
        return super.topLevel(node);
    }
  }

  protected override globalDecl(node: Node, scope: string[] | undefined): void {
    super.globalDecl(node, scope ?? this.nsScope);
  }

  protected override functionDef(node: Node, scope: string[] | undefined, owner: ClassCtx | undefined): void {
    super.functionDef(node, scope ?? this.nsScope, owner);
  }

  private namespaceDecl(node: Node): void {
    const nameNode = node.childForFieldName('name');
    const segments = nameNode ? nameNode.descendantsOfType('namespace_identifier').map((n) => n?.text ?? '').filter(Boolean) : [];
    if (!segments.length) segments.push(...(nameNode?.text.split('::').map((s) => s.trim()).filter(Boolean) ?? []));
    // The first top-level namespace stands in for the file, like a package.
    if (!this.nsScope.length && segments.length && !this.facts.namespace) this.facts.namespace = segments.join('.');
    const body = node.namedChildren.find((c) => c?.type === 'declaration_list');
    if (!segments.length) {
      this.anonDepth++;
      for (const c of body?.namedChildren ?? []) if (c) this.topLevel(c);
      this.anonDepth--;
      return;
    }
    this.nsScope.push(...segments);
    for (const c of body?.namedChildren ?? []) if (c) this.topLevel(c);
    this.nsScope.splice(this.nsScope.length - segments.length, segments.length);
  }

  private usingDecl(node: Node): void {
    if (/^using\s+namespace\b/.test(node.text)) {
      const target = node.namedChildren.find((c) => !!c && (c.type === 'identifier' || c.type === 'qualified_identifier' || c.type === 'nested_namespace_specifier'));
      const dotted = target ? target.text.split('::').map((s) => s.trim()).filter(Boolean).join('.') : '';
      if (!dotted) return;
      this.facts.imports.push({ source: dotted, line: line(node), typeOnly: false, specifiers: [], wildcard: true });
      return;
    }
    const qualified = node.namedChildren.find((c) => c?.type === 'qualified_identifier');
    if (!qualified) return;
    const parts = qualified.text
      .split('::')
      .map((p) => p.replace(/<[^]*>$/, '').trim())
      .filter(Boolean);
    const name = parts.pop();
    if (!name || !parts.length) return;
    this.facts.imports.push({ source: parts.join('.'), line: line(node), typeOnly: false, specifiers: [{ imported: name, local: name }] });
  }

  private aliasDecl(node: Node, parent: string | undefined): void {
    const name = node.childForFieldName('name')?.text ?? node.namedChildren.find((c) => c?.type === 'type_identifier')?.text;
    if (!name) return;
    const sym = this.symbol(name, 'type', node, true, parent);
    const target = this.typeOf(node.namedChildren.find((c) => !!c && this.isTypeNode(c) && c !== node.childForFieldName('name')));
    if (target) sym.typeName = target;
    this.addSymbol(sym);
    if (target) {
      const aliased = this.symbolsByName.get(target);
      if (aliased?.fields) sym.fields = aliased.fields.map((f) => ({ ...f }));
    }
  }

  protected override specifierDecl(node: Node, parent: string | undefined): void {
    if (node.type === 'class_specifier' || node.type === 'struct_specifier' || node.type === 'union_specifier') return this.cppClassDecl(node, parent);
    super.specifierDecl(node, parent);
  }

  private cppClassDecl(node: Node, parent: string | undefined): void {
    const name = node.childForFieldName('name')?.text;
    if (!name) return;
    if (!node.namedChildren.some((c) => c?.type === 'field_declaration_list')) return;
    const sym = this.symbol(name, 'class', node, true, parent);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    const bases = node.namedChildren
      .find((c) => c?.type === 'base_class_clause')
      ?.namedChildren.filter((c) => !!c && (c.type === 'type_identifier' || c.type === 'qualified_identifier' || c.type === 'template_type'))
      .map((c) => this.typeOf(c))
      .filter((t): t is string => !!t);
    // Every C++ base is implementation inheritance.
    if (bases?.length) sym.extends = bases;
    sym.fields = [];
    this.addSymbol(sym);
    const ctx: ClassCtx = { sym, fields: new Set(), methods: new Set() };
    const members = this.flatMembers(node.namedChildren.find((c) => c?.type === 'field_declaration_list'));
    // Collect fields and methods before walking bodies, so bare names resolve to `this.x`.
    for (const m of members) this.collectMember(m, ctx);
    const prev = this.cls;
    this.cls = ctx;
    for (const m of members) this.member(m, ctx);
    this.cls = prev;
  }

  private collectMember(node: Node, ctx: ClassCtx): void {
    switch (node.type) {
      case 'field_declaration': {
        if (this.isMethodMember(node)) {
          const n = this.memberKey(node, ctx);
          if (n) ctx.methods.add(n);
        } else {
          for (const f of this.fieldDecls(
            node,
            node.namedChildren.find((c) => !!c && this.isTypeNode(c)),
          ))
            ctx.fields.add(f.name);
        }
        return;
      }
      case 'declaration': {
        if (this.isMethodMember(node)) {
          const n = this.memberKey(node, ctx);
          if (n) ctx.methods.add(n);
        } else {
          for (const f of this.fieldDecls(
            node,
            node.namedChildren.find((c) => !!c && this.isTypeNode(c)),
          ))
            ctx.fields.add(f.name);
        }
        return;
      }
      case 'function_definition': {
        const n = this.memberKey(node, ctx);
        if (n) ctx.methods.add(n);
        return;
      }
      case 'template_declaration': {
        const inner = node.namedChildren.find((c) => !!c && c.type !== 'template_parameter_list' && c.type !== 'requires_clause');
        if (inner) this.collectMember(inner, ctx);
        return;
      }
      default:
        return;
    }
  }

  private isMethodMember(node: Node): boolean {
    return node.namedChildren.some((c) => !!c && /declarator$/.test(c.type) && !c.type.startsWith('abstract') && this.isFunctionDeclarator(c));
  }

  /** A member's method name, with constructors collapsed (destructors are never referenced bare). */
  private memberKey(node: Node, ctx: ClassCtx): string | null {
    const decl = node.namedChildren.find((c) => !!c && /declarator$/.test(c.type) && !c.type.startsWith('abstract'));
    const named = declaratorName(decl);
    if (!named || named.special === 'destructor') return null;
    return this.methodName(named, ctx.sym.name);
  }

  private member(node: Node, ctx: ClassCtx): void {
    switch (node.type) {
      case 'field_declaration': {
        const typeNode = node.namedChildren.find((c) => !!c && this.isTypeNode(c));
        const hasDeclarator = node.namedChildren.some((c) => !!c && (c.type === 'field_identifier' || c.type === 'identifier' || /declarator$/.test(c.type)));
        const hasBody = !!typeNode && typeNode.namedChildren.some((c) => c?.type === 'field_declaration_list' || c?.type === 'enumerator_list');
        if (typeNode && /_specifier$/.test(typeNode.type) && !typeNode.childForFieldName('name') && !hasDeclarator && hasBody) {
          // Anonymous nested type: its members belong to the enclosing class.
          for (const f of this.nestedFields(typeNode)) {
            ctx.sym.fields!.push(f);
            ctx.fields.add(f.name);
          }
          return;
        }
        if (typeNode && /_specifier$/.test(typeNode.type) && typeNode.childForFieldName('name') && hasBody) {
          if (typeNode.type === 'enum_specifier') this.specifierDecl(typeNode, ctx.sym.qualifiedName);
          else this.cppClassDecl(typeNode, ctx.sym.qualifiedName);
        }
        if (this.isMethodMember(node)) {
          for (const d of node.namedChildren.filter((c) => !!c && /declarator$/.test(c.type) && !c.type.startsWith('abstract'))) {
            if (this.isFunctionDeclarator(d)) this.functionProto(node, d, undefined, ctx);
          }
          return;
        }
        for (const f of this.fieldDecls(node, typeNode)) {
          ctx.sym.fields!.push(f);
          ctx.fields.add(f.name);
        }
        return;
      }
      case 'declaration': {
        if (this.isMethodMember(node)) {
          for (const d of node.namedChildren.filter((c) => !!c && /declarator$/.test(c.type) && !c.type.startsWith('abstract'))) {
            if (this.isFunctionDeclarator(d)) this.functionProto(node, d, undefined, ctx);
          }
          return;
        }
        const typeNode = node.namedChildren.find((c) => !!c && this.isTypeNode(c));
        for (const f of this.fieldDecls(node, typeNode)) {
          ctx.sym.fields!.push(f);
          ctx.fields.add(f.name);
        }
        return;
      }
      case 'function_definition':
        return this.functionDef(node, undefined, ctx);
      case 'template_declaration': {
        const inner = node.namedChildren.find((c) => !!c && c.type !== 'template_parameter_list' && c.type !== 'requires_clause');
        if (inner) this.member(inner, ctx);
        return;
      }
      case 'friend_declaration': {
        // A friend defined inline belongs to the enclosing namespace, not the class.
        const inner = node.namedChildren.find((c) => c?.type === 'function_definition');
        if (inner) this.functionDef(inner, this.nsScope, undefined);
        return;
      }
      case 'alias_declaration':
        return this.aliasDecl(node, ctx.sym.qualifiedName);
      case 'class_specifier':
        return this.cppClassDecl(node, ctx.sym.qualifiedName);
      case 'enum_specifier':
        return this.specifierDecl(node, ctx.sym.qualifiedName);
      case 'using_declaration':
      case 'access_specifier':
      case 'static_assert_declaration':
        return;
      default:
        return;
    }
  }

  protected override rootName(name: string): string[] {
    if (this.cls && !this.isDeclared(name) && (this.cls.fields.has(name) || this.cls.methods.has(name))) return ['this', name];
    return [name];
  }
}
