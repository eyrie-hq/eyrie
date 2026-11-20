/** Windows Ask runs the whole Codex CLI inside MXC, with an Eyrie-only login. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { findCommand } from '@eyrie/core/commands';
import type { AiBackend, AiRequest } from './analysis.js';
import { codexArgs, codexPrompt, parseCodexRun, strictSchema } from './codex.js';

const AUTH_STORE = 'cli_auth_credentials_store=file';
const MXC = 'windows.sandbox=mxc';
const SIGN_IN = 'Sign in to ChatGPT with the dedicated Eyrie Codex profile. See the Windows Ask setup in the README.';

function mxcConfig(codex: string, work: string, auth: string, env: NodeJS.ProcessEnv): string {
  return [
    'default_permissions = "eyrie-ask"',
    '[features]',
    'network_proxy = true',
    '[permissions.eyrie-ask.filesystem]',
    '":root" = "deny"',
    '":minimal" = "read"',
    `${JSON.stringify(work)} = "write"`,
    `${JSON.stringify(auth)} = "write"`,
    `${JSON.stringify(codex)} = "read"`,
    '[permissions.eyrie-ask.network]',
    'enabled = true',
    // MXC requires local binding for the managed proxy. The inner sandbox and
    // Codex tool settings still have to prevent a model from using loopback.
    'allow_local_binding = true',
    'allow_upstream_proxy = false',
    '[permissions.eyrie-ask.network.domains]',
    '"auth.openai.com" = "allow"',
    '"chatgpt.com" = "allow"',
    '[shell_environment_policy]',
    'inherit = "none"',
    '[shell_environment_policy.set]',
    ...Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
  ].join('\n');
}

function runMxc(
  codex: string, args: string[], work: string, env: NodeJS.ProcessEnv, systemRoot: string,
  request: AiRequest, deadline: number, input = '',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (request.signal?.aborted) return Promise.reject(new Error('cancelled'));
  const timeout = new Error(`codex did not answer within ${Math.round(request.timeoutMs / 1000)} s`);
  if (Date.now() >= deadline) return Promise.reject(timeout);
  return new Promise((resolve, reject) => {
    const child = spawn(codex, args, { cwd: work, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    let stopFailed = false;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      // Killing only the launcher can leave the contained command running.
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const stopped = spawnSync(join(systemRoot, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true, stdio: 'ignore', timeout: 5000,
        });
        stopFailed = stopped.status !== 0;
      }
    };
    const abort = () => stop(new Error('cancelled'));
    const timer = setTimeout(() => stop(timeout), deadline - Date.now());
    request.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (failure) return;
      stdout += chunk;
      if (stdout.length > 1_000_000) stop(new Error('Codex returned too much output.'));
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', () => { failure ??= new Error('Could not start Codex for Windows Ask.'); });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stop(new Error('Could not send the question to Codex.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      // taskkill can race a launcher that has already exited on its own.
      if (stopFailed && code === null) failure = new Error('Could not stop the Codex process tree.');
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
    if (request.signal?.aborted) abort();
    child.stdin.end(input);
  });
}

/** Used by the per-question HTTP picker. Startup backends use codexBackend. */
export function codexWindowsAskBackend(env: NodeJS.ProcessEnv = process.env): AiBackend {
  return {
    name: 'codex',
    async run(request) {
      if (request.signal?.aborted) throw new Error('cancelled');
      const command = findCommand('codex.exe', env.PATH ?? env.Path ?? '', { platform: 'win32', extensions: ['.exe'] });
      if (!command || !isAbsolute(command)) throw new Error('Could not find native codex.exe on PATH. Install the standalone Codex CLI for Windows Ask.');
      const codex = realpathSync(command);
      const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
      const localAppData = env.LOCALAPPDATA;
      if (!systemRoot || !isAbsolute(systemRoot) || !localAppData || !isAbsolute(localAppData)) {
        throw new Error('Windows Ask needs SystemRoot and LOCALAPPDATA to start Codex in MXC.');
      }
      const appData = realpathSync(localAppData);
      const auth = join(appData, 'Eyrie', 'codex-ask');
      mkdirSync(auth, { recursive: true });
      if (realpathSync(auth).toLowerCase() !== auth.toLowerCase()) throw new Error('The Eyrie Codex profile must be a local directory under LOCALAPPDATA.');

      const deadline = Date.now() + request.timeoutMs;
      const work = realpathSync(mkdtempSync(join(tmpdir(), 'eyrie-codex-')));
      try {
        const launcherHome = join(work, 'launcher');
        mkdirSync(launcherHome);
        const baseEnv = { SystemRoot: systemRoot, WINDIR: systemRoot, ProgramData: env.ProgramData, TEMP: work, TMP: work };
        const launcherEnv = { ...baseEnv, LOCALAPPDATA: appData, CODEX_HOME: launcherHome };
        const childEnv = { ...baseEnv, LOCALAPPDATA: work, USERPROFILE: work, CODEX_HOME: auth };
        writeFileSync(join(launcherHome, 'config.toml'), mxcConfig(codex, work, auth, childEnv));

        const launch = ['-c', MXC, 'sandbox', '--include-managed-config', '--permission-profile', 'eyrie-ask', '--cd', work, '--', codex, '-c', AUTH_STORE];
        const run = (args: string[], input?: string) => runMxc(codex, [...launch, ...args], work, launcherEnv, systemRoot, request, deadline, input);
        const login = await run(['login', 'status']);
        if (login.code !== 0 && !/not logged in/i.test(login.stdout + login.stderr)) {
          throw new Error('Could not start Codex with the required MXC isolation. Check Windows MXC support, managed policy, and your Codex CLI version.');
        }
        if (login.code !== 0 || !/logged in using ChatGPT/i.test(login.stdout + login.stderr)) throw new Error(SIGN_IN);

        const schemaFile = join(work, 'schema.json');
        const lastMessageFile = join(work, 'answer.json');
        writeFileSync(schemaFile, JSON.stringify(strictSchema(request.schema)));
        const result = await run(['-c', MXC, ...codexArgs({ workDir: work, schemaFile, lastMessageFile })], codexPrompt(request));
        if (result.code !== 0) throw new Error('Codex could not answer inside MXC. Check your ChatGPT sign-in, usage, and network policy.');
        if (!existsSync(lastMessageFile)) throw new Error('Codex answered without the requested JSON.');
        return parseCodexRun(result.stdout, readFileSync(lastMessageFile, 'utf8'), { answerOnly: true });
      } finally {
        rmSync(work, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  };
}
