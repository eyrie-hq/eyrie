/**
 * Recent work shared by the Recent tab, the top-bar counter, the Panel and
 * the change tape: the view of `/api/recent`, and the one way a session
 * points at the map.
 */
import type { ArchNode } from '@eyrie/core';
import { store } from '../state/store';

export interface SessionComponentView {
  id: string;
  label: string;
  kind: string;
  lane: string;
}

export interface SessionNoteView {
  id: number;
  component: string;
  label: string;
  backend: string;
  model: string | null;
  status: 'ok' | 'failed' | 'rejected';
  note: string | null;
  files: string[];
  error: string | null;
}

export interface SessionView {
  id: number;
  task: string;
  summary: string | null;
  agent: string;
  startedAt: number;
  endedAt: number | null;
  changes: {
    files: { file: string; change: string }[];
    added: SessionComponentView[];
    changed: SessionComponentView[];
    removed: SessionComponentView[];
    linksAdded: { source: string; target: string }[];
    linksRemoved: { source: string; target: string }[];
  };
  notes: SessionNoteView[];
  commit: { hash: string; subject: string; committedAt: number } | null;
}

export interface RecentView {
  sessions: SessionView[];
}

const BACKEND_LABEL: Record<string, string> = { 'claude-code': 'Claude', claude: 'Claude', codex: 'Codex', muse: 'Muse', openai: 'OpenAI', scripted: 'Scripted' };

/** Who wrote a note: its model, or its backend when the model is unknown. */
export function noteByline(note: SessionNoteView): string {
  return note.model ?? BACKEND_LABEL[note.backend] ?? note.backend;
}

/** The mark for a session component: `+` new, `~` changed, `−` removed. */
export function sessionMarks(session: SessionView): Map<string, string> {
  const marks = new Map<string, string>();
  for (const c of session.changes.added) marks.set(c.id, '+');
  for (const c of session.changes.changed) marks.set(c.id, '~');
  for (const c of session.changes.removed) marks.set(c.id, '−');
  return marks;
}

/** Rings the session's components green with `+`/`~`/`−` badges; edges between them run heavier. */
export function showSession(session: SessionView, nodes: Map<string, ArchNode>): void {
  const marks = sessionMarks(session);
  const ids = [...marks.keys()].filter((id) => nodes.has(id));
  if (!ids.length) return;
  const labels: Record<string, string> = {};
  for (const id of ids) labels[id] = marks.get(id)!;
  store.setHighlight({ source: 'recent', ids, labels, path: ids.length > 1 ? ids : undefined, description: session.task });
}
