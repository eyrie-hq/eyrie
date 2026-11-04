import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EYRIE_END, EYRIE_START, agentsSection, excludeFromGit, initAgents, withAgentsSection } from '../src/init-agents.js';

const dir = mkdtempSync(join(tmpdir(), 'eyrie-init-agents-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const repo = () => {
  const root = join(dir, `${n++}`);
  mkdirSync(root, { recursive: true });
  return root;
};

describe('init-agents', () => {
  it('tells agents when to call each tool', () => {
    const section = agentsSection();
    expect(section).toContain('components_for_files');
    expect(section).toContain('impact');
    expect(section).toContain('record_intent');
    expect(section).toContain('recent_changes');
    expect(section).toContain('check');
  });

  it('creates AGENTS.md with a marked section', () => {
    const root = repo();
    const result = initAgents(root);
    expect(result).toEqual({ file: join(root, 'AGENTS.md'), created: true, updated: true, excluded: false });
    const body = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(body).toContain(EYRIE_START);
    expect(body).toContain(EYRIE_END);
  });

  it('leaves other content alone and updates the section in place', () => {
    const root = repo();
    writeFileSync(join(root, 'AGENTS.md'), '# Team notes\n\nRun pnpm test.\n');
    initAgents(root);
    const first = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(first.startsWith('# Team notes\n\nRun pnpm test.\n')).toBe(true);
    // A stale section (an older Eyrie wrote fewer tools) is refreshed, not duplicated.
    writeFileSync(join(root, 'AGENTS.md'), first.replace('`check`', '`old-tool`'));
    const second = initAgents(root);
    expect(second.updated).toBe(true);
    const body = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(body).not.toContain('old-tool');
    expect(body.match(/<!-- eyrie:start -->/g)).toHaveLength(1);
    // A second run changes nothing.
    expect(initAgents(root).updated).toBe(false);
  });

  it('repairs a lone marker instead of duplicating the section', () => {
    const { text, updated } = withAgentsSection(`# Notes\n${EYRIE_START}\n`);
    expect(updated).toBe(true);
    expect(text.match(/<!-- eyrie:start -->/g)).toHaveLength(1);
    expect(text).toContain(EYRIE_END);
  });

  it('writes CLAUDE.local.md locally and keeps it out of git', () => {
    const root = repo();
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    const result = initAgents(root, { local: true });
    expect(result.file).toBe(join(root, 'CLAUDE.local.md'));
    expect(result.excluded).toBe(true);
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('CLAUDE.local.md\n');
    // A second run neither rewrites the file nor the exclude list.
    const before = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(initAgents(root, { local: true }).updated).toBe(false);
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toBe(before);
  });

  it('follows work-tree git pointers and skips non-repositories', () => {
    const root = repo();
    expect(excludeFromGit(root, 'CLAUDE.local.md')).toBe(false);
    const gitDir = join(dir, 'real-git');
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    writeFileSync(join(root, '.git'), `gitdir: ${gitDir}\n`);
    expect(excludeFromGit(root, 'CLAUDE.local.md')).toBe(true);
    expect(readFileSync(join(gitDir, 'info', 'exclude'), 'utf8')).toContain('CLAUDE.local.md\n');
  });
});
