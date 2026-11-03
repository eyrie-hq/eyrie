/**
 * Health rules: pure functions from the architecture graph and per-file
 * facts to findings. No file reads, no network, no git here; the caller
 * (the server's check adapter) assembles the {@link CheckInput}.
 *
 * Findings cite locations only. A finding about a secret names the pattern
 * that matched and the file and line, never the value.
 */
import type { ArchGraph, FileFacts } from '@eyrie/core';

export type Severity = 'high' | 'medium' | 'low';

export interface FindingFile {
  path: string;
  line?: number;
}

export interface Finding {
  /** Stable within a run: `<rule>:<path>:<line>:<detail>`. */
  id: string;
  rule: string;
  severity: Severity;
  title: string;
  /** One sentence, safe to show and to send to a model. */
  evidence: string;
  files: FindingFile[];
  componentIds: string[];
  /** Architecture edges to draw heavier when the finding is selected. */
  path?: [from: string, to: string][];
  /** A prompt the user can hand to an agent to fix this. */
  fixPrompt: string;
}

export interface FileCheckFacts {
  path: string;
  /** Parsed facts, present for source files the engine indexed. */
  facts?: FileFacts;
  /** Raw text, present only for files the engine never parses (.env, SQL, rules). */
  text?: string;
  ignored: boolean;
  tracked: boolean;
}

/** The code-level call graph, reduced to what the graph rules traverse. */
export interface CodeCallGraph {
  /** Caller code-node id to callee ids, CALLS edges only. */
  calls: Map<string, string[]>;
  /** Code-node id to its defining file. */
  nodeFile: Map<string, string>;
  /** Function-like code-node ids per file: where handler reachability starts. */
  fileNodes: Map<string, string[]>;
}

export interface CheckInput {
  arch: ArchGraph;
  files: FileCheckFacts[];
  code: CodeCallGraph;
  /** When set, only findings touching these files are returned. Rules still see the whole graph. */
  onlyFiles?: string[];
}

export interface RuleMeta {
  title: string;
  severity: Severity;
  description: string;
}

export const RULES: Record<string, RuleMeta> = {
  'hardcoded-secret': {
    title: 'Hardcoded secret',
    severity: 'high',
    description: 'A secret-shaped string literal is committed in source. Move it to an environment variable.',
  },
  'public-env-secret': {
    title: 'Secret in a public env var',
    severity: 'high',
    description: 'A client-visible variable (NEXT_PUBLIC_*, VITE_*, …) has a secret-sounding name, so the value ships to browsers.',
  },
  'env-file-exposed': {
    title: '.env file exposed',
    severity: 'medium',
    description: 'A .env file is tracked by git or not ignored, so secrets in it can leak into clones and deploys.',
  },
  'supabase-no-rls': {
    title: 'Supabase table without RLS',
    severity: 'high',
    description: 'A migration creates a table without enabling row-level security, leaving it open to any client with the anon key.',
  },
  'firebase-test-mode': {
    title: 'Firebase rules in test mode',
    severity: 'high',
    description: 'Security rules allow reads or writes when true, so anyone on the internet can read and write the data.',
  },
  'unguarded-write': {
    title: 'Public route reaches a write',
    severity: 'high',
    description: 'A route reaches a database write with no auth guard anywhere on the path.',
  },
  'client-env-leak': {
    title: 'Server env read in UI code',
    severity: 'medium',
    description: 'UI-lane code reads a server-only environment variable. Only public variables belong in the client.',
  },
  'unverified-webhook': {
    title: 'Webhook without verification',
    severity: 'high',
    description: 'A webhook handler never reaches a signature-verification call, so anyone can forge its events.',
  },
};

const byId = (a: Finding, b: Finding): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function archIdsForFile(arch: ArchGraph, path: string): string[] {
  return arch.nodes.filter((n) => n.files.includes(path)).map((n) => n.id);
}

