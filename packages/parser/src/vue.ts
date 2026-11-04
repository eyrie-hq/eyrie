/**
 * Vue single-file component adapter.
 *
 * No tree-sitter Vue grammar ships a loadable WASM, so a .vue file is split
 * into its <script> blocks and each block is parsed with the TypeScript
 * grammar and walked by the TypeScript extractor. Block sources are padded
 * with blank lines so every recorded line number is file-absolute. The
 * <template> block contributes component-tag references (kind 'jsx', like
 * TSX); <style> blocks are ignored.
 */
import type { FileFacts, ReferenceFact } from '@eyrie/core';
import { ParserPool } from './languages.js';
import { extractSecurity } from './security.js';
import { TypeScriptExtractor } from './typescript.js';

interface Block {
  /** 1-based line where the block body starts. */
  startLine: number;
  body: string;
}

function blocks(source: string, tag: 'script' | 'template'): Block[] {
  const out: Block[] = [];
  // Depth-counted so a nested `<template v-if>` does not end the outer block early.
  const re = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  let m: RegExpExecArray | null;
  let openEnd = -1;
  let depth = 0;
  while ((m = re.exec(source))) {
    if (m[0][1] === '/') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && openEnd >= 0) {
        out.push({ startLine: source.slice(0, openEnd).split('\n').length, body: source.slice(openEnd, m.index) });
        openEnd = -1;
      }
    } else {
      if (depth === 0) openEnd = m.index + m[0].length;
      depth++;
    }
  }
  return out;
}

/** Built-in tags that are never components. Lowercase names are HTML. */
const BUILTINS = new Set(['component', 'slot', 'template', 'transition', 'transition-group', 'keep-alive', 'teleport', 'suspense']);

function templateRefs(tpl: Block): ReferenceFact[] {
  const refs: ReferenceFact[] = [];
  const re = /<([A-Za-z][\w-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tpl.body))) {
    const tag = m[1]!;
    if (!/^[A-Z]/.test(tag) && !tag.includes('-')) continue;
    if (BUILTINS.has(tag) || BUILTINS.has(tag.toLowerCase())) continue;
    // Kebab-case tags name the PascalCase component (`order-list` → OrderList).
    const name = tag
      .split('-')
      .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : ''))
      .join('');
    if (!name) continue;
    refs.push({ from: '', kind: 'jsx', callee: [name], line: tpl.startLine + tpl.body.slice(0, m.index).split('\n').length - 1 });
  }
  return refs;
}

export async function extractVue(path: string, source: string, hash: string): Promise<FileFacts | null> {
  const pool = new ParserPool();
  try {
    const parser = await pool.get('typescript');
    const facts: FileFacts = {
      path,
      language: 'vue',
      hash,
      loc: source.split('\n').length,
      directives: [],
      imports: [],
      exports: [],
      symbols: [],
      references: [],
      routes: [],
      parseErrors: 0,
    };
    for (const s of blocks(source, 'script')) {
      const padded = '\n'.repeat(s.startLine - 1) + s.body;
      const tree = parser.parse(padded);
      if (!tree) continue;
      try {
        const part = new TypeScriptExtractor(path, 'vue', hash, padded).run(tree.rootNode);
        facts.directives.push(...part.directives);
        facts.imports.push(...part.imports);
        facts.exports.push(...part.exports);
        facts.symbols.push(...part.symbols);
        facts.references.push(...part.references);
        facts.routes.push(...part.routes);
        facts.parseErrors += part.parseErrors;
        if (part.namespace && !facts.namespace) facts.namespace = part.namespace;
        if (part.models) (facts.models ??= []).push(...part.models);
        if (part.routeMounts) (facts.routeMounts ??= []).push(...part.routeMounts);
      } finally {
        tree.delete();
      }
    }
    for (const tpl of blocks(source, 'template')) facts.references.push(...templateRefs(tpl));
    facts.references.sort((a, b) => a.line - b.line);
    facts.security = extractSecurity(path, 'vue', facts, source);
    return facts;
  } finally {
    pool.dispose();
  }
}
