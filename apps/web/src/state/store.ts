import { useSyncExternalStore } from 'react';
import {
  diffGraphs,
  type ArchCategory,
  type ArchDiff,
  type ArchEdge,
  type ArchGraph,
  type ArchNode,
  type FileChange,
  type GraphStats,
  type RepoInfo,
  type ServerMessage,
} from '@eyrie/core';
import { SYSTEM_ID_PREFIX, systemIdOf, type FocusMode } from '@eyrie/lens';
import type { HealthSummaryView } from '../lib/findings';
import type { RecentView } from '../lib/sessions';
import { readPref, writePref } from './prefs';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'unauthorized';
export type Mark = 'new' | 'modified' | 'removed';
export type { FocusMode } from '@eyrie/lens';
export type ViewMode = '2d' | '3d';
/** Which question the map answers: how it is built, how data moves, what one request does, or what the system's parts are. */
export type Lens = 'architecture' | 'dataflow' | 'sequence' | 'system';
/** The insight drawer's tabs: a model's answer, security findings, or recent agent work. */
export type DrawerTab = 'ask' | 'health' | 'recent';
export type HighlightSource = 'ask' | 'health' | 'recent';

/**
 * One thing the drawer points at on the map: an answer's steps, one finding,
 * or a session's changed components. Lenses, 2D, 3D and trace modes all read
 * this one field: the ids get a ring and a mark, the path's edges run heavier,
 * and the rest of the map dims.
 */
export interface InsightHighlight {
  source: HighlightSource;
  ids: string[];
  /** The mark on each id: a step number, `!`, `+`, `−` or `~`. */
  labels?: Record<string, string>;
  /** The cited path through the map, in order. */
  path?: string[];
  description?: string;
}

const VIEW_KEY = 'eyrie-view';
const LENS_KEY = 'eyrie-lens';
/** The view the user last chose; the flat 2D map until they pick 3D. */
function savedView(): ViewMode {
  return readPref(VIEW_KEY) === '3d' ? '3d' : '2d';
}
const LENSES: readonly Lens[] = ['system', 'architecture', 'dataflow', 'sequence'];
/** The lens the user last chose; a first visit starts at the System view and zooms in from there. */
function savedLens(): Lens {
  const v = readPref(LENS_KEY);
  return LENSES.find((l) => l === v) ?? 'system';
}

/** One save (or burst of saves) as it appears on the change tape. */
export interface ChangeFrame {
  seq: number;
  at: number;
  ms: number;
  files: FileChange[];
  added: { id: string; label: string }[];
  removed: { id: string; label: string }[];
  /** Components whose code changed (including body-only edits). */
  touched: string[];
  linksAdded: number;
  linksRemoved: number;
}

export interface State {
  status: ConnectionStatus;
  repo: RepoInfo | null;
  stats: GraphStats | null;
  nodes: Map<string, ArchNode>;
  edges: Map<string, ArchEdge>;
  /** Bumps whenever nodes or edges change; drives re-layout. */
  graphVersion: number;
  marks: Map<string, Mark>;
  /** Removed nodes kept briefly so they can animate out. */
  ghosts: Map<string, ArchNode>;
  frames: ChangeFrame[];
  selected: string | null;
  focus: FocusMode;
  hoverFrame: number | null;
  query: string;
  hidden: Set<ArchCategory>;
  loaded: boolean;
  /** Ask the canvas to pan to a node (search, panel links, change tape). */
  reveal: { id: string; n: number } | null;
  view: ViewMode;
  lens: Lens;
  /** Component the sequence view traces from. */
  sequenceEntry: string | null;
  /** What the insight drawer currently points at on the map. */
  highlight: InsightHighlight | null;
  drawer: { open: boolean; tab: DrawerTab };
  /** A row the drawer should open on mount: the Panel's deep-link into a tab. Consumed once. */
  drawerSelection: { tab: DrawerTab; id: string } | null;
  /** The last health check: read by the Health tab, the top-bar counter and the Panel. */
  health: HealthSummaryView | null;
  healthLoading: boolean;
  healthError: string | null;
  /** Recorded agent sessions: read by the Recent tab, the top-bar counter, the Panel and the tape. */
  recent: RecentView | null;
  recentLoading: boolean;
  recentError: string | null;
}

const MARK_MS = 4500;
const MAX_FRAMES = 240;

type Listener = () => void;

class Store {
  private state: State = {
    status: 'connecting',
    repo: null,
    stats: null,
    nodes: new Map(),
    edges: new Map(),
    graphVersion: 0,
    marks: new Map(),
    ghosts: new Map(),
    frames: [],
    selected: null,
    focus: 'neighbors',
    hoverFrame: null,
    query: '',
    hidden: new Set(),
    loaded: false,
    reveal: null,
    view: savedView(),
    lens: savedLens(),
    sequenceEntry: null,
    highlight: null,
    drawer: { open: false, tab: 'ask' },
    drawerSelection: null,
    health: null,
    healthLoading: false,
    healthError: null,
    recent: null,
    recentLoading: false,
    recentError: null,
  };
  private listeners = new Set<Listener>();
  private markTimers = new Map<string, number>();

