/**
 * Runs the health rules against a live engine. The rules themselves are
 * pure (`@eyrie/checks`); this adapter gathers their input: parsed facts
 * from the index, raw text for the files the engine never parses (.env,
 * SQL migrations, Firebase rules), and the code-level call graph.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks, type CheckInput, type FileCheckFacts, type Finding, type Severity } from '@eyrie/checks';
import { DEFAULT_IGNORED_DIRS, type GraphEngine } from '@eyrie/engine';
import { isTracked } from '@eyrie/knowledge';

export interface HealthSummary {
  findings: Finding[];
  /** Epoch milliseconds of the run. */
  checkedAt: number;
  filesChecked: number;
  counts: Record<Severity, number>;
}

const MAX_SIDECARS = 100;
const MAX_SIDECAR_BYTES = 256 * 1024;

function isSidecar(name: string): boolean {
  return /^\.env(\..+)?$/.test(name) || name.endsWith('.sql') || name === 'firestore.rules' || name === 'storage.rules' || name === 'database.rules.json';
}

/** Files the engine never indexes but the rules read as text. Ignore rules do not apply: an ignored .env is still worth reporting when tracked. */
function findSidecars(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= MAX_SIDECARS) return;
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORED_DIRS.has(entry.name) && entry.name !== '.git') walk(rel);
      } else if (entry.isFile() && isSidecar(entry.name)) {
        out.push(rel);
      }
      if (out.length >= MAX_SIDECARS) return;
    }
  };
  walk('');
  return out.sort();
}

function readSidecar(root: string, rel: string): string | null {
  try {
    const text = readFileSync(join(root, rel), 'utf8');
    return text.length <= MAX_SIDECAR_BYTES ? text : null;
  } catch {
    return null;
  }
}

export async function runHealthCheck(engine: GraphEngine, opts: { onlyFiles?: string[] } = {}): Promise<HealthSummary> {
  const files: FileCheckFacts[] = [];
  for (const path of engine.index.files) {
    files.push({ path, facts: engine.index.getFacts(path), ignored: engine.isIgnored(path), tracked: false });
  }
  const seen = new Set(files.map((f) => f.path));
  for (const rel of findSidecars(engine.root)) {
    if (seen.has(rel)) continue;
    const text = readSidecar(engine.root, rel);
    if (text === null) continue;
    // Only .env files use tracked/ignored, so only they pay for a git call.
    const envFile = /^\.env(\..+)?$/.test(rel.split('/').pop()!);
    files.push({ path: rel, text, ignored: envFile && engine.isIgnored(rel), tracked: envFile && (await isTracked(engine.root, rel)) });
  }

  const calls = new Map<string, string[]>();
  for (const edge of engine.index.store.edges()) {
    if (edge.kind !== 'CALLS') continue;
    const list = calls.get(edge.source) ?? [];
    list.push(edge.target);
    calls.set(edge.source, list);
  }
  const nodeFile = new Map<string, string>();
  const fileNodes = new Map<string, string[]>();
  for (const node of engine.index.store.nodes()) {
    if (!node.file) continue;
    nodeFile.set(node.id, node.file);
    const list = fileNodes.get(node.file) ?? [];
    list.push(node.id);
    fileNodes.set(node.file, list);
  }

  const input: CheckInput = { arch: engine.architecture, files, code: { calls, nodeFile, fileNodes }, onlyFiles: opts.onlyFiles };
  const findings = runChecks(input);
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return { findings, checkedAt: Date.now(), filesChecked: files.length, counts };
}
