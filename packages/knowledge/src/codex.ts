/**
 * The Codex CLI as an AI backend: `codex exec`, signed in the way the user
 * already uses it, so Eyrie holds no API key. This runner uses macOS Seatbelt.
 *
 * Codex's own settings are not enough to stop a model acting on the machine.
 * Checked with Codex 0.160: its command tool cannot be turned off (`unified_exec`
 * ignores `--disable`), and its `read-only` sandbox blocks writes but lets
 * commands read any file the user can, ~/.ssh included. A commit message is
 * text from a repository Eyrie did not write, so an injected instruction could
 * have a file read and sent to OpenAI. So Codex runs with:
 *
 * 1. Its own settings: `--sandbox read-only`, no user config or rules, no saved
 *    session, no web search, approvals never asked, and the features that add
 *    tools (connectors, plugins, browser, computer use, sub-agents…) disabled.
 * 2. A macOS sandbox around the whole Codex process (`sandbox-exec`): no file
 *    can be written anywhere except one fresh workspace (holding the prompt's
 *    schema and a copy of Codex's login) and /dev, and no file's contents can be
 *    read nor folder listed in the home folder, the per-user temporary folder
 *    and /Volumes outside that workspace. Codex's own command sandbox cannot
 *    start inside another sandbox, so no command runs at all, and its in-process
 *    patch tool cannot write outside the workspace either.
 *
 * If Codex refreshes its login during a run, the new login is copied back, so
 * the user's own Codex stays signed in.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import type { AiBackend, AiRequest, AiResult } from './analysis.js';

export interface CodexOptions {
  /** The executable; `codex` on PATH by default. */
  command?: string;
  model?: string;
  /** Environment to find the command and Codex's home in; the current one by default. */
  env?: NodeJS.ProcessEnv;
  /** Checked when the backend is created; `process.platform` by default. */
  platform?: NodeJS.Platform;
}

/** Codex features that add tools beyond answering: connectors, plugins, skills, browser and computer use, sub-agents, images, hooks. */
export const CODEX_DISABLED_FEATURES = [
  'shell_tool',
  'apps',
  'plugins',
  'remote_plugin',
  'skill_search',
  'skill_mcp_dependency_install',
  'tool_suggest',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'code_mode_host',
  'multi_agent',
  'image_generation',
  'view_image',
  'hooks',
  'goals',
  'sleep_tool',
];

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** The arguments `codex` runs with. Exported for tests. */
export function codexArgs(opts: { workDir: string; schemaFile: string; lastMessageFile: string; model?: string }): string[] {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--cd',
    opts.workDir,
    '-c',
    'approval_policy="never"',
    '-c',
    'web_search="disabled"',
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    '--output-schema',
    opts.schemaFile,
    '--output-last-message',
    opts.lastMessageFile,
    ...(opts.model ? ['--model', opts.model] : []),
  ];
}

export function codexPrompt(request: AiRequest): string {
  return `${request.system}\n\nDo not run commands or invoke Codex tools. For Eyrie graph tools, put requests in the JSON response and Eyrie will run them.\n\n${request.prompt}`;
}

