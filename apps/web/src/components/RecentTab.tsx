import { Check, ChevronDown, History, Loader2, MapPin, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { noteByline, showSession, type SessionView } from '../lib/sessions';
import { timeAgo } from '../projects/format.js';
import { store, useStore } from '../state/store';

/** Agent sessions as inspector cards: the live one pinned open, earlier ones a push away. */
export function RecentTab() {
  const recent = useStore((s) => s.recent);
  const loading = useStore((s) => s.recentLoading);
  const error = useStore((s) => s.recentError);
  const nodes = useStore((s) => s.nodes);
  const [openId, setOpenId] = useState<number | null>(null);
  const selection = useStore((s) => s.drawerSelection);
  const opened = useRef<string | null>(null);

  useEffect(() => {
    if (!store.get().recent && !store.get().recentLoading) void store.loadRecent();
  }, []);

  // Opening the tab shows the live session; a Panel deep-link opens its row instead, keeping the highlight the Panel set. Leaving takes it down, unless another tab points by then.
  useEffect(() => {
    if (!recent) return;
    if (selection && selection.tab === 'recent' && opened.current !== selection.id) {
      store.takeDrawerSelection();
      opened.current = selection.id;
      const target = recent.sessions.find((s) => String(s.id) === selection.id);
      if (target) {
        setOpenId(target.id);
        return;
      }
    }
    if (store.get().highlight?.source === 'recent') return;
    const live = recent.sessions.find((s) => !s.endedAt);
    if (live) {
      setOpenId(live.id);
      showSession(live, nodes);
    }
    return () => {
      if (store.get().highlight?.source === 'recent') store.clearHighlight();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent, selection]);

  const toggle = (session: SessionView) => {
    if (openId === session.id) {
      setOpenId(null);
      if (store.get().highlight?.source === 'recent') store.clearHighlight();
      return;
    }
    setOpenId(session.id);
    showSession(session, nodes);
  };

  if (!recent && loading) {
    return (
      <>
        <div className="insight-loading" role="status">
          <Loader2 size={13} className="insight-spinner" aria-hidden="true" />
          <span>Loading sessions…</span>
        </div>
        <ul className="insight-skeleton" aria-hidden="true">
          <li />
          <li />
          <li />
        </ul>
      </>
    );
  }
  if (!recent) {
    return (
      <div className="insight-empty-state">
        <History size={18} aria-hidden="true" />
        <p className="insight-empty-title">Sessions did not load</p>
        <p className="insight-error" role="alert">
          {error ?? 'Sessions did not load.'}
        </p>
        <button type="button" className="insight-btn" onClick={() => store.loadRecent()}>
          <RotateCw size={12} aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }

  const sessions = recent.sessions;
  const liveCount = sessions.filter((s) => !s.endedAt).length;
  return (
    <div className="recent-tab">
      <div className="health-summary" role="status">
        <div className="health-summary-top">
          <span className="health-summary-count">
            {sessions.length === 0 ? 'No sessions yet' : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
            {liveCount > 0 ? (
              <span className="recent-live-pill">
                <span className="recent-live-dot" aria-hidden="true" />
                {liveCount} live
              </span>
            ) : null}
          </span>
          <button type="button" className="insight-btn is-quiet" onClick={() => store.loadRecent()} disabled={loading}>
            <RotateCw size={12} aria-hidden="true" className={loading ? 'insight-spinner' : undefined} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="insight-empty-state">
          <History size={18} aria-hidden="true" />
          <p className="insight-empty-title">No agent work yet</p>
          <p className="insight-empty">When an agent records its intent, its work lands here: the task, what it changed, and why.</p>
        </div>
      ) : (
        <ul className="insp-list">
          {sessions.map((session) => {
            const isOpen = openId === session.id;
            const live = !session.endedAt;
            const added = session.changes.added.length;
            const changed = session.changes.changed.length;
            const removed = session.changes.removed.length;
            return (
              <li key={session.id} className="insp-item" data-open={isOpen}>
                <button type="button" className="insp-head" aria-expanded={isOpen} aria-controls={`recent-body-${session.id}`} onClick={() => toggle(session)}>
                  {live ? (
                    <span className="recent-live-dot" role="img" aria-label="Live session" />
                  ) : session.commit ? (
                    <span className="recent-id" aria-hidden="true">
                      {session.commit.hash.slice(0, 4)}
                    </span>
                  ) : (
                    <span className="recent-id is-done" aria-hidden="true">
                      <Check size={11} />
                    </span>
                  )}
                  <span className="insp-text">
                    <span className="insp-title">{session.task}</span>
                    <span className="insp-meta">
                      {session.agent} · <PartsBreakdown added={added} changed={changed} removed={removed} /> ·{' '}
                      <time dateTime={new Date(session.startedAt).toISOString()}>{timeAgo(session.startedAt, Date.now())}</time>
                    </span>
                  </span>
                  <ChevronDown size={14} className="insp-chevron" aria-hidden="true" />
                </button>
                <div className="insp-body" id={`recent-body-${session.id}`}>
                  <div>
                    {live ? (
                      <p className="recent-live">
                        <span className="recent-live-dot" aria-hidden="true" />
                        Live session — still recording
                      </p>
                    ) : null}
                    {session.summary && session.endedAt ? <p className="recent-summary">{session.summary}</p> : null}
                    <SessionParts session={session} />
                    <SessionByline session={session} />
                    <div className="recent-footer">
                      <button type="button" className="insight-btn" onClick={() => showSession(session, nodes)}>
                        <MapPin size={12} aria-hidden="true" />
                        Show on map
                      </button>
                      <span className="recent-commit">{session.commit ? session.commit.hash.slice(0, 7) : 'Not committed yet'}</span>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PartsBreakdown({ added, changed, removed }: { added: number; changed: number; removed: number }) {
  const total = added + changed + removed;
  if (!total) return <>no changes yet</>;
  const parts: string[] = [];
  if (added) parts.push(`+${added}`);
  if (changed) parts.push(`~${changed}`);
  if (removed) parts.push(`−${removed}`);
  return <>{parts.join(' ')}</>;
}

function SessionParts({ session }: { session: SessionView }) {
  const groups = [
    { key: 'added' as const, label: 'Added', items: session.changes.added, mark: '+' },
    { key: 'changed' as const, label: 'Changed', items: session.changes.changed, mark: '~' },
    { key: 'removed' as const, label: 'Removed', items: session.changes.removed, mark: '−' },
  ].filter((g) => g.items.length);
  if (!groups.length) return <p className="insight-empty">{session.endedAt ? 'Nothing in the architecture moved.' : 'No changes yet.'}</p>;
  const notes = new Map(session.notes.filter((n) => n.status === 'ok').map((n) => [n.component, n]));
  return (
    <div className="recent-groups">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h4 className={`recent-group-title recent-mark-${group.key === 'added' ? 'new' : group.key === 'changed' ? 'changed' : 'removed'}`}>
            <span className="recent-mark" aria-hidden="true">
              {group.mark}
            </span>
            {group.label} · {group.items.length}
          </h4>
          <ul className="recent-components">
            {group.items.map((part) => (
              <li key={part.id}>
                <span className="recent-component">
                  <span className="recent-label">{part.label}</span>
                  {notes.get(part.id)?.note ? <span className="recent-note">{notes.get(part.id)!.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SessionByline({ session }: { session: SessionView }) {
  const models = [...new Set(session.notes.filter((n) => n.status === 'ok').map(noteByline))];
  if (!models.length) return null;
  return <p className="recent-byline">notes by {models.join(', ')} · each cites a file it touched</p>;
}
