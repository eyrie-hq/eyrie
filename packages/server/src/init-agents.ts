/**
 * `eyrie init-agents`: tells the coding agents working in a repository that
 * Eyrie's MCP tools exist, and when to call them. Agents rarely call tools
 * they have no reason to; a short marked section in the repository's agent
 * instructions gives them the reason.
 *
 * The section goes to AGENTS.md (read by agents across vendors, committed with
 * the repository) or, with `local`, to CLAUDE.local.md (kept out of commits
 * through .git/info/exclude). A second run refreshes the section in place and
 * changes nothing else in the file.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const EYRIE_START = '<!-- eyrie:start -->';
export const EYRIE_END = '<!-- eyrie:end -->';

/** The section, without surrounding blank lines. */
export function agentsSection(): string {
  return [
    EYRIE_START,
    '## Eyrie architecture tools',
    '',
    'Eyrie keeps a live architecture map of this repository. When the eyrie MCP server is connected, use its tools around every edit:',
    '',
    '- Before editing, call `components_for_files` with the files you plan to change, and `impact` on the components involved, to see what depends on them.',
    '- At the start of a task, call `record_intent` with the task; call it again with `done: true` and a `summary` when the task ends.',
    '- After editing, call `recent_changes` to see what your edits changed, and `check` for new findings in the files you touched.',
    EYRIE_END,
  ].join('\n');
}

export interface InitAgentsOptions {
  /** Write CLAUDE.local.md instead of AGENTS.md, and keep it out of git. */
  local?: boolean;
}

export interface InitAgentsResult {
  /** The file written, as an absolute path. */
  file: string;
  /** It did not exist before. */
  created: boolean;
  /** Its contents changed. A second run changes nothing. */
  updated: boolean;
  /** CLAUDE.local.md was added to .git/info/exclude (local mode, git repositories). */
  excluded: boolean;
}

/** `body` with the Eyrie section refreshed: replaced in place, or appended. */
export function withAgentsSection(body: string): { text: string; updated: boolean } {
  const section = agentsSection();
  const span = /<!-- eyrie:start -->[\s\S]*?<!-- eyrie:end -->/;
  if (span.test(body)) {
    const text = body.replace(span, () => section);
    return { text, updated: text !== body };
  }
  // A lone marker from an interrupted write carries no section; drop it.
  const cleaned = body.replace(/<!-- eyrie:(start|end) -->\n?/g, '');
  const gap = cleaned && !cleaned.endsWith('\n') ? '\n' : '';
  const blank = cleaned && !cleaned.endsWith('\n\n') ? '\n' : '';
  return { text: `${cleaned}${gap}${blank}${section}\n`, updated: true };
}

/**
 * Keeps a file out of commits through the repository's info/exclude. Returns
 * false outside a git repository (or a work tree whose git dir is elsewhere).
 */
export function excludeFromGit(root: string, file: string): boolean {
  const dotGit = join(root, '.git');
  let gitDir: string;
  try {
    if (statSync(dotGit).isDirectory()) {
      gitDir = dotGit;
    } else {
      const pointer = readFileSync(dotGit, 'utf8');
      if (!pointer.startsWith('gitdir: ')) return false;
      gitDir = resolve(root, pointer.slice('gitdir: '.length).trim());
    }
  } catch {
    return false;
  }
  const exclude = join(gitDir, 'info', 'exclude');
  let lines: string[] = [];
  try {
    lines = readFileSync(exclude, 'utf8').split('\n');
  } catch {
    lines = [];
  }
  if (lines.some((l) => l.trim() === file)) return true;
  mkdirSync(dirname(exclude), { recursive: true });
  const body = lines.join('\n');
  writeFileSync(exclude, `${!body ? '' : body.endsWith('\n') ? body : `${body}\n`}${file}\n`);
  return true;
}

export function initAgents(root: string, opts: InitAgentsOptions = {}): InitAgentsResult {
  const name = opts.local ? 'CLAUDE.local.md' : 'AGENTS.md';
  const file = join(root, name);
  let body = '';
  let created = false;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    created = true;
  }
  const { text, updated } = withAgentsSection(body);
  if (updated) writeFileSync(file, text);
  const excluded = opts.local ? excludeFromGit(root, name) : false;
  return { file, created, updated, excluded };
}
