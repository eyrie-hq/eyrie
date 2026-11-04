/**
 * Objective-C language adapter.
 *
 * Extends the C adapter: `#import` / `#include` includes (quoted and
 * angle-bracket), plain C functions, globals, structs and enums in `.m`
 * files all reuse the C declaration logic. On top it records
 * `@interface` / `@implementation` classes (including `Name(Category)`
 * categories and `Name ()` class extensions, which merge into one class
 * symbol), `@protocol` interfaces, methods with full selector names
 * (`doThing:with:`), `@property` and instance-variable fields, and
 * `[receiver selector:arg]` message sends as call references chained
 * from the receiver (`self` becomes `this`, `[super ...]` becomes
 * `super`).
 *
 * Grammar gaps (tree-sitter-objc): `NS_ENUM` / `NS_OPTIONS` macros and
 * forward `@interface Foo;` declarations (missing `@end`) produce parse
 * errors; `.h` headers stay mapped to C++, so interfaces only resolve
 * when they also appear in an implementation file.
 */
import type { Node } from 'web-tree-sitter';
import type { SymbolFact } from '@eyrie/core';
import { CExtractor, declaratorName, declaratorNames } from './c.js';

const MAX_CHAIN = 6;

export class ObjcExtractor extends CExtractor {
  protected override collectTypeNames(node: Node): void {
    super.collectTypeNames(node);
    for (const t of ['class_interface', 'class_implementation', 'protocol_declaration']) {
      for (const n of node.descendantsOfType(t)) {
        const name = n.namedChildren[0];
        if (name?.type === 'identifier') this.typeNames.add(name.text);
      }
    }
  }

  protected override isTypeNode(node: Node): boolean {
    return super.isTypeNode(node) || node.type === 'type_name' || node.type === 'typedefed_specifier' || node.type === 'generic_specifier';
  }

  protected override typeOf(typeNode: Node | null | undefined): string | undefined {
    if (!typeNode) return undefined;
    switch (typeNode.type) {
      case 'type_name':
        return this.typeOf(typeNode.namedChildren.find((c) => !!c && this.isTypeNode(c)));
      case 'typedefed_specifier': {
        // `id`, `BOOL`, `SEL`, and `id<Proto>` collapse to their base name.
        const m = /^[A-Za-z_]\w*/.exec(typeNode.text);
        return m ? m[0] : undefined;
      }
      case 'generic_specifier':
        return typeNode.namedChildren.find((c) => c?.type === 'type_identifier')?.text;
      default:
        return super.typeOf(typeNode);
    }
  }

  protected override topLevel(node: Node): void {
    switch (node.type) {
      case 'class_interface':
        return this.classInterface(node);
      case 'class_implementation':
        return this.classImplementation(node);
      case 'protocol_declaration':
        return this.protocolDecl(node);
      case 'class_declaration':
      case 'protocol_forward_declaration':
        // `@class Foo;` and `@protocol P;` bind nothing, like C forward declarations.
        return;
      default:
        return super.topLevel(node);
    }
  }

  /** Get-or-create: interfaces, extensions and implementations merge into one class symbol. */
  private objcClass(name: string, node: Node): SymbolFact {
    const existing = this.symbolsByName.get(name);
    if (existing) {
      existing.fields ??= [];
      return existing;
    }
    const sym = this.symbol(name, 'class', node, true);
    const doc = this.leadingDoc(node);
    if (doc) sym.doc = doc;
    sym.fields = [];
    this.addSymbol(sym);
    return this.symbolsByName.get(name)!;
  }

  /** `@interface Name : Super <Proto>`, `Name (Category)` and `Name ()` extensions. */
  private classInterface(node: Node): void {
    const nameNode = node.namedChildren[0];
    if (!nameNode || nameNode.type !== 'identifier') return;
    const category = node.childForFieldName('category')?.text;
    const sym = this.objcClass(category ? `${nameNode.text}(${category})` : nameNode.text, node);
    const superclass = node.childForFieldName('superclass')?.text;
    if (superclass && !sym.extends) sym.extends = [superclass];
    const protos = node.namedChildren
      .find((c) => c?.type === 'parameterized_arguments')
      ?.namedChildren.filter((c): c is Node => !!c)
      .map((c) => this.typeOf(c))
      .filter((t): t is string => !!t);
    if (protos?.length && !sym.implements) sym.implements = protos;
    for (const m of node.namedChildren) {
      if (!m) continue;
      if (m.type === 'instance_variables') {
        for (const v of m.namedChildren) if (v?.type === 'instance_variable') this.objcFields(v, sym);
      } else if (m.type === 'property_declaration') {
        this.propertyDecl(m, sym);
      } else if (m.type === 'method_declaration') {
        this.methodDecl(m, sym, null);
      }
    }
  }

