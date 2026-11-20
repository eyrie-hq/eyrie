import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexWindowsAskBackend, type AiRequest } from '../src/index.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

class CodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42;
  readonly exitCode = null;
  readonly signalCode = null;

  close(code: number, stdout = '', stderr = '') {
    this.stdout.end(stdout);
    this.stderr.end(stderr);
    this.emit('close', code);
  }
}

const request: AiRequest = { system: 'Use the evidence', prompt: 'Where is checkout?', schema: { type: 'object' }, timeoutMs: 1000 };

describe('Windows Ask Codex', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const launches: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; profile: string }[] = [];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'eyrie-mxc-test-')));
    env = { PATH: dir, LOCALAPPDATA: dir, SystemRoot: dir, OPENAI_API_KEY: 'synthetic inherited key' };
    launches.length = 0;
    vi.resetAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function launch(reply: (process: CodexProcess, args: string[], cwd: string) => void) {
    vi.mocked(spawn).mockImplementationOnce((executable, args, options) => {
      const opts = options as { cwd: string; env: NodeJS.ProcessEnv };
      const argv = args as string[];
      const child = new CodexProcess();
      launches.push({ executable, args: argv, ...opts, profile: readFileSync(join(opts.env.CODEX_HOME!, 'config.toml'), 'utf8') });
      queueMicrotask(() => reply(child, argv, opts.cwd));
      return child as unknown as ReturnType<typeof spawn>;
    });
  }

  function loggedIn() {
    writeFileSync(join(dir, 'codex.exe'), 'stub');
    launch((child) => child.close(0, 'Logged in using ChatGPT\n'));
  }

  it('runs sign-in status and inference in explicit MXC and removes its workspace', async () => {
    loggedIn();
    launch((child, args) => {
      writeFileSync(args[args.indexOf('--output-last-message') + 1]!, '{"answer":"here"}');
      child.close(0, '{"type":"turn.completed","usage":{"input_tokens":10}}\n');
    });
    await expect(codexWindowsAskBackend(env).run(request)).resolves.toEqual({ json: { answer: 'here' }, usage: { input_tokens: 10 } });
    const [status, answer] = launches;
    expect(status!.executable).toBe(join(dir, 'codex.exe'));
    expect(status!.args).toEqual(expect.arrayContaining(['windows.sandbox=mxc', '--include-managed-config', '--permission-profile', 'eyrie-ask', 'login', 'status']));
    expect(answer!.args).toEqual(expect.arrayContaining(['windows.sandbox=mxc', '--ignore-user-config', '--sandbox', 'read-only']));
    expect(answer!.env.OPENAI_API_KEY).toBeUndefined();
    expect(answer!.profile).toContain('":root" = "deny"');
    expect(answer!.profile).toContain(JSON.stringify(join(dir, 'Eyrie', 'codex-ask')));
    expect(answer!.profile).not.toContain('synthetic inherited key');
    expect(status!.cwd).toBe(answer!.cwd);
    expect(existsSync(answer!.cwd)).toBe(false);
  });

  it('refuses script launchers and never starts a shell to run Codex', async () => {
    writeFileSync(join(dir, 'codex.cmd'), 'stub');
    await expect(codexWindowsAskBackend(env).run(request)).rejects.toThrow('native codex.exe');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['Not logged in', 'Sign in to ChatGPT'],
    ['Error checking login status: could not read auth.json', 'Your ChatGPT sign-in needs to be renewed.'],
    ['MXC is unavailable', 'required MXC isolation'],
    ['Error: windows.allow_mxc = false (set by C:\\ProgramData\\OpenAI\\Codex\\requirements.toml)', 'MXC is disabled by Windows Codex configuration or administrator policy.'],
  ])('stops before inference when the launch reports %s', async (stderr, error) => {
    writeFileSync(join(dir, 'codex.exe'), 'stub');
    launch((child) => child.close(1, '', stderr));
    await expect(codexWindowsAskBackend(env).run(request)).rejects.toThrow(error);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(existsSync(launches[0]!.cwd)).toBe(false);
  });

  it('asks the user to sign in again when a cached login cannot refresh', async () => {
    loggedIn();
    launch((child) => child.close(1, JSON.stringify({
      type: 'turn.failed',
      error: { message: 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.' },
    })));
    await expect(codexWindowsAskBackend(env).run(request)).rejects.toThrow(/^Your ChatGPT sign-in needs to be renewed\./);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(existsSync(launches[1]!.cwd)).toBe(false);
  });

  it('reports a policy denial when policy changes after the login check', async () => {
    loggedIn();
    launch((child) => child.close(1, '', 'MXC refused because windows.allow_mxc = false'));
    await expect(codexWindowsAskBackend(env).run(request)).rejects.toThrow(/^MXC is disabled/);
    expect(launches[1]!.args).toContain('--include-managed-config');
    expect(existsSync(launches[1]!.cwd)).toBe(false);
  });

  it.each([
    { stop: 'cancellation', status: 0, exit: 1 },
    { stop: 'timeout', status: 0, exit: 1 },
    { stop: 'cancellation as Codex exits', status: 1, exit: 0 },
  ])('terminates the process tree on $stop and waits for close before cleanup', async ({ stop, status, exit }) => {
    vi.useFakeTimers();
    loggedIn();
    const controller = new AbortController();
    let started!: (child: CodexProcess) => void;
    const running = new Promise<CodexProcess>((resolve) => { started = resolve; });
    launch((child) => started(child));
    vi.mocked(spawnSync).mockReturnValue({ status } as ReturnType<typeof spawnSync>);
    const result = codexWindowsAskBackend(env).run({ ...request, signal: controller.signal });
    const child = await running;
    if (stop === 'timeout') await vi.advanceTimersByTimeAsync(request.timeoutMs);
    else controller.abort();
    expect(spawnSync).toHaveBeenCalledWith(join(dir, 'System32', 'taskkill.exe'), ['/pid', '42', '/t', '/f'], expect.any(Object));
    expect(existsSync(launches[1]!.cwd)).toBe(true);
    child.close(exit);
    await expect(result).rejects.toThrow(stop === 'timeout' ? 'did not answer' : 'cancelled');
    expect(existsSync(launches[1]!.cwd)).toBe(false);
  });
});
