import { archPath } from '@eyrie/lens';
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { timeAgo } from '../projects/format.js';
import { api, store, useStore } from '../state/store';

interface AskStepView {
  text: string;
  componentIds: string[];
}

interface AskCallView {
  name: string;
  args: Record<string, unknown>;
}

interface AskResultView {
  status: 'ok' | 'failed' | 'rejected';
  answer: { answer: string; steps: AskStepView[] } | null;
  calls: AskCallView[];
  backend: string;
  model: string | null;
  error: string | null;
  ms: number;
  id: number | null;
}

interface AskRecordView extends AskResultView {
  question: string;
  createdAt: number;
}

const BACKEND_LABEL: Record<string, string> = { 'claude-code': 'Claude', claude: 'Claude', codex: 'Codex', muse: 'Muse', openai: 'OpenAI', scripted: 'Scripted' };
const BACKENDS = [
  { id: 'auto', label: 'Auto' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'muse', label: 'Muse' },
  { id: 'openai', label: 'OpenAI' },
];

const recordKey = (record: AskRecordView): string => (record.id === null ? `live-${record.question}` : String(record.id));

/** Ask the map: answers as inspector rows, each openable onto its evidence and map path. */
export function AskTab() {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [current, setCurrent] = useState<AskRecordView | null>(null);
  const [history, setHistory] = useState<AskRecordView[] | null>(null);
  const [serverBackend, setServerBackend] = useState<string | null>(null);
  const [pick, setPick] = useState('auto');
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const edges = useStore((s) => s.edges);
  const nodes = useStore((s) => s.nodes);

  useEffect(() => {
    let alive = true;
    api<{ backend: string | null; questions: AskRecordView[] }>('/api/ask?limit=20')
      .then((res) => {
        if (!alive) return;
        setServerBackend(res.backend);
        setHistory(res.questions);
      })
      .catch((err: unknown) => alive && setFailed((err as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  // The open answer points at the map; leaving the tab takes it down, unless another tab points by then.
  useEffect(() => {
    const steps = current?.answer?.steps;
    if (current && steps?.length) showSteps(current.question, steps);
    return () => {
      if (store.get().highlight?.source === 'ask') store.clearHighlight();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  useEffect(() => () => abort.current?.abort(), []);

  const showSteps = (question: string, steps: AskStepView[], path?: string[]) => {
    const ids: string[] = [];
    const labels: Record<string, string> = {};
    steps.forEach((s, i) => {
      for (const id of s.componentIds) {
        if (!labels[id] && nodes.has(id)) {
          labels[id] = String(i + 1);
          ids.push(id);
        }
      }
    });
    if (ids.length) store.setHighlight({ source: 'ask', ids, labels, path, description: `Answer to "${question}"` });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const q = question.trim();
    if (!q || asking) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setAsking(true);
    setFailed(null);
    try {
      const result = await api<AskResultView>('/api/ask', { method: 'POST', body: JSON.stringify({ question: q, backend: pick }), signal: controller.signal });
      setQuestion('');
      const res = await api<{ backend: string | null; questions: AskRecordView[] }>('/api/ask?limit=20');
      setServerBackend(res.backend);
      setHistory(res.questions);
      setCurrent(res.questions.find((r) => r.id === result.id) ?? { ...result, question: q, createdAt: Date.now() });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setFailed((err as Error).message);
    } finally {
      if (abort.current === controller) abort.current = null;
      setAsking(false);
    }
  };

  const open = (record: AskRecordView | null) => {
    setCurrent(record);
    if (!record && store.get().highlight?.source === 'ask') store.clearHighlight();
  };

  const replay = () => {
    const steps = current?.answer?.steps;
    if (!current || !steps?.length) return;
    const cited = steps.flatMap((s) => s.componentIds).filter((id) => nodes.has(id));
    const from = cited[0]!;
    const to = cited[cited.length - 1]!;
    const path = archPath([...edges.values()], from, to)?.nodes ?? cited;
    showSteps(current.question, steps, path);
    store.select(from, true);
  };

  const copy = async (record: AskRecordView) => {
    const answer = record.answer;
    if (!answer) return;
    const key = recordKey(record);
    const text = `${record.question}\n\n${answer.answer}\n\n${answer.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((id) => (id === key ? null : id)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const onPickKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = BACKENDS.findIndex((b) => b.id === pick);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? BACKENDS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + BACKENDS.length) % BACKENDS.length;
    setPick(BACKENDS[next]!.id);
    (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
  };

  const labelOf = (id: string) => nodes.get(id)?.label ?? id;
  const autoLabel = serverBackend ? `Auto (${BACKEND_LABEL[serverBackend] ?? serverBackend})` : 'Auto';
  const asked = history ?? [];
  const rows = current && !asked.some((h) => h.id === current.id) ? [current, ...asked] : asked;

  return (
    <div className="ask-tab">
      <form className="ask-form" onSubmit={submit}>
        <label className="ask-label" htmlFor="ask-question">
          Ask anything about this architecture
        </label>
        <div className="ask-row">
          <input
            id="ask-question"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={serverBackend || pick !== 'auto' ? 'Where does checkout write?' : 'Pick who answers, below'}
            disabled={asking}
            maxLength={2000}
            autoComplete="off"
          />
          {asking ? (
            <button type="button" className="ask-stop" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!question.trim()}>
              Ask
            </button>
          )}
        </div>
        <div className="ask-backends" role="radiogroup" aria-label="Who answers">
          {BACKENDS.map((b) => (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={pick === b.id}
              tabIndex={pick === b.id ? 0 : -1}
              title={b.id === 'auto' ? `Server default${serverBackend ? `: ${BACKEND_LABEL[serverBackend] ?? serverBackend}` : ' (none set)'}` : `Answer with ${b.label}`}
              onClick={() => setPick(b.id)}
              onKeyDown={onPickKeyDown}
            >
              {b.id === 'auto' ? autoLabel : b.label}
            </button>
          ))}
        </div>
        {!serverBackend && pick === 'auto' && history !== null ? <p className="ask-off">No AI backend configured — pick one above, or start Eyrie with --ai.</p> : null}
      </form>

      {failed ? (
        <p className="insight-error" role="alert">
          {failed}
        </p>
      ) : null}
      {asking ? (
        <p className="insight-progress" role="status">
          {BACKEND_LABEL[pick] ?? 'The model'} is reading the map…
        </p>
      ) : null}

      {rows.length ? (
        <ul className="insp-list">
          {rows.map((record) => {
            const isOpen = current?.id != null ? current.id === record.id : current?.question === record.question && record.id === null;
            const bodyId = `ask-body-${record.id ?? 'live'}`;
            return (
              <li key={recordKey(record)} className="insp-item" data-open={isOpen}>
                <button
                  type="button"
                  className="insp-head"
                  aria-expanded={isOpen}
                  aria-controls={bodyId}
                  onClick={() => open(isOpen ? null : record)}
                  title={new Date(record.createdAt).toLocaleString()}
                >
                  <span className={`ask-status ${record.status}`} role="img" aria-label={record.status} />
                  <span className="insp-title">{record.question}</span>
                  <span className="insp-meta">
                    {record.model ?? BACKEND_LABEL[record.backend] ?? record.backend} · <time dateTime={new Date(record.createdAt).toISOString()}>{timeAgo(record.createdAt, Date.now())}</time>
                  </span>
                  <ChevronDown size={14} className="insp-chevron" aria-hidden="true" />
                </button>
                <div className="insp-body" id={bodyId}>
                  <div>
                    {record.status === 'ok' && record.answer ? (
                      <>
                        <p className="ask-text">{record.answer.answer}</p>
                        <ol className="ask-steps">
                          {record.answer.steps.map((s, i) => (
                            <li key={i}>
                              <button type="button" className="ask-step" onClick={() => showSteps(record.question, [s])} title="Show this step on the map">
                                <span className="ask-step-no">{i + 1}</span>
                                <span>
                                  {s.text} {s.componentIds.map((id) => labelOf(id)).join(' › ')}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ol>
                      </>
                    ) : (
                      <p className="insight-error" role="alert">
                        {record.status === 'rejected' ? `Rejected: ${record.error}` : (record.error ?? 'The model did not answer.')}
                      </p>
                    )}
                    <p className="ask-byline">
                      answered by {record.model ?? BACKEND_LABEL[record.backend] ?? record.backend} · {record.calls.length} tool calls
                    </p>
                    <div className="ask-actions">
                      {record.status === 'ok' && record.answer?.steps.length ? <button type="button" onClick={replay}>Replay path</button> : null}
                      {record.status === 'ok' ? <button type="button" onClick={() => copy(record)}>{copied === recordKey(record) ? 'Copied' : 'Copy answer'}</button> : null}
                      <details className="ask-calls">
                        <summary>{record.calls.length} tool calls</summary>
                        <ol>
                          {record.calls.map((c, i) => (
                            <li key={i}>
                              <code>{c.name}</code> {Object.values(c.args ?? {}).filter((v) => typeof v === 'string' || typeof v === 'number').join(' · ')}
                            </li>
                          ))}
                        </ol>
                      </details>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : history === null && !failed ? (
        <p className="insight-empty">Loading questions…</p>
      ) : !asking && !failed ? (
        <p className="insight-empty">No questions yet. Ask where something lives, what would break, or how a request flows.</p>
      ) : null}
    </div>
  );
}
