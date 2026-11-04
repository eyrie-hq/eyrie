import { ArrowDownRight, ArrowUpLeft, Code2, ExternalLink, Network, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ArchEdge, ArchNode, CodeNodeKind } from '@eyrie/core';
import { focusSet, impactOf, type Impact } from '../graph/analysis';
import { useLensGraph } from '../graph/useLensGraph';
import { showFinding } from '../lib/findings';
import { noteByline, showSession, type SessionNoteView, type SessionView } from '../lib/sessions';
import { KIND_LABEL, LANE_LABEL, catClass, edgeVerbs, isBroken, kindLabel, systemPart } from '../graph/vocabulary';
import { api, store, useStore, type FocusMode } from '../state/store';

interface Member {
  id: string;
  kind: CodeNodeKind;
  name: string;
  qualifiedName: string;
  file?: string;
  line?: number;
  endLine?: number;
  doc?: string;
  signature?: string;
}

const MEMBER_KIND: Partial<Record<CodeNodeKind, string>> = {
  react_component: 'component',
  api_route: 'route',
  database_model: 'model',
  external_service: 'client',
  variable: 'const',
  function: 'fn',
  interface: 'iface',
};

interface Source {
  file: string;
  start: number;
  end: number;
  lines: string[];
  total: number;
}

export function Panel() {
  const selected = useStore((s) => s.selected);
  const nodes = useStore((s) => s.nodes);
  const lensGraph = useLensGraph();
  // A System-view box exists only in that lens, not in the component graph.
  const node = selected ? (nodes.get(selected) ?? lensGraph.nodes.find((n) => n.id === selected)) : undefined;
  if (!node) return null;
  return (
    <aside
      aria-label={`${node.label} details`}
      className="detail-panel scroll-thin fixed inset-x-0 bottom-0 z-20 max-h-[min(60dvh,calc(100dvh-340px))] overflow-y-auto rounded-t-lg border-t border-rule bg-ink-1 md:static md:z-auto md:max-h-none md:w-[384px] md:shrink-0 md:rounded-none md:border-t-0 md:border-l"
    >
      {systemPart(node) ? <SystemDetails key={node.id} node={node} /> : <Details key={node.id} node={node} />}
    </aside>
  );
}

