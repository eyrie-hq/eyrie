/**
 * Ask the map: a question answered by a model that may only use Eyrie's
 * read-only tools, never files. The loop runs over any AI backend: each turn
 * the model either calls tools or gives its final answer, and every component
 * id it cites must have come back from a tool call, or the answer is stored
 * as `rejected` — the same rule AI commit notes follow.
 *
 * AI annotates; it never asserts a dependency. The tools answer from the
 * parsed graph, and the answer is shown with the model that wrote it and the
 * tool calls it made.
 */
import type { AiBackend, AiResult } from './analysis.js';

/** The read-only tools the model may call, by their MCP names. */
export interface AskTools {
  architecture_overview(): unknown | Promise<unknown>;
  find_components(query: string, limit?: number): unknown | Promise<unknown>;
  explain_component(component: string): unknown | Promise<unknown>;
  find_path(from: string, to: string): unknown | Promise<unknown>;
  impact(component: string): unknown | Promise<unknown>;
  trace(component: string): unknown | Promise<unknown>;
}

export interface AskToolCall {
  name: string;
  args: Record<string, unknown>;
  /** The tool's answer, or `{ error }` when it failed. */
  result: unknown;
}

export interface AskStep {
  text: string;
  componentIds: string[];
}

export interface AskAnswer {
  answer: string;
  steps: AskStep[];
}

export type AskStatus = 'ok' | 'failed' | 'rejected';

export interface AskResult {
  status: AskStatus;
  answer: AskAnswer | null;
  calls: AskToolCall[];
  backend: string;
  model: string | null;
  error: string | null;
  usage: Record<string, unknown> | null;
  ms: number;
}

export interface AskOptions {
  tools: AskTools;
  backend: AiBackend;
  /** Every component id the model may cite: only tool results can ground them. */
  ids: Set<string>;
  /** Turns before giving up (default 6). */
  maxTurns?: number;
  /** Timeout per model call (default 120 s). */
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

const MAX_RESULT_CHARS = 8000;
const MAX_STEPS = 10;
const MAX_IDS_PER_STEP = 20;
const MAX_CALLS_PER_TURN = 4;

const SYSTEM = `You answer questions about a codebase's architecture for Eyrie, a tool that keeps a live map of it: components (pages, API routes, services, data models, external services) in lanes ui → edge → api → logic → data → external, and the links between them.
You cannot see files. Your only way to learn anything is these tools, which answer from Eyrie's parsed graph:
- architecture_overview: every component by lane, and the most connected components. Start here when you know nothing.
- find_components(query, limit?): search components by name, route, domain or file path.
- explain_component(component): what one component is, what it depends on and what uses it.
- find_path(from, to): the chain of dependencies from one component to another.
- impact(component): everything that depends on a component.
- trace(component): everything a component depends on, down to data and external services.
Each turn, either call tools or give the final answer, as one JSON object. Call at most ${MAX_CALLS_PER_TURN} tools per turn, and only tools from this list, with the arguments shown. A component is named by the id the tools return.
The final answer is one short paragraph plus numbered steps, each step naming the components it walks through by id. Cite only ids a tool call returned: anything else is rejected. No steps is better than a guess. Write plainly, without hype.`;

const TURN_SCHEMA = {
  type: 'object',
  properties: {
    think: { type: 'string' },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          args: {
            type: 'object',
            properties: { query: { type: 'string' }, component: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'number' } },
          },
        },
        required: ['name', 'args'],
      },
    },
    answer: {
      type: 'object',
      properties: {
        answer: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: { text: { type: 'string' }, componentIds: { type: 'array', items: { type: 'string' } } },
            required: ['text', 'componentIds'],
          },
        },
      },
      required: ['answer', 'steps'],
    },
  },
};

const TOOL_NAMES = ['architecture_overview', 'find_components', 'explain_component', 'find_path', 'impact', 'trace'] as const;
type ToolName = (typeof TOOL_NAMES)[number];

/** Every string in a tool result that is a component id. */
function groundedIds(result: unknown, ids: Set<string>): Set<string> {
  const found = new Set<string>();
  const seen = new Set<object>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (ids.has(value)) found.add(value);
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const v of Object.values(value)) walk(v);
  };
  walk(result);
  return found;
}

