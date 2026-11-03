/**
 * Optional AI notes on a session's changed components: one or two sentences
 * on how each change serves the session's task.
 *
 * The same rules as commit notes hold: the model sees names, paths and the
 * graph's components, never source code; a note cites a file the session
 * touched or it is stored as `rejected`; every note is labelled with the
 * model that wrote it; and a note never becomes a fact.
 */
import type { AiBackend, AiRequest } from './analysis.js';
import type { SessionComponent } from './store.js';

const SYSTEM = `You explain code changes for Eyrie, a tool that keeps a live architecture map of a codebase.
For each changed component you get the agent's task, the component (id, label, kind, lane), and the files the session touched.
You do not see source code. Use only the facts given.
For each component, in one or two sentences, say how its change serves the task, and cite one or two touched files as evidence.
Write plainly, without hype.`;

/** Components per request: one request covers a session, and long sessions are cut, not paged. */
export const MAX_NOTED_COMPONENTS = 8;
const MAX_FILES = 40;
const MAX_NOTE = 500;

export interface SessionNoteInput {
  task: string;
  components: SessionComponent[];
  /** Every file the session touched. */
  touchedFiles: string[];
}

export interface SessionNoteEntry {
  component: string;
  note: string;
  files: string[];
}

const SCHEMA = {
  type: 'object',
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          component: { type: 'string' },
          note: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['component', 'note', 'files'],
      },
    },
  },
  required: ['notes'],
};

/** The request for one session's notes. */
export function noteRequest(input: SessionNoteInput, timeoutMs: number, signal?: AbortSignal): AiRequest {
  const packet = {
    task: input.task,
    components: input.components.slice(0, MAX_NOTED_COMPONENTS).map((c) => ({ id: c.id, label: c.label, kind: c.kind, lane: c.lane })),
    touchedFiles: [...new Set(input.touchedFiles)].slice(0, MAX_FILES),
  };
  return {
    system: SYSTEM,
    prompt: `Explain these changes. Answer with one entry per component, in the same order.\n\n${JSON.stringify(packet, null, 1)}`,
    schema: SCHEMA,
    timeoutMs,
    signal,
  };
}

/**
 * Checks one entry of the model's answer against the session it is about.
 * Returns the entry, or why it is rejected.
 */
export function validateSessionNote(input: SessionNoteInput, raw: unknown): { entry: SessionNoteEntry } | { error: string } {
  const r = raw as Partial<SessionNoteEntry> | null;
  if (!r || typeof r !== 'object') return { error: 'not an object' };
  if (typeof r.component !== 'string' || !input.components.some((c) => c.id === r.component)) return { error: 'unknown component' };
  if (typeof r.note !== 'string' || !r.note.trim()) return { error: 'missing note' };
  if (r.note.length > MAX_NOTE) return { error: 'note too long' };
  if (!Array.isArray(r.files) || !r.files.length) return { error: 'cites no file' };
  const touched = new Set(input.touchedFiles);
  for (const file of r.files) {
    if (typeof file !== 'string' || !touched.has(file)) return { error: `cites a file the session did not touch: ${String(file)}` };
  }
  return { entry: { component: r.component, note: r.note.trim(), files: r.files as string[] } };
}

export interface NotedComponent {
  component: string;
  label: string;
  status: 'ok' | 'failed' | 'rejected';
  note: string | null;
  files: string[];
  error: string | null;
}

/**
 * Notes the session's changed components through one model call. A failed
 * call fails every component; an entry that names no touched file is
 * rejected; a component with no entry gets no note.
 */
export async function noteSessionChanges(backend: AiBackend, input: SessionNoteInput, timeoutMs: number): Promise<{ noted: NotedComponent[]; model: string | null }> {
  const components = input.components.slice(0, MAX_NOTED_COMPONENTS);
  let json: unknown;
  let model: string | null = null;
  try {
    const result = await backend.run(noteRequest(input, timeoutMs));
    json = result.json;
    model = result.model ?? null;
  } catch (err) {
    const error = (err as Error).message;
    return { noted: components.map((c) => ({ component: c.id, label: c.label, status: 'failed' as const, note: null, files: [], error })), model: null };
  }
  const entries = ((json as { notes?: unknown[] } | null)?.notes ?? []) as unknown[];
  const noted: NotedComponent[] = [];
  for (const component of components) {
    const raw = entries.find((e) => (e as Partial<SessionNoteEntry> | null)?.component === component.id);
    if (!raw) continue;
    const checked = validateSessionNote(input, raw);
    if ('entry' in checked) {
      noted.push({ component: component.id, label: component.label, status: 'ok', note: checked.entry.note, files: checked.entry.files, error: null });
    } else {
      noted.push({ component: component.id, label: component.label, status: 'rejected', note: null, files: [], error: checked.error });
    }
  }
  return { noted, model };
}
