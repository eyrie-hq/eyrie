import type { ArchNode } from '@eyrie/core';
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { findingChain, RULE_CATEGORY, showAllFindings, showFinding, type FindingView } from '../lib/findings';
import { timeAgo } from '../projects/format.js';
import { store, useStore } from '../state/store';

/** Security findings as inspector rows: scan the rail, open one onto its evidence and map path. */
export function HealthTab() {
  const health = useStore((s) => s.health);
  const loading = useStore((s) => s.healthLoading);
  const error = useStore((s) => s.healthError);
  const nodes = useStore((s) => s.nodes);
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const selection = useStore((s) => s.drawerSelection);
  const opened = useRef<string | null>(null);

  useEffect(() => {
    if (!store.get().health && !store.get().healthLoading) void store.loadHealth();
  }, []);

  // Opening the tab badges every finding's components; a Panel deep-link opens its row instead, keeping the highlight the Panel set. Leaving takes badges down, unless another tab points by then.
  useEffect(() => {
    if (!health) return;
    if (selection && selection.tab === 'health' && opened.current !== selection.id) {
      store.takeDrawerSelection();
      opened.current = selection.id;
      if (health.findings.some((f) => f.id === selection.id)) {
        setOpenId(selection.id);
        return;
      }
    }
    if (store.get().highlight?.source !== 'health') {
      setOpenId(null);
      showAllFindings(health.findings, nodes);
    }
    return () => {
      if (store.get().highlight?.source === 'health') store.clearHighlight();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health, selection]);

  const toggle = (finding: FindingView) => {
    if (openId === finding.id) {
      setOpenId(null);
      if (health) showAllFindings(health.findings, nodes);
      return;
    }
    setOpenId(finding.id);
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
      <div className="health-strip">
        <span className="health-strip-count" role="status">
          {findings.length === 0 ? 'Clean' : `${findings.length} finding${findings.length === 1 ? '' : 's'}`}
          <span className="visually-hidden">{breakdown(counts) ? `, ${breakdown(counts)}` : ''}</span>
        </span>
        <span aria-hidden="true" className="health-strip-chips">
          {counts.high ? <span className="health-chip high">{counts.high} high</span> : null}
          {counts.medium ? <span className="health-chip medium">{counts.medium} medium</span> : null}
          {counts.low ? <span className="health-chip low">{counts.low} low</span> : null}
        </span>
        <span className="health-strip-meta">
          {timeAgo(health.checkedAt, Date.now())} · {health.filesChecked} files
        </span>
        <button type="button" className="health-recheck" onClick={() => store.loadHealth()} disabled={loading}>
          {loading ? 'Checking…' : 'Re-check'}
        </button>
      </div>

      {findings.length === 0 ? (
        <p className="insight-empty">The map is clean: no hardcoded secrets, no unguarded writes, nothing else on the checklist.</p>
      ) : (
        <ul className="insp-list">
          {findings.map((finding, index) => {
            const isOpen = openId === finding.id;
            const onMap = finding.componentIds.some((id) => nodes.has(id));
            const bodyId = `health-body-${index}`;
            return (
              <li key={finding.id} className="insp-item" data-open={isOpen} data-severity={finding.severity}>
                <button type="button" className="insp-head" aria-expanded={isOpen} aria-controls={bodyId} onClick={() => toggle(finding)}>
                  <span className={`health-dot ${finding.severity}`} aria-hidden="true" />
                  <span className="insp-title">{finding.title}</span>
                  <span className="insp-meta">
                    {finding.severity.toUpperCase()} · {RULE_CATEGORY[finding.rule] ?? finding.rule}
                  </span>
                  <ChevronDown size={14} className="insp-chevron" aria-hidden="true" />
                </button>
                <div className="insp-body" id={bodyId}>
                  <div>
                    <p className="health-evidence">{finding.evidence}</p>
                    {monoRoute(finding, nodes) ? <p className="health-route">{monoRoute(finding, nodes)}</p> : null}
                    <div className="health-actions">
                      {onMap ? <button type="button" onClick={() => showFinding(finding, nodes)}>Show on map</button> : null}
                      <button type="button" onClick={() => copy(finding)}>
                        {copied === finding.id ? 'Copied' : 'Copy fix prompt'}
                      </button>
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

/** The severity breakdown as a sentence fragment for the live region. */
function breakdown(counts: { high: number; medium: number; low: number }): string {
  return [
    counts.high ? `${counts.high} high` : '',
    counts.medium ? `${counts.medium} medium` : '',
    counts.low ? `${counts.low} low` : '',
  ]
    .filter(Boolean)
    .join(', ');
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
