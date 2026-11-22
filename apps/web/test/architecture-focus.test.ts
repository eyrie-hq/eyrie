import type { ArchEdge, ArchNode } from '@eyrie/core';
import { expect, it, vi } from 'vitest';
import { focusSet, visibleMap } from '../src/graph/analysis';
import { countLanes, withLaneTotals, type Layout } from '../src/graph/layout';
import { store } from '../src/state/store';

vi.mock('../src/lib/desktop', () => ({ desktop: undefined }));

const page: ArchNode = { id: 'page', key: 'page', kind: 'page', category: 'frontend', lane: 'ui', label: 'Page', members: [], files: [] };
const service: ArchNode = { id: 'service', key: 'service', kind: 'service', category: 'service', lane: 'logic', label: 'Service', members: [], files: [] };
const data: ArchNode = { id: 'data', key: 'data', kind: 'database_model', category: 'data', lane: 'data', label: 'Data', members: [], files: [] };
const other: ArchNode = { ...page, id: 'other', key: 'other', label: 'Other' };
const link = (source: string, target: string): ArchEdge => ({ id: `${source}:${target}`, source, target, kinds: ['CALLS'], weight: 1 });

it('shows exactly the highlighted neighborhood for each selection and respects category filters', () => {
  const callsService = link('page', 'service');
  const callsData = link('service', 'data');
  const betweenNeighbors = link('page', 'data');
  const unrelated = link('page', 'other');
  const graph = { nodes: [page, service, data, other], edges: [callsService, callsData, betweenNeighbors, unrelated] };

  expect(visibleMap(graph, new Set(), focusSet(graph.edges, 'service', 'neighbors'))).toEqual({ nodes: [page, service, data], edges: [callsService, callsData] });
  expect(visibleMap(graph, new Set(), focusSet(graph.edges, 'page', 'neighbors'))).toEqual({ nodes: graph.nodes, edges: [callsService, betweenNeighbors, unrelated] });
  expect(visibleMap(graph, new Set(['data']), focusSet(graph.edges, 'service', 'neighbors'))).toEqual({ nodes: [page, service], edges: [callsService] });
  expect(visibleMap(graph, new Set())).toEqual(graph);
});

it('keeps all lane headers and routes edges to the shifted nodes across empty lanes', () => {
  const edge = link('page', 'service');
  const layout: Layout = {
    nodes: new Map([['page', { node: page, x: 40, y: 50 }], ['service', { node: service, x: 320, y: 50 }]]),
    edges: new Map([[edge.id, { edge, points: [{ x: 256, y: 90 }, { x: 320, y: 90 }] }]]),
    lanes: [{ lane: 'ui', x0: 20, x1: 288 }, { lane: 'logic', x0: 288, x1: 556 }],
    width: 604,
    height: 178,
  };
  const result = withLaneTotals(layout, countLanes([page, other, service, data]));

  expect(result.lanes.map((band) => band.lane)).toEqual(['ui', 'edge', 'api', 'logic', 'data', 'external']);
  expect(result.laneTotals?.get('data')).toBe(1);
  expect(countLanes([...result.nodes.values()].map(({ node }) => node)).get('data')).toBeUndefined();
  expect(result.nodes.get('service')?.x).toBeGreaterThan(320);
  expect(result.edges.get(edge.id)?.points).toEqual([{ x: 256, y: 90 }, { x: result.nodes.get('service')!.x, y: 90 }]);
  expect(layout.nodes.get('service')?.x).toBe(320);
});

it('filters to Ask citations and lets a node selection take over without turning off the filter', () => {
  const originalState = store.get();
  const callsService = link('page', 'service');
  const callsData = link('service', 'data');
  const graph = { nodes: [page, service, data, other], edges: [callsService, callsData] };
  try {
    store.select(page.id);
    store.toggleShowOnlyHighlighted();
    store.setHighlight({ source: 'ask', ids: [service.id, data.id] });
    expect(store.get()).toMatchObject({ followAskHighlight: true, showOnlyHighlighted: true, selected: page.id });
    expect(visibleMap(graph, new Set(), { nodes: new Set(store.get().highlight?.ids) })).toEqual({ nodes: [service, data], edges: [callsData] });

    store.select(service.id);
    expect(store.get()).toMatchObject({ followAskHighlight: false, showOnlyHighlighted: true, selected: service.id });
    store.setHighlight({ source: 'ask', ids: [data.id] });
    expect(store.get().followAskHighlight).toBe(true);
    store.clearHighlight();
    expect(store.get().followAskHighlight).toBe(false);
  } finally {
    store.set(originalState);
  }
});
