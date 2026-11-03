import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { noteByline, showSession, type SessionView } from '../lib/sessions';
import { timeAgo } from '../projects/format.js';
import { store, useStore } from '../state/store';

/** Agent sessions as inspector rows: the live one pinned open, earlier ones a push away. */
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
      <p className="insight-progress" role="status">
        Loading sessions…
      </p>
    );
  }
  if (!recent) {
    return (
      <>
        <p className="insight-error" role="alert">
          {error ?? 'Sessions did not load.'}
        </p>
        <p className="health-retry">
          <button type="button" onClick={() => store.loadRecent()}>
            Try again
          </button>
        </p>
      </>
    );
  }

  const sessions = recent.sessions;
  return (
    <div className="recent-tab">
      <div className="health-strip">
        <span className="health-strip-count" role="status">
          {sessions.length === 0 ? 'No sessions yet' : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
        </span>
        <button type="button" className="health-recheck" onClick={() => store.loadRecent()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {sessions.length === 0 ? (
        <p className="insight-empty">When an agent records its intent, its work lands here: the task, what it changed, and why.</p>
      ) : (
        <ul className="insp-list">
          {sessions.map((session) => {
            const isOpen = openId === session.id;
            const live = !session.endedAt;
            const parts = session.changes.added.length + session.changes.changed.length + session.changes.removed.length;
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
                    <span className="recent-live-dot hollow" aria-hidden="true" />
                  )}
                  <span className="insp-title">
                    {session.agent} · {session.task}
                  </span>
                  <span className="insp-meta">
                    {parts} part{parts === 1 ? '' : 's'} · <time dateTime={new Date(session.startedAt).toISOString()}>{timeAgo(session.startedAt, Date.now())}</time>
                  </span>
                  <ChevronDown size={14} className="insp-chevron" aria-hidden="true" />
                </button>
                <div className="insp-body" id={`recent-body-${session.id}`}>
                  <div>
                    {live ? <p className="recent-live">Live session</p> : null}
                    {session.summary && session.endedAt ? <p className="recent-summary">{session.summary}</p> : null}
                    <SessionParts session={session} />
                    <SessionByline session={session} />
                    <div className="health-actions">
                      <button type="button" onClick={() => showSession(session, nodes)}>
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

function SessionParts({ session }: { session: SessionView }) {
  const parts = [
    ...session.changes.added.map((c) => ({ ...c, mark: '+' as const })),
    ...session.changes.changed.map((c) => ({ ...c, mark: '~' as const })),
    ...session.changes.removed.map((c) => ({ ...c, mark: '−' as const })),
  ];
  if (!parts.length) return <p className="insight-empty">{session.endedAt ? 'Nothing in the architecture moved.' : 'No changes yet.'}</p>;
  const notes = new Map(session.notes.filter((n) => n.status === 'ok').map((n) => [n.component, n]));
  return (
    <ul className="recent-components">
      {parts.map((part) => (
        <li key={part.id} className={`recent-mark-${part.mark === '+' ? 'new' : part.mark === '~' ? 'changed' : 'removed'}`}>
          <span className="recent-mark" aria-hidden="true">
            {part.mark}
          </span>
          <span className="visually-hidden">{part.mark === '+' ? 'added' : part.mark === '~' ? 'changed' : 'removed'}: </span>
          <span className="recent-component">
            <span className="recent-label">{part.label}</span>
            {notes.get(part.id)?.note ? <span className="recent-note">{notes.get(part.id)!.note}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SessionByline({ session }: { session: SessionView }) {
  const models = [...new Set(session.notes.filter((n) => n.status === 'ok').map(noteByline))];
  if (!models.length) return null;
  return <p className="recent-byline">notes by {models.join(', ')} · each cites a file it touched</p>;
}
