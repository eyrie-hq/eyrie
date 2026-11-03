import { archPath } from '@eyrie/lens';
import { useEffect, useRef, useState } from 'react';
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

interface Current {
  question: string;
  result: AskResultView;
}

const BACKEND_LABEL: Record<string, string> = { 'claude-code': 'Claude', claude: 'Claude', codex: 'Codex', muse: 'Muse', openai: 'OpenAI', scripted: 'Scripted' };

/** Ask the map: a question answered by a model that only used Eyrie's read-only tools. */
export function AskTab() {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [current, setCurrent] = useState<Current | null>(null);
  const [history, setHistory] = useState<AskRecordView[]>([]);
  const [backend, setBackend] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const edges = useStore((s) => s.edges);
  const nodes = useStore((s) => s.nodes);

  useEffect(() => {
    let alive = true;
    api<{ backend: string | null; questions: AskRecordView[] }>('/api/ask?limit=20')
      .then((res) => {
        if (!alive) return;
        setBackend(res.backend);
        setHistory(res.questions);
      })
      .catch((err: unknown) => alive && setFailed((err as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  // The current answer points at the map; leaving the tab takes it down, unless another tab points by then.
  useEffect(() => {
    const steps = current?.result.answer?.steps;
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
    setCurrent(null);
    try {
      const result = await api<AskResultView>('/api/ask', { method: 'POST', body: JSON.stringify({ question: q }), signal: controller.signal });
      setQuestion('');
      setCurrent({ question: q, result });
      const res = await api<{ backend: string | null; questions: AskRecordView[] }>('/api/ask?limit=20');
      setBackend(res.backend);
      setHistory(res.questions);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setFailed((err as Error).message);
    } finally {
      if (abort.current === controller) abort.current = null;
      setAsking(false);
    }
  };

  const replay = () => {
    const steps = current?.result.answer?.steps;
    if (!current || !steps?.length) return;
    const cited = steps.flatMap((s) => s.componentIds).filter((id) => nodes.has(id));
    const from = cited[0]!;
    const to = cited[cited.length - 1]!;
    const path = archPath([...edges.values()], from, to)?.nodes ?? cited;
    showSteps(current.question, steps, path);
    store.select(from, true);
  };

  const copy = async () => {
    const answer = current?.result.answer;
    if (!current || !answer) return;
    const text = `${current.question}\n\n${answer.answer}\n\n${answer.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const labelOf = (id: string) => nodes.get(id)?.label ?? id;

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
            placeholder={backend ? 'Where does checkout write?' : 'Start Eyrie with --ai to ask questions'}
            disabled={!backend || asking}
            maxLength={2000}
            autoComplete="off"
          />
          {asking ? (
            <button type="button" className="ask-stop" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!backend || !question.trim()}>
              Ask
            </button>
          )}
        </div>
      </form>

      {failed ? (
        <p className="insight-error" role="alert">
          {failed}
        </p>
      ) : null}
      {asking ? (
        <p className="insight-progress" role="status">
          Asking the map…
        </p>
      ) : null}

      {current ? (
        <article className="ask-answer">
          <h3>{current.question}</h3>
          {current.result.status === 'ok' && current.result.answer ? (
            <>
              <p className="ask-text">{current.result.answer.answer}</p>
              <ol className="ask-steps">
                {current.result.answer.steps.map((s, i) => (
                  <li key={i}>
                    <button type="button" className="ask-step" onClick={() => showSteps(current.question, [s])} title="Show this step on the map">
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
              {current.result.status === 'rejected' ? `Rejected: ${current.result.error}` : (current.result.error ?? 'The model did not answer.')}
            </p>
          )}
          <p className="ask-byline">
            answered by {current.result.model ?? BACKEND_LABEL[current.result.backend] ?? current.result.backend} · {current.result.calls.length} tool calls
          </p>
          <div className="ask-actions">
            {current.result.status === 'ok' && current.result.answer?.steps.length ? (
              <button type="button" onClick={replay}>
                Replay path
              </button>
            ) : null}
            {current.result.status === 'ok' ? <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy answer'}</button> : null}
            <details className="ask-calls">
              <summary>{current.result.calls.length} tool calls</summary>
              <ol>
                {current.result.calls.map((c, i) => (
                  <li key={i}>
                    <code>{c.name}</code> {Object.values(c.args ?? {}).filter((v) => typeof v === 'string' || typeof v === 'number').join(' · ')}
                  </li>
                ))}
              </ol>
            </details>
          </div>
        </article>
      ) : null}

      {history.length ? (
        <section className="ask-history" aria-label="Earlier questions">
          <h4>Earlier questions</h4>
          <ul>
            {history.map((q) => (
              <li key={q.id}>
                <button
                  type="button"
                  className={current?.result.id === q.id ? 'is-active' : undefined}
                  onClick={() => setCurrent({ question: q.question, result: q })}
                  title={new Date(q.createdAt).toLocaleString()}
                >
                  <span className={`ask-status ${q.status}`} aria-label={q.status} />
                  <span className="ask-history-q">{q.question}</span>
                  <time dateTime={new Date(q.createdAt).toISOString()}>{timeAgo(q.createdAt, Date.now())}</time>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
