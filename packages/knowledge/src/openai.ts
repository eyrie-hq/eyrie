/**
 * Any OpenAI-compatible chat-completions API as an AI backend: OpenAI itself,
 * a Meta model through the Meta Model API, or a local server. The only backend
 * that speaks HTTP; the CLI backends reuse the user's signed-in agent CLIs so
 * Eyrie holds no key.
 *
 * Configuration, from the options or the environment:
 * - base URL: `EYRIE_OPENAI_BASE_URL` (or `OPENAI_BASE_URL`), defaulting to
 *   OpenAI's `https://api.openai.com/v1`.
 * - API key: `EYRIE_OPENAI_API_KEY` (or `OPENAI_API_KEY`); sent as a bearer
 *   token. Local servers that need none run without it.
 * - model: the `--ai-model` option, `EYRIE_OPENAI_MODEL` (or `OPENAI_MODEL`),
 *   defaulting to `gpt-4o-mini`.
 *
 * Answers are requested as strict JSON schema. A server that refuses that
 * shape gets one retry as plain JSON; anything that is not the requested JSON
 * is an error, never a guess.
 */
import { strictSchema } from './codex.js';
import type { AiBackend, AiRequest, AiResult } from './analysis.js';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

export interface OpenAiOptions {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  /** Environment the configuration is read from; the current one by default. */
  env?: NodeJS.ProcessEnv;
  /** `fetch`, injectable for tests. */
  fetch?: typeof fetch;
}

export interface OpenAiConfig {
  baseURL: string;
  apiKey: string | null;
  model: string;
}

/** The effective configuration. Exported for tests. */
export function openaiConfig(opts: OpenAiOptions = {}): OpenAiConfig {
  const env = opts.env ?? process.env;
  return {
    baseURL: (opts.baseURL ?? env.EYRIE_OPENAI_BASE_URL ?? env.OPENAI_BASE_URL ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: opts.apiKey ?? env.EYRIE_OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? null,
    model: opts.model ?? env.EYRIE_OPENAI_MODEL ?? env.OPENAI_MODEL ?? OPENAI_DEFAULT_MODEL,
  };
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface ChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null } }[];
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** The request body for one attempt: strict JSON schema first, plain JSON on retry. */
export function openaiBody(request: Pick<AiRequest, 'system' | 'prompt' | 'schema'>, model: string, strict: boolean): Record<string, unknown> {
  const messages: ChatMessage[] = [
    { role: 'system', content: request.system },
    { role: 'user', content: request.prompt },
  ];
  return {
    model,
    messages,
    ...(strict
      ? { response_format: { type: 'json_schema', json_schema: { name: 'eyrie', strict: true, schema: strictSchema(request.schema) } } }
      : { response_format: { type: 'json_object' } }),
  };
}

/** Reads one chat-completions answer. Exported for tests. */
export function parseOpenaiResponse(status: number, body: string): AiResult {
  let data: ChatResponse;
  try {
    data = JSON.parse(body) as ChatResponse;
  } catch {
    throw new Error(`the model answered with status ${status} and no JSON body`);
  }
  if (status < 200 || status >= 300) throw new Error(`the model refused the request (status ${status}): ${String(data?.error?.message ?? body).slice(0, 300)}`);
  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error('the model answered without a message');
  if (message.refusal) throw new Error(`the model refused to answer: ${message.refusal.slice(0, 300)}`);
  if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('the model answered without content');
  let json: unknown;
  try {
    json = JSON.parse(message.content.trim());
  } catch {
    throw new Error('the model answered without the requested JSON');
  }
  const usage: Record<string, unknown> = {};
  if (typeof data.usage?.prompt_tokens === 'number') usage.input_tokens = data.usage.prompt_tokens;
  if (typeof data.usage?.completion_tokens === 'number') usage.output_tokens = data.usage.completion_tokens;
  return { json, model: data.model, usage };
}

export function openaiBackend(opts: OpenAiOptions = {}): AiBackend {
  const { baseURL, apiKey, model } = openaiConfig(opts);
  const runFetch = opts.fetch ?? fetch;
  return {
    name: 'openai',
    run: async (request: AiRequest): Promise<AiResult> => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const timeout = AbortSignal.timeout(request.timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      let attempt = 0;
      for (;;) {
        attempt++;
        const strict = attempt === 1;
        let response: Response;
        try {
          response = await runFetch(`${baseURL}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(openaiBody(request, model, strict)), signal });
        } catch (err) {
          if (request.signal?.aborted) throw new Error('cancelled');
          if (err instanceof Error && err.name === 'TimeoutError') throw new Error(`the model did not answer within ${Math.round(request.timeoutMs / 1000)} s`);
          throw err instanceof Error ? new Error(`could not reach ${baseURL}: ${err.message}`) : err;
        }
        const text = await response.text();
        try {
          return parseOpenaiResponse(response.status, text);
        } catch (err) {
          // A server that does not know strict JSON schema gets one plain-JSON retry.
          if (strict && response.status === 400 && /response_format|json_schema|strict/i.test(text)) continue;
          throw err;
        }
      }
    },
  };
}
