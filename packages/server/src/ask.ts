/**
 * Ask the map, answered from the live engine: the Ask loop's tools call
 * through the MCP server, so a question sees the same graph an agent sees.
 * Answers are stored in knowledge.db when the server has one, with the model
 * that wrote them and the tool calls they made.
 */
import { ask, type AiBackend, type AskResult, type AskTools, type ProjectKnowledge } from '@eyrie/knowledge';
import type { EyrieMcp } from './mcp.js';

/** The Ask loop's tools, answered by an MCP server over the live engine. */
export function mcpAskTools(mcp: EyrieMcp): AskTools {
  const call = (name: string, args: Record<string, unknown>): Promise<unknown> => mcp.answerTool(name, args);
  return {
    architecture_overview: () => call('architecture_overview', {}),
    find_components: (query: string, limit?: number) => call('find_components', limit === undefined ? { query } : { query, limit }),
    explain_component: (component: string) => call('explain_component', { component }),
    find_path: (from: string, to: string) => call('find_path', { from, to }),
    impact: (component: string) => call('impact', { component }),
    trace: (component: string) => call('trace', { component }),
  };
}

export interface AnswerQuestionOptions {
  mcp: EyrieMcp;
  knowledge?: ProjectKnowledge | null;
  backend: AiBackend;
  question: string;
  maxTurns?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

/** Runs the Ask loop and stores the answer. The stored row id travels with the result. */
export async function answerQuestion(opts: AnswerQuestionOptions): Promise<AskResult & { id: number | null }> {
  const question = opts.question.trim();
  if (!question) throw new Error('Ask a question.');
  const result = await ask(question, {
    tools: mcpAskTools(opts.mcp),
    backend: opts.backend,
    ids: opts.mcp.componentIds(),
    maxTurns: opts.maxTurns,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    log: opts.log,
  });
  let id: number | null = null;
  if (opts.knowledge) {
    id = opts.knowledge.store.addAsk({
      question,
      backend: result.backend,
      model: result.model,
      status: result.status,
      answer: result.answer,
      calls: result.calls,
      error: result.error,
      usage: result.usage,
    });
  }
  return { ...result, id };
}
