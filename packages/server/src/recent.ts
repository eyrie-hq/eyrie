/**
 * Recent agent work for the UI: recorded sessions with their notes, each
 * linked to its commit once one lands. A session is linked to the agent's
 * earliest commit after the session started — usually this task's — through
 * the `Co-Authored-By` attribution commits already carry.
 */
import type { ProjectKnowledge, SessionNote, SessionRecord } from '@eyrie/knowledge';

export interface RecentSessionView extends SessionRecord {
  notes: SessionNote[];
  commit: { hash: string; subject: string; committedAt: number } | null;
}

export function recentSessions(knowledge: ProjectKnowledge | null | undefined, limit = 20): { sessions: RecentSessionView[] } {
  if (!knowledge) return { sessions: [] };
  const sessions = knowledge.store.sessions(limit);
  const bySession = new Map<number, SessionNote[]>();
  for (const note of knowledge.store.sessionNotes(sessions.map((s) => s.id))) {
    const list = bySession.get(note.sessionId) ?? [];
    list.push(note);
    bySession.set(note.sessionId, list);
  }
  return {
    sessions: sessions.map((session) => {
      // Git stamps whole seconds, so a commit from the session's first second
      // can read up to 999 ms before the session started.
      const landed = knowledge.store
        .commits({ agent: session.agent, limit: 50 })
        .filter((c) => c.committedAt >= session.startedAt - 1000)
        .sort((a, b) => a.committedAt - b.committedAt)[0];
      return {
        ...session,
        notes: bySession.get(session.id) ?? [],
        commit: landed ? { hash: landed.hash, subject: landed.subject, committedAt: landed.committedAt } : null,
      };
    }),
  };
}
