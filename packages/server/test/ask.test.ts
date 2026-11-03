/**
 * Ask the map over the real engine: a scripted model calls real MCP tools and
 * answers with an id it read back from a tool result, the way a model would.
 * Anything else is rejected, and every answer is stored with its tool calls.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphEngine } from '@eyrie/engine';
import type { AiBackend } from '@eyrie/knowledge';
import { EyrieMcp } from '../src/mcp.js';
import { answerQuestion, resolveAskBackend } from '../src/ask.js';

describe('resolveAskBackend', () => {
  const server = { name: 'server-default' } as AiBackend;

  it('keeps the server backend on auto or no pick', () => {
    expect(resolveAskBackend(server, undefined)).toBe(server);
    expect(resolveAskBackend(server, 'auto')).toBe(server);
    expect(resolveAskBackend(null, 'auto')).toBeNull();
  });

  it('builds the picked backend, even with no server default', () => {
    const names: [pick: string, built: string][] = [
      ['claude', 'claude-code'],
      ['codex', 'codex'],
      ['muse', 'muse'],
      ['openai', 'openai'],
    ];
    for (const [pick, built] of names) {
      expect(resolveAskBackend(null, pick)?.name).toBe(built);
    }
    expect(resolveAskBackend(server, 'codex')).not.toBe(server);
  });

  it('refuses unknown or mistyped picks', () => {
    expect(() => resolveAskBackend(server, 'metamate')).toThrow('Unknown AI backend');
    expect(() => resolveAskBackend(server, 42)).toThrow('Pick a backend');
  });
});

const FIXTURE = fileURLToPath(new URL('../../../fixtures/bookstore-app', import.meta.url));

/**
 * A model that behaves: first it reads the overview, then it answers with the
 * first component id the tool returned, read back from the transcript.
 * `lie: true` answers with an id no tool call returned instead.
 */
function behavingBackend(opts: { lie?: boolean } = {}): AiBackend & { turns: number } {
  const backend = {
    name: 'behaving',
    turns: 0,
    run: async (request: { prompt: string }) => {
      backend.turns++;
      if (backend.turns === 1) return { json: { tool_calls: [{ name: 'architecture_overview', args: {} }] } };
      if (opts.lie) return { json: { answer: { answer: 'It is here.', steps: [{ text: 'Nowhere.', componentIds: ['service:ghost'] }] } } };
      const id = request.prompt.match(/"id":\s*"([^"]+)"/)?.[1];
      if (!id) throw new Error('the test model found no component id in the transcript');
      return { json: { answer: { answer: `Start at ${id}.`, steps: [{ text: `Start at ${id}.`, componentIds: [id] }] } } };
    },
  };
  return backend;
}

describe('answerQuestion', () => {
  let dir: string;
  let engine: GraphEngine;
  let mcp: EyrieMcp;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eyrie-ask-e2e-'));
    const root = join(dir, 'bookstore');
    cpSync(FIXTURE, root, { recursive: true });
    engine = new GraphEngine({ root, dataDir: join(dir, 'data'), watch: false });
    await engine.start();
    mcp = new EyrieMcp({ engine, ready: Promise.resolve({}), version: 'test' });
  });
  afterAll(async () => {
    mcp.dispose();
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers with a component id its tool call returned', async () => {
    const backend = behavingBackend();
    const result = await answerQuestion({ mcp, knowledge: null, backend, question: 'What is on the map?' });
    expect(result.status).toBe('ok');
    expect(result.id).toBeNull();
    expect(backend.turns).toBe(2);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.name).toBe('architecture_overview');
    const [step] = result.answer!.steps;
    expect(engine.architecture.nodes.some((n) => n.id === step!.componentIds[0])).toBe(true);
    expect(result.answer!.answer).toContain(step!.componentIds[0]!);
  });

  it('rejects an answer citing a component id no tool call returned', async () => {
    const result = await answerQuestion({ mcp, knowledge: null, backend: behavingBackend({ lie: true }), question: 'Where is the cart?' });
    expect(result.status).toBe('rejected');
    expect(result.error).toContain('service:ghost');
    // The lie still made its tool call first.
    expect(result.calls).toHaveLength(1);
  });
});
