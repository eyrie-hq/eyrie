/**
 * Security facts for the health check, derived per file from what the
 * extractors already record plus lexical scans for what they do not.
 *
 * References (tree-sitter, precise) give call-based env reads, webhook
 * verification calls and call-based auth guards. A line scan over the source
 * with comments stripped gives member env reads (`process.env.X`), secret-
 * shaped literals, decorators and attributes, and middleware matchers.
 *
 * Secret facts are locations only: the kind names the pattern that matched,
 * never the value. Nothing here reads another file or the network.
 */
import type { AuthGuardFact, EnvReadFact, FileFacts, ReferenceFact, SecretFact, SecurityFacts, SourceLanguage, WebhookVerifyFact } from '@eyrie/core';

/** Dotted callee whose first string argument names the variable. */
const ENV_CALLS = new Set([
  'os.getenv',
  'os.environ.get',
  'os.Getenv',
  'os.LookupEnv',
  'System.getenv',
  'Environment.GetEnvironmentVariable',
  'GetEnvironmentVariable',
  'getenv',
  'env.var',
]);

/** Session and auth calls that guard a route. Bare `auth()` is deliberately absent: too broad. */
const GUARD_CALLS = new Set([
  'getServerSession',
  'getAuth',
  'requireAuth',
  'requireRole',
  'withAuth',
  'authenticate',
  'require_auth',
  'require_login',
  'get_current_user',
  'get_current_active_user',
  'jwt_required',
  'login_required',
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function dotted(ref: ReferenceFact): string {
  return ref.callee.join('.');
}

function firstStringArg(ref: ReferenceFact): string | null {
  const arg = ref.args?.[0];
  return typeof arg === 'string' ? arg : null;
}

function fromReferences(facts: FileFacts): { env: EnvReadFact[]; webhooks: WebhookVerifyFact[]; guards: AuthGuardFact[] } {
  const env: EnvReadFact[] = [];
  const webhooks: WebhookVerifyFact[] = [];
  const guards: AuthGuardFact[] = [];
  for (const ref of facts.references) {
    const callee = dotted(ref);
    if ((ref.kind === 'call' || ref.kind === 'ref') && ENV_CALLS.has(callee)) {
      const name = firstStringArg(ref);
      if (name && ENV_NAME.test(name)) env.push({ name, line: ref.line });
      continue;
    }
    if (ref.kind === 'call' && /(^|\.)(constructEvent|construct_event|ConstructEvent)$/.test(callee)) {
      webhooks.push({ line: ref.line, callee });
      continue;
    }
    if (ref.kind === 'call' && /(^|\.)verify$/.test(callee) && /(webhook|svix)/i.test(callee)) {
      webhooks.push({ line: ref.line, callee });
      continue;
    }
    // A Svix verifier under construction: `wh.verify` below it names only the
    // variable, so the constructor is the signal that reaches us.
    if (ref.kind === 'new' && callee === 'Webhook') {
      webhooks.push({ line: ref.line, callee: 'new Webhook' });
      continue;
    }
    if (ref.kind === 'call' && ref.callee.length && GUARD_CALLS.has(ref.callee[ref.callee.length - 1]!)) {
      guards.push({ line: ref.line, kind: 'auth-call' });
    }
  }
  return { env, webhooks, guards };
}

const MEMBER_ENV: { languages: SourceLanguage[]; pattern: RegExp }[] = [
  { languages: ['typescript', 'tsx', 'javascript', 'jsx', 'vue'], pattern: /\bprocess\.env\.([A-Za-z_]\w*)|\bprocess\.env\[['"]([^'"]+)['"]\]|\bimport\.meta\.env\.([A-Za-z_]\w*)/g },
  { languages: ['python'], pattern: /\bos\.environ\[['"]([^'"]+)['"]\]|\bos\.environ\.get\(\s*['"]([^'"]+)['"]/g },
  { languages: ['php'], pattern: /\$_(?:ENV|SERVER)\[['"]([^'"]+)['"]/g },
  { languages: ['ruby'], pattern: /\bENV\[['"]?([^'"\]\s]+)['"]?\]/g },
  { languages: ['rust'], pattern: /\benv::var\(\s*"([^"]+)"|\benv!\(\s*"([^"]+)"|\boption_env!\(\s*"([^"]+)"/g },
  { languages: ['swift'], pattern: /ProcessInfo\.processInfo\.environment\[\s*["']([^"']+)["']/g },
  { languages: ['dart'], pattern: /Platform\.environment\[\s*['"]([^'"]+)['"]/g },
  { languages: ['objc'], pattern: /\benvironment\[\s*@"([^"]+)"/g },
];

const SECRET_PATTERNS: { kind: string; pattern: RegExp }[] = [
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'github-token', pattern: /\b(ghp|gho)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'stripe-key', pattern: /\b[rs]k_(live|test)_[A-Za-z0-9]{10,}\b/ },
  { kind: 'stripe-webhook-secret', pattern: /\bwhsec_[A-Za-z0-9]{10,}\b/ },
  { kind: 'private-key', pattern: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/ },
  { kind: 'aws-secret-key', pattern: /\b[A-Za-z0-9/+=]{40}\b/ },
];

/** Values that look assigned but are placeholders, not secrets. */
const PLACEHOLDERS = /^(test|example|placeholder|changeme|your[-_].*|xxx+|\*+|password123|secret123)$/i;

/** An assigned literal worth flagging: quoted, no whitespace, not a placeholder. */
function assignedSecret(line: string): boolean {
  const m = /\b(password|passwd|secret|api[-_]?key|apikey|auth[-_]?token|access[-_]?token|client[-_]?secret)\b\s*[:=]\s*['"]([^'"]+)['"]/i.exec(line);
  if (!m) return false;
  const value = m[2]!;
  return value.length >= 8 && !/\s/.test(value) && !PLACEHOLDERS.test(value);
}

const GUARD_PATTERNS: { kind: string; pattern: RegExp }[] = [
  { kind: 'decorator', pattern: /@(login_required|jwt_required|permission_classes|PreAuthorize|Secured|RolesAllowed)\b/ },
  { kind: 'attribute', pattern: /\[Authorize\b/ },
  { kind: 'route-middleware', pattern: /middleware\(\s*['"]auth/ },
  { kind: 'filter', pattern: /before_action\s+:authenticate|authenticate_user!|require_login/ },
  { kind: 'dependency', pattern: /Depends\(\s*get_current_\w+/ },
];

function stripLine(line: string, language: SourceLanguage, block: { open: boolean }): string {
  let out = line;
  const cLike = language === 'typescript' || language === 'tsx' || language === 'javascript' || language === 'jsx' || language === 'go' || language === 'java' || language === 'rust' || language === 'csharp' || language === 'php' || language === 'kotlin' || language === 'swift' || language === 'c' || language === 'cpp' || language === 'dart' || language === 'vue' || language === 'objc';
  if (cLike) {
    if (block.open) {
      const end = out.indexOf('*/');
      if (end === -1) return '';
      out = out.slice(end + 2);
      block.open = false;
    }
    for (;;) {
      const start = out.indexOf('/*');
      if (start === -1) break;
      const end = out.indexOf('*/', start + 2);
      if (end === -1) {
        out = out.slice(0, start);
        block.open = true;
        break;
      }
      out = out.slice(0, start) + out.slice(end + 2);
    }
  }
  // A comment marker starts a comment at the line start or after whitespace;
  // `https://` inside a string is not one. (PHP is C-like, so it takes the
  // first branch; every other language here comments with `#`, except Lua.)
  const tokens = cLike ? ['//'] : language === 'lua' ? ['--'] : ['#'];
  for (const token of tokens) {
    const at = out.indexOf(token);
    if (at === 0 || (at > 0 && /[\s;({[,=]/.test(out[at - 1]!))) {
      out = out.slice(0, at);
      break;
    }
  }
  return out;
}

/** The matcher array of a Next.js-style middleware file, when this file is one. */
function middlewareMatcher(path: string, source: string): { line: number; detail: string } | null {
  if (!/(^|\/)middleware\.(ts|js|mts|cts)$/.test(path)) return null;
  const m = /matcher\s*:\s*\[([\s\S]*?)\]/.exec(source);
  if (!m) return null;
  const line = source.slice(0, m.index).split('\n').length;
  return { line, detail: m[1]!.trim().slice(0, 500) };
}

export function extractSecurity(path: string, language: SourceLanguage, facts: FileFacts, source: string): SecurityFacts {
  const fromRefs = fromReferences(facts);
  const block = { open: false };
  const lines = source.split('\n');
  const env: EnvReadFact[] = [...fromRefs.env];
  const secrets: SecretFact[] = [];
  const webhooks: WebhookVerifyFact[] = [...fromRefs.webhooks];
  const guards: AuthGuardFact[] = [...fromRefs.guards];

  const member = MEMBER_ENV.filter((m) => m.languages.includes(language)).map((m) => m.pattern);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = stripLine(raw, language, block);
    if (!line.trim()) return;
    for (const pattern of member) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(line))) {
        const name = m.slice(1).find((g) => g !== undefined);
        if (!name || !ENV_NAME.test(name)) continue;
        // The reference walk usually catches the same read; keep one entry.
        if (!env.some((e) => e.line === lineNo && e.name === name)) env.push({ name, line: lineNo });
      }
    }
    for (const { kind, pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (kind === 'aws-secret-key') {
        // A bare 40-char token is noise; next to `aws` it is a secret key.
        if (/aws/i.test(line) && pattern.test(line)) secrets.push({ line: lineNo, kind });
      } else if (pattern.test(line)) {
        secrets.push({ line: lineNo, kind });
      }
    }
    if (assignedSecret(line) && !secrets.some((s) => s.line === lineNo)) secrets.push({ line: lineNo, kind: 'assigned-secret' });
    for (const { kind, pattern } of GUARD_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) guards.push({ line: lineNo, kind });
    }
  });

  const matcher = middlewareMatcher(path, source);
  if (matcher) guards.push({ line: matcher.line, kind: 'middleware-matcher', detail: matcher.detail });

  // References and the line scan merge here; source order keeps findings stable.
  // One guard per line: the scan kind names the mechanism, the call kind is fallback.
  const guardByLine = new Map<number, AuthGuardFact>();
  for (const g of guards) {
    if (guardByLine.get(g.line)?.kind !== 'auth-call' && guardByLine.has(g.line)) continue;
    guardByLine.set(g.line, g);
  }
  env.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { env, secrets, webhooks, guards: [...guardByLine.values()].sort((a, b) => a.line - b.line) };
}