function guardsIn(input: CheckInput, paths: readonly string[]): boolean {
  const set = new Set(paths);
  return input.files.some((f) => set.has(f.path) && (f.facts?.security?.guards.length ?? 0) > 0);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Secret-shaped literals committed in source. One finding per location. */
function hardcodedSecrets(input: CheckInput): Finding[] {
  const out: Finding[] = [];
  for (const file of input.files) {
    for (const secret of file.facts?.security?.secrets ?? []) {
      out.push({
        id: `hardcoded-secret:${file.path}:${secret.line}:${secret.kind}`,
        rule: 'hardcoded-secret',
        severity: 'high',
        title: 'Hardcoded secret',
        evidence: `A ${secret.kind} secret is committed at ${file.path}:${secret.line}.`,
        files: [{ path: file.path, line: secret.line }],
        componentIds: archIdsForFile(input.arch, file.path),
        fixPrompt: `Remove the hardcoded secret at ${file.path}:${secret.line} (a ${secret.kind} value). Read it from an environment variable instead, add the variable name to .env.example, and rotate the exposed value.`,
      });
    }
  }
  return out;
}

const PUBLIC_PREFIX = /^(NEXT_PUBLIC|VITE_|PUBLIC_|EXPO_PUBLIC|REACT_APP_|VUE_APP_|NUXT_PUBLIC_)/;
const SECRET_WORD = /(SECRET|PRIVATE|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|CLIENT[_-]?SECRET)/;

function publicEnvSecrets(input: CheckInput): Finding[] {
  const out: Finding[] = [];
  for (const file of input.files) {
    for (const read of file.facts?.security?.env ?? []) {
      if (!PUBLIC_PREFIX.test(read.name) || !SECRET_WORD.test(read.name)) continue;
      out.push({
        id: `public-env-secret:${file.path}:${read.line}:${read.name}`,
        rule: 'public-env-secret',
        severity: 'high',
        title: 'Secret in a public env var',
        evidence: `${read.name}, read at ${file.path}:${read.line}, is client-visible and sounds like a secret.`,
        files: [{ path: file.path, line: read.line }],
        componentIds: archIdsForFile(input.arch, file.path),
        fixPrompt: `The variable ${read.name}, read at ${file.path}:${read.line}, is exposed to browsers by its public prefix. Move the secret to a server-only variable and read it in server code instead.`,
      });
    }
  }
  return out;
}

const ENV_FILE = /(^|\/)\.env(\..+)?$/;
const ENV_TEMPLATE = /\.env\.(example|sample|template|example-.*)$/;

function envFilesExposed(input: CheckInput): Finding[] {
  const out: Finding[] = [];
  for (const file of input.files) {
    if (!ENV_FILE.test(file.path) || ENV_TEMPLATE.test(file.path)) continue;
    if (!file.tracked && file.ignored) continue;
    const why = file.tracked ? 'tracked by git' : 'not ignored';
    out.push({
      id: `env-file-exposed:${file.path}`,
      rule: 'env-file-exposed',
      severity: 'medium',
      title: '.env file exposed',
      evidence: `${file.path} is ${why}, so its secrets can leak.`,
      files: [{ path: file.path }],
      componentIds: [],
      fixPrompt: `${file.path} holds secrets and is ${why}. Add it to .gitignore${file.tracked ? ', stop tracking it with git rm --cached, and rotate every secret it held' : ''}.`,
    });
  }
  return out;
}

const MIGRATION_SQL = /(^|\/)(supabase\/migrations\/.*|.*migrations?\/.*)\.sql$/i;
const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"([^"]+)"|`([^`]+)|(\w+))/gi;
const ENABLE_RLS = /alter\s+table\s+(?:only\s+)?(?:"([^"]+)"|`([^`]+)|(\w+))[^;]*?enable\s+row\s+level\s+security/gi;

