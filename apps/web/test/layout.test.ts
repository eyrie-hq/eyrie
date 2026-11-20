import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchEdge, ArchNode } from '@eyrie/core';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { computeLayout, NODE_H, NODE_W } from '../src/graph/layout';

const api: ArchNode = { id: 'api', key: 'api', label: 'API', kind: 'api_route', category: 'api', lane: 'api', members: [], files: [] };
const service: ArchNode = { id: 'service', key: 'service', label: 'Service', kind: 'service', category: 'service', lane: 'logic', members: [], files: [] };
const link: ArchEdge = { id: 'call', source: api.id, target: service.id, kinds: ['calls'], weight: 1 };

let worker: LayoutWorker;

class LayoutWorker extends EventTarget {
  onmessage?: (event: MessageEvent) => void;
  postMessage = vi.fn<(message: { cmd: string; id: number; graph?: ElkNode }) => void>();
  terminate = vi.fn();

  constructor() {
    super();
    worker = this;
  }
}

describe('graph layout worker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', LayoutWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses the positions returned by ELK', async () => {
    const result = computeLayout([api], [], undefined, new AbortController().signal);
    const [register, layout] = worker.postMessage.mock.calls.map(([message]) => message);
    expect(layout?.cmd).toBe('layout');
    worker.onmessage?.(new MessageEvent('message', { data: { id: register?.id } }));
    worker.onmessage?.(new MessageEvent('message', { data: { id: layout?.id, data: { children: [{ id: api.id, x: 80, y: 100 }] } } }));
    await vi.advanceTimersByTimeAsync(1);
    expect((await result)?.nodes.get(api.id)).toEqual({ node: api, x: 80, y: 100 });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates layout at the deadline and draws the same components and links', async () => {
    const result = computeLayout([api, service], [link], undefined, new AbortController().signal);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    const layout = (await result)!;
    const source = layout.nodes.get(api.id)!;
    const target = layout.nodes.get(service.id)!;
    expect(source.x + NODE_W).toBeLessThan(target.x);
    expect(layout.edges.get(link.id)?.points.at(0)).toEqual({ x: source.x + NODE_W, y: source.y + NODE_H / 2 });
    expect(layout.edges.get(link.id)?.points.at(-1)).toEqual({ x: target.x, y: target.y + NODE_H / 2 });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('cancels superseded layouts without waiting for the deadline', async () => {
    const controller = new AbortController();
    const result = computeLayout([api], [], undefined, controller.signal);
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
