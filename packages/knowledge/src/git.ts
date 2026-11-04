/**
 * Reads a repository's history with the `git` command line. Eyrie opens
 * repositories it did not write, so git runs without a shell and with the
 * settings a repository could use to run its own programs turned off
 * (fsmonitor, external diff, textconv); `git log` runs no hooks.
 */
import { execFile } from 'node:child_process';

/** One file a commit changed. `added`/`deleted` are null for binary files. */
export interface CommitFile {
  path: string;
  added: number | null;
  deleted: number | null;
}

export interface GitCommit {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Epoch milliseconds. */
  authoredAt: number;
  committedAt: number;
  subject: string;
  /** The message after the subject line, trimmed. */
  body: string;
  /** People and agents named in `Co-Authored-By` trailers. */
  coAuthors: { name: string; email: string }[];
  /** Paths relative to the directory the history was read for. Merges list their changes against the first parent. */
  files: CommitFile[];
}

const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-c', 'log.showSignature=false'];
const MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      { cwd, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** Whether `path` (repo-relative) is tracked by git. False outside a work tree. */
export async function isTracked(dir: string, path: string): Promise<boolean> {
  try {
    return (await git(dir, ['ls-files', '--error-unmatch', '--', path])).trim().length > 0;
  } catch {
    return false;
  }
}

/** The commit HEAD points at, or null when `dir` is not in a git work tree or has no commits. */
export async function headCommit(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The newest `max` commits on HEAD that touched `dir`, newest first, as hashes
 * only: cheap enough to run on every open and scan.
 */
export async function recentHashes(dir: string, max: number): Promise<string[]> {
  try {
    const out = await git(dir, ['log', '--no-color', '--format=%H', `-n${max}`, 'HEAD', '--', '.']);
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const RS = '\x1e';
const US = '\x1f';
const FORMAT = `${RS}%H${US}%P${US}%an${US}%ae${US}%at${US}%ct${US}%B${US}`;

/**
 * Full details of the given commits, in the order given. Paths are relative to
 * `dir`, and changes outside it are left out, so a project opened at a
 * sub-folder of a repository sees only its own files.
 */
export async function readCommits(dir: string, hashes: string[]): Promise<GitCommit[]> {
  if (!hashes.length) return [];
  const out = await git(dir, [
    'log',
    '--no-walk=unsorted',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--diff-merges=first-parent',
    '--relative',
    '--numstat',
    `--format=${FORMAT}`,
    ...hashes,
    '--',
    '.',
  ]);
  return parseLog(out);
}

/** Parses `readCommits`' output. */
function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of out.split(RS)) {
    if (!record.trim()) continue;
    const fields = record.split(US);
    if (fields.length < 8) continue;
    const [hash, parents, authorName, authorEmail, authoredAt, committedAt, message, numstat] = fields as [string, string, string, string, string, string, string, string];
    const lines = message.replace(/\r\n/g, '\n').trim().split('\n');
    const subject = lines[0] ?? '';
    const body = lines.slice(1).join('\n').trim();
    commits.push({
      hash: hash.trim(),
      parents: parents.trim().split(' ').filter(Boolean),
      authorName,
      authorEmail,
      authoredAt: Number(authoredAt) * 1000,
      committedAt: Number(committedAt) * 1000,
      subject,
      body,
      coAuthors: coAuthorsOf(body),
      files: parseNumstat(numstat),
    });
  }
  return commits;
}

function parseNumstat(text: string): CommitFile[] {
  const files: CommitFile[] = [];
  for (const line of text.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    files.push({ path: match[3]!, added: match[1] === '-' ? null : Number(match[1]), deleted: match[2] === '-' ? null : Number(match[2]) });
  }
  return files;
}

function coAuthorsOf(body: string): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  for (const match of body.matchAll(/^co-authored-by:\s*(.+?)\s*<([^>]*)>\s*$/gim)) out.push({ name: match[1]!, email: match[2]! });
  return out;
}

/** Coding agents recognised from an author or co-author, by name or address. */
const AGENTS: [RegExp, string][] = [
  [/\bclaude\b|@anthropic\.com$/i, 'Claude'],
  [/\bcodex\b|\bopenai\b|@openai\.com$/i, 'Codex'],
  [/\bcopilot\b/i, 'Copilot'],
  [/\bcursor\b|@cursor\.(com|sh)$/i, 'Cursor'],
  [/\bgemini\b|\bjules\b|\bantigravity\b/i, 'Gemini'],
  [/\bmuse\b/i, 'Muse'],
  [/\bdevin\b/i, 'Devin'],
  [/\baider\b/i, 'Aider'],
];

/**
 * The canonical agent for an MCP client name (`claude-code` → `Claude`), so
 * sessions recorded over MCP match the agents commits name. Unknown clients
 * keep their own name and simply never match a commit.
 */
export function agentOfClient(name: string): string {
  for (const [pattern, agent] of AGENTS) if (pattern.test(name)) return agent;
  return name;
}

/** The coding agents a commit names as its author or co-authors, e.g. from `Co-Authored-By: Claude …`. */
export function agentsOf(commit: Pick<GitCommit, 'authorName' | 'authorEmail' | 'coAuthors'>): string[] {
  const found = new Set<string>();
  for (const person of [{ name: commit.authorName, email: commit.authorEmail }, ...commit.coAuthors]) {
    for (const [pattern, agent] of AGENTS) if (pattern.test(person.name) || pattern.test(person.email)) found.add(agent);
  }
  return [...found];
}
