import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AiBackend, AiRequest, AiResult } from '../src/analysis.js';
import { ask, type AskTools } from '../src/ask.js';
import { createAiBackend } from '../src/backends.js';
import { museArgs, museBackend, musePrompt, parseMuseRun } from '../src/muse.js';
import { openaiBackend, openaiBody, openaiConfig, parseOpenaiResponse } from '../src/openai.js';
import { KnowledgeStore } from '../src/store.js';

const dir = mkdtempSync(join(tmpdir(), 'eyrie-ask-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A backend that answers turns from a script. */
function scriptedBackend(turns: unknown[], opts: { model?: string; fail?: string } = {}): AiBackend {
  let n = 0;
  return {
    name: 'scripted',
    run: async (_request: AiRequest): Promise<AiResult> => {
      if (opts.fail) throw new Error(opts.fail);
      const json = turns[Math.min(n++, turns.length - 1)];
      return { json, model: opts.model ?? 'scripted-1' };
    },
  };
}

const TOOLS: AskTools = {
  architecture_overview: () => ({ lanes: { ui: [{ id: 'page:home', label: 'Home' }] } }),
  find_components: (query: string) => (query === 'cart' ? [{ id: 'service:cart', label: 'Cart' }] : []),
  explain_component: (component: string) => ({ component: { id: component }, dependsOn: component === 'page:home' ? ['service:cart'] : [] }),
  find_path: (from: string, to: string) => ({ from, to, via: [] }),
  impact: (component: string) => ({ component, upstream: [] }),
  trace: (component: string) => ({ component, downstream: [] }),
};

const IDS = new Set(['page:home', 'service:cart']);

describe('ask backends', () => {
  it('registers muse and openai alongside claude and codex', () => {
    expect(createAiBackend('muse')?.name).toBe('muse');
    expect(createAiBackend('openai')?.name).toBe('openai');
    expect(createAiBackend('claude')?.name).toBe('claude-code');
  });

  it('locks the muse CLI down: no workspace, writes, shell or web', () => {
    const args = museArgs('/tmp/prompt.md', 'some-model');
    expect(args).toEqual(['exec', '--json', '--prompt-file', '/tmp/prompt.md', '--disable-write', '--disable-shell', '--disable-web-tools', '--disable-reminders', '--disable-request-user-input', '--no-foreign-personal-context', '--no-session-log', '--model', 'some-model']);
    expect(museBackend({ command: 'no-such-muse' }).name).toBe('muse');
  });

  it('reads the answer from the terminal payload of a muse run', () => {
    const stdout = [
      JSON.stringify({ payload_type: 'run.output.delta', payload: { kind: 'run_output_delta', text: '{"ok":' } }),
      JSON.stringify({ payload_type: 'run.usage', payload: { kind: 'run_usage', models: [{ model: 'm1', input_tokens: 10, output_tokens: 5 }] } }),
      JSON.stringify({ payload_type: 'run.terminal.completed', payload: { kind: 'run_terminal', terminal: 'completed', text: '```json\n{"ok":true}\n```' } }),
    ].join('\n');
    expect(parseMuseRun(stdout)).toEqual({ json: { ok: true }, model: 'm1', usage: { input_tokens: 10, output_tokens: 5 } });
    expect(() => parseMuseRun(JSON.stringify({ payload_type: 'run.terminal.failed', payload: { reason: 'blew up' } }))).toThrow('blew up');
    expect(() => parseMuseRun('')).toThrow('without an answer');
    expect(() => parseMuseRun(JSON.stringify({ payload_type: 'run.terminal.completed', payload: { text: 'hello' } }))).toThrow('without the requested JSON');
  });

  it('sends the schema in the muse prompt, since the CLI takes none', () => {
    const prompt = musePrompt({ system: 'sys', prompt: 'task', schema: { type: 'object' } });
    expect(prompt).toContain('sys');
    expect(prompt).toContain('task');
    expect(prompt).toContain('{"type":"object"}');
  });

  it('configures the OpenAI-compatible backend from options, EYRIE_*, or OPENAI_*', () => {
    expect(openaiConfig({})).toEqual({ baseURL: 'https://api.openai.com/v1', apiKey: null, model: 'gpt-4o-mini' });
    expect(openaiConfig({ env: { EYRIE_OPENAI_BASE_URL: 'https://meta.example/v1/', EYRIE_OPENAI_API_KEY: 'k', EYRIE_OPENAI_MODEL: 'm' } })).toEqual({
      baseURL: 'https://meta.example/v1',
      apiKey: 'k',
      model: 'm',
    });
    expect(openaiConfig({ env: { OPENAI_BASE_URL: 'http://localhost:1234/v1', OPENAI_API_KEY: 'x', OPENAI_MODEL: 'local' } })).toEqual({
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'x',
      model: 'local',
    });
    expect(openaiConfig({ baseURL: 'https://x/v1', apiKey: 'y', model: 'z' })).toEqual({ baseURL: 'https://x/v1', apiKey: 'y', model: 'z' });
  });

  it('asks for strict JSON schema first, plain JSON on retry', () => {
    const strict = openaiBody({ system: 's', prompt: 'p', schema: { type: 'object', properties: { a: { type: 'string' } } } }, 'm', true) as {
      response_format: { json_schema: { schema: Record<string, unknown> } };
    };
    expect(strict.response_format.json_schema.schema).toMatchObject({ additionalProperties: false, required: ['a'] });
    const plain = openaiBody({ system: 's', prompt: 'p', schema: { type: 'object' } }, 'm', false) as { response_format: { type: string } };
    expect(plain.response_format.type).toBe('json_object');
  });

  it('reads a chat-completions answer and refuses anything else', () => {
    const ok = parseOpenaiResponse(200, JSON.stringify({ model: 'm', choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
    expect(ok).toEqual({ json: { a: 1 }, model: 'm', usage: { input_tokens: 3, output_tokens: 4 } });
    expect(() => parseOpenaiResponse(401, JSON.stringify({ error: { message: 'bad key' } }))).toThrow('bad key');
    expect(() => parseOpenaiResponse(200, JSON.stringify({ choices: [{ message: { refusal: 'no' } }] }))).toThrow('refused');
    expect(() => parseOpenaiResponse(200, JSON.stringify({ choices: [{ message: {} }] }))).toThrow('without content');
    expect(() => parseOpenaiResponse(200, JSON.stringify({ choices: [{ message: { content: 'nope' } }] }))).toThrow('without the requested JSON');
    expect(() => parseOpenaiResponse(500, 'down')).toThrow('no JSON body');
  });

  it('posts to the configured endpoint, retrying plain JSON when strict is refused', async () => {
    const seen: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    let n = 0;
    const stub = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      n++;
      seen.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, auth: init.headers.authorization ?? null });
      if (n === 1) return new Response(JSON.stringify({ error: { message: "Unknown response_format 'json_schema'" } }), { status: 400 });
      return new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: '{"a":2}' } }] }));
    }) as unknown as typeof fetch;
    const result = await openaiBackend({ baseURL: 'http://local/v1', apiKey: 'k', model: 'm', fetch: stub }).run({ system: 's', prompt: 'p', schema: { type: 'object' }, timeoutMs: 5000 });
    expect(result).toEqual({ json: { a: 2 }, model: 'm', usage: {} });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toBe('http://local/v1/chat/completions');
    expect(seen[0]!.auth).toBe('Bearer k');
    expect((seen[0]!.body.response_format as { type: string }).type).toBe('json_schema');
    expect((seen[1]!.body.response_format as { type: string }).type).toBe('json_object');
  });

  it('reports an unreachable endpoint', async () => {
    const down = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    await expect(openaiBackend({ baseURL: 'http://down/v1', fetch: down }).run({ system: 's', prompt: 'p', schema: {}, timeoutMs: 1000 })).rejects.toThrow('could not reach http://down/v1');
  });
});