  get = () => this.state;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // ── actions ──────────────────────────────────────────────────────────────

  select = (id: string | null, reveal = false) => {
    // The System view draws components inside boxes; selecting a component selects its box.
    const component = id && this.state.lens === 'system' ? this.state.nodes.get(id) : undefined;
    if (component) id = systemIdOf(component);
    this.set({
      selected: id,
      focus: id === this.state.selected ? this.state.focus : 'neighbors',
      reveal: reveal && id ? { id, n: (this.state.reveal?.n ?? 0) + 1 } : this.state.reveal,
    });
  };
  setFocus = (focus: FocusMode) => this.set({ focus });
  setView = (view: ViewMode) => {
    writePref(VIEW_KEY, view);
    this.set({ view });
  };
  setLens = (lens: Lens) => {
    writePref(LENS_KEY, lens);
    const patch: Partial<State> = { lens, graphVersion: this.state.graphVersion + 1 };
    // Switching to the sequence view traces the selection, when a request can start there.
    const selected = this.state.selected;
    if (lens === 'sequence' && selected && [...this.state.edges.values()].some((e) => e.source === selected)) patch.sequenceEntry = selected;
    // The System view shows a selected component as the box that holds it; other lenses have no boxes.
    if (selected) {
      const component = this.state.nodes.get(selected);
      if (lens === 'system' && component) patch.selected = systemIdOf(component);
      else if (lens !== 'system' && selected.startsWith(SYSTEM_ID_PREFIX)) patch.selected = null;
    }
    this.set(patch);
  };
  setSequenceEntry = (sequenceEntry: string | null) => this.set({ sequenceEntry });
  setQuery = (query: string) => this.set({ query });
  setHoverFrame = (hoverFrame: number | null) => this.set({ hoverFrame });
  setHighlight = (highlight: InsightHighlight | null) => {
    if (this.state.highlight !== highlight) this.set({ highlight });
  };
  clearHighlight = () => {
    if (this.state.highlight) this.set({ highlight: null });
  };
  openDrawer = (tab: DrawerTab) => this.set({ drawer: { open: true, tab } });
  openDrawerSelection = (tab: DrawerTab, id: string) => this.set({ drawer: { open: true, tab }, drawerSelection: { tab, id } });
  /** Reads and clears the pending drawer selection, if any. */
  takeDrawerSelection = (): { tab: DrawerTab; id: string } | null => {
    const selection = this.state.drawerSelection;
    if (selection) this.set({ drawerSelection: null });
    return selection;
  };
  closeDrawer = () => {
    if (this.state.drawer.open) this.set({ drawer: { ...this.state.drawer, open: false } });
  };
  setDrawerTab = (tab: DrawerTab) => this.set({ drawer: { open: true, tab } });

  private healthRun: Promise<void> | null = null;

  /** Runs the health check once; concurrent callers share the run. */
  loadHealth = (): Promise<void> => {
    this.healthRun ??= (async () => {
      this.set({ healthLoading: true, healthError: null });
      try {
        this.set({ health: await api<HealthSummaryView>('/api/check'), healthLoading: false });
      } catch (err) {
        this.set({ healthLoading: false, healthError: (err as Error).message });
      } finally {
        this.healthRun = null;
      }
    })();
    return this.healthRun;
  };

  private recentRun: Promise<void> | null = null;

  /** Loads recorded sessions once; concurrent callers share the run. */
  loadRecent = (): Promise<void> => {
    this.recentRun ??= (async () => {
      this.set({ recentLoading: true, recentError: null });
      try {
        this.set({ recent: await api<RecentView>('/api/recent'), recentLoading: false });
      } catch (err) {
        this.set({ recentLoading: false, recentError: (err as Error).message });
      } finally {
        this.recentRun = null;
      }
    })();
    return this.recentRun;
  };
  toggleCategory = (cat: ArchCategory) => {
    const hidden = new Set(this.state.hidden);
    if (hidden.has(cat)) hidden.delete(cat);
    else hidden.add(cat);
    this.set({ hidden, graphVersion: this.state.graphVersion + 1 });
  };

  /** Full graph from the server (first connect or reconnect). */
  receiveGraph(repo: RepoInfo, stats: GraphStats, graph: ArchGraph) {
    if (!this.state.loaded) {
      this.set({
        repo,
        stats,
        nodes: new Map(graph.nodes.map((n) => [n.id, n])),
        edges: new Map(graph.edges.map((e) => [e.id, e])),
        graphVersion: this.state.graphVersion + 1,
        loaded: true,
        status: 'live',
      });
      return;
    }
    // Reconnected: animate whatever changed while we were away.
    const diff = diffGraphs({ nodes: this.state.nodes.values(), edges: this.state.edges.values() }, graph);
    this.set({ repo, stats, status: 'live' });
    this.applyArchDiff(diff, [], null);
  }

  receiveBatch(msg: Extract<ServerMessage, { type: 'batch' }>) {
    const arch = msg.events.find((e) => e.type === 'architecture.updated');
    const diff: ArchDiff = arch?.type === 'architecture.updated' ? arch.diff : { addedNodes: [], updatedNodes: [], removedNodes: [], addedEdges: [], updatedEdges: [], removedEdges: [] };
    this.set({ stats: msg.stats });
    this.applyArchDiff(diff, msg.files, { seq: msg.seq, at: msg.at, ms: msg.ms });
  }

