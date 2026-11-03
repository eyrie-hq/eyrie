/**
 * The Muse CLI as an AI backend: `muse exec`, signed in the way the
 * user already uses it, so Eyrie holds no API key.
 *
 * Eyrie must never let a model act on the repository, so the CLI runs in an
 * empty temporary folder rather than the repository, with workspace writes,
 * shell execution, web tools, reminders and session logging all off, and its
 * own sandbox left on. The prompt goes in through a file (`--prompt-file`),
 * since packets are too large for an argument.
 *
 * Verified with Muse Code 1.4.14: `muse exec --json` prints JSONL on stdout;
 * the answer is the `run.terminal.completed` payload's text, and `run.usage`
 * carries per-model token counters. Muse takes no JSON schema flag, so the
 * schema travels in the prompt and the answer is parsed back here; anything
 * that is not the requested JSON is an error, never a guess.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiBackend, AiRequest, AiResult } from './analysis.js';

export interface MuseOptions {
  /** The executable; `muse` on PATH by default. */
  command?: string;
  model?: string;
  /** Environment for the CLI; the current one by default. Its PATH must find the command. */
  env?: NodeJS.ProcessEnv;
}

/** The arguments `muse` runs with. Exported for tests. */
export function museArgs(promptFile: string, model?: string): string[] {
  return [
    'exec',
    '--json',
    '--prompt-file',
    promptFile,
    '--disable-write',
    '--disable-shell',
    '--disable-web-tools',
    '--disable-reminders',
    '--disable-request-user-input',
    '--no-foreign-personal-context',
    '--no-session-log',
    ...(model ? ['--model', model] : []),
  ];
}

/** The prompt for a request: the system prompt, the task, and the schema the answer must match. */
export function musePrompt(request: Pick<AiRequest, 'system' | 'prompt' | 'schema'>): string {
  return `${request.system}\n\n${request.prompt}\n\nAnswer with a single JSON object matching this schema, and no other text:\n${JSON.stringify(request.schema)}`;
}

/**
 * Reads a finished `muse exec --json` run: the terminal payload's text, parsed
 * as the requested JSON. Exported for tests.
 */
export function parseMuseRun(stdout: string): AiResult {
  let text: string | null = null;
  let failed: string | null = null;
  let usage: Record<string, unknown> | undefined;
  let model: string | undefined;
  for (const line of stdout.split('\n')) {
    if (!line.trimStart().startsWith('{')) continue;
    let event: { payload_type?: string; payload?: { terminal?: string; text?: string; reason?: string; models?: { model?: string; input_tokens?: number; output_tokens?: number }[] } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.payload_type === 'run.terminal.completed') text = event.payload?.text ?? null;
    else if (event.payload_type === 'run.terminal.failed' || event.payload_type === 'run.terminal.error' || event.payload_type === 'run.terminal.cancelled') {
      failed = event.payload?.reason ?? event.payload_type;
    } else if (event.payload_type === 'run.usage' && Array.isArray(event.payload?.models)) {
      const counters: Record<string, unknown> = {};
      let input = 0;
      let output = 0;
      for (const m of event.payload.models) {
        model ??= m.model ?? undefined;
        if (typeof m.input_tokens === 'number') input += m.input_tokens;
        if (typeof m.output_tokens === 'number') output += m.output_tokens;
      }
      counters.input_tokens = input;
      counters.output_tokens = output;
      usage = counters;
    }
  }
  if (failed) throw new Error(`muse failed: ${failed}`.slice(0, 500));
  if (text === null) throw new Error('muse ended without an answer');
  const bare = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return { json: JSON.parse(bare), model, usage };
  } catch {
    throw new Error('muse answered without the requested JSON');
  }
}

export function museBackend(opts: MuseOptions = {}): AiBackend {
  const command = opts.command ?? 'muse';
  return {
    name: 'muse',
    run: (request) =>
      new Promise<AiResult>((resolve, reject) => {
        const cwd = mkdtempSync(join(tmpdir(), 'eyrie-ai-'));
        const promptFile = join(cwd, 'prompt.md');
        // Not a nested session of whatever Muse session started Eyrie.
        const env: NodeJS.ProcessEnv = {};
        for (const [k, v] of Object.entries(opts.env ?? process.env)) if (!/^MUSE_(SESSION|THREAD|TOOL_USE|RELEASE)_/.test(k)) env[k] = v;
        let child;
        try {
          writeFileSync(promptFile, musePrompt(request));
          child = spawn(command, museArgs(promptFile, opts.model), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (err) {
          rmSync(cwd, { recursive: true, force: true });
          reject(err as Error);
          return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (err: Error | null, value?: AiResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', abort);
          rmSync(cwd, { recursive: true, force: true });
          if (err) reject(err);
          else resolve(value!);
        };
        const abort = () => {
          child.kill();
          finish(new Error('cancelled'));
        };
        const timer = setTimeout(() => {
          child.kill();
          finish(new Error(`muse did not answer within ${Math.round(request.timeoutMs / 1000)} s`));
        }, request.timeoutMs);
        request.signal?.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.on('error', (err) => finish(new Error(`could not run ${command}: ${err.message}`)));
        child.on('close', (code) => {
          if (code !== 0 && !stdout.trim()) return finish(new Error(`muse exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
          try {
            finish(null, parseMuseRun(stdout));
          } catch (err) {
            finish(err as Error);
          }
        });
      }),
  };
}
