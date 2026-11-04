/**
 * Runs the Ask eval (scripts/ask-eval/questions.ts) against one AI backend and
 * scores cited components against the known path: precision (cited ∩ truth /
 * cited) and recall (cited ∩ truth / truth), macro-averaged. Prints a table
 * and records the run as JSON under scripts/ask-eval/results/.
 *
 * Usage: `tsx scripts/ask-eval/run.ts --ai <backend> [--ai-model <m>] [--limit <n>]`
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GraphEngine } from '../../packages/engine/src/index.js';
import { createAiBackend } from '../../packages/knowledge/src/index.js';
import { archPath } from '../../packages/lens/src/index.js';
import { answerQuestion, EyrieMcp } from '../../packages/server/src/index.js';
import { QUESTIONS } from './questions.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');

const values = parseArgs({ options: { ai: { type: 'string' }, 'ai-model': { type: 'string' }, limit: { type: 'string' } } }).values;
const backendName = values.ai ?? process.env.EYRIE_AI ?? null;
const backend = createAiBackend(backendName, { model: values['ai-model'] });
if (!backend) {
  console.error('Pass a backend: tsx scripts/ask-eval/run.ts --ai <claude|codex|muse|openai> [--ai-model <m>]');
  process.exit(1);
}
const questions = QUESTIONS.slice(0, values.limit ? Number(values.limit) : QUESTIONS.length);

const tmp = mkdtempSync(join(tmpdir(), 'eyrie-ask-eval-'));
const engine = new GraphEngine({ root: join(repoRoot, 'fixtures', 'bookstore-app'), dataDir: join(tmp, 'data'), watch: false, log: () => {} });
const ready = engine.start().then(() => ({}));
const mcp = new EyrieMcp({ engine, ready, version: 'ask-eval', ai: backend });

interface Scored {
  id: string;
  question: string;
  status: string;
  model: string | null;
  calls: number;
  ms: number;
  truth: string[];
  cited: string[];
  precision: number | null;
  recall: number | null;
  error: string | null;
}

const labelOf = (id: string) => engine.architecture.nodes.find((n) => n.id === id)?.label ?? id;
const idOf = (label: string): string => {
  const found = engine.architecture.nodes.filter((n) => n.label === label);
  if (found.length !== 1) throw new Error(`Fixture has ${found.length} components labelled "${label}"`);
  return found[0]!.id;
};

const scored: Scored[] = [];
try {
  await ready;
  for (const q of questions) {
    const truth = archPath(engine.architecture.edges, idOf(q.from), idOf(q.to))?.nodes ?? [];
    if (!truth.length) throw new Error(`Fixture has no path for ${q.id}: ${q.from} -> ${q.to}`);
    process.stdout.write(`${q.id}: asking…`);
    const result = await answerQuestion({ mcp, knowledge: null, backend, question: q.question, log: () => {} });
    const cited = [...new Set(result.answer?.steps.flatMap((s) => s.componentIds) ?? [])];
    const hit = cited.filter((id) => truth.includes(id)).length;
    const precision = cited.length ? hit / cited.length : null;
    const recall = truth.length ? hit / truth.length : null;
    scored.push({ id: q.id, question: q.question, status: result.status, model: result.model, calls: result.calls.length, ms: result.ms, truth, cited, precision, recall, error: result.error });
    console.log(` ${result.status} (P ${precision?.toFixed(2) ?? '—'} R ${recall?.toFixed(2) ?? '—'} in ${(result.ms / 1000).toFixed(0)} s, ${result.calls.length} calls)`);
  }
} finally {
  mcp.dispose();
  await engine.stop();
}

const answered = scored.filter((s) => s.status === 'ok');
const mean = (xs: (number | null)[]) => {
  const ns = xs.filter((x): x is number => x !== null);
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
};
const summary = {
  backend: backend.name,
  at: new Date().toISOString(),
  answered: `${answered.length}/${scored.length}`,
  meanPrecision: mean(scored.map((s) => s.precision)),
  meanRecall: mean(scored.map((s) => s.recall)),
};
console.log(`\n${backend.name}: ${summary.answered} answered, mean P ${summary.meanPrecision?.toFixed(2) ?? '—'} R ${summary.meanRecall?.toFixed(2) ?? '—'}`);

const outDir = join(here, 'results');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${backend.name}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
writeFileSync(out, JSON.stringify({ ...summary, labelOf: Object.fromEntries(engine.architecture.nodes.map((n) => [n.id, n.label])), scored }, null, 1) + '\n');
console.log(`Recorded in ${out}`);