function supabaseNoRls(input: CheckInput): Finding[] {
  const out: Finding[] = [];
  for (const file of input.files) {
    if (!MIGRATION_SQL.test(file.path) || file.text === undefined) continue;
    const created = new Map<string, number>();
    for (const m of file.text.matchAll(CREATE_TABLE)) {
      const table = (m[1] ?? m[2] ?? m[3] ?? '').toLowerCase();
      if (table && !created.has(table)) created.set(table, lineOf(file.text, m.index));
    }
    if (!created.size) continue;
    const enabled = new Set<string>();
    for (const m of file.text.matchAll(ENABLE_RLS)) {
      enabled.add((m[1] ?? m[2] ?? m[3] ?? '').toLowerCase());
    }
    for (const [table, line] of created) {
      if (enabled.has(table)) continue;
      out.push({
        id: `supabase-no-rls:${file.path}:${line}:${table}`,
        rule: 'supabase-no-rls',
        severity: 'high',
        title: 'Supabase table without RLS',
        evidence: `Migration ${file.path}:${line} creates table ${table} without enabling row-level security.`,
        files: [{ path: file.path, line }],
        componentIds: archIdsForFile(input.arch, file.path),
        fixPrompt: `In ${file.path}, enable row-level security on the ${table} table (alter table ${table} enable row level security) and add the policies its clients need.`,
      });
    }
  }
  return out;
}

const FIRESTORE_RULES = /(^|\/)(firestore|storage)\.rules$/;
const RTDB_RULES = /(^|\/)database\.rules\.json$/;
const ALLOW_TRUE = /allow\s+[\w,\s]+:\s*if\s+true\b/g;
const RTDB_TRUE = /"(?:\.(?:read|write)|read|write)"\s*:\s*true\b/g;

function firebaseTestMode(input: CheckInput): Finding[] {
  const out: Finding[] = [];
  for (const file of input.files) {
    if (file.text === undefined) continue;
    const pattern = FIRESTORE_RULES.test(file.path) ? ALLOW_TRUE : RTDB_RULES.test(file.path) ? RTDB_TRUE : null;
    if (!pattern) continue;
    pattern.lastIndex = 0;
    for (const m of file.text.matchAll(pattern)) {
      const line = lineOf(file.text, m.index);
      out.push({
        id: `firebase-test-mode:${file.path}:${line}`,
        rule: 'firebase-test-mode',
        severity: 'high',
        title: 'Firebase rules in test mode',
        evidence: `${file.path}:${line} allows access when true: anyone on the internet can use it.`,
        files: [{ path: file.path, line }],
        componentIds: archIdsForFile(input.arch, file.path),
        fixPrompt: `In ${file.path}:${line}, replace the test-mode rule (if true) with one that requires authentication, and check what data was exposed while it was open.`,
      });
    }
  }
  return out;
}

const ROUTE_KINDS = new Set(['api_route', 'server_action']);

/**
 * A route that reaches a database write with no auth guard on the path.
 * The walk follows architecture edges out of each route; the first edge
 * carrying a write ends the path, and the files of every node on it must
 * hold no guard.
 */
function unguardedWrites(input: CheckInput): Finding[] {
  const out: Finding[] = [];
  const outgoing = new Map<string, { to: string; writes: boolean }[]>();
  for (const edge of input.arch.edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push({ to: edge.target, writes: edge.kinds.includes('WRITES_TO') });
    outgoing.set(edge.source, list);
  }
  const filesOf = (id: string): string[] => input.arch.nodes.find((n) => n.id === id)?.files ?? [];
  for (const route of input.arch.nodes) {
    if (!ROUTE_KINDS.has(route.kind)) continue;
    // Breadth-first: the shortest path to a write is the finding's path.
    const prev = new Map<string, string>([[route.id, '']]);
    const queue = [route.id];
    let writer: string | null = null;
    while (queue.length && !writer) {
      const current = queue.shift()!;
      for (const { to, writes } of outgoing.get(current) ?? []) {
        if (prev.has(to)) continue;
        prev.set(to, current);
        if (writes) {
          writer = to;
          break;
        }
        queue.push(to);
      }
    }
    if (!writer) continue;
    const chain = [writer];
    for (let at = prev.get(writer)!; at; at = prev.get(at)!) chain.unshift(at);
    const chainFiles = [...new Set(chain.flatMap(filesOf))];
    if (guardsIn(input, chainFiles)) continue;
    const label = route.sublabel ?? route.label;
    const target = input.arch.nodes.find((n) => n.id === writer)?.label ?? writer;
    const path: [string, string][] = chain.slice(1).map((id, i) => [chain[i]!, id]);
    out.push({
      id: `unguarded-write:${route.id}:${writer}`,
      rule: 'unguarded-write',
      severity: 'high',
      title: 'Public route reaches a write',
      evidence: `${label} reaches a write in ${target} with no auth guard on the path.`,
      files: route.files.map((path) => ({ path })),
      componentIds: chain,
      path,
      fixPrompt: `The route ${label} (${route.files.join(', ')}) reaches a database write in ${target} without authentication. Add an auth guard (getServerSession, requireAuth, or middleware) so unauthenticated requests are rejected before the write.`,
    });
  }
  return out;
}

