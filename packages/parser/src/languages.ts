import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { Language, Parser } from 'web-tree-sitter';
import type { SourceLanguage } from '@eyrie/core';

/**
 * Lazily, because this module also bundles to CommonJS for the desktop app's
 * single-executable `eyrie`, where import.meta does not exist. Bundled builds
 * always set EYRIE_GRAMMAR_DIR, so this is never reached there.
 */
let cachedRequire: NodeRequire | null = null;
function wasmRequire(): NodeRequire {
  cachedRequire ??= createRequire(import.meta.url);
  return cachedRequire;
}
const require = { resolve: (id: string): string => wasmRequire().resolve(id) };

type GrammarLanguage = Exclude<SourceLanguage, 'prisma'>;

const GRAMMARS: Record<GrammarLanguage, string> = {
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  go: 'tree-sitter-go/tree-sitter-go.wasm',
  java: 'tree-sitter-java/tree-sitter-java.wasm',
  rust: 'tree-sitter-rust/tree-sitter-rust.wasm',
  csharp: 'tree-sitter-c-sharp/tree-sitter-c_sharp.wasm',
  php: 'tree-sitter-php/tree-sitter-php.wasm',
  ruby: 'tree-sitter-ruby/tree-sitter-ruby.wasm',
};

const EXTENSIONS: Record<string, SourceLanguage> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.rs': 'rust',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.prisma': 'prisma',
};

export type { GrammarLanguage };

export const SOURCE_EXTENSIONS = Object.keys(EXTENSIONS);

/** Generated code that would only add noise to the graph. */
const GENERATED = /(\.d\.[mc]?ts|\.pb\.go|_pb2(_grpc)?\.py|\.g\.cs|\.designer\.cs|\.generated\.cs|AssemblyInfo\.cs)$/i;

export function detectLanguage(path: string): SourceLanguage | null {
  if (GENERATED.test(path)) return null;
  const dot = path.lastIndexOf('.');
  if (dot === -1) return null;
  return EXTENSIONS[path.slice(dot).toLowerCase()] ?? null;
}

const RUNTIME_WASM = 'web-tree-sitter/web-tree-sitter.wasm';

/**
 * Every WASM file the parser loads: tree-sitter's runtime and each grammar.
 * A bundled build (the desktop app) copies these into one folder and points
 * `EYRIE_GRAMMAR_DIR` at it, because it has no `node_modules` to resolve from.
 */
export function grammarFiles(): string[] {
  return [...new Set([RUNTIME_WASM, ...Object.values(GRAMMARS)])].map((f) => require.resolve(f));
}

/** Read when the first file is parsed, so a host can set it after importing the parser. */
function grammarDir(): string | undefined {
  return process.env.EYRIE_GRAMMAR_DIR || undefined;
}

function wasmPath(file: string, dir = grammarDir()): string {
  return dir ? join(dir, basename(file)) : require.resolve(file);
}

let initPromise: Promise<void> | null = null;
const languages = new Map<GrammarLanguage, Promise<Language>>();

export async function loadLanguage(lang: GrammarLanguage): Promise<Language> {
  const dir = grammarDir();
  initPromise ??= Parser.init(dir ? { locateFile: (name: string) => join(dir, name) } : undefined);
  await initPromise;
  let pending = languages.get(lang);
  if (!pending) {
    pending = Language.load(wasmPath(GRAMMARS[lang], dir));
    languages.set(lang, pending);
  }
  return pending;
}

/** One parser per language; tree-sitter parsers are cheap to reuse. */
export class ParserPool {
  private parsers = new Map<GrammarLanguage, Parser>();

  async get(lang: GrammarLanguage): Promise<Parser> {
    let parser = this.parsers.get(lang);
    if (!parser) {
      const language = await loadLanguage(lang);
      parser = new Parser();
      parser.setLanguage(language);
      this.parsers.set(lang, parser);
    }
    return parser;
  }

  dispose(): void {
    for (const p of this.parsers.values()) p.delete();
    this.parsers.clear();
  }
}
