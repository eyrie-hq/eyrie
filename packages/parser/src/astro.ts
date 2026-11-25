/**
 * Astro component adapter.
 *
 * No tree-sitter Astro grammar ships a loadable WASM, and the parts that hold
 * code are TypeScript, so a .astro file is split like a Vue SFC: the
 * frontmatter (between the leading `---` fences) and each bundled `<script>`
 * are parsed with the TypeScript grammar and walked by the TypeScript
 * extractor, padded with blank lines so every recorded line number is
 * file-absolute. The template contributes component-tag references (kind
 * 'jsx', like TSX). `<style>` blocks, `<script is:inline>` and
 * `<script src>` (which Astro does not bundle) are ignored, and so are
 * expressions inside the template.
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

const lineAt = (source: string, offset: number) => source.slice(0, offset).split('\n').length;

/** The frontmatter, and where the template starts. Astro only accepts the fence first in the file. */
function frontmatter(source: string): { block: Block | null; templateStart: number } {
  const open = /^\s*---[ \t]*\r?\n/.exec(source);
  if (!open) return { block: null, templateStart: 0 };
  const bodyStart = open[0].length;
  const close = /^---[ \t]*\r?$/m.exec(source.slice(bodyStart));
  if (!close) return { block: null, templateStart: 0 };
  const bodyEnd = bodyStart + close.index;
  return { block: { startLine: lineAt(source, bodyStart), body: source.slice(bodyStart, bodyEnd) }, templateStart: bodyEnd + close[0].length };
}

/** `<script>` and `<style>` elements of the template, with their attributes. */
function elements(source: string, from: number, tag: 'script' | 'style'): { start: number; end: number; attrs: string; block: Block }[] {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    out.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] ?? '', block: { startLine: lineAt(source, bodyStart), body: m[2] ?? '' } });
  }
  return out;
}

/** Astro bundles a script unless it is inline or loads another file. */
const bundled = (attrs: string) => !/\bis:inline\b|\bsrc\s*=/.test(attrs);

/** Built-in elements that are never imported components. */
const BUILTINS = new Set(['Fragment']);

/**
 * Component tags: a capitalised name (`<Card>`) or a member of an imported
 * namespace (`<UI.Button>`). Lowercase tags are HTML.
 */
function templateRefs(source: string, from: number, skip: { start: number; end: number }[]): ReferenceFact[] {
  const refs: ReferenceFact[] = [];
  const re = /<([A-Za-z_$][\w$]*(?:\.[\w$]+)*)/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const at = m.index;
    if (skip.some((s) => at >= s.start && at < s.end)) continue;
    const callee = m[1]!.split('.');
    if (callee.length === 1 && !/^[A-Z]/.test(callee[0]!)) continue;
    if (BUILTINS.has(callee[0]!)) continue;
    refs.push({ from: '', kind: 'jsx', callee, line: lineAt(source, at) });
  }
  return refs;
}

export async function extractAstro(path: string, source: string, hash: string): Promise<FileFacts | null> {
  const pool = new ParserPool();
  try {
    const parser = await pool.get('typescript');
    const facts: FileFacts = {
      path,
      language: 'astro',
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
    const { block, templateStart } = frontmatter(source);
    const scripts = elements(source, templateStart, 'script');
    const styles = elements(source, templateStart, 'style');
    const code = [...(block ? [block] : []), ...scripts.filter((s) => bundled(s.attrs)).map((s) => s.block)];
    for (const s of code) {
      const padded = '\n'.repeat(s.startLine - 1) + s.body;
      const tree = parser.parse(padded);
      if (!tree) continue;
      try {
        const part = new TypeScriptExtractor(path, 'astro', hash, padded).run(tree.rootNode);
        facts.directives.push(...part.directives);
        facts.imports.push(...part.imports);
        facts.exports.push(...part.exports);
        facts.symbols.push(...part.symbols);
        facts.references.push(...part.references);
        facts.routes.push(...part.routes);
        facts.parseErrors += part.parseErrors;
        if (part.models) (facts.models ??= []).push(...part.models);
        if (part.routeMounts) (facts.routeMounts ??= []).push(...part.routeMounts);
      } finally {
        tree.delete();
      }
    }
    facts.references.push(...templateRefs(source, templateStart, [...scripts, ...styles]));
    facts.references.sort((a, b) => a.line - b.line);
    facts.security = extractSecurity(path, 'astro', facts, source);
    return facts;
  } finally {
    pool.dispose();
  }
}