/** UI-lane code reading server-only variables: only public names belong in the client. */
function clientEnvLeaks(input: CheckInput): Finding[] {
  const out: Finding[] = [];
  for (const node of input.arch.nodes) {
    if (node.lane !== 'ui') continue;
    for (const path of node.files) {
      const file = input.files.find((f) => f.path === path);
      for (const read of file?.facts?.security?.env ?? []) {
        if (PUBLIC_PREFIX.test(read.name)) continue;
        out.push({
          id: `client-env-leak:${path}:${read.line}:${read.name}`,
          rule: 'client-env-leak',
          severity: 'medium',
          title: 'Server env read in UI code',
          evidence: `${read.name}, read at ${path}:${read.line}, is server-only but this is UI code.`,
          files: [{ path, line: read.line }],
          componentIds: [node.id],
          fixPrompt: `UI code at ${path}:${read.line} reads the server-only variable ${read.name}. Move that read to server code (a route or server action) and pass the result down, or rename the variable with a public prefix if the value is safe for browsers.`,
        });
      }
    }
  }
  return out;
}

const WEBHOOK = /webhook/i;

/**
 * A webhook route whose handler never reaches a verification call. The
 * handler's file verifies the finding away when it holds a verification
 * call itself; otherwise the code call graph is walked from every function
 * in that file, and any reached file with a verification call clears it.
 */
function unverifiedWebhooks(input: CheckInput): Finding[] {
  const out: Finding[] = [];
  const verified = new Set(input.files.filter((f) => (f.facts?.security?.webhooks.length ?? 0) > 0).map((f) => f.path));
  const reachesVerification = (start: string): boolean => {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length) {
      for (const next of input.code.calls.get(queue.shift()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        const file = input.code.nodeFile.get(next);
        if (file && verified.has(file)) return true;
        queue.push(next);
      }
    }
    return false;
  };
  for (const file of input.files) {
    for (const route of file.facts?.routes ?? []) {
      const isWebhook = WEBHOOK.test(route.path) || WEBHOOK.test(file.path) || route.handlers.some((h) => WEBHOOK.test(h));
      if (!isWebhook) continue;
      if (verified.has(file.path)) continue;
      const roots = input.code.fileNodes.get(file.path) ?? [];
      if (roots.some(reachesVerification)) continue;
      const ids = archIdsForFile(input.arch, file.path);
      const label = `${route.method} ${route.path}`;
      out.push({
        id: `unverified-webhook:${file.path}:${route.line}`,
        rule: 'unverified-webhook',
        severity: 'high',
        title: 'Webhook without verification',
        evidence: `${label} in ${file.path}:${route.line} never verifies its signatures.`,
        files: [{ path: file.path, line: route.line }],
        componentIds: ids,
        fixPrompt: `The webhook handler ${label} (${file.path}:${route.line}) accepts events without verifying their signature. Verify each request (for example stripe.webhooks.constructEvent with the raw body, or the provider's verifier) and reject unverified ones before doing any work.`,
      });
    }
  }
  return out;
}

const RULE_FNS = [hardcodedSecrets, publicEnvSecrets, envFilesExposed, supabaseNoRls, firebaseTestMode, unguardedWrites, clientEnvLeaks, unverifiedWebhooks];

/** Every rule over the input, findings sorted by stable id, limited to `onlyFiles` when set. */
export function runChecks(input: CheckInput): Finding[] {
  const findings = RULE_FNS.flatMap((rule) => rule(input)).sort(byId);
  if (!input.onlyFiles?.length) return findings;
  const only = new Set(input.onlyFiles);
  return findings.filter((f) => f.files.some((file) => only.has(file.path)));
}
