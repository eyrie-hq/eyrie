import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { ARCH_LANES, type ArchEdge, type ArchLane, type ArchNode } from '@eyrie/core';

export const NODE_W = 216;
export const NODE_H = 80;

export interface Point {
  x: number;
  y: number;
}

export interface PlacedNode {
  node: ArchNode;
  x: number;
  y: number;
}

export interface PlacedEdge {
  edge: ArchEdge;
  points: Point[];
}

export interface LaneBand {
  lane: ArchLane;
  x0: number;
  x1: number;
}

export interface Layout {
  nodes: Map<string, PlacedNode>;
  edges: Map<string, PlacedEdge>;
  lanes: LaneBand[];
  width: number;
  height: number;
}

const laneIndex = (lane: ArchLane) => ARCH_LANES.indexOf(lane);
const LAYOUT_TIMEOUT_MS = 2_000;

async function layoutInWorker(graph: ElkNode, signal: AbortSignal): Promise<ElkNode> {
  const worker = new Worker(elkWorkerUrl);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<ElkNode>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      worker.addEventListener('error', reject, { once: true });
      worker.addEventListener('messageerror', reject, { once: true });
      timer = setTimeout(() => reject(new Error('Graph layout timed out')), LAYOUT_TIMEOUT_MS);
      const elk = new ELK({ workerFactory: () => worker, algorithms: ['layered'] });
      void elk.layout(graph).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    worker.terminate();
  }
}

/** Keep every component and link drawable when ELK cannot finish in time. */
function laneLayout(graph: ElkNode): ElkNode {
  const rows = new Map<number, number>();
  const children = (graph.children ?? []).map((node) => {
    const lane = Number(node.layoutOptions?.['elk.partitioning.partition']);
    const row = rows.get(lane) ?? 0;
    rows.set(lane, row + 1);
    return { ...node, x: 40 + lane * (NODE_W + 96), y: 56 + row * (NODE_H + 24) };
  });
  const positions = new Map(children.map((node) => [node.id, node]));
  const edges = (graph.edges ?? []).map((edge) => {
    const source = positions.get(edge.sources[0]!)!;
    const target = positions.get(edge.targets[0]!)!;
    const forward = source.x <= target.x;
    const startPoint = { x: source.x + (forward ? NODE_W : 0), y: source.y + NODE_H / 2 };
    const endPoint = { x: target.x + (source.x >= target.x ? NODE_W : 0), y: target.y + NODE_H / 2 };
    if (source === target) endPoint.y += NODE_H / 4;
    const x = source.x === target.x ? startPoint.x + 24 : (startPoint.x + endPoint.x) / 2;
    return { ...edge, sections: [{ id: edge.id, startPoint, endPoint, bendPoints: [{ x, y: startPoint.y }, { x, y: endPoint.y }] }] };
  });
  return { ...graph, children, edges };
}

/**
 * Layered left-to-right layout. Lanes are ELK partitions, so a request
 * always reads UI → Edge → API → Logic → Data → External. Nodes are fed in
 * a stable order (lane, then key) so small changes move few nodes.
 */