  private applyArchDiff(diff: ArchDiff, files: FileChange[], meta: { seq: number; at: number; ms: number } | null) {
    const nodes = new Map(this.state.nodes);
    const edges = new Map(this.state.edges);
    const ghosts = new Map(this.state.ghosts);
    const removed: ChangeFrame['removed'] = [];
    for (const id of diff.removedEdges) edges.delete(id);
    for (const id of diff.removedNodes) {
      const old = nodes.get(id);
      if (old) {
        ghosts.set(id, old);
        removed.push({ id, label: old.label });
      }
      nodes.delete(id);
    }
    for (const n of [...diff.addedNodes, ...diff.updatedNodes]) nodes.set(n.id, n);
    for (const e of [...diff.addedEdges, ...diff.updatedEdges]) edges.set(e.id, e);

    // Components whose files changed, even when their summary did not.
    const changedFiles = new Set(files.map((f) => f.file));
    const touched = new Set<string>(diff.updatedNodes.map((n) => n.id));
    if (changedFiles.size) for (const n of nodes.values()) if (n.files.some((f) => changedFiles.has(f))) touched.add(n.id);
    const added = diff.addedNodes.map((n) => ({ id: n.id, label: n.label }));
    for (const a of added) touched.delete(a.id);

    const marks = new Map(this.state.marks);
    for (const a of added) marks.set(a.id, 'new');
    for (const id of touched) marks.set(id, 'modified');
    for (const r of removed) marks.set(r.id, 'removed');

    const structural = diff.addedNodes.length + diff.removedNodes.length + diff.addedEdges.length + diff.removedEdges.length + diff.updatedNodes.length + diff.updatedEdges.length > 0;
    const patch: Partial<State> = { nodes, edges, ghosts, marks, graphVersion: structural ? this.state.graphVersion + 1 : this.state.graphVersion };
    // A selected System-view box is not a component; it lives as long as the lens shows it.
    if (this.state.selected && !this.state.selected.startsWith(SYSTEM_ID_PREFIX) && !nodes.has(this.state.selected)) patch.selected = null;
    if (this.state.sequenceEntry && !nodes.has(this.state.sequenceEntry)) patch.sequenceEntry = null;
    if (meta && (files.length || structural)) {
      const frame: ChangeFrame = {
        ...meta,
        files,
        added,
        removed,
        touched: [...touched],
        linksAdded: diff.addedEdges.length,
        linksRemoved: diff.removedEdges.length,
      };
      patch.frames = [...this.state.frames, frame].slice(-MAX_FRAMES);
    }
    this.set(patch);

    for (const id of [...added.map((a) => a.id), ...touched, ...removed.map((r) => r.id)]) this.expireMark(id);
  }

  private expireMark(id: string) {
    const prev = this.markTimers.get(id);
    if (prev) window.clearTimeout(prev);
    this.markTimers.set(
      id,
      window.setTimeout(() => {
        this.markTimers.delete(id);
        const marks = new Map(this.state.marks);
        const wasRemoved = marks.get(id) === 'removed';
        marks.delete(id);
        const patch: Partial<State> = { marks };
        if (wasRemoved) {
          const ghosts = new Map(this.state.ghosts);
          ghosts.delete(id);
          patch.ghosts = ghosts;
          patch.graphVersion = this.state.graphVersion + 1;
        }
        this.set(patch);
      }, MARK_MS),
    );
  }
}

export const store = new Store();

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

// ── connection ───────────────────────────────────────────────────────────

const TOKEN_KEY = 'eyrie-token';

export function accessToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      /* storage unavailable; keep the token in the URL instead */
      return fromUrl;
    }
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function connect(token: string): () => void {
  let ws: WebSocket | null = null;
  let retry = 0;
  let timer: number | undefined;
  let closed = false;

  const open = () => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      retry = 0;
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      if (msg.type === 'hello') store.receiveGraph(msg.repo, msg.stats, msg.architecture);
      else if (msg.type === 'batch') store.receiveBatch(msg);
    };
    ws.onclose = (ev) => {
      if (closed) return;
      const retryLater = () => {
        retry++;
        timer = window.setTimeout(open, Math.min(5000, 400 * 2 ** Math.min(retry, 4)));
      };
      store.set({ status: 'reconnecting' });
      if (ev.code !== 1006) return retryLater();
      // A rejected upgrade looks like an abnormal close; ask the API whether the token is the problem.
      fetch('/api/state', { headers: { 'x-eyrie-token': token } })
        .then((r) => {
          if (r.status === 401) store.set({ status: 'unauthorized' });
          else retryLater();
        })
        .catch(retryLater);
    };
  };
  open();
  return () => {
    closed = true;
    window.clearTimeout(timer);
    ws?.close();
  };
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = accessToken() ?? '';
  const res = await fetch(path, { ...init, headers: { 'x-eyrie-token': token, 'content-type': 'application/json', ...init?.headers } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
