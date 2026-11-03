/**
 * Health findings shared by the Health tab, the top-bar counter and the
 * Panel's Findings section: the view of `/api/check`, display labels per
 * rule, and the one way a finding points at the map.
 */
import type { ArchNode } from '@eyrie/core';
import { store } from '../state/store';

export type Severity = 'high' | 'medium' | 'low';

export interface FindingFileView {
  path: string;
  line?: number;
}

export interface FindingView {
  id: string;
  rule: string;
  severity: Severity;
  title: string;
  evidence: string;
  files: FindingFileView[];
  componentIds: string[];
  path?: [from: string, to: string][];
  fixPrompt: string;
}

export interface HealthSummaryView {
  findings: FindingView[];
  checkedAt: number;
  filesChecked: number;
  counts: Record<Severity, number>;
}

/** The category word beside the severity, per the mock (`HIGH · AUTH`). */
export const RULE_CATEGORY: Record<string, string> = {
  'hardcoded-secret': 'SECRETS',
  'public-env-secret': 'SECRETS',
  'env-file-exposed': 'SECRETS',
  'supabase-no-rls': 'DATA',
  'firebase-test-mode': 'DATA',
  'unguarded-write': 'AUTH',
  'client-env-leak': 'CLIENT',
  'unverified-webhook': 'WEBHOOK',
};

/** The cited path as an ordered node chain for the highlight. */
export function findingChain(finding: FindingView): string[] {
  if (finding.path?.length) return [finding.path[0]![0], ...finding.path.map(([, to]) => to)];
  return finding.componentIds;
}

/** Rings the finding's components red, marks them `!`, and draws its path heavier. */
export function showFinding(finding: FindingView, nodes: Map<string, ArchNode>): void {
  const chain = findingChain(finding).filter((id) => nodes.has(id));
  const ids = chain.length ? chain : finding.componentIds.filter((id) => nodes.has(id));
  if (!ids.length) return;
  const labels: Record<string, string> = {};
  for (const id of ids) labels[id] = '!';
  store.setHighlight({ source: 'health', ids, labels, path: chain.length > 1 ? chain : undefined, description: finding.title });
}

/** Every finding's components get a `!` badge; nothing is ringed yet. */
export function showAllFindings(findings: FindingView[], nodes: Map<string, ArchNode>): void {
  const ids = [...new Set(findings.flatMap((f) => f.componentIds))].filter((id) => nodes.has(id));
  if (!ids.length) return;
  const labels: Record<string, string> = {};
  for (const id of ids) labels[id] = '!';
  store.setHighlight({ source: 'health', ids, labels, description: `${findings.length} findings` });
}