function clipped(result: unknown): string {
  const text = JSON.stringify(result);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…(truncated)` : text;
}

function fail(backend: AiBackend, calls: AskToolCall[], error: string, t0: number): AskResult {
  return { status: 'failed', answer: null, calls, backend: backend.name, model: null, error, usage: null, ms: Math.round(performance.now() - t0) };
}

export async function ask(question: string, opts: AskOptions): Promise<AskResult> {
  const { tools, backend, ids, maxTurns = 6, timeoutMs = 120_000, signal, log = () => {} } = opts;
  const t0 = performance.now();
  const calls: AskToolCall[] = [];
  const seen = new Set<string>();
  const transcript: string[] = [`Question: ${question.trim()}`];
  let model: string | null = null;
  let usage: Record<string, unknown> | null = null;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) return { ...fail(backend, calls, 'cancelled', t0), model, usage };
    let result: AiResult;
    try {
      log(`Asking ${backend.name} (turn ${turn})`);
      result = await backend.run({ system: SYSTEM, prompt: transcript.join('\n\n'), schema: TURN_SCHEMA, timeoutMs, signal });
    } catch (err) {
      return { ...fail(backend, calls, (err as Error).message, t0), model, usage };
    }
    model ??= result.model ?? null;
    usage ??= result.usage ?? null;
    const out = (result.json ?? {}) as { tool_calls?: { name?: unknown; args?: unknown }[]; answer?: { answer?: unknown; steps?: unknown } };
    if (out.answer && typeof out.answer === 'object') {
      const checked = checkAnswer(out.answer, seen);
      const ms = Math.round(performance.now() - t0);
      if ('answer' in checked) return { status: 'ok', answer: checked.answer, calls, backend: backend.name, model, error: null, usage, ms };
      return { status: 'rejected', answer: null, calls, backend: backend.name, model, error: checked.error, usage, ms };
    }
    const requested = Array.isArray(out.tool_calls) ? out.tool_calls.slice(0, MAX_CALLS_PER_TURN) : [];
    if (!requested.length) {
      transcript.push('Turn: answer with tool_calls or the final answer.');
      continue;
    }
    for (const call of requested) {
      if (signal?.aborted) return { ...fail(backend, calls, 'cancelled', t0), model, usage };
      const name = typeof call?.name === 'string' ? call.name : '';
      const args = (call?.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>;
      let resultJson: unknown;
      try {
        resultJson = await runTool(tools, name, args);
      } catch (err) {
        resultJson = { error: (err as Error).message };
      }
      calls.push({ name, args, result: resultJson });
      for (const id of groundedIds(resultJson, ids)) seen.add(id);
      transcript.push(`Tool ${name} ${JSON.stringify(args)}:\n${clipped(resultJson)}`);
    }
  }
  return { status: 'rejected', answer: null, calls, backend: backend.name, model, error: `no answer within ${maxTurns} turns`, usage, ms: Math.round(performance.now() - t0) };
}

async function runTool(tools: AskTools, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) throw new Error(`Unknown tool "${name}". Available: ${TOOL_NAMES.join(', ')}.`);
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  switch (name as ToolName) {
    case 'architecture_overview':
      return tools.architecture_overview();
    case 'find_components': {
      if (!text(args.query)) throw new Error('find_components needs a query string.');
      return tools.find_components(text(args.query), typeof args.limit === 'number' ? args.limit : undefined);
    }
    case 'explain_component':
      if (!text(args.component)) throw new Error('explain_component needs a component id.');
      return tools.explain_component(text(args.component));
    case 'find_path':
      if (!text(args.from) || !text(args.to)) throw new Error('find_path needs from and to component ids.');
      return tools.find_path(text(args.from), text(args.to));
    case 'impact':
      if (!text(args.component)) throw new Error('impact needs a component id.');
      return tools.impact(text(args.component));
    case 'trace':
      if (!text(args.component)) throw new Error('trace needs a component id.');
      return tools.trace(text(args.component));
  }
}

/** Checks a final answer: shaped right, and every cited id grounded in a tool result. */
function checkAnswer(raw: { answer?: unknown; steps?: unknown }, seen: Set<string>): { answer: AskAnswer } | { error: string } {
  if (typeof raw.answer !== 'string' || !raw.answer.trim()) return { error: 'the answer has no text' };
  if (!Array.isArray(raw.steps)) return { error: 'the answer has no steps' };
  const steps: AskStep[] = [];
  for (const s of raw.steps.slice(0, MAX_STEPS)) {
    const step = s as { text?: unknown; componentIds?: unknown };
    if (typeof step?.text !== 'string' || !step.text.trim()) return { error: 'a step has no text' };
    if (!Array.isArray(step.componentIds) || !step.componentIds.every((id): id is string => typeof id === 'string')) return { error: 'a step has no component ids' };
    for (const id of step.componentIds) {
      if (!seen.has(id)) return { error: `cites a component id no tool call returned: ${id}` };
    }
    steps.push({ text: step.text.trim(), componentIds: step.componentIds.slice(0, MAX_IDS_PER_STEP) });
  }
  return { answer: { answer: raw.answer.trim(), steps } };
}