  private classImplementation(node: Node): void {
    const nameNode = node.namedChildren[0];
    if (!nameNode || nameNode.type !== 'identifier') return;
    const category = node.childForFieldName('category')?.text;
    const sym = this.objcClass(category ? `${nameNode.text}(${category})` : nameNode.text, node);
    for (const m of node.namedChildren) {
      if (!m) continue;
      if (m.type === 'instance_variables') {
        for (const v of m.namedChildren) if (v?.type === 'instance_variable') this.objcFields(v, sym);
      } else if (m.type === 'implementation_definition') {
        const def = m.namedChildren.find((c) => !!c);
        // `property_implementation` (`@synthesize` / `@dynamic`) binds nothing new.
        if (def?.type === 'method_definition') {
          this.methodDecl(def, sym, def.namedChildren.find((c) => c?.type === 'compound_statement') ?? null);
        }
      }
    }
  }

  private protocolDecl(node: Node): void {
    const nameNode = node.namedChildren[0];
    if (!nameNode || nameNode.type !== 'identifier') return;
    let sym = this.symbolsByName.get(nameNode.text);
    if (!sym) {
      sym = this.symbol(nameNode.text, 'interface', node, true);
      const doc = this.leadingDoc(node);
      if (doc) sym.doc = doc;
      sym.fields = [];
      this.addSymbol(sym);
      sym = this.symbolsByName.get(nameNode.text)!;
    }
    sym.fields ??= [];
    const refs = node.namedChildren.find((c) => c?.type === 'protocol_reference_list');
    if (refs && !sym.extends) {
      const bases = refs.namedChildren.filter((c) => c?.type === 'identifier').map((c) => c!.text);
      if (bases.length) sym.extends = bases;
    }
    for (const m of node.namedChildren) {
      if (!m) continue;
      if (m.type === 'property_declaration') this.propertyDecl(m, sym);
      else if (m.type === 'method_declaration') this.methodDecl(m, sym, null);
      else if (m.type === 'qualified_protocol_interface_declaration') {
        // `@optional` / `@required` sections hold plain declarations.
        for (const q of m.namedChildren) {
          if (q?.type === 'method_declaration') this.methodDecl(q, sym, null);
          else if (q?.type === 'property_declaration') this.propertyDecl(q, sym);
        }
      }
    }
  }

  private propertyDecl(node: Node, owner: SymbolFact): void {
    for (const s of node.namedChildren) if (s?.type === 'struct_declaration') this.objcFields(s, owner);
  }

  /** Fields from a `@property` or instance variable (both wrap `struct_declaration`). */
  private objcFields(node: Node, owner: SymbolFact): void {
    const decl = node.type === 'struct_declaration' ? node : node.namedChildren.find((c) => c?.type === 'struct_declaration');
    if (!decl) return;
    // Block-typed properties (`void (^completion)(...)`) carry no useful type name.
    const isBlock = decl.descendantsOfType('block_pointer_declarator').length > 0;
    const t = isBlock ? undefined : this.typeOf(decl.namedChildren.find((c) => !!c && this.isTypeNode(c)));
    for (const d of decl.namedChildren.filter((c) => !!c && (c.type === 'struct_declarator' || c.type === 'identifier' || c.type === 'field_identifier'))) {
      const name = d.type === 'struct_declarator' ? this.structDeclaratorName(d) : d.text;
      if (!name) continue;
      if (!owner.fields!.some((e) => e.name === name)) owner.fields!.push(t ? { name, type: t } : { name });
    }
  }

  /**
   * The name a `struct_declarator` binds. Unlike the C declarators, it
   * carries no `declarator` field, so the shared helper cannot see
   * through it to the bare identifier or pointer inside.
   */
  private structDeclaratorName(decl: Node): string | null {
    const inner = decl.namedChildren.find((c) => !!c);
    if (!inner) return null;
    if (inner.type === 'identifier' || inner.type === 'field_identifier') return inner.text;
    return declaratorName(inner)?.name ?? null;
  }