describe('ask loop', () => {
  it('answers from tool results, grounding every cited id', async () => {
    const backend = scriptedBackend([
      { tool_calls: [{ name: 'find_components', args: { query: 'cart' } }] },
      { answer: { answer: 'The cart is a service.', steps: [{ text: 'Find the cart service.', componentIds: ['service:cart'] }] } },
    ]);
    const result = await ask('Where is the cart?', { tools: TOOLS, backend, ids: IDS });
    expect(result.status).toBe('ok');
    expect(result.answer?.steps).toEqual([{ text: 'Find the cart service.', componentIds: ['service:cart'] }]);
    expect(result.calls).toHaveLength(1);
    expect(result.backend).toBe('scripted');
    expect(result.model).toBe('scripted-1');
  });

  it('rejects an answer that cites an id no tool call returned', async () => {
    const backend = scriptedBackend([{ answer: { answer: 'It is here.', steps: [{ text: 'Nowhere.', componentIds: ['service:ghost'] }] } }]);
    const result = await ask('Where?', { tools: TOOLS, backend, ids: IDS });
    expect(result.status).toBe('rejected');
    expect(result.answer).toBeNull();
    expect(result.error).toContain('service:ghost');
  });

  it('hands a tool error back to the model instead of failing', async () => {
    const backend = scriptedBackend([
      { tool_calls: [{ name: 'nope', args: {} }] },
      { answer: { answer: 'No tools needed.', steps: [] } },
    ]);
    const result = await ask('Hi?', { tools: TOOLS, backend, ids: IDS });
    expect(result.status).toBe('ok');
    expect(result.calls[0]!.result).toEqual({ error: expect.stringContaining('Unknown tool') });
  });

  it('gives up after maxTurns and reports a dead backend as failed', async () => {
    const chatty = scriptedBackend([{ tool_calls: [{ name: 'architecture_overview', args: {} }] }]);
    const gaveUp = await ask('Tell me everything.', { tools: TOOLS, backend: chatty, ids: IDS, maxTurns: 2 });
    expect(gaveUp.status).toBe('rejected');
    expect(gaveUp.error).toContain('within 2 turns');
    const dead = scriptedBackend([], { fail: 'boom' });
    const failed = await ask('Hello?', { tools: TOOLS, backend: dead, ids: IDS });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('boom');
  });

  it('stores every answer with its model and tool calls', () => {
    const store = KnowledgeStore.open(join(dir, 'knowledge.db'));
    const id = store.addAsk({
      question: 'Where is the cart?',
      backend: 'scripted',
      model: 'scripted-1',
      status: 'ok',
      answer: { answer: 'A service.', steps: [{ text: 'Find it.', componentIds: ['service:cart'] }] },
      calls: [{ name: 'find_components', args: { query: 'cart' }, result: [] }],
      error: null,
      usage: { input_tokens: 1 },
    });
    const [entry] = store.askHistory();
    expect(entry).toMatchObject({ id, question: 'Where is the cart?', backend: 'scripted', model: 'scripted-1', status: 'ok', error: null });
    expect(entry!.answer?.steps).toEqual([{ text: 'Find it.', componentIds: ['service:cart'] }]);
    expect(entry!.calls).toHaveLength(1);
    store.close();
  });
});
