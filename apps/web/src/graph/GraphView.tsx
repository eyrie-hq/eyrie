import { Box, Map as MapIcon, Maximize2, Minus, Plus, RotateCcw, RotateCw, Scan } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { SequenceView } from './SequenceView';
import { store, useStore, type Lens, type ViewMode } from '../state/store';
import { systemIdOf } from '@eyrie/lens';
import { focusSet, matches } from './analysis';
import { FlowCanvas } from './FlowCanvas';
import { computeLayout, type Layout } from './layout';
import type { CityRenderer, GraphRenderer, Highlight } from './renderer';
import { boxIds, boxMarks, useLensGraph } from './useLensGraph';

export function GraphView() {
  const lens = useStore((s) => s.lens);
  return (
    <>
      <GlobalKeys />
      {lens === 'sequence' ? <SequenceView /> : <MapView />}
    </>
  );
}

/** The architecture, data-flow and System lenses are the same map, drawn in 2D or 3D. */
function MapView() {
  const flowRef = useRef<CityRenderer | null>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  const layoutRef = useRef<Layout | null>(null);
  const highlightRef = useRef<Highlight | null>(null);
  const runRef = useRef(0);

  const { nodes, edges } = useLensGraph();
  const graphVersion = useStore((s) => s.graphVersion);
  const lens = useStore((s) => s.lens);
  const lensRef = useRef<Lens>(lens);
  const hidden = useStore((s) => s.hidden);
  const marks = useStore((s) => s.marks);
  const selected = useStore((s) => s.selected);
  const focusMode = useStore((s) => s.focus);
  const query = useStore((s) => s.query);
  const hoverFrame = useStore((s) => s.hoverFrame);
  const frames = useStore((s) => s.frames);
  const reveal = useStore((s) => s.reveal);
  const view = useStore((s) => s.view);
  // In the System view a box shows the changes of the components inside it.
  const shownMarks = useMemo(() => (lens === 'system' ? boxMarks(marks, nodes) : marks), [lens, marks, nodes]);
  const marksRef = useRef(shownMarks);
  marksRef.current = shownMarks;

  // One renderer at a time; switching views rebuilds it from the current layout.
  useEffect(() => {
    const renderer = flowRef.current;
    if (!renderer) return;
    rendererRef.current = renderer;
    const layout = layoutRef.current;
    if (layout?.nodes.size) {
      renderer.render(layout, marksRef.current, { animate: false });
      renderer.fit(0);
      if (highlightRef.current) renderer.setHighlight(highlightRef.current);
    }
    const onResize = () => {
      if (!layoutRef.current) return;
      const selected = store.get().selected;
      if (selected) renderer.ensureVisible(selected);
      else renderer.fit(0);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      renderer.destroy();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [view]);

  // Re-layout whenever the graph or the category filter changes.
  useEffect(() => {
    if (!store.get().loaded) return;
    const run = ++runRef.current;
    const visibleNodes = nodes.filter((n) => !hidden.has(n.category));
    const ids = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    void (async () => {
      await document.fonts.ready;
      const layout = await computeLayout(visibleNodes, visibleEdges, layoutRef.current ?? undefined);
      const renderer = rendererRef.current;
      if (run !== runRef.current || !renderer) return;
      // The first non-empty layout appears without "new" animations and is fitted to the screen.
      const first = !layoutRef.current || layoutRef.current.nodes.size === 0;
      const switched = lensRef.current !== lens;
      lensRef.current = lens;
      layoutRef.current = layout;
      renderer.render(layout, marksRef.current, { animate: !first });
      // A lens shows a different slice of the repo; frame it.
      if ((first || switched) && layout.nodes.size) renderer.fit(first ? 0 : 420);
    })();
  }, [graphVersion, nodes, edges, hidden, lens]);

  useEffect(() => rendererRef.current?.setMarks(shownMarks), [shownMarks]);

  const focus = useMemo(() => (selected && nodes.some((n) => n.id === selected) ? focusSet(edges, selected, focusMode) : null), [selected, focusMode, edges, nodes]);
  const components = useStore((s) => s.nodes);
  const matchSet = useMemo(() => {
    if (!query.trim()) return null;
    // In the System view a box lights up when a component inside it matches.
    if (lens === 'system') return boxIds([...components.values()].filter((n) => matches(n, query)).map((n) => n.id), nodes);
    return new Set(nodes.filter((n) => matches(n, query)).map((n) => n.id));
  }, [query, nodes, lens, components]);
  const frameSet = useMemo(() => {
    if (hoverFrame === null) return null;
    const f = frames.find((x) => x.seq === hoverFrame);
    if (!f) return null;
    const ids = [...f.touched, ...f.added.map((a) => a.id)];
    return lens === 'system' ? boxIds(ids, nodes) : new Set(ids);
  }, [hoverFrame, frames, lens, nodes]);
  const insight = useStore((s) => s.highlight);
  const insightSet = useMemo(() => {
    if (!insight?.ids.length) return null;
    // In the System view a box lights up when a component inside it is cited.
    const onMap = lens === 'system' ? boxIds(insight.ids, nodes) : new Set(insight.ids.filter((id) => nodes.some((n) => n.id === id)));
    if (!onMap.size) return null;
    const labels = new Map<string, string>();
    if (lens === 'system') {
      for (const id of insight.ids) {
        const component = components.get(id);
        if (!component) continue;
        const box = systemIdOf(component);
        if (onMap.has(box) && !labels.has(box) && insight.labels?.[id]) labels.set(box, insight.labels[id]!);
      }
    } else {
      for (const [id, label] of Object.entries(insight.labels ?? {})) if (onMap.has(id)) labels.set(id, label);
    }
    return { source: insight.source, ids: onMap, labels, path: insight.path ?? [] };
  }, [insight, lens, nodes, components]);

  useEffect(() => {
    const hl: Highlight = { selected, focus, flow: focusMode !== 'neighbors', matches: matchSet, frame: frameSet, insight: insightSet };
    highlightRef.current = hl;
    rendererRef.current?.setHighlight(hl);
  }, [selected, focus, focusMode, matchSet, frameSet, insightSet, graphVersion, view]);

  useEffect(() => {
    if (reveal) rendererRef.current?.reveal(reveal.id);
  }, [reveal]);

  // The panel narrows the canvas; keep the selection on screen.
  useEffect(() => {
    if (!selected) return;
    const id = requestAnimationFrame(() => rendererRef.current?.ensureVisible(selected));
    return () => cancelAnimationFrame(id);
  }, [selected]);

  const scene = () => flowRef.current;

  return (
    <div className="relative h-full w-full overflow-hidden">
      <FlowCanvas key={view} ref={flowRef} city={view === '3d'} onSelect={(id) => store.select(id)} />
      <div className="absolute right-3 bottom-3 flex items-end gap-2">
        {view === '3d' ? (
          <ControlGroup>
            <CanvasButton label="Rotate left (Q)" onClick={() => scene()?.rotateBy(-30)}>
              <RotateCcw size={13} />
            </CanvasButton>
            <CanvasButton label="Rotate right (E)" onClick={() => scene()?.rotateBy(30)}>
              <RotateCw size={13} />
            </CanvasButton>
            <CanvasButton label="Top-down plan / 3D (T)" onClick={() => scene()?.toggleTilt()}>
              <Scan size={13} />
            </CanvasButton>
          </ControlGroup>
        ) : null}
        <ControlGroup>
          <CanvasButton label="Zoom in" onClick={() => rendererRef.current?.zoomBy(1.25)}>
            <Plus size={14} />
          </CanvasButton>
          <CanvasButton label="Zoom out" onClick={() => rendererRef.current?.zoomBy(0.8)}>
            <Minus size={14} />
          </CanvasButton>
          <CanvasButton label={view === '3d' ? 'Reset view (R)' : 'Fit to screen (F)'} onClick={() => (view === '3d' ? scene()?.home() : rendererRef.current?.fit())}>
            <Maximize2 size={13} />
          </CanvasButton>
        </ControlGroup>
        <ViewSwitch view={view} />
      </div>
      <Shortcuts onFit={() => rendererRef.current?.fit()} />
    </div>
  );
}

function ViewSwitch({ view }: { view: ViewMode }) {
  const options: { value: ViewMode; label: string; icon: React.ReactNode }[] = [
    { value: '2d', label: '2D', icon: <MapIcon size={13} /> },
    { value: '3d', label: '3D', icon: <Box size={13} /> },
  ];
  return (
    <div role="radiogroup" aria-label="View" className="flex overflow-hidden rounded-md border border-rule bg-ink-1/90 p-0.5 backdrop-blur">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={view === o.value}
          title={`${o.label} view (V)`}
          onClick={() => store.setView(o.value)}
          className={`flex h-7 items-center gap-1.5 rounded px-2.5 font-mono text-[11px] transition-colors ${view === o.value ? 'bg-ink-3 text-text' : 'text-dim hover:text-text'}`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ControlGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col overflow-hidden rounded-md border border-rule bg-ink-1/90 backdrop-blur">{children}</div>;
}

function CanvasButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="grid h-8 w-8 place-items-center text-dim transition-colors hover:bg-ink-3 hover:text-text">
      {children}
    </button>
  );
}

function Shortcuts({ onFit }: { onFit: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey) return;
      if (e.key === 'f' || e.key === 'F') onFit();
      if (e.key === 'v' || e.key === 'V') store.setView(store.get().view === '3d' ? '2d' : '3d');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onFit]);
  return null;
}

const LENS_KEYS: Record<string, Lens> = { '1': 'system', '2': 'architecture', '3': 'dataflow', '4': 'sequence' };

/** Shortcuts that work in every lens, including the sequence view. */
function GlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey) return;
      const lens = LENS_KEYS[e.key];
      if (lens) store.setLens(lens);
      if (e.key === 'a' || e.key === 'A') store.openDrawer('ask');
      if (e.key === 'Escape') {
        if (store.get().drawer.open) store.closeDrawer();
        else store.select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
