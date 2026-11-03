import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerMessage } from '@eyrie/core';
import { GraphEngine } from '@eyrie/engine';
import { startServer, type RunningServer } from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/bookstore-app', import.meta.url));
const TOKEN = 'test-token';

describe('server', () => {
  let engine: GraphEngine;
  let server: RunningServer;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'eyrie-data-'));
    engine = new GraphEngine({ root: FIXTURE, dataDir, watch: false });
    await engine.start();
    server = await startServer({ engine, host: '127.0.0.1', port: 0, token: TOKEN });
  });

  afterAll(async () => {
    await server.close();
    await engine.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${server.url}${path}`, { headers: { 'x-eyrie-token': TOKEN, ...headers } });

  it('requires the token', async () => {
    expect((await fetch(`${server.url}/api/state`)).status).toBe(401);
    expect((await get('/api/state')).status).toBe(200);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolve) => {
      request(`${server.url}/api/state`, { headers: { host: 'evil.example.com', 'x-eyrie-token': TOKEN } }, (res) => resolve(res.statusCode ?? 0)).end();
    });
    expect(status).toBe(403);
  });

  it('serves the architecture, component details and source', async () => {
    const state = (await (await get('/api/state')).json()) as { architecture: { nodes: { id: string; label: string }[] } };
    const svc = state.architecture.nodes.find((n) => n.label === 'OrderService')!;
    const details = (await (await get(`/api/arch/${svc.id}`)).json()) as { members: { qualifiedName: string }[] };
    expect(details.members.map((m) => m.qualifiedName)).toEqual(expect.arrayContaining(['OrderService', 'OrderService.checkout', 'orderService']));
    const src = (await (await get('/api/source?file=src/services/recommender.service.ts&start=1&end=3')).json()) as { lines: string[] };
    expect(src.lines[0]).toContain("from '@/lib/openai'");
    expect((await get('/api/source?file=package.json')).status).toBe(404);
  });

  it('serves recent sessions', async () => {
    const res = await get('/api/recent');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it('serves the health check', async () => {
    const res = await get('/api/check');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: unknown[]; checkedAt: number; filesChecked: number; counts: Record<string, number> };
    expect(Array.isArray(body.findings)).toBe(true);
    expect(body.filesChecked).toBeGreaterThan(0);
    expect(typeof body.checkedAt).toBe('number');
    expect(Object.keys(body.counts).sort()).toEqual(['high', 'low', 'medium']);
  });

  it('sends a hello message over WebSocket', async () => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=${TOKEN}`);
    const msg = await new Promise<ServerMessage>((resolve, reject) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as ServerMessage));
      ws.once('error', reject);
    });
    ws.close();
    expect(msg.type).toBe('hello');
    if (msg.type === 'hello') expect(msg.architecture.nodes.length).toBe(36);
  });
});