export async function computeLayout(nodes: ArchNode[], edges: ArchEdge[], previous: Layout | undefined, signal: AbortSignal): Promise<Layout | null> {
  if (signal.aborted) return null;
  // After the first layout, keep every lane's vertical order (the map must not
  // reshuffle on each save). New nodes slot in beside the nodes they connect to.
  const stable = !!previous && previous.nodes.size > 0;
  const anchorY = new Map<string, number>();
  if (stable) {
    for (const n of nodes) {
      const prev = previous!.nodes.get(n.id);
      if (prev) {
        anchorY.set(n.id, prev.y);
        continue;
      }
      const ys = edges
        .filter((e) => e.source === n.id || e.target === n.id)
        .map((e) => previous!.nodes.get(e.source === n.id ? e.target : e.source)?.y)
        .filter((y): y is number => y !== undefined);
      anchorY.set(n.id, ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length + 0.5 : Number.MAX_SAFE_INTEGER);
    }
  }
  const ordered = [...nodes].sort(
    (a, b) => laneIndex(a.lane) - laneIndex(b.lane) || (stable ? anchorY.get(a.id)! - anchorY.get(b.id)! : 0) || a.key.localeCompare(b.key),
  );
  const ids = new Set(ordered.map((n) => n.id));
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.partitioning.activate': 'true',
      'elk.layered.spacing.nodeNodeBetweenLayers': '54',
      'elk.spacing.nodeNode': '16',
      'elk.layered.spacing.edgeNodeBetweenLayers': '18',
      'elk.spacing.edgeEdge': '9',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.forceNodeModelOrder': stable ? 'true' : 'false',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      'elk.separateConnectedComponents': 'false',
      'elk.padding': '[top=56,left=40,bottom=40,right=40]',
    },
    children: ordered.map((n) => ({
      id: n.id,
      width: NODE_W,
      height: NODE_H,
      layoutOptions: { 'elk.partitioning.partition': String(laneIndex(n.lane)) },
    })),
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e): ElkExtendedEdge => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const out = await layoutInWorker(graph, signal).catch(() => signal.aborted ? null : laneLayout(graph));
  if (!out || signal.aborted) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placed = new Map<string, PlacedNode>();
  for (const c of out.children ?? []) placed.set(c.id, { node: byId.get(c.id)!, x: c.x ?? 0, y: c.y ?? 0 });

  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const placedEdges = new Map<string, PlacedEdge>();
  for (const e of (out.edges ?? []) as ElkExtendedEdge[]) {
    const section = e.sections?.[0];
    const edge = edgeById.get(e.id);
    if (!section || !edge) continue;
    placedEdges.set(e.id, { edge, points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] });
  }

  const lanes: LaneBand[] = [];
  for (const lane of ARCH_LANES) {
    const inLane = [...placed.values()].filter((p) => p.node.lane === lane);
    if (!inLane.length) continue;
    lanes.push({ lane, x0: Math.min(...inLane.map((p) => p.x)) - 18, x1: Math.max(...inLane.map((p) => p.x + NODE_W)) + 18 });
  }
  // Close the gaps so bands tile the canvas.
  for (let i = 1; i < lanes.length; i++) {
    const mid = (lanes[i - 1]!.x1 + lanes[i]!.x0) / 2;
    lanes[i - 1]!.x1 = mid;
    lanes[i]!.x0 = mid;
  }
  // ELK does not always report root dimensions; derive them from the content.
  let width = 0;
  let height = 0;
  for (const p of placed.values()) {
    width = Math.max(width, p.x + NODE_W);
    height = Math.max(height, p.y + NODE_H);
  }
  for (const e of placedEdges.values()) {
    for (const pt of e.points) {
      width = Math.max(width, pt.x);
      height = Math.max(height, pt.y);
    }
  }
  if (lanes.length) width = Math.max(width, lanes[lanes.length - 1]!.x1);
  return { nodes: placed, edges: placedEdges, lanes, width: width + 48, height: height + 48 };
}

/** Orthogonal polyline → SVG path with rounded corners (metro style). */
export function roundedPath(points: Point[], radius = 10): string {
  if (points.length < 2) return '';
  const p0 = points[0]!;
  let d = `M${p0.x.toFixed(1)},${p0.y.toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += `L${cur.x.toFixed(1)},${cur.y.toFixed(1)}`;
      continue;
    }
    const a = { x: cur.x - ((cur.x - prev.x) / inLen) * r, y: cur.y - ((cur.y - prev.y) / inLen) * r };
    const b = { x: cur.x + ((next.x - cur.x) / outLen) * r, y: cur.y + ((next.y - cur.y) / outLen) * r };
    d += `L${a.x.toFixed(1)},${a.y.toFixed(1)}Q${cur.x.toFixed(1)},${cur.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  }
  const last = points[points.length - 1]!;
  return `${d}L${last.x.toFixed(1)},${last.y.toFixed(1)}`;
}

/** The point a fraction `t` of the way along a polyline, by length. */
export function pointAlong(points: Point[], t: number): Point {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 };
  return resample(points, 101)[Math.round(Math.min(1, Math.max(0, t)) * 100)]!;
}

/** Resamples a polyline to `n` evenly spaced points (for tweening routes). */
export function resample(points: Point[], n: number): Point[] {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  const total = lengths[lengths.length - 1]!;
  const out: Point[] = [];
  let seg = 1;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (seg < points.length - 1 && lengths[seg]! < target) seg++;
    const a = points[seg - 1]!;
    const b = points[seg]!;
    const span = lengths[seg]! - lengths[seg - 1]! || 1;
    const t = Math.min(1, Math.max(0, (target - lengths[seg - 1]!) / span));
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}
