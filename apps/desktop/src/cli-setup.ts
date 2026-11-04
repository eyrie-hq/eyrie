/**
 * The `eyrie` command the app ships for coding agents (resources/cli: a single
 * executable with its grammars and web UI beside it), and how projects connect
 * it to agents. Pure helpers; the menus in main.ts call them.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';

/** Path joins for the platform the paths are for, which tests set explicitly. */
const paths = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

/** The folder the `eyrie` command is installed into for terminal use. */
export function userBinDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const join = paths(platform).join;
  const home = platform === 'win32' ? (env.USERPROFILE ?? homedir()) : (env.HOME ?? homedir());
  return platform === 'win32' ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Eyrie', 'bin') : join(home, '.eyrie', 'bin');
}

export function eyrieFile(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'eyrie.exe' : 'eyrie';
}

/** The command as shipped inside the app's resources, or null when it is not there. */
export function bundledEyrie(resourcesDir: string, platform: NodeJS.Platform = process.platform): string | null {
  const bin = paths(platform).join(resourcesDir, 'cli', eyrieFile(platform));
  return existsSync(bin) ? bin : null;
}

/** The command as installed for the user, or null when it is not installed. */
export function installedEyrie(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  const bin = paths(platform).join(userBinDir(platform, env), eyrieFile(platform));
  return existsSync(bin) ? bin : null;
}

/**
 * The command a Connect menu item runs: the installed copy when there is one
 * (it survives app updates), else the bundled copy.
 */
export function eyrieForConnect(resourcesDir: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  return installedEyrie(platform, env) ?? bundledEyrie(resourcesDir, platform);
}

/** Copies resources/cli to the user's bin folder, replacing an older install. */
export function installCli(resourcesDir: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const join = paths(platform).join;
  const source = join(resourcesDir, 'cli');
  if (!existsSync(join(source, eyrieFile(platform)))) throw new Error('The app was built without the eyrie command.');
  const target = userBinDir(platform, env);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
  return join(target, eyrieFile(platform));
}

/** `eyrie-<project>`, the name the agent sees. */
export function mcpServerName(projectName: string): string {
  return `eyrie-${projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'}`;
}

/** `<client> mcp add <name> -- <eyrie> mcp <root>`, as a command plus arguments. */
export function mcpAddArgs(client: 'claude' | 'codex', name: string, eyrieBin: string, root: string): { command: string; args: string[] } {
  return { command: client, args: ['mcp', 'add', name, '--', eyrieBin, 'mcp', root] };
}

export function geminiSettingsPath(home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  return paths(platform).join(home, '.gemini', 'settings.json');
}

export function cursorSettingsPath(home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  return paths(platform).join(home, '.cursor', 'mcp.json');
}

export interface McpServerEntry {
  command: string;
  args: string[];
}

/**
 * `existing` settings with `name` added under `mcpServers` (Gemini CLI and
 * Cursor share this shape), keeping every other server. `existing` is null
 * when the file does not exist yet; anything unparseable is refused rather
 * than overwritten.
 */
export function withMcpServer(existing: string | null, name: string, entry: McpServerEntry): string {
  let settings: Record<string, unknown> = {};
  if (existing !== null && existing.trim()) {
    const parsed: unknown = JSON.parse(existing);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The settings file does not hold a JSON object.');
    settings = parsed as Record<string, unknown>;
  }
  const servers = settings.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) throw new Error('The settings file has an mcpServers that is not an object.');
  return JSON.stringify({ ...settings, mcpServers: { ...((servers as Record<string, unknown> | undefined) ?? {}), [name]: entry } }, null, 2) + '\n';
}

/** Adds the server to a settings file, creating folders as needed. Returns the path written. */
export function writeMcpSettings(file: string, name: string, entry: McpServerEntry): string {
  let existing: string | null = null;
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    existing = null;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, withMcpServer(existing, name, entry));
  return file;
}

/** What the install dialog tells the user about reaching `eyrie` from a terminal. */
export function pathHint(binDir: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') return `Use it as ${paths(platform).join(binDir, 'eyrie.exe')}, or add ${binDir} to your user PATH to run eyrie anywhere.`;
  const home = env.HOME ?? homedir();
  const shown = home && binDir.startsWith(home + '/') ? `~/${binDir.slice(home.length + 1)}` : binDir;
  return `Use it as ${shown}/eyrie, or add this to your shell profile to run eyrie anywhere:\n\nexport PATH="${shown}:$PATH"`;
}
