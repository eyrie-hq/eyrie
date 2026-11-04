import type { ArchNode } from '@eyrie/core';
import { Check, ChevronDown, Copy, Loader2, MapPin, RotateCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { findingChain, RULE_CATEGORY, showAllFindings, showFinding, type FindingView, type Severity } from '../lib/findings';
import { timeAgo } from '../projects/format.js';
import { store, useStore } from '../state/store';

type SeverityFilter = 'all' | Severity;

const FILTERS: { id: SeverityFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Security findings as inspector cards: scan the rail, open one onto its evidence and map path. */
export function HealthTab() {
  const health = useStore((s) => s.health);
  const loading = useStore((s) => s.healthLoading);
  const error = useStore((s) => s.healthError);
  const nodes = useStore((s) => s.nodes);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<SeverityFilter>('all');
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
      <>
        <div className="insight-loading" role="status">
          <Loader2 size={13} className="insight-spinner" aria-hidden="true" />
          <span>Checking the map…</span>
        </div>
        <ul className="insight-skeleton" aria-hidden="true">
          <li />
          <li />
          <li />
        </ul>
      </>
    );
  }
  if (!health) {
    return (
      <div className="insight-empty-state">
        <ShieldAlert size={18} aria-hidden="true" />
        <p className="insight-empty-title">The health check did not run</p>
        <p className="insight-error" role="alert">
          {error ?? 'The health check did not run.'}
        </p>
        <button type="button" className="insight-btn" onClick={() => store.loadHealth()}>
          <RotateCw size={12} aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }

  const { findings, counts } = health;
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const visible = filter === 'all' ? sorted : sorted.filter((f) => f.severity === filter);

  return (
    <div className="health-tab">
      <div className="health-summary" role="status">
        <div className="health-summary-top">
          {findings.length === 0 ? (
            <span className="health-summary-count is-clean">
              <ShieldCheck size={14} aria-hidden="true" />
              Clean
            </span>
          ) : (
            <span className="health-summary-count">
              {findings.length} finding{findings.length === 1 ? '' : 's'}
              <span className="visually-hidden">{breakdown(counts) ? `, ${breakdown(counts)}` : ''}</span>
            </span>
          )}
          <button type="button" className="insight-btn is-quiet" onClick={() => store.loadHealth()} disabled={loading}>
            <RotateCw size={12} aria-hidden="true" className={loading ? 'insight-spinner' : undefined} />
            {loading ? 'Checking…' : 'Re-check'}
          </button>
        </div>
        {findings.length > 0 ? (
          <div className="health-summary-chips" role="group" aria-label="Filter by severity">
            {FILTERS.map((f) => {
              const n = f.id === 'all' ? findings.length : counts[f.id as Severity];
              if (f.id !== 'all' && !n) return null;
              return (
                <button key={f.id} type="button" className="health-chip" data-severity={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(filter === f.id ? 'all' : f.id)}>
                  <span className="health-chip-dot" aria-hidden="true" />
                  {n} {f.label.toLowerCase()}
                </button>
              );
            })}
          </div>
        ) : null}
        <p className="health-summary-meta">
          Checked {timeAgo(health.checkedAt, Date.now())} · {health.filesChecked} files
        </p>
      </div>

      {findings.length === 0 ? (
        <div className="insight-empty-state">
          <ShieldCheck size={18} aria-hidden="true" />
          <p className="insight-empty-title">Nothing on the checklist</p>
          <p className="insight-empty">No hardcoded secrets, no unguarded writes, no unverified webhooks. Re-check after your next change.</p>
        </div>
      ) : visible.length === 0 ? (
        <p className="insight-empty">No {filter} findings. The rest of the checklist is clear at this severity.</p>
      ) : (
        <ul className="insp-list">
          {visible.map((finding) => {
            const isOpen = openId === finding.id;
            const onMap = finding.componentIds.some((id) => nodes.has(id));
            const bodyId = `health-body-${finding.id}`;
            const route = monoRoute(finding, nodes);
            return (
              <li key={finding.id} className="insp-item" data-open={isOpen} data-severity={finding.severity}>
                <button type="button" className="insp-head" aria-expanded={isOpen} aria-controls={bodyId} onClick={() => toggle(finding)}>
                  <span className={`health-sev ${finding.severity}`} aria-hidden="true">
                    {finding.severity === 'high' ? 'H' : finding.severity === 'medium' ? 'M' : 'L'}
                  </span>
                  <span className="insp-text">
                    <span className="insp-title">{finding.title}</span>
                    <span className="insp-meta">
                      {finding.severity.toUpperCase()} · {RULE_CATEGORY[finding.rule] ?? finding.rule}
                    </span>
                  </span>
                  <ChevronDown size={14} className="insp-chevron" aria-hidden="true" />
                </button>
                <div className="insp-body" id={bodyId}>
                  <div>
                    <p className="health-evidence">{finding.evidence}</p>
                    {route ? <p className="health-route">{route}</p> : null}
                    <div className="health-actions">
                      {onMap ? (
                        <button type="button" className="insight-btn" onClick={() => showFinding(finding, nodes)}>
                          <MapPin size={12} aria-hidden="true" />
                          Show on map
                        </button>
                      ) : null}
                      <button type="button" className="insight-btn" onClick={() => copy(finding)}>
                        {copied === finding.id ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
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
