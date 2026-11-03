import {
  BaseEdge, Background, BackgroundVariant, EdgeLabelRenderer, Handle, MarkerType, MiniMap, Position, ReactFlow,
  ViewportPortal, useReactFlow, useViewport, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react';
import { ArrowLeft, ArrowRight, Boxes, Database, FileCode2, Network, Route } from 'lucide-react';
import { forwardRef, lazy, memo, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { animate, utils } from 'animejs';
import type { ArchNode } from '@eyrie/core';
import type { Mark } from '../state/store';
import { focusSet } from './analysis';
import { reducedMotion, sendParticle, startFlow } from './effects';
import { NODE_H, NODE_W, pointAlong, roundedPath, type Layout, type PlacedNode, type Point } from './layout';
import type { CityRenderer, Highlight, RendererCallbacks } from './renderer';
import type { CityScene } from '../graph3d/CityScene';
import { CITY_LABEL_H, CITY_LABEL_W, HOME_ANGLE, cityLabelMatrix, projectCity, projectPoint, orientCamera, type CityAngle } from '../graph3d/projection';
import { OrthographicCamera } from 'three';
import { store } from '../state/store';
import { LANE_LABEL, catClass, dataRoleOf, edgeVerbs, isBroken, kindLabel, linkClass, systemPart } from './vocabulary';

type ComponentNode = Node<{ node: ArchNode; mark?: Mark; dim: boolean; faded: boolean; match: boolean; exiting: boolean; city: boolean; roofTransform?: string; insight: boolean; insightMark?: string; insightSource?: string }, 'component'>;
type DependencyEdge = Edge<{ points: Point[]; hot: boolean; flow: boolean; sweep: number; description: string; city: boolean; label?: string; muted: boolean; insight: boolean }, 'dependency'>;
type Instance = ReactFlowInstance<ComponentNode, DependencyEdge>;
const EMPTY_HIGHLIGHT: Highlight = { selected: null, focus: null, flow: false, matches: null, frame: null, insight: null };
const GLYPH: Record<Mark, string> = { new: '+', modified: '~', removed: '−' };
const CityLayer = lazy(() => import('../graph3d/CityLayer').then((module) => ({ default: module.CityLayer })));

const Component = memo(function Component({ data, selected }: NodeProps<ComponentNode>) {
  const { node, mark, dim, faded, match, exiting } = data;
  const Icon = node.lane === 'ui' ? FileCode2 : node.lane === 'api' || node.lane === 'edge' ? Route : node.lane === 'data' ? Database : node.lane === 'external' ? Network : Boxes;
  const path = node.sublabel ?? node.source?.file ?? '';
  const insightMark = data.insightMark;
  return (
    <div style={data.roofTransform ? { transform: data.roofTransform } : undefined} className={`flow-node${data.city ? ' city-label' : ''}${systemPart(node) ? ' is-system' : ''} ${catClass(node)}${selected ? ' is-selected' : ''}${dim ? ' is-dim' : ''}${faded ? ' is-faded' : ''}${match ? ' is-match' : ''}${isBroken(node) ? ' is-broken' : ''}${mark ? ` mark-${mark}` : ''}${exiting ? ' is-exiting' : ''}${data.insight ? ` is-insight is-insight-${data.insightSource ?? 'ask'}` : ''}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="flow-node-meta"><Icon size={12} aria-hidden="true" /><span>{kindLabel(node)}</span>{mark ? <span className={`flow-change ${mark}`} aria-label={mark}>{GLYPH[mark]}</span> : null}{insightMark ? <span className={`flow-insight is-insight-${data.insightSource ?? 'ask'}`} aria-label={`cited: ${insightMark}`}>{insightMark}</span> : null}</div>
      <strong className="flow-node-title" title={node.label}>{node.label}</strong>
      <span className="flow-node-path" title={path}>{path.length > 31 ? `…${path.slice(-30)}` : path}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

const Dependency = memo(function Dependency({ id, data, markerStart, markerEnd }: EdgeProps<DependencyEdge>) {
  const motionPath = useRef<SVGPathElement>(null);
  const particles = useRef<SVGGElement>(null);
  const path = roundedPath(data?.points ?? []);
  useEffect(() => {
    if (data?.city || !data?.hot || !motionPath.current || !particles.current) return;
    if (data.flow) return startFlow(particles.current, [motionPath.current]);
    if (data.sweep) return sendParticle(particles.current, motionPath.current, { r: 3, className: 'particle selection-particle' });
  }, [data?.city, data?.hot, data?.flow, data?.sweep, path]);
  if (data?.city) return <g><BaseEdge id={id} path={path} interactionWidth={12} style={{ stroke: 'transparent' }} /><title>{data.description}</title></g>;
  const at = data?.label ? pointAlong(data.points, 0.5) : null;
  return (
    <>
      <g className={`flow-edge${data?.hot ? ' hot' : ''}${data?.insight ? ' is-insight' : ''}`}>
        <BaseEdge id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} interactionWidth={16} />
        <path ref={motionPath} d={path} fill="none" stroke="none" aria-hidden="true" />
        <g ref={particles} aria-hidden="true" />
        <title>{data?.description}</title>
      </g>
      {at ? (
        <EdgeLabelRenderer>
          <span aria-hidden="true" className={`flow-edge-label${data!.hot ? ' is-hot' : ''}${data!.muted ? ' is-dim' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}>
            {data!.label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

const nodeTypes = { component: Component };
const edgeTypes = { dependency: Dependency };

/** React Flow owns the viewport and interactions; ELK remains the layout authority. */
export const FlowCanvas = forwardRef<CityRenderer, RendererCallbacks & { city?: boolean }>(function FlowCanvas({ onSelect, city = false }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Instance | null>(null);
  const currentLayout = useRef<Layout | null>(null);
  const pendingCamera = useRef<((api: Instance) => void) | null>(null);
  const lastSelected = useRef<string | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [marks, setMarks] = useState(new Map<string, Mark>());
  const [highlight, setHighlight] = useState(EMPTY_HIGHLIGHT);
  const [hover, setHover] = useState<string | null>(null);
  const [sweep, setSweep] = useState(0);
  const [exiting, setExiting] = useState<PlacedNode[]>([]);
  const [moving, setMoving] = useState(false);
  const origin = useRef<Point>({ x: 0, y: 0 });
  const angle = useRef<CityAngle>({ ...HOME_ANGLE });
  const [orientation, setOrientation] = useState<CityAngle>({ ...HOME_ANGLE });
  const scene = useRef<CityScene | null>(null);
  const [webglError, setWebglError] = useState(false);
  const onWebglError = useCallback(() => setWebglError(true), []);
  const orbit = useRef<{ x: number; y: number; yaw: number; elevation: number } | null>(null);
  const suppressClickUntil = useRef(0);
  const nodeWidth = city ? CITY_LABEL_W : NODE_W;
  const nodeHeight = city ? CITY_LABEL_H : NODE_H;
  const cityLayout = useMemo(() => city && layout && exiting.length ? { ...layout, nodes: new Map([...layout.nodes, ...exiting.map((p) => [p.node.id, p] as const)]) } : layout, [city, layout, exiting]);
  const shownLayout = useMemo(() => city && cityLayout ? projectCity(cityLayout, orientation, origin.current) : layout, [city, cityLayout, layout, orientation]);

  useEffect(() => () => { utils.remove(angle.current); }, []);

  useEffect(() => () => clearTimeout(exitTimer.current), []);

  useImperativeHandle(ref, () => {
    const camera = (action: (api: Instance) => void) => {
      if (instance.current) action(instance.current);
      else pendingCamera.current = action;
    };
    const duration = (ms: number) => reducedMotion() ? 0 : ms;
    const orient = (next: CityAngle) => {
      utils.remove(angle.current);
      if (reducedMotion()) { Object.assign(angle.current, next); setOrientation({ ...next }); return; }
      animate(angle.current, { ...next, duration: 420, ease: 'outQuart', onUpdate: () => setOrientation({ ...angle.current }) });
    };
    const projected = () => city && currentLayout.current ? projectCity(currentLayout.current, angle.current, origin.current) : currentLayout.current;
    const fit = (ms = 420) => camera((api) => {
      const graph = projected();
      const el = host.current;
      if (!graph?.nodes.size || !el?.clientWidth || !el.clientHeight) return;
      if (city) {
        const points = [...graph.nodes.values()];
        const minX = Math.min(...points.map((p) => p.x));
        const minY = Math.min(...points.map((p) => p.y));
        const maxX = Math.max(...points.map((p) => p.x + CITY_LABEL_W));
        const maxY = Math.max(...points.map((p) => p.y + CITY_LABEL_H + 50));
        const zoom = Math.max(el.clientWidth < 768 ? 0.85 : 0.35, Math.min(1.1, (el.clientWidth - 80) / (maxX - minX), (el.clientHeight - 130) / (maxY - minY)));
        void api.setViewport({ x: (el.clientWidth - (maxX - minX) * zoom) / 2 - minX * zoom, y: (el.clientHeight - (maxY - minY) * zoom) / 2 - minY * zoom, zoom }, { duration: duration(ms) });
        return;
      }
      const zoom = Math.max(0.85, Math.min(1.1, (el.clientWidth - 64) / graph.width, (el.clientHeight - 120) / graph.height));
      const x = graph.width * zoom <= el.clientWidth ? (el.clientWidth - graph.width * zoom) / 2 : 24;
      const y = Math.max(56, (el.clientHeight - graph.height * zoom) / 2);
      void api.setViewport({ x, y, zoom }, { duration: duration(ms) });
    });
    const reveal = (id: string, force: boolean) => camera((api) => {
      const placed = projected()?.nodes.get(id);
      const el = host.current;
      if (!placed || !el) return;
      const box = el.getBoundingClientRect();
      const panel = document.querySelector('.detail-panel')?.getBoundingClientRect();
      const height = panel && panel.top > box.top && panel.left < box.right && panel.right > box.left ? Math.max(80, panel.top - box.top) : box.height;
      const view = api.getViewport();
      const zoom = force ? Math.max(1, view.zoom) : city ? Math.max(0.85, view.zoom) : view.zoom;
      const left = placed.x * zoom + view.x;
      const top = placed.y * zoom + view.y;
      if (!force && zoom === view.zoom && left >= 24 && left + nodeWidth * zoom <= box.width - 24 && top >= 48 && top + nodeHeight * zoom <= height - 24) return;
      void api.setViewport({ x: box.width / 2 - (placed.x + nodeWidth / 2) * zoom, y: Math.max(70, height / 2) - (placed.y + nodeHeight / 2) * zoom, zoom }, { duration: duration(320) });
    });
    return {
      render(next, nextMarks, opts) {
        clearTimeout(exitTimer.current);
        const old = currentLayout.current;
        if (!old?.nodes.size) origin.current = { x: next.width / 2, y: next.height / 2 };
        currentLayout.current = next;
        setMoving(opts.animate && !reducedMotion());
        const removed = opts.animate && !reducedMotion() ? [...(old?.nodes.values() ?? [])].filter((p) => !next.nodes.has(p.node.id) && (!city || nextMarks.get(p.node.id) === 'removed')) : [];
        setExiting(removed);
        if (removed.length) exitTimer.current = setTimeout(() => setExiting([]), 280);
        setLayout(next);
        setMarks(nextMarks);
      },
      setMarks,
      setHighlight(next) {
        if (lastSelected.current !== next.selected) {
          lastSelected.current = next.selected;
          setSweep((n) => n + 1);
        }
        setHighlight(next);
      },
      fit,
      zoomBy(factor) { camera((api) => { void api.zoomTo(api.getZoom() * factor, { duration: duration(180) }); }); },
      reveal(id) { reveal(id, true); },
      ensureVisible(id) { reveal(id, false); },
      rotateBy(degrees) { orient({ ...angle.current, yaw: angle.current.yaw + degrees }); },
      toggleTilt() { orient({ ...angle.current, elevation: angle.current.elevation > 80 ? HOME_ANGLE.elevation : 89.9 }); },
      home() {
        utils.remove(angle.current);
        Object.assign(angle.current, HOME_ANGLE);
        setOrientation({ ...HOME_ANGLE });
        fit();
      },
      destroy() { clearTimeout(exitTimer.current); utils.remove(angle.current); pendingCamera.current = null; },
    };
  }, [city, nodeWidth, nodeHeight]);

  useEffect(() => {
    if (!city) return;
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable]') || event.metaKey || event.ctrlKey) return;
      const handle = typeof ref === 'object' ? ref?.current : null;
      if (event.key.toLowerCase() === 'q') handle?.rotateBy(-30);
      if (event.key.toLowerCase() === 'e') handle?.rotateBy(30);
      if (event.key.toLowerCase() === 't') handle?.toggleTilt();
      if (event.key.toLowerCase() === 'r') handle?.home();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [city, ref]);

  const emphasis = useMemo(() => {
    if (highlight.frame) return { nodes: highlight.frame, edges: null, soft: false };
    if (highlight.focus) return { nodes: highlight.focus.nodes, edges: highlight.focus.edges, soft: false };
    if (highlight.insight) return { nodes: highlight.insight.ids, edges: null, soft: false };
    if (highlight.matches) return { nodes: highlight.matches, edges: null, soft: false };
    if (hover && layout) {
      const focus = focusSet([...layout.edges.values()].map((p) => p.edge), hover, 'neighbors');
      return { nodes: focus.nodes, edges: focus.edges, soft: true };
    }
    return { nodes: null, edges: null, soft: false };
  }, [highlight, hover, layout]);

  const cityInsight = useMemo(() => {
    const insight = highlight.insight;
    if (!insight) return null;
    return { ids: insight.ids, color: insight.source === 'health' ? 'broken' : insight.source === 'recent' ? 'modified' : 'frontend' };
  }, [highlight.insight]);

  // Edges of the insight's cited path, in order: consecutive path members run heavier.
  const insightEdges = useMemo(() => {
    const path = highlight.insight?.path;
    if (!path?.length || !layout) return null;
    const order = new Map(path.map((id, i) => [id, i]));
    const ids = new Set<string>();
    for (const p of layout.edges.values()) {
      const a = order.get(p.edge.source);
      const b = order.get(p.edge.target);
      if (a !== undefined && b !== undefined && Math.abs(a - b) === 1) ids.add(p.edge.id);
    }
    return ids;
  }, [highlight.insight, layout]);

  const roofTransform = useMemo(() => city && !webglError ? `matrix(${cityLabelMatrix(orientation).join(',')})` : undefined, [city, webglError, orientation]);
  const nodes = useMemo<ComponentNode[]>(() => [...(shownLayout?.nodes.values() ?? []), ...(city ? [] : exiting)].map((p) => {
    const removed = !layout?.nodes.has(p.node.id);
    const inactive = !!emphasis.nodes && !emphasis.nodes.has(p.node.id);
    const insight = highlight.insight;
    const cited = !!insight?.ids.has(p.node.id);
    return {
      id: p.node.id, type: 'component', position: { x: p.x, y: p.y }, width: nodeWidth, height: nodeHeight,
      selected: p.node.id === highlight.selected, selectable: !removed, focusable: !removed,
      ariaRole: 'button', ariaLabel: `${p.node.label}, ${kindLabel(p.node)}${marks.has(p.node.id) ? `, ${marks.get(p.node.id)}` : ''}`,
      data: { node: p.node, mark: marks.get(p.node.id), dim: inactive && !emphasis.soft, faded: inactive && emphasis.soft, match: !!highlight.matches?.has(p.node.id), exiting: removed, city, roofTransform, insight: cited, insightMark: cited ? insight!.labels.get(p.node.id) : undefined, insightSource: insight?.source },
    };
  }), [layout, shownLayout, city, roofTransform, nodeWidth, nodeHeight, exiting, marks, highlight.selected, highlight.matches, highlight.insight, emphasis]);

  const edges = useMemo<DependencyEdge[]>(() => {
    const sweepEdges = new Set([...(highlight.focus?.edges ?? [])].slice(0, 18));
    return [...(shownLayout?.edges.values() ?? [])].map((p) => {
    const edge = p.edge;
    const hot = !!emphasis.edges?.has(edge.id);
    const onPath = !!insightEdges?.has(edge.id);
    const inactive = emphasis.edges ? !hot && !onPath : !!emphasis.nodes && !(emphasis.nodes.has(edge.source) && emphasis.nodes.has(edge.target));
    const role = dataRoleOf(edge);
    const color = hot || onPath ? 'var(--color-text)' : role === 'read' ? 'var(--color-data)' : role === 'write' || role === 'readwrite' ? 'var(--color-service)' : 'var(--color-dim)';
    const marker = { type: MarkerType.Arrow, color, width: 14, height: 14 };
    const source = layout?.nodes.get(edge.source)?.node.label;
    const target = layout?.nodes.get(edge.target)?.node.label;
    return {
      id: edge.id, source: edge.source, target: edge.target, type: 'dependency', selectable: false,
      className: `${linkClass(edge)}${inactive ? emphasis.soft ? ' is-faded' : ' is-dim' : ''}`,
      markerEnd: marker, markerStart: role === 'readwrite' ? marker : undefined,
      data: { points: p.points, hot, flow: highlight.flow && !!highlight.focus && !highlight.frame, sweep: highlight.selected && sweepEdges.has(edge.id) ? sweep : 0, city, muted: inactive, insight: onPath,
        // System-view links merge many component links; name what they carry on the line itself.
        label: edge.meta?.system ? `${edgeVerbs(edge.kinds)}${edge.weight > 1 ? ` ×${edge.weight}` : ''}` : undefined,
        description: `${source} → ${target}: ${edgeVerbs(edge.kinds)}${edge.weight > 1 ? ` ×${edge.weight}` : ''}${edge.via?.length ? ` via ${edge.via.join(' › ')}` : ''}${edge.meta?.flipped ? ' (arrow follows the data)' : ''}` },
    };
    });
  }, [layout, shownLayout, city, emphasis, insightEdges, highlight.flow, highlight.focus, highlight.frame, highlight.selected, sweep]);

  return (
    <div ref={host} className={`flow-canvas${city ? ' flow-city' : ''}${webglError ? ' webgl-unavailable' : ''}${moving && !city ? ' animate-layout' : ''}`}
      onContextMenu={(event) => { if (city) event.preventDefault(); }}
      onPointerDownCapture={(event) => {
        if (!city || (event.button !== 2 && !event.altKey)) return;
        event.preventDefault(); event.stopPropagation();
        utils.remove(angle.current);
        orbit.current = { x: event.clientX, y: event.clientY, ...angle.current };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMoveCapture={(event) => {
        if (!orbit.current) return;
        event.stopPropagation();
        angle.current = { yaw: orbit.current.yaw + (event.clientX - orbit.current.x) * 0.3, elevation: Math.max(25, Math.min(89.9, orbit.current.elevation + (event.clientY - orbit.current.y) * 0.2)) };
        setOrientation({ ...angle.current });
      }}
      onPointerUpCapture={(event) => {
        if (!orbit.current) return;
        orbit.current = null; suppressClickUntil.current = performance.now() + 200;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}>
      <ReactFlow<ComponentNode, DependencyEdge>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onInit={(api) => { instance.current = api; pendingCamera.current?.(api); pendingCamera.current = null; }}
        onNodeClick={(_, node) => onSelect(node.id)} onPaneClick={(event) => { if (performance.now() >= suppressClickUntil.current) onSelect(city ? scene.current?.pick(event.clientX, event.clientY) ?? null : null); }}
        onEdgeClick={(event) => { if (city) onSelect(scene.current?.pick(event.clientX, event.clientY) ?? null); }}
        onNodeMouseEnter={(_, node) => setHover(node.id)} onNodeMouseLeave={() => setHover(null)}
        onNodesChange={(changes) => {
          const selections = changes.filter((c) => c.type === 'select');
          const chosen = selections.find((c) => c.selected);
          if (chosen) onSelect(chosen.id);
          else if (selections.some((c) => c.id === lastSelected.current && !c.selected)) onSelect(null);
        }}
        nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} edgesFocusable={false}
        deleteKeyCode={null} multiSelectionKeyCode={null} selectionKeyCode={null}
        minZoom={0.35} maxZoom={2.5} panOnDrag={city ? [0] : true} zoomOnDoubleClick={false} attributionPosition="top-right"
        ariaLabelConfig={{ 'node.a11yDescription.default': 'Press Enter or Space to inspect this component. Press Escape to clear selection.' }}
      >
        {city && cityLayout ? <Suspense fallback={<div className="city-loading" role="status">Loading 3D view...</div>}><CityLayer layout={cityLayout} origin={origin.current} angle={orientation} emphasis={emphasis} selected={highlight.selected} marks={marks} flow={highlight.flow && !!highlight.focus && !highlight.frame} sweep={sweep} insight={cityInsight} sceneRef={scene} onError={onWebglError} /></Suspense> : null}
        {!city ? <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--color-rule-strong)" /> : null}
        <ViewportPortal>
          <div className="flow-lanes" aria-hidden="true">
            {!city ? layout?.lanes.map((lane, i) => <div key={lane.lane} className={`flow-lane${i % 2 ? ' alternate' : ''}`} style={{ left: lane.x0, width: lane.x1 - lane.x0 }} />) : <CityLanes layout={layout} origin={origin.current} angle={orientation} />}
          </div>
        </ViewportPortal>
        {layout && !city ? <LaneRuler layout={layout} marks={marks} /> : null}
        <MiniMap<ComponentNode> position="bottom-left" pannable zoomable nodeColor={(n) => `var(--color-${isBroken(n.data.node) ? 'broken' : n.data.node.category === 'infra' ? 'utility' : n.data.node.category})`} nodeBorderRadius={4} maskColor="color-mix(in oklab, var(--color-ink-0) 70%, transparent)" ariaLabel="Architecture overview" />
      </ReactFlow>
      {webglError ? <div className="city-error" role="alert"><span>3D rendering is unavailable.</span><button type="button" onClick={() => store.setView('2d')}>Switch to 2D</button></div> : null}
    </div>
  );
});

function CityLanes({ layout, origin, angle }: { layout: Layout | null; origin: Point; angle: CityAngle }) {
  if (!layout) return null;
  const camera = new OrthographicCamera();
  orientCamera(camera, angle);
  return <>{layout.lanes.map((lane) => {
    const point = projectPoint(camera, { x: (lane.x0 + lane.x1) / 2, y: layout.height + 20 }, 0, origin);
    const count = [...layout.nodes.values()].filter((p) => p.node.lane === lane.lane).length;
    return <span className="city-lane-label" key={lane.lane} style={{ left: point.x, top: point.y }}>{LANE_LABEL[lane.lane]}<b>{count}</b></span>;
  })}</>;
}

function LaneRuler({ layout, marks }: { layout: Layout; marks: Map<string, Mark> }) {
  const viewport = useViewport();
  const ruler = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ruler.current) return;
    const resize = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    resize.observe(ruler.current);
    return () => resize.disconnect();
  }, []);
  const lanes = layout.lanes.map((lane) => ({ ...lane, left: lane.x0 * viewport.zoom + viewport.x, right: lane.x1 * viewport.zoom + viewport.x }));
  const left = lanes.filter((lane) => lane.right < 36).at(-1);
  const right = lanes.find((lane) => lane.left > width - 36);
  const changed = (name: string) => marks.get([...layout.nodes.values()].find((p) => p.node.lane === name && marks.has(p.node.id))?.node.id ?? '');
  return (
    <nav ref={ruler} className="flow-ruler" aria-label="Architecture lanes">
      {left ? <LaneJump lane={left} viewport={viewport} width={width} side="left" changed={changed(left.lane)} /> : null}
      {lanes.filter((lane) => lane.right >= 36 && lane.left <= width - 36).map((lane) => {
        const x = Math.max(left ? 112 : 0, lane.left);
        const available = Math.min(right ? width - 112 : width, lane.right) - x;
        if (available < 64) return null;
        const count = [...layout.nodes.values()].filter((p) => p.node.lane === lane.lane).length;
        return <span key={lane.lane} className="flow-lane-label" style={{ left: x + 14, width: available - 20 }}>{LANE_LABEL[lane.lane]}<b>{count}</b></span>;
      })}
      {right ? <LaneJump lane={right} viewport={viewport} width={width} side="right" changed={changed(right.lane)} /> : null}
    </nav>
  );
}

function LaneJump({ lane, viewport, width, side, changed }: { lane: Layout['lanes'][number]; viewport: { x: number; y: number; zoom: number }; width: number; side: 'left' | 'right'; changed?: Mark }) {
  const api = useReactFlow<ComponentNode, DependencyEdge>();
  const Icon = side === 'left' ? ArrowLeft : ArrowRight;
  // A lane jump preserves vertical orientation and zoom.
  return <button type="button" className={`flow-lane-jump ${side}`} title={`Reveal ${LANE_LABEL[lane.lane]} lane`} aria-label={`Reveal ${LANE_LABEL[lane.lane]} lane`} onClick={() => void api.setViewport({ x: width / 2 - (lane.x0 + lane.x1) / 2 * viewport.zoom, y: viewport.y, zoom: viewport.zoom }, { duration: reducedMotion() ? 0 : 320 })}>
    <Icon size={13} aria-hidden="true" /><span>{LANE_LABEL[lane.lane]}</span>{changed ? <span className={`flow-lane-change ${changed}`} aria-label={`Contains ${changed} components`}>{GLYPH[changed]}</span> : null}
  </button>;
}