function Details({ node }: { node: ArchNode }) {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const focus = useStore((s) => s.focus);
  const health = useStore((s) => s.health);
  const recent = useStore((s) => s.recent);
  const frames = useStore((s) => s.frames.length);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [preview, setPreview] = useState<{ file: string; line: number; end?: number } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<{ members: Member[] }>(`/api/arch/${node.id}`)
      .then((d) => live && setMembers(d.members))
      .catch(() => live && setMembers([]));
    return () => {
      live = false;
    };
  }, [node.id, frames]);

  const outgoing = useMemo(() => [...edges.values()].filter((e) => e.source === node.id), [edges, node.id]);
  const incoming = useMemo(() => [...edges.values()].filter((e) => e.target === node.id), [edges, node.id]);
  const findings = useMemo(() => health?.findings.filter((f) => f.componentIds.includes(node.id)) ?? [], [health, node.id]);
  const touchedBy = useMemo(() => {
    const out: { session: SessionView; mark: string; note: SessionNoteView | undefined }[] = [];
    for (const session of recent?.sessions ?? []) {
      const mark = session.changes.added.some((c) => c.id === node.id) ? '+' : session.changes.changed.some((c) => c.id === node.id) ? '~' : session.changes.removed.some((c) => c.id === node.id) ? '−' : null;
      if (!mark) continue;
      out.push({ session, mark, note: session.notes.find((n) => n.component === node.id && n.status === 'ok') });
    }
    return out.slice(0, 3);
  }, [recent, node.id]);

  useEffect(() => {
    if (!store.get().health && !store.get().healthLoading) void store.loadHealth();
    if (!store.get().recent && !store.get().recentLoading) void store.loadRecent();
  }, []);
  const down = useMemo(() => impactOf(nodes, focusSet(edges.values(), node.id, 'downstream')), [nodes, edges, node.id]);
  const up = useMemo(() => impactOf(nodes, focusSet(edges.values(), node.id, 'upstream')), [nodes, edges, node.id]);

  const openInEditor = async (file: string, line: number) => {
    setOpenError(null);
    try {
      await api('/api/open', { method: 'POST', body: JSON.stringify({ file, line }) });
    } catch {
      setOpenError('No editor found. Set EYRIE_EDITOR (for example "code") and restart eyrie.');
    }
  };

  const source = node.source;
  const broken = isBroken(node);

  return (
    <div className={`${catClass(node)} detail-content flex flex-col`}>
      <div className="sticky top-0 z-10 border-b border-rule bg-ink-1/95 px-5 pt-4 pb-4 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.12em] uppercase" style={{ color: 'var(--c)' }}>
            <span className="h-2 w-2 rounded-sm" style={{ background: 'var(--c)' }} />
            {broken ? 'Missing route' : KIND_LABEL[node.kind]}
            <span className="text-faint">· {LANE_LABEL[node.lane]} lane</span>
          </div>
          <button type="button" aria-label="Close details" onClick={() => store.select(null)} className="rounded p-1 text-faint hover:bg-ink-3 hover:text-text">
            <X size={15} />
          </button>
        </div>
        <h2 className="condensed mt-2 text-[22px] leading-tight font-[680] tracking-tight break-words">{node.label}</h2>
        {node.sublabel ? <p className="mt-1 font-mono text-[11.5px] break-all text-dim">{node.sublabel}</p> : null}
      </div>

      <div className="flex flex-col gap-6 px-5 py-5">
        {node.summary ? (
          <Section title="Purpose">
            <p className={`text-[13.5px] leading-relaxed ${broken ? 'text-broken' : 'text-text'}`}>{node.summary}</p>
            {node.meta?.summaryFrom === 'generated' ? (
              <p className="mt-2 text-[11.5px] text-faint">Generated from the code. Add a doc comment to the main export to describe it in your own words.</p>
            ) : null}
          </Section>
        ) : null}

        {findings.length ? (
          <Section title={`Findings · ${findings.length}`}>
            <ul className="flex flex-col gap-1">
              {findings.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => {
                      store.openDrawerSelection('health', f.id);
                      showFinding(f, nodes);
                    }}
                    className="group flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-ink-3"
                    title={f.evidence}
                  >
                    <span className={`health-dot ${f.severity} mt-1 shrink-0`} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-text">{f.title}</span>
                    <span className="shrink-0 font-mono text-[10px] tracking-wider text-faint uppercase">{f.severity}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {touchedBy.length ? (
          <Section title="Changed in session">
            <ul className="flex flex-col gap-3">
              {touchedBy.map(({ session, mark, note }) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => {
                      store.openDrawerSelection('recent', String(session.id));
                      showSession(session, nodes);
                    }}
                    className="group flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-ink-3"
                    title={session.task}
                  >
                    <span className={`shrink-0 font-mono text-[12px] font-bold ${mark === '+' ? 'text-new' : mark === '~' ? 'text-modified' : 'text-removed'}`} aria-hidden="true">
                      {mark}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-text">
                      {session.agent} · {session.task}
                    </span>
                  </button>
                  {note?.note ? (
                    <p className="mt-1 px-1.5 text-[12px] leading-relaxed text-dim">{note.note}</p>
                  ) : null}
                  {note ? (
                    <p className="mt-0.5 px-1.5 font-mono text-[10.5px] text-faint">
                      AI note · {noteByline(note)}
                      {note.files[0] ? ` · cites ${note.files[0].split('/').pop()}` : ''}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {source ? (
          <Section title="Source">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setPreview(preview ? null : { file: source.file, line: source.line, end: source.endLine })}
                className="flex min-w-0 items-center gap-1.5 rounded border border-rule bg-ink-0 px-2 py-1 font-mono text-[11.5px] text-text hover:border-rule-strong"
              >
                <Code2 size={12} className="shrink-0 text-faint" />
                <span className="truncate">
                  {source.file}:{source.line}
                </span>
              </button>
              <button
                type="button"
                onClick={() => openInEditor(source.file, source.line)}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-dim hover:bg-ink-3 hover:text-text"
              >
                <ExternalLink size={12} />
                Open in editor
              </button>
            </div>
            {openError ? <p className="mt-2 text-[11.5px] text-broken">{openError}</p> : null}
            {preview ? <CodePreview {...preview} /> : null}
          </Section>
        ) : null}

        <Section title="Trace">
          <FocusSwitch value={focus} />
          <ImpactSummary mode={focus} down={down} up={up} />
        </Section>

        <EdgeList title="Calls" empty="Calls nothing in this map." edges={outgoing} pick={(e) => e.target} nodes={nodes} />
        <EdgeList title="Used by" empty={node.lane === 'ui' ? 'Nothing calls this; it is an entry point.' : 'Nothing in this map uses it.'} edges={incoming} pick={(e) => e.source} nodes={nodes} />

        {node.files.length > 1 ? (
          <Section title={`Files · ${node.files.length}`}>
            <ul className="flex flex-col gap-1 font-mono text-[11.5px] text-dim">
              {node.files.map((f) => (
                <li key={f} className="break-all">
                  {f}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title={members ? `Code inside · ${members.length}` : 'Code inside'}>
          {members === null ? (
            <p className="text-[12px] text-faint">Loading…</p>
          ) : members.length === 0 ? (
            <p className="text-[12px] text-faint">No symbols.</p>
          ) : (
            <ul className="flex flex-col">
              {members.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => m.file && m.line && setPreview({ file: m.file, line: m.line, end: m.endLine })}
                    className="group flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-ink-3"
                    title={m.doc ?? m.signature}
                  >
                    <span className="w-[62px] shrink-0 font-mono text-[9.5px] tracking-wider text-faint uppercase">{MEMBER_KIND[m.kind] ?? m.kind}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text">{m.qualifiedName}</span>
                    {m.line ? <span className="font-mono text-[10.5px] text-faint group-hover:text-dim">:{m.line}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

/** A System-view box: what it groups, what it talks to, and a way down to each component. */
function SystemDetails({ node }: { node: ArchNode }) {
  const part = systemPart(node)!;
  const components = useStore((s) => s.nodes);
  const focus = useStore((s) => s.focus);
  const { nodes, edges } = useLensGraph();
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const outgoing = useMemo(() => edges.filter((e) => e.source === node.id), [edges, node.id]);
  const incoming = useMemo(() => edges.filter((e) => e.target === node.id), [edges, node.id]);
  const down = useMemo(() => impactOf(byId, focusSet(edges, node.id, 'downstream')), [byId, edges, node.id]);
  const up = useMemo(() => impactOf(byId, focusSet(edges, node.id, 'upstream')), [byId, edges, node.id]);
  const members = useMemo(
    () => part.members.map((id) => components.get(id)).filter((m): m is ArchNode => !!m).sort((a, b) => a.lane.localeCompare(b.lane) || a.label.localeCompare(b.label)),
    [part.members, components],
  );
  const open = (id: string) => {
    store.setLens('architecture');
    store.select(id, true);
  };

  return (
    <div className={`${catClass(node)} detail-content flex flex-col`}>
      <div className="sticky top-0 z-10 border-b border-rule bg-ink-1/95 px-5 pt-4 pb-4 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.12em] uppercase" style={{ color: 'var(--c)' }}>
            <span className="h-2 w-2 rounded-sm" style={{ background: 'var(--c)' }} />
            {kindLabel(node)}
            <span className="text-faint">· System view</span>
          </div>
          <button type="button" aria-label="Close details" onClick={() => store.select(null)} className="rounded p-1 text-faint hover:bg-ink-3 hover:text-text">
            <X size={15} />
          </button>
        </div>
        <h2 className="condensed mt-2 text-[22px] leading-tight font-[680] tracking-tight break-words">{node.label}</h2>
        {part.scope ? <p className="mt-1 font-mono text-[11.5px] break-all text-dim">{part.scope}</p> : null}
      </div>

      <div className="flex flex-col gap-6 px-5 py-5">
        <Section title="Purpose">
          <p className="text-[13.5px] leading-relaxed text-text">{node.summary}</p>
          <p className="mt-2 text-[11.5px] text-dim">A group derived from where components live and which lane they sit in. Press 2 to see every component.</p>
        </Section>

        <Section title="Trace">
          <FocusSwitch value={focus} />
          <ImpactSummary mode={focus} down={down} up={up} />
        </Section>

        <EdgeList title="Calls" empty="Calls nothing outside this group." edges={outgoing} pick={(e) => e.target} nodes={byId} />
        <EdgeList title="Used by" empty="Nothing outside this group uses it." edges={incoming} pick={(e) => e.source} nodes={byId} />

        <Section title={`Contains · ${members.length}`}>
          <ul className="flex flex-col">
            {members.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => open(m.id)}
                  aria-label={`${m.label}, ${KIND_LABEL[m.kind]}: show in the architecture view`}
                  title="Show in the architecture view"
                  className={`${catClass(m)} flex w-full items-center gap-2.5 rounded px-1.5 py-1.5 text-left hover:bg-ink-3`}
                >
                  <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: 'var(--c)' }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-text">{m.label}</span>
                    <span className="block truncate font-mono text-[10.5px] text-dim">{m.sublabel ?? m.files[0] ?? ''}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-dim">{KIND_LABEL[m.kind]}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2.5 font-mono text-[10px] tracking-[0.16em] text-faint uppercase">{title}</h3>
      {children}
    </section>
  );
}

const FOCUS_OPTIONS: { value: FocusMode; label: string; icon: React.ReactNode; hint: string }[] = [
  { value: 'neighbors', label: 'Neighbors', icon: <Network size={12} />, hint: 'Direct connections only' },
  { value: 'downstream', label: 'Depends on', icon: <ArrowDownRight size={12} />, hint: 'Follow the request through everything this calls' },
  { value: 'upstream', label: 'Impact', icon: <ArrowUpLeft size={12} />, hint: 'Everything that could break if this changes' },
];

function FocusSwitch({ value }: { value: FocusMode }) {
  return (
    <div role="radiogroup" aria-label="Highlight on the map" className="grid grid-cols-3 gap-1 rounded-md border border-rule bg-ink-0 p-1">
      {FOCUS_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.hint}
          onClick={() => store.setFocus(o.value)}
          className={`flex items-center justify-center gap-1.5 rounded px-1.5 py-1.5 text-[11.5px] transition-colors ${
            value === o.value ? 'bg-ink-3 text-text' : 'text-dim hover:text-text'
          }`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ImpactSummary({ mode, down, up }: { mode: FocusMode; down: Impact; up: Impact }) {
  const groups = (i: Impact) =>
    [
      ['API', i.apis],
      ['UI', i.ui],
      ['Services', i.services],
      ['Data', i.data],
      ['External', i.external],
    ].filter(([, list]) => (list as string[]).length) as [string, string[]][];

  if (mode === 'neighbors') {
    return (
      <p className="mt-3 text-[12.5px] text-dim">
        Depends on <b className="font-[650] text-text">{down.direct + down.indirect}</b> {down.direct + down.indirect === 1 ? 'component' : 'components'}. A change here can reach{' '}
        <b className="font-[650] text-text">{up.direct + up.indirect}</b>.
      </p>
    );
  }
  const data = mode === 'downstream' ? down : up;
  const total = data.direct + data.indirect;
  return (
    <div className="mt-3">
      <p className="text-[12.5px] text-dim">
        {mode === 'downstream' ? 'Depends on' : 'A change here can reach'} <b className="font-[650] text-text">{total}</b> {total === 1 ? 'component' : 'components'}: {data.direct} directly, {data.indirect} through others.
      </p>
      <dl className="mt-3 flex flex-col gap-2">
        {groups(data).map(([label, list]) => (
          <div key={label} className="grid grid-cols-[72px_1fr] gap-2">
            <dt className="font-mono text-[10.5px] text-faint">
              {label} {list.length}
            </dt>
            <dd className="text-[12px] leading-snug text-text">{list.join(', ')}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EdgeList({ title, empty, edges, pick, nodes }: { title: string; empty: string; edges: ArchEdge[]; pick: (e: ArchEdge) => string; nodes: Map<string, ArchNode> }) {
  const rows = edges
    .map((e) => ({ e, other: nodes.get(pick(e)) }))
    .filter((r): r is { e: ArchEdge; other: ArchNode } => !!r.other)
    .sort((a, b) => a.other.lane.localeCompare(b.other.lane) || a.other.label.localeCompare(b.other.label));
  return (
    <Section title={rows.length ? `${title} · ${rows.length}` : title}>
      {rows.length === 0 ? (
        <p className="text-[12px] text-faint">{empty}</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map(({ e, other }) => (
            <li key={e.id}>
              <button type="button" onClick={() => store.select(other.id, true)} className={`${catClass(other)} flex w-full items-center gap-2.5 rounded px-1.5 py-1.5 text-left hover:bg-ink-3`}>
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: 'var(--c)' }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-text">{other.label}</span>
                  {e.via?.length ? <span className="block truncate font-mono text-[10.5px] text-faint">via {e.via.join(' › ')}</span> : null}
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-dim">
                  {edgeVerbs(e.kinds)}
                  {e.weight > 1 ? ` ×${e.weight}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function CodePreview({ file, line, end }: { file: string; line: number; end?: number }) {
  const [src, setSrc] = useState<Source | null>(null);
  const [error, setError] = useState(false);
  const from = Math.max(1, line - 2);
  const to = Math.min((end ?? line) + 2, from + 60);
  useEffect(() => {
    let live = true;
    setError(false);
    api<Source>(`/api/source?file=${encodeURIComponent(file)}&start=${from}&end=${to}`)
      .then((s) => live && setSrc(s))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [file, from, to]);
  if (error) return <p className="mt-2 text-[12px] text-broken">This file is no longer in the index.</p>;
  if (!src) return null;
  return (
    <pre className="scroll-thin mt-3 max-h-80 overflow-auto rounded-md border border-rule bg-ink-0 py-2 font-mono text-[11.5px] leading-[1.55]">
      {src.lines.map((text, i) => {
        const n = src.start + i;
        const inRange = n >= line && n <= (end ?? line);
        return (
          <div key={n} className={`flex ${inRange ? 'bg-ink-3/60' : ''}`}>
            <span className="w-10 shrink-0 pr-3 text-right text-faint select-none">{n}</span>
            <code className="pr-3 whitespace-pre text-text">{text || ' '}</code>
          </div>
        );
      })}
      {src.end - src.start + 1 < (end ?? line) - line + 1 + 4 ? <div className="px-3 pt-1 text-faint">…</div> : null}
    </pre>
  );
}
