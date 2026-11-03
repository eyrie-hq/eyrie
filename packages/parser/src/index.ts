import { createHash } from 'node:crypto';
import type { FileFacts, SourceLanguage } from '@eyrie/core';
import type { BaseExtractor } from './base.js';
import { CSharpExtractor } from './csharp.js';
import { GoExtractor } from './go.js';
import { JavaExtractor } from './java.js';
import { ParserPool, SOURCE_EXTENSIONS, detectLanguage, type GrammarLanguage } from './languages.js';
import { PhpExtractor } from './php.js';
import { extractPrisma } from './prisma.js';
import { PythonExtractor } from './python.js';
import { RubyExtractor } from './ruby.js';
import { RustExtractor } from './rust.js';
import { extractSecurity } from './security.js';
import { TypeScriptExtractor } from './typescript.js';

export { SOURCE_EXTENSIONS, detectLanguage, grammarFiles } from './languages.js';
export { goPackageName } from './go.js';
export { extractSecurity } from './security.js';

/** Bump whenever extraction output changes so cached facts are re-parsed. */
export const FACTS_VERSION = '5';

/**
 * A language adapter turns one file into facts. Adding a language means
 * adding an adapter; nothing downstream depends on tree-sitter.
 */
export interface LanguageAdapter {
  readonly id: string;
  readonly languages: readonly SourceLanguage[];
  extract(path: string, source: string, language: GrammarLanguage): Promise<FileFacts | null>;
  dispose(): void;
}

export function contentHash(source: string): string {
  return createHash('sha1').update(source).digest('hex').slice(0, 16);
}

type ExtractorClass = new (path: string, language: SourceLanguage, hash: string, source: string) => Pick<BaseExtractor, 'run'>;

const EXTRACTORS: Record<GrammarLanguage, ExtractorClass> = {
  typescript: TypeScriptExtractor,
  tsx: TypeScriptExtractor,
  javascript: TypeScriptExtractor,
  jsx: TypeScriptExtractor,
  python: PythonExtractor,
  go: GoExtractor,
  java: JavaExtractor,
  rust: RustExtractor,
  csharp: CSharpExtractor,
  php: PhpExtractor,
  ruby: RubyExtractor,
};

/** Every tree-sitter language: parse once, hand the tree to that language's extractor. */
export class TreeSitterAdapter implements LanguageAdapter {
  readonly id = 'tree-sitter';
  readonly languages = Object.keys(EXTRACTORS) as GrammarLanguage[];
  private pool = new ParserPool();

  async extract(path: string, source: string, language: GrammarLanguage): Promise<FileFacts | null> {
    const parser = await this.pool.get(language);
    const tree = parser.parse(source);
    if (!tree) return null;
    try {
      const facts = new EXTRACTORS[language](path, language, contentHash(source), source).run(tree.rootNode);
      facts.security = extractSecurity(path, language, facts, source);
      return facts;
    } finally {
      tree.delete();
    }
  }

  dispose(): void {
    this.pool.dispose();
  }
}

/** Files that are too large or look minified are skipped. */
export function shouldSkipSource(source: string): boolean {
  if (source.length > 1_000_000) return true;
  const lines = source.split('\n', 50);
  const longest = Math.max(...lines.map((l) => l.length));
  return longest > 2_000 && lines.length < 5;
}

export class SourceParser {
  private adapter = new TreeSitterAdapter();

  supports(path: string): boolean {
    return detectLanguage(path) !== null;
  }

  async parse(path: string, source: string): Promise<FileFacts | null> {
    const language = detectLanguage(path);
    if (!language || shouldSkipSource(source)) return null;
    if (language === 'prisma') return extractPrisma(path, source, contentHash(source));
    return this.adapter.extract(path, source, language);
  }

  dispose(): void {
    this.adapter.dispose();
  }
}

export const supportedExtensions = SOURCE_EXTENSIONS;
