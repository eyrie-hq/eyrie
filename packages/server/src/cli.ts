#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GraphEngine } from '@eyrie/engine';
import { createAiBackend, type ProjectKnowledge } from '@eyrie/knowledge';
import { initAgents } from './init-agents.js';
import { launch, openKnowledge } from './launch.js';
import { EyrieMcp, serveStdio } from './mcp.js';
import { VERSION } from './version.js';

const HELP = `eyrie — live architecture graph for a codebase

Usage
  eyrie [path] [options]       index a repository and open its live map
  eyrie mcp [path] [options]   serve the repository to coding agents over MCP (stdio)
  eyrie init-agents [path]     tell the repository's coding agents about Eyrie's MCP tools

Options
  --port <n>       Port for the local UI (default: 4319 or the next free one; 0 = any)
  --host <h>       Interface to bind (default 127.0.0.1)
  --token <t>      Access token (default: random per run)
  --no-open        Do not open the browser
  --no-watch       Index once without watching for changes
  --reset          Ignore the cache and re-parse every file
  --ai <backend>   Answer questions and note recorded commits with an AI backend:
                   claude (your Claude Code CLI), codex (your Codex CLI,
                   macOS only), muse (your Muse CLI), or openai (any
                   OpenAI-compatible API: EYRIE_OPENAI_BASE_URL,
                   EYRIE_OPENAI_API_KEY, EYRIE_OPENAI_MODEL). Off by default;
                   also EYRIE_AI. Sends commit messages, file paths and
                   component names, never source code.
  --ai-model <m>   Model for --ai (default: the backend's own)
  --local          With init-agents: write CLAUDE.local.md (kept out of git)
                   instead of AGENTS.md
  -h, --help       Show this help

Add Eyrie to Claude Code (other MCP clients take the same command):
  claude mcp add eyrie -- eyrie mcp /path/to/repo
`;

async function main(): Promise<void> {
  // `pnpm start -- <path>` forwards a literal `--`; drop it so options still parse.
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      token: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      'no-watch': { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      ai: { type: 'string' },
      'ai-model': { type: 'string' },
      local: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (positionals[0] === 'init-agents') {
    const result = initAgents(resolve(positionals[1] ?? process.cwd()), { local: values.local });
    process.stdout.write(result.updated ? `Eyrie tools written to ${result.file}\n` : `${result.file} already tells agents about Eyrie\n`);
    return;
  }
  const ai = createAiBackend(values.ai ?? process.env.EYRIE_AI, { model: values['ai-model'] });
  if (positionals[0] === 'mcp') return mcp(resolve(positionals[1] ?? process.cwd()), { watch: !values['no-watch'], reset: values.reset, ai });

  const root = resolve(positionals[0] ?? process.cwd());
  const log = (m: string) => process.stdout.write(`[eyrie] ${m}\n`);
  log(`Indexing ${root}`);
  const port = values.port === undefined ? undefined : Number(values.port);
  const eyrie = await launch({ root, host: values.host, port, token: values.token, webDir: process.env.EYRIE_WEB_DIR, watch: !values['no-watch'], reset: values.reset, ai, log }).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`Port ${values.port} is already in use. Choose another with --port, or use --port 0 for any free port.`);
    throw err;
  });
  log(`Open ${eyrie.url}`);
  if (!values['no-open']) openBrowser(eyrie.url);

  const shutdown = async () => {
    await eyrie.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * MCP over stdio. The handshake is answered at once and tool calls wait for the
 * index, so a large repository does not time out the client. stdout carries
 * the protocol only; everything else goes to stderr.
 */
async function mcp(root: string, opts: { watch: boolean; reset: boolean; ai: ReturnType<typeof createAiBackend> }): Promise<void> {
  const log = (m: string) => process.stderr.write(`[eyrie] ${m}\n`);
  const engine = new GraphEngine({ root, watch: opts.watch, reset: opts.reset, log });
  engine.on('error', (err) => log(`error: ${err.message}`));
  let knowledge: ProjectKnowledge | undefined;
  const ready = engine.start().then(async () => {
    knowledge = await openKnowledge(engine, { ai: opts.ai, watch: opts.watch, log });
    return { knowledge };
  });
  ready.catch((err: unknown) => log(`Could not index ${root}: ${(err as Error).message}`));
  const server = new EyrieMcp({ engine, ready, version: VERSION, ai: opts.ai });
  await serveStdio(server);
  server.dispose();
  await knowledge?.close();
  await engine.stop();
  process.exit(0);
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* the URL is printed above */
  }
}

main().catch((err: unknown) => {
  const e = err as Error;
  process.stderr.write(`[eyrie] ${process.env.EYRIE_DEBUG ? (e.stack ?? String(err)) : e.message}\n`);
  process.exit(1);
});
