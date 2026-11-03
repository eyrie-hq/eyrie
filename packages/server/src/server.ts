import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep, win32 } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { GraphEvent, ServerMessage } from '@eyrie/core';
import { findCommand, findEditor, startDetached } from '@eyrie/core/commands';
import type { EngineBatch, GraphEngine } from '@eyrie/engine';
import { commitView, type AiBackend, type ProjectKnowledge } from '@eyrie/knowledge';
import { answerQuestion } from './ask.js';
import { runHealthCheck } from './check.js';
import { EyrieMcp } from './mcp.js';
import { recentSessions } from './recent.js';

export interface ServerOptions {
  engine: GraphEngine;
  /** The project's recorded git history, served at /api/commits. */
  knowledge?: ProjectKnowledge;
  /** The model POST /api/ask answers with. Without one, asking reports that AI is off. */
  ai?: AiBackend | null;
  host: string;
  port: number;
  /** Required on every API and WebSocket request. */
  token: string;
  /** Directory with the built web UI. */
  webDir?: string;
  log?: (message: string) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MAX_CODE_EVENTS = 1500;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Converts an engine batch into the wire format. */
export function toMessage(batch: EngineBatch): ServerMessage {
  const events: GraphEvent[] = batch.files.map((f) => ({ type: 'file.changed', file: f.file, change: f.change }));
  const c = batch.code;
  const codeCount = c.addedNodes.length + c.updatedNodes.length + c.removedNodes.length + c.addedEdges.length + c.updatedEdges.length + c.removedEdges.length;
  const truncated = codeCount > MAX_CODE_EVENTS;
  if (!truncated) {
    for (const node of c.addedNodes) events.push({ type: 'node.created', node });
    for (const node of c.updatedNodes) events.push({ type: 'node.updated', node });
    for (const id of c.removedNodes) events.push({ type: 'node.deleted', id });
    for (const edge of c.addedEdges) events.push({ type: 'edge.created', edge });
    for (const edge of c.updatedEdges) events.push({ type: 'edge.updated', edge });
    for (const id of c.removedEdges) events.push({ type: 'edge.deleted', id });
  }
  events.push({ type: 'architecture.updated', diff: batch.architecture });
  return { type: 'batch', seq: batch.seq, at: batch.at, ms: Math.round(batch.ms * 10) / 10, files: batch.files, events, truncated, stats: batch.stats };
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { engine, token } = opts;
  const log = opts.log ?? (() => {});
  let port = opts.port;

  const allowedHost = (host: string | undefined) => {
    if (!host) return false;
    const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === opts.host;
  };
  const tokenOf = (req: IncomingMessage, url: URL) => url.searchParams.get('token') ?? req.headers['x-eyrie-token'];

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolveBody, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 64_000) req.destroy();
      });
      req.on('end', () => {
        try {
          resolveBody(data ? JSON.parse(data) : {});
        } catch (err) {
          reject(err);
        }
      });
    });

  // One MCP server behind the HTTP API, so a question sees the same graph an agent sees.
  // The engine has indexed by the time the server listens, so `ready` resolves at once.
  let mcp: EyrieMcp | null = null;
  const askMcp = (): EyrieMcp => (mcp ??= new EyrieMcp({ engine, ready: Promise.resolve({ knowledge: opts.knowledge }), version: 'http', ai: opts.ai ?? null }));

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const path = url.pathname;
    if (req.method === 'GET' && path === '/api/state') {
      return json(res, 200, { repo: engine.repo, stats: engine.stats, seq: engine.seq, architecture: engine.architecture });
    }
    const arch = /^\/api\/arch\/([\w-]+)$/.exec(path);
    if (req.method === 'GET' && arch) {
      const details = engine.archNodeDetails(arch[1]!);
      return details ? json(res, 200, details) : json(res, 404, { error: 'not found' });
    }
    const code = /^\/api\/code\/([\w-]+)$/.exec(path);
    if (req.method === 'GET' && code) {
      const details = engine.codeNode(code[1]!);
      return details ? json(res, 200, details) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && path === '/api/source') {
      const file = url.searchParams.get('file') ?? '';
      const start = Number(url.searchParams.get('start') ?? 1);
      const end = Number(url.searchParams.get('end') ?? start + 80);
      const src = engine.readSource(file, start, end);
      return src ? json(res, 200, src) : json(res, 404, { error: 'not an indexed source file' });
    }
    if (req.method === 'GET' && path === '/api/commits') {
      const k = opts.knowledge;
      if (!k) return json(res, 200, { summary: null, commits: [] });
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const commits = k.store.commits({ limit, component: url.searchParams.get('component') ?? undefined, agent: url.searchParams.get('agent') ?? undefined });
      return json(res, 200, { summary: k.summary(), commits: commits.map((c) => commitView(k.store, c)) });
    }
    if (req.method === 'POST' && path === '/api/open') {
      const body = (await readBody(req)) as { file?: string; line?: number };
      const abs = body.file ? engine.absolutePath(body.file) : null;
      if (!abs) return json(res, 404, { error: 'not an indexed source file' });
      const opened = openInEditor(abs, Number(body.line) || 1);
      return json(res, opened ? 200 : 501, { opened });
    }
    if (req.method === 'GET' && path === '/api/check') {
      return json(res, 200, await runHealthCheck(engine));
    }
    if (req.method === 'GET' && path === '/api/recent') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      return json(res, 200, recentSessions(opts.knowledge ?? null, limit));
    }
    if (req.method === 'GET' && path === '/api/ask') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      return json(res, 200, { backend: opts.ai?.name ?? null, questions: opts.knowledge?.store.askHistory(limit) ?? [] });
    }
    if (req.method === 'POST' && path === '/api/ask') {
      const backend = opts.ai;
      if (!backend) return json(res, 501, { error: 'AI is off. Start Eyrie with --ai to ask questions.' });
      const body = (await readBody(req)) as { question?: string };
      if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 2000) {
        return json(res, 400, { error: 'Ask a question of at most 2000 characters.' });
      }
      try {
        return json(res, 200, await answerQuestion({ mcp: askMcp(), knowledge: opts.knowledge ?? null, backend, question: body.question, log }));
      } catch (err) {
        return json(res, 500, { error: (err as Error).message });
      }
    }
    return json(res, 404, { error: 'unknown endpoint' });
  };

  const webDir = opts.webDir && existsSync(join(opts.webDir, 'index.html')) ? resolve(opts.webDir) : null;
  const serveStatic = (res: ServerResponse, pathname: string) => {
    if (!webDir) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<p>Eyrie engine is running. The web UI is not built yet: run <code>pnpm --filter @eyrie/web build</code>, or <code>pnpm dev</code> for development.</p>');
      return;
    }
    const target = normalize(join(webDir, decodeURIComponent(pathname)));
    const file = target.startsWith(webDir + sep) && existsSync(target) && statSync(target).isFile() ? target : join(webDir, 'index.html');
    const immutable = file.includes(`${join(webDir, 'assets')}`);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(readFileSync(file));
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!allowedHost(req.headers.host)) {
      res.writeHead(403).end('Forbidden host');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (tokenOf(req, url) !== token) return json(res, 401, { error: 'missing or invalid token' });
      api(req, res, url).catch((err: unknown) => json(res, 500, { error: (err as Error).message }));
      return;
    }
    serveStatic(res, url.pathname);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || !allowedHost(req.headers.host) || tokenOf(req, url) !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    const hello: ServerMessage = { type: 'hello', seq: engine.seq, repo: engine.repo, stats: engine.stats, architecture: engine.architecture };
    ws.send(JSON.stringify(hello));
  });
  const broadcast = (batch: EngineBatch) => {
    const payload = JSON.stringify(toMessage(batch));
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
  };

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, opts.host, () => resolveListen());
  });
  // Subscribe only once listening, so a failed attempt (port in use) leaves nothing behind.
  engine.on('batch', broadcast);
  const address = server.address();
  if (address && typeof address === 'object') port = address.port;
  const url = `http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${port}`;
  log(`Serving on ${url}`);

  return {
    url,
    port,
    close: async () => {
      engine.off('batch', broadcast);
      mcp?.dispose();
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * Opens a file at a line in the user's editor, else in the system's default app for it, or
 * Notepad on Windows, where `.ts` files belong to a video player. No shell runs, except cmd.exe
 * for an editor installed as a Windows `.cmd` file, with every argument escaped for it.
 */
export function openInEditor(abs: string, line: number): boolean {
  const path = process.env.PATH ?? '';
  const editor = findEditor(path, process.env.EYRIE_EDITOR);
  if (editor) {
    const zed = /^zed(\.exe)?$/i.test(win32.basename(editor.file));
    return startDetached(editor.file, zed ? [`${abs}:${line}`] : ['-g', `${abs}:${line}`]);
  }
  const fallback = findCommand(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'notepad' : 'xdg-open', path);
  return !!fallback && startDetached(fallback, [abs]);
}
