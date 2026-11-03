import type { ArchNode } from '@eyrie/core';
import { useEffect, useState } from 'react';
import { findingChain, RULE_CATEGORY, showAllFindings, showFinding, type FindingView } from '../lib/findings';
import { timeAgo } from '../projects/format.js';
import { store, useStore } from '../state/store';

/** Security findings from the health check, each able to point at the map. */
export function HealthTab() {
  const health = useStore((s) => s.health);
  const loading = useStore((s) => s.healthLoading);
  const error = useStore((s) => s.healthError);
  const nodes = useStore((s) => s.nodes);
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!store.get().health && !store.get().healthLoading) void store.loadHealth();
  }, []);

  // Opening the tab badges every finding's components; leaving takes them down, unless another tab points by then.
  useEffect(() => {
    if (health) {
      setShown(null);
      showAllFindings(health.findings, nodes);
    }
    return () => {
      if (store.get().highlight?.source === 'health') store.clearHighlight();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health]);

  const toggle = (finding: FindingView) => {
    if (shown === finding.id) {
      setShown(null);
      if (health) showAllFindings(health.findings, nodes);
      return;
    }
    setShown(finding.id);
    showFinding(finding, nodes);
  };

  const copy = async (finding: FindingView) => {
    try {
      await navigator.clipboard.writeText(finding.fixPrompt);
      setCopied(finding.id);
      setTimeout(() => setCopied((id) => (id === finding.id ? null : id)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (!health && loading) {
    return (
      <p className="insight-progress" role="status">
        Checking the map…
      </p>
    );
  }
  if (!health) {
    return (
      <>
        <p className="insight-error" role="alert">
          {error ?? 'The health check did not run.'}
        </p>
        <p className="health-retry">
          <button type="button" onClick={() => store.loadHealth()}>
            Try again
          </button>
        </p>
      </>
    );
  }

  const { findings, counts } = health;
  return (
    <div className="health-tab">
      <div className="health-head">
        <p className="health-count">
          {findings.length === 0 ? 'No findings' : `${findings.length} finding${findings.length === 1 ? '' : 's'}`}
        </p>
        <p className="health-meta">
          checked {timeAgo(health.checkedAt, Date.now())} · {health.filesChecked} files
        </p>
        <div className="health-chips">
          {counts.high ? <span className="health-chip high">{counts.high} high</span> : null}
          {counts.medium ? <span className="health-chip medium">{counts.medium} medium</span> : null}
          {counts.low ? <span className="health-chip low">{counts.low} low</span> : null}
          <button type="button" className="health-recheck" onClick={() => store.loadHealth()} disabled={loading}>
            {loading ? 'Checking…' : 'Re-check'}
          </button>
        </div>
      </div>

      {findings.length === 0 ? (
        <p className="insight-empty">The map is clean: no hardcoded secrets, no unguarded writes, nothing else on the checklist.</p>
      ) : (
        <ul className="health-list">
          {findings.map((finding) => {
            const onMap = finding.componentIds.some((id) => nodes.has(id));
            const route = monoRoute(finding, nodes);
            return (
              <li key={finding.id}>
                <article className="health-card">
                  <p className={`health-severity ${finding.severity}`}>
                    <span className="health-dot" aria-hidden="true" />
                    {finding.severity.toUpperCase()} · {RULE_CATEGORY[finding.rule] ?? finding.rule}
                  </p>
                  <h3>{finding.title}</h3>
                  <p className="health-evidence">{finding.evidence}</p>
                  {route ? <p className="health-route">{route}</p> : null}
                  <div className="health-actions">
                    {onMap ? (
                      <button type="button" onClick={() => toggle(finding)} aria-pressed={shown === finding.id}>
                        {shown === finding.id ? 'Showing on map' : 'Show on map'}
                      </button>
                    ) : null}
                    <button type="button" onClick={() => copy(finding)}>
                      {copied === finding.id ? 'Copied' : 'Copy fix prompt'}
                    </button>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The finding's route through the map, or its file, in mono. */
function monoRoute(finding: FindingView, nodes: Map<string, ArchNode>): string | null {
  const labels = findingChain(finding)
    .map((id) => nodes.get(id)?.label)
    .filter((label): label is string => !!label);
  if (labels.length > 1) return labels.join(' → ');
  if (labels.length === 1) return labels[0]!;
  const file = finding.files[0];
  return file ? `${file.path}${file.line ? `:${file.line}` : ''}` : null;
}
