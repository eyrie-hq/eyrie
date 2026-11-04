import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphEngine } from '@eyrie/engine';
import { ProjectKnowledge, type AiBackend } from '@eyrie/knowledge';
import { startServer, type RunningServer } from './server.js';

const DEFAULT_PORT = 4319;

export interface LaunchOptions {
  /** Absolute path of the repository to index. */
  root: string;
  host?: string;
  /** A fixed port, `0` for any free port, or omitted for the first free port from 4319. */
  port?: number;
  /** Access token; random per run when omitted. */
  token?: string;
  /** Directory with the built web UI. Defaults to `apps/web/dist` in this repository. */
  webDir?: string;
  /** Where the SQLite cache lives. Defaults to ~/.eyrie/repos/<hash>. */
  dataDir?: string;
  watch?: boolean;
  /** Ignore the facts cache and re-parse every file. */
  reset?: boolean;
  /** Notes recorded commits with this backend in the background. Off when omitted. */
  ai?: AiBackend | null;
  log?: (message: string) => void;
}

export interface RunningEyrie {
  engine: GraphEngine;
  /** The project's recorded git history and notes on it (knowledge.db). */
  knowledge: ProjectKnowledge;
  server: RunningServer;
  token: string;
  /** The UI address, token included. */
  url: string;
  close(): Promise<void>;
}

/** The web UI as built in this repository. A bundled host (the desktop app, the npm CLI) passes its own `webDir`. */
function defaultWebDir(): string {
  try {
    return fileURLToPath(new URL('../../../apps/web/dist', import.meta.url));
  } catch {
    // A bundle with no repository around it (and no webDir passed): the
    // server reports the UI as not built instead of crashing.
    return join('apps', 'web', 'dist', '__missing__');
  }
}

/**
 * Indexes a repository and serves the UI for it: what the `eyrie` CLI and the
 * desktop app both run. A requested port that is in use rejects with the
 * listen error (`EADDRINUSE`), after the engine has been stopped again.
 */
export async function launch(opts: LaunchOptions): Promise<RunningEyrie> {
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? (() => {});
  const engine = new GraphEngine({ root: opts.root, dataDir: opts.dataDir, watch: opts.watch ?? true, reset: opts.reset, log });
  engine.on('error', (err) => log(`error: ${err.message}`));
  await engine.start();
  const knowledge = await openKnowledge(engine, { ai: opts.ai, watch: opts.watch ?? true, log });

  const token = opts.token ?? randomBytes(12).toString('base64url');
  const webDir = opts.webDir ?? defaultWebDir();
  let server: RunningServer;
  try {
    server = await listen(opts.port, (port) => startServer({ engine, knowledge, ai: opts.ai ?? null, host, port, token, webDir, log }));
  } catch (err) {
    await knowledge.close();
    await engine.stop();
    throw err;
  }
  return {
    engine,
    knowledge,
    server,
    token,
    url: `${server.url}/?token=${encodeURIComponent(token)}`,
    close: async () => {
      await server.close();
      await knowledge.close();
      await engine.stop();
    },
  };
}

/**
 * Opens the project's knowledge.db next to its cache and records the commits it
 * has not seen. Analysis, when an AI backend is set, runs in the background
 * unless `waitForAnalysis`, and with `watch` both repeat whenever HEAD moves.
 * A git failure is logged, never fatal.
 */
export async function openKnowledge(
  engine: GraphEngine,
  opts: { ai?: AiBackend | null; watch?: boolean; waitForAnalysis?: boolean; log?: (message: string) => void },
): Promise<ProjectKnowledge> {
  const log = opts.log ?? (() => {});
  const knowledge = ProjectKnowledge.open({
    root: engine.root,
    dataDir: engine.dataDir,
    architecture: () => engine.architecture,
    project: () => ({ name: engine.repo.name, frameworks: engine.repo.frameworks }),
    ai: opts.ai,
    log,
  });
  await knowledge.record().catch((err: unknown) => log(`Could not read git history: ${(err as Error).message}`));
  const analysis = knowledge.analyze();
  if (opts.waitForAnalysis) await analysis;
  if (opts.watch) knowledge.watch();
  return knowledge;
}

/** Uses the requested port, or the first free port from 4319 when none was given. */
async function listen<T>(requested: number | undefined, start: (port: number) => Promise<T>): Promise<T> {
  if (requested !== undefined) return start(requested);
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 20; port++) {
    try {
      return await start(port);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  return start(0);
}