  /** `doThing:(int)x with:(NSString *)s` → selector `doThing:with:` plus typed parameters. */
  private methodSelector(node: Node): { selector: string; params: { name: string; type: string | undefined }[] } {
    const kids = node.namedChildren.filter((c): c is Node => !!c);
    const rest = kids[0]?.type === 'method_type' ? kids.slice(1) : kids;
    let selector = '';
    const params: { name: string; type: string | undefined }[] = [];
    for (let i = 0; i < rest.length; i++) {
      const k = rest[i]!;
      if (k.type === 'identifier') {
        selector += rest[i + 1]?.type === 'method_parameter' ? `${k.text}:` : k.text;
      } else if (k.type === 'method_parameter') {
        const name = k.namedChildren.find((c) => c?.type === 'identifier')?.text;
        const mtype = k.namedChildren.find((c) => c?.type === 'method_type');
        if (name) params.push({ name, type: this.typeOf(mtype?.namedChildren.find((c) => !!c && this.isTypeNode(c))) });
      }
    }
    return { selector, params };
  }

  /**
   * A method declaration or definition. Interface declarations always
   * become symbols (they are the link targets); a definition merges into
   * the declared symbol so bodies are walked once.
   */
  private methodDecl(node: Node, owner: SymbolFact, body: Node | null): void {
    const { selector, params } = this.methodSelector(node);
    if (!selector) return;
    const qname = `${owner.qualifiedName}.${selector}`;
    let sym = this.symbolsByName.get(qname);
    if (!sym) {
      sym = this.symbol(selector, 'method', node, true, owner.qualifiedName);
      const doc = this.leadingDoc(node);
      if (doc) sym.doc = doc;
      sym.locals = {};
      this.addSymbol(sym);
      sym = this.symbolsByName.get(qname)!;
    }
    sym.locals ??= {};
    const declared = new Set<string>();
    for (const p of params) {
      declared.add(p.name);
      if (p.type) sym.locals[p.name] = p.type;
    }
    if (body) {
      this.declared.push(declared);
      this.withScope({ name: sym.qualifiedName, locals: sym.locals }, () => this.walk(body));
      this.declared.pop();
    }
  }

  /** Splits a message send into its receiver, full selector and argument expressions. */
  private messageParts(node: Node): { receiver: Node | null; selector: string; args: Node[] } {
    const receiver = node.childrenForFieldName('receiver')[0] ?? node.namedChildren[0] ?? null;
    const methods = new Set(node.childrenForFieldName('method').map((m) => m.startIndex));
    let selector = '';
    const args: Node[] = [];
    const kids = node.namedChildren.filter((c): c is Node => !!c && c.startIndex !== receiver?.startIndex);
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if (methods.has(k.startIndex)) {
        const next = kids[i + 1];
        selector += next && !methods.has(next.startIndex) ? `${k.text}:` : k.text;
      } else {
        args.push(k);
      }
    }
    return { receiver, selector, args };
  }

  /** `[receiver selector:arg]` records a call chained from the receiver. */
  private messageSend(node: Node): void {
    const { receiver, selector, args } = this.messageParts(node);
    const recv = this.chain(receiver);
    if (recv && selector) {
      const callee = [...recv, selector];
      this.addRef(this.callKind(callee), callee, node, args.slice(0, 3).map((a) => this.argLiteral(a)));
    }
    if (receiver && receiver.type !== 'identifier' && receiver.type !== 'field_identifier' && receiver.type !== 'type_identifier') this.walk(receiver);
    for (const a of args) this.argument(a);
  }

  protected override rootName(name: string): string[] {
    if (name === 'self') return ['this'];
    return [name];
  }

  protected override chain(node: Node | null | undefined): string[] | null {
    if (node?.type === 'message_expression') {
      const { receiver, selector } = this.messageParts(node);
      const base = this.chain(receiver);
      if (!base || !selector || base.length >= MAX_CHAIN) return null;
      return [...base, `${selector}()`];
    }
    return super.chain(node);
  }

  protected override walk(node: Node): void {
    switch (node.type) {
      case 'message_expression':
        return this.messageSend(node);
      case 'block_literal': {
        // Block parameters scope like lambdas: declared, not symbol locals.
        const declared = new Set<string>();
        const params = node.namedChildren.find((c) => c?.type === 'parameter_list');
        for (const p of params?.namedChildren ?? []) {
          if (p?.type !== 'parameter_declaration') continue;
          const d = p.namedChildren.find((c) => !!c && (/declarator$/.test(c.type) || c.type === 'identifier') && !c.type.startsWith('abstract'));
          for (const n of declaratorNames(d)) declared.add(n);
        }
        this.declared.push(declared);
        for (const c of node.namedChildren) if (c) this.walk(c);
        this.declared.pop();
        return;
      }
      case 'selector_expression':
        // `@selector(name)` names a method without invoking it.
        return;
      default:
        return super.walk(node);
    }
  }
}