const sbString = (path: string) => `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * A Seatbelt profile: no file may be written anywhere except the workspace
 * and /dev (/dev/null, the terminal); no file's contents may be read and no
 * folder listed under `denyRead`, except the workspace and `readOnly`. Later
 * rules win. Metadata stays readable so paths still resolve. Exported for tests.
 */
export function seatbeltProfile(paths: { denyRead: string[]; workspace: string; readOnly?: string[] }): string {
  const subpaths = (list: string[]) => list.map((p) => `(subpath ${sbString(p)})`).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write* (subpath "/dev"))',
    `(deny file-read-data ${subpaths(paths.denyRead)})`,
    ...(paths.readOnly?.length ? [`(allow file-read-data ${subpaths(paths.readOnly)})`] : []),
    `(allow file-read-data file-write* ${subpaths([paths.workspace])})`,
  ].join('\n');
}

/**
 * Codex asks for strict structured output: every object closed and every
 * property required. A property that was optional becomes nullable instead.
 * Exported for tests.
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const s = { ...(schema as Record<string, unknown>) };
  if (s.items) s.items = strictSchema(s.items);
  if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
    const required = new Set((s.required as string[] | undefined) ?? []);
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(s.properties as Record<string, unknown>)) {
      const strict = strictSchema(value) as Record<string, unknown>;
      properties[key] = required.has(key) || typeof strict.type !== 'string' ? strict : { ...strict, type: [strict.type, 'null'], ...(strict.enum ? { enum: [...(strict.enum as unknown[]), null] } : {}) };
    }
    s.properties = properties;
    s.required = Object.keys(properties);
    s.additionalProperties = false;
  }
  return s;
}

/** Reads a finished `codex exec --json` run: its JSONL events and the last message. Exported for tests. */
export function parseCodexRun(events: string, lastMessage: string, opts: { answerOnly?: boolean } = {}): AiResult {
  let usage: Record<string, unknown> | undefined;
  let completed = false;
  for (const line of events.split('\n')) {
    if (!line.trim()) continue;
    let event: { type?: string; item?: { type?: string; exit_code?: number | string; command?: string }; usage?: Record<string, unknown>; error?: { message?: string }; message?: string };
    try {
      event = JSON.parse(line);
    } catch {
      if (opts.answerOnly) throw new Error('Codex returned invalid events.');
      continue;
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      if (opts.answerOnly) throw new Error('Codex could not answer. Check your ChatGPT sign-in and usage.');
      throw new Error(`codex failed: ${event.error?.message ?? event.message ?? 'unknown error'}`.slice(0, 500));
    }
    // Codex reports nonfatal warnings as error items. Fatal errors have their own events.
    if (opts.answerOnly && event.type?.startsWith('item.') && !['agent_message', 'reasoning', 'error'].includes(event.item?.type ?? '')) {
      throw new Error('Codex attempted to use a tool. Its answer was discarded.');
    }
    // Commands cannot start inside the outer sandbox. If one ever completes, the run is not trusted.
    if (event.type === 'item.completed' && event.item?.type === 'command_execution' && Number(event.item.exit_code) === 0) {
      throw new Error(`codex ran a command (${String(event.item.command).slice(0, 80)}); its answer is discarded`);
    }
    if (event.type === 'turn.completed') {
      completed = true;
      if (event.usage) usage = event.usage;
    }
  }
  if (opts.answerOnly && !completed) throw new Error('Codex did not complete the answer.');
  let json: unknown;
  try {
    json = JSON.parse(lastMessage.trim());
  } catch {
    throw new Error('codex answered without the requested JSON');
  }
  const counters: Record<string, unknown> = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']) if (typeof usage?.[key] === 'number') counters[key] = usage[key];
  return { json, usage: counters };
}

/** An executable on PATH, as an absolute path with symbolic links resolved. */
function resolveCommand(command: string, path: string): string | null {
  const candidates = isAbsolute(command) ? [command] : path.split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return realpathSync(candidate);
    } catch {
      /* try the next */
    }
  }
  return null;
}

const readOrNull = (file: string) => (existsSync(file) ? readFileSync(file) : null);

export function codexBackend(opts: CodexOptions = {}): AiBackend {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') throw new Error('The Codex backend needs macOS for now: Eyrie runs Codex inside a macOS sandbox so the model cannot read your files.');
  const env = opts.env ?? process.env;
  const command = opts.command ?? 'codex';
  return {
    name: 'codex',
    run: (request: AiRequest) =>
      new Promise<AiResult>((resolve, reject) => {
        const codex = resolveCommand(command, env.PATH ?? '');
        if (!codex) return reject(new Error(`could not find ${command} on PATH`));
        const home = realpathSync(homedir());
        const tempRoot = realpathSync(tmpdir());
        const work = realpathSync(mkdtempSync(join(tempRoot, 'eyrie-codex-')));
        const dirs = { cwd: join(work, 'work'), home: join(work, 'home'), codexHome: join(work, 'codex-home'), tmp: join(work, 'tmp') };
        for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

        // Codex's login, copied in; copied back afterwards if Codex refreshed it.
        const realAuth = join(env.CODEX_HOME ?? join(home, '.codex'), 'auth.json');
        const original = readOrNull(realAuth);
        const tempAuth = join(dirs.codexHome, 'auth.json');
        if (original) {
          copyFileSync(realAuth, tempAuth);
        }
        const schemaFile = join(work, 'schema.json');
        const lastMessageFile = join(work, 'last-message.json');
        writeFileSync(schemaFile, JSON.stringify(strictSchema(request.schema)));

        // A Codex installed inside the home folder still has to be readable.
        const codexDir = dirname(dirname(codex));
        const profile = seatbeltProfile({ denyRead: [home, tempRoot, '/Volumes'], workspace: work, readOnly: codexDir.startsWith(home) || codexDir.startsWith(tempRoot) ? [codexDir] : [] });
        const childEnv: NodeJS.ProcessEnv = { PATH: env.PATH ?? '/usr/bin:/bin', HOME: dirs.home, CODEX_HOME: dirs.codexHome, TMPDIR: dirs.tmp, LANG: env.LANG ?? 'en_US.UTF-8' };
        if (env.OPENAI_API_KEY) childEnv.OPENAI_API_KEY = env.OPENAI_API_KEY;

        const child = spawn(SANDBOX_EXEC, ['-p', profile, codex, ...codexArgs({ workDir: dirs.cwd, schemaFile, lastMessageFile, model: opts.model })], {
          cwd: dirs.cwd,
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (err: Error | null, value?: AiResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', abort);
          try {
            const refreshed = readOrNull(tempAuth);
            // Only when Codex changed it and nothing else changed the user's copy meanwhile.
            if (original && refreshed && !refreshed.equals(original) && readOrNull(realAuth)?.equals(original)) {
              const next = `${realAuth}.eyrie-${process.pid}.tmp`;
              writeFileSync(next, refreshed, { mode: 0o600 });
              renameSync(next, realAuth);
            }
          } finally {
            rmSync(work, { recursive: true, force: true });
          }
          if (err) reject(err);
          else resolve(value!);
        };
        const abort = () => {
          child.kill();
          finish(new Error('cancelled'));
        };
        const timer = setTimeout(() => {
          child.kill();
          finish(new Error(`codex did not answer within ${Math.round(request.timeoutMs / 1000)} s`));
        }, request.timeoutMs);
        request.signal?.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.on('error', (err) => finish(new Error(`could not run codex: ${err.message}`)));
        child.on('close', (code) => {
          const last = readOrNull(lastMessageFile)?.toString('utf8') ?? '';
          if (code !== 0 && !last) return finish(new Error(`codex exited with code ${code}: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`));
          try {
            finish(null, { ...parseCodexRun(stdout, last), model: opts.model });
          } catch (err) {
            finish(err as Error);
          }
        });
        child.stdin.end(codexPrompt(request));
      }),
  };
}
