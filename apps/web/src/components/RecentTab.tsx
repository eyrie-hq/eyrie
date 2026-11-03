import { useEffect, useState } from 'react';
import { noteByline, showSession, type SessionView } from '../lib/sessions';
import { timeAgo } from '../projects/format.js';
import { store, useStore } from '../state/store';

/** Agent sessions with the why: each task, what it changed, and what the agent said about it. */
export function RecentTab() {
  const recent = useStore((s) => s.recent);
  const loading = useStore((s) => s.recentLoading);
  const error = useStore((s) => s.recentError);
  const nodes = useStore((s) => s.nodes);
  const [shown, setShown] = useState<number | null>(null);

  useEffect(() => {
    if (!store.get().recent && !store.get().recentLoading) void store.loadRecent();
  }, []);

  // Opening the tab shows the live session; leaving takes it down, unless another tab points by then.
  useEffect(() => {
    const live = recent?.sessions.find((s) => !s.endedAt);
    if (live) {
      setShown(live.id);
      showSession(live, nodes);
    }
    return () => {
      if (store.get().highlight?.source === 'recent') store.clearHighlight();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent]);

  const toggle = (session: SessionView) => {
    if (shown === session.id) {
      setShown(null);
      store.clearHighlight();
      return;
    }
    setShown(session.id);
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

  const [live, ...earlier] = recent.sessions;
  const liveOpen = live && !live.endedAt ? live : null;
  const past = liveOpen ? earlier : recent.sessions;
  return (
    <div className="recent-tab">
      <div className="health-head">
        <p className="health-count">{recent.sessions.length === 0 ? 'No sessions yet' : `${recent.sessions.length} session${recent.sessions.length === 1 ? '' : 's'}`}</p>
        <div className="health-chips">
          <button type="button" className="health-recheck" onClick={() => store.loadRecent()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {recent.sessions.length === 0 ? (
        <p className="insight-empty">When an agent records its intent, its work lands here: the task, what it changed, and why.</p>
      ) : (
        <>
          {liveOpen ? <SessionCard session={liveOpen} live shown={shown === liveOpen.id} onToggle={() => toggle(liveOpen)} /> : null}
          {past.length ? (
            <section className="recent-earlier" aria-label="Earlier sessions">
              <h3 className="recent-earlier-title">Earlier sessions</h3>
              <ul>
                {past.map((session) => (
                  <li key={session.id}>
                    <details className="recent-collapsed">
                      <summary>
                        <span className="recent-summary-agent">{session.agent}</span>
                        <span className="recent-summary-when">{timeAgo(session.startedAt, Date.now())}</span>
                        <span className="recent-summary-task">{session.task}</span>
                        <span className="recent-summary-commit">{session.commit ? session.commit.hash.slice(0, 7) : 'uncommitted'}</span>
                      </summary>
                      <SessionCard session={session} level="h4" shown={shown === session.id} onToggle={() => toggle(session)} />
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function SessionCard({ session, live, shown, onToggle, level = 'h3' }: { session: SessionView; live?: boolean; shown: boolean; onToggle: () => void; level?: 'h3' | 'h4' }) {
  const Title = level;
  const parts = [
    ...session.changes.added.map((c) => ({ ...c, mark: '+' as const })),
    ...session.changes.changed.map((c) => ({ ...c, mark: '~' as const })),
    ...session.changes.removed.map((c) => ({ ...c, mark: '−' as const })),
  ];
  const entries = parts.map((part) => ({ ...part, note: session.notes.find((n) => n.component === part.id && n.status === 'ok') }));
  const models = [...new Set(session.notes.filter((n) => n.status === 'ok').map(noteByline))];
  const onMap = entries.length > 0;
  return (
    <article className="recent-card">
      {live ? <p className="recent-live">Live session</p> : null}
      <p className="recent-agent">
        {session.agent} · started {timeAgo(session.startedAt, Date.now())}
      </p>
      <Title>{session.task}</Title>
      <p className="recent-recorded">task recorded by the agent · record_intent</p>
      {session.summary && session.endedAt ? <p className="recent-summary">{session.summary}</p> : null}
      {entries.length ? (
        <ul className="recent-components">
          {entries.map((entry) => (
            <li key={entry.id} className={`recent-mark-${entry.mark === '+' ? 'new' : entry.mark === '~' ? 'changed' : 'removed'}`}>
              <span className="recent-mark" aria-hidden="true">
                {entry.mark}
              </span>
              <span className="recent-component">
                <span className="recent-label">{entry.label}</span>
                {entry.note?.note ? <span className="recent-note">{entry.note.note}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="insight-empty">{session.endedAt ? 'Nothing in the architecture moved.' : 'No changes yet.'}</p>
      )}
      {models.length ? <p className="recent-byline">notes by {models.join(', ')} · each cites a file it touched</p> : null}
      <div className="health-actions">
        {onMap ? (
          <button type="button" onClick={onToggle} aria-pressed={shown}>
            {shown ? 'Showing on map' : 'Show on map'}
          </button>
        ) : null}
        <span className="recent-commit">{session.commit ? session.commit.hash.slice(0, 7) : 'Not committed yet'}</span>
      </div>
    </article>
  );
}
