/**
 * `pnpm smoke <executable>`: checks a packaged build. The app opens
 * fixtures/bookstore-app with an empty cache, so its bundled grammars parse
 * every file, and with a user-data folder of its own, where it records what it
 * indexed in projects.json. The engine is deterministic, so that must match
 * what the engine finds here, run from source on the same machine. Then the
 * app's bundled `eyrie` command answers `architecture_overview` over MCP, and
 * that must match too.
 *
 * It reads projects.json rather than the app's output because a Windows GUI
 * app's stdout is not dependable.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphEngine } from '@eyrie/engine';

const executable = process.argv[2];
if (!executable || !existsSync(executable)) {
  console.error(`usage: pnpm smoke <the packaged app's executable>${executable ? ` (not found: ${executable})` : ''}`);
  process.exit(2);
}

const TIMEOUT_MS = 180_000;
const fixture = fileURLToPath(new URL('../../../fixtures/bookstore-app', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'eyrie-smoke-'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Counts {
  files: number;
  symbols: number;
  components: number;
  links: number;
}

const engine = new GraphEngine({ root: fixture, watch: false, dataDir: join(dir, 'source') });
await engine.start();
const expected: Counts = { files: engine.stats.files, symbols: engine.stats.symbols, components: engine.stats.archNodes, links: engine.stats.archEdges };
await engine.stop();

const userData = join(dir, 'user-data');
const app = spawn(executable, [`--user-data-dir=${userData}`, fixture], { env: { ...process.env, EYRIE_HOME: join(dir, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
app.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
app.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
let exit: string | undefined;
app.on('exit', (code, signal) => (exit = `exit code ${code}, signal ${signal}`));
app.on('error', (err) => (exit = err.message));

/** The project as the app recorded it, once it has an index or an error. */
function recorded(): { scan?: Counts; error?: string } | undefined {
  try {
    const list = JSON.parse(readFileSync(join(userData, 'projects.json'), 'utf8')) as { projects?: { scan?: Counts; error?: string }[] };
    return list.projects?.find((p) => p.scan || p.error);
  } catch {
    return undefined;
  }
}

const started = Date.now();
let project = recorded();
while (!project && exit === undefined && Date.now() - started < TIMEOUT_MS) {
  await wait(500);
  project = recorded();
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (exit === undefined) {
  const exited = new Promise((r) => app.once('exit', r));
  app.kill();
  await Promise.race([exited, wait(10_000)]);
}

const actual = project?.scan && { files: project.scan.files, symbols: project.scan.symbols, components: project.scan.components, links: project.scan.links };
const ok = !!actual && (Object.keys(expected) as (keyof Counts)[]).every((k) => actual[k] === expected[k]);
console.log(`engine from source: ${JSON.stringify(expected)}`);
console.log(`packaged app:       ${actual ? JSON.stringify(actual) : project?.error ? `failed: ${project.error}` : exit ? `exited before indexing (${exit})` : `nothing recorded after ${seconds} s`}`);
if (ok) console.log(`PASS: the packaged app indexed the fixture as the engine does (${seconds} s)`);
else console.log(`FAIL\n--- app output ---\n${output.slice(-4000)}`);

/** The `eyrie` command shipped in the app's resources next to the executable. */
function bundledCli(executable: string): string | null {
  const dir = dirname(realpathSync(executable));
  const resources = basename(dir) === 'MacOS' ? join(dir, '..', 'Resources') : join(dir, 'resources');
  const bin = join(resources, 'cli', process.platform === 'win32' ? 'eyrie.exe' : 'eyrie');
  return existsSync(bin) ? bin : null;
}

/** Asks the bundled command for `architecture_overview` over MCP. */
async function cliOverview(bin: string): Promise<Counts> {
  const child = spawn(bin, ['mcp', fixture, '--no-watch'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, EYRIE_HOME: join(dir, 'cli-home') } });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const stop = () => {
    child.kill();
    return new Promise((r) => child.once('exit', r));
  };
  try {
    const call = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<unknown>((resolve, reject) => {
        let buffer = '';
        const onData = (chunk: string) => {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (!line) continue;
            const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
            if (message.id !== id) continue;
            child.stdout.off('data', onData);
            if (message.error) reject(new Error(message.error.message ?? 'JSON-RPC error'));
            else resolve(message.result);
          }
        };
        child.stdout.setEncoding('utf8').on('data', onData);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    const timeout = setTimeout(() => void stop().then(() => console.log('CLI check timed out after 120 s')), 120_000);
    try {
      await call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'desktop-smoke', version: '0' } });
      const answer = (await call(2, 'tools/call', { name: 'architecture_overview', arguments: {} })) as { content?: { text?: string }[] };
      const overview = JSON.parse(answer?.content?.[0]?.text ?? 'null') as { size?: Counts } | null;
      if (!overview?.size) throw new Error(`no overview in the answer${stderr ? ` (stderr: ${stderr.slice(-500)})` : ''}`);
      return overview.size;
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    await stop();
  }
}

let cliOk = false;
const cliBin = bundledCli(executable);
if (!cliBin) {
  console.log('FAIL: the packaged app ships no eyrie command in its resources');
} else {
  try {
    const cliCounts = await cliOverview(cliBin);
    cliOk = (Object.keys(expected) as (keyof Counts)[]).every((k) => cliCounts[k] === expected[k]);
    console.log(`bundled eyrie:    ${JSON.stringify(cliCounts)}`);
    console.log(cliOk ? 'PASS: the packaged app’s eyrie command answered as the engine does' : 'FAIL: the bundled eyrie command answered differently');
  } catch (err) {
    console.log(`FAIL: the bundled eyrie command failed: ${(err as Error).message}`);
  }
}

try {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch {
  /* Windows may still hold a file of the engine host's; it is a temp folder */
}
process.exit(ok && cliOk ? 0 : 1);
