import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bundledEyrie,
  cursorSettingsPath,
  eyrieForConnect,
  geminiSettingsPath,
  installCli,
  installedEyrie,
  mcpAddArgs,
  mcpServerName,
  pathHint,
  userBinDir,
  withMcpServer,
  writeMcpSettings,
} from '../src/cli-setup.js';

const dir = mkdtempSync(join(tmpdir(), 'eyrie-cli-setup-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('cli-setup', () => {
  it('names the MCP server after the project', () => {
    expect(mcpServerName('bookstore-app')).toBe('eyrie-bookstore-app');
    expect(mcpServerName('My Cool Repo!')).toBe('eyrie-my-cool-repo');
    expect(mcpServerName('!!!')).toBe('eyrie-project');
  });

  it('builds the mcp add command for an eyrie binary and a root', () => {
    expect(mcpAddArgs('claude', 'eyrie-shop', '/home/u/.eyrie/bin/eyrie', '/home/u/shop')).toEqual({
      command: 'claude',
      args: ['mcp', 'add', 'eyrie-shop', '--', '/home/u/.eyrie/bin/eyrie', 'mcp', '/home/u/shop'],
    });
  });

  it('keeps the user install outside the app, per platform', () => {
    expect(userBinDir('darwin', { HOME: '/Users/u' })).toBe('/Users/u/.eyrie/bin');
    expect(userBinDir('linux', { HOME: '/home/u' })).toBe('/home/u/.eyrie/bin');
    expect(userBinDir('win32', { USERPROFILE: 'C:\\U', APPDATA: 'C:\\U\\AppData\\Roaming' })).toBe('C:\\U\\AppData\\Roaming\\Eyrie\\bin');
  });

  it('prefers the installed command and falls back to the bundled one', () => {
    const resources = join(dir, 'resources');
    const home = join(dir, 'home');
    const env = { HOME: home };
    mkdirSync(join(resources, 'cli'), { recursive: true });
    writeFileSync(join(resources, 'cli', 'eyrie'), 'bundled');
    expect(bundledEyrie(resources, 'darwin')).toBe(join(resources, 'cli', 'eyrie'));
    expect(installedEyrie('darwin', env)).toBeNull();
    expect(eyrieForConnect(resources, 'darwin', env)).toBe(join(resources, 'cli', 'eyrie'));
    const bin = installCli(resources, 'darwin', env);
    expect(bin).toBe(join(home, '.eyrie', 'bin', 'eyrie'));
    expect(readFileSync(bin, 'utf8')).toBe('bundled');
    expect(eyrieForConnect(resources, 'darwin', env)).toBe(bin);
  });

  it('refuses to install when the app was built without the command', () => {
    expect(() => installCli(join(dir, 'empty-resources'), 'darwin', { HOME: join(dir, 'home2') })).toThrow('built without the eyrie command');
  });

  it('merges an MCP server into Gemini and Cursor settings without touching the rest', () => {
    const entry = { command: 'eyrie', args: ['mcp', '.'] };
    expect(JSON.parse(withMcpServer(null, 'eyrie', entry))).toEqual({ mcpServers: { eyrie: entry } });
    expect(JSON.parse(withMcpServer('{"theme":"dark","mcpServers":{"other":{"command":"x","args":[]}}}', 'eyrie', entry))).toEqual({
      theme: 'dark',
      mcpServers: { other: { command: 'x', args: [] }, eyrie: entry },
    });
    expect(() => withMcpServer('not json', 'eyrie', entry)).toThrow();
    expect(() => withMcpServer('[]', 'eyrie', entry)).toThrow('JSON object');
    expect(() => withMcpServer('{"mcpServers":[]}', 'eyrie', entry)).toThrow('not an object');
  });

  it('writes the settings file, creating folders', () => {
    expect(geminiSettingsPath('/h')).toBe(join('/h', '.gemini', 'settings.json'));
    expect(cursorSettingsPath('/h')).toBe(join('/h', '.cursor', 'mcp.json'));
    const file = join(dir, 'deep', 'nest', 'mcp.json');
    writeMcpSettings(file, 'eyrie', { command: 'eyrie', args: ['mcp', '.'] });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mcpServers: { eyrie: { command: 'eyrie', args: ['mcp', '.'] } } });
  });

  it('tells the user how to reach the installed command', () => {
    const home = process.env.HOME ?? '';
    expect(pathHint(join(home, '.eyrie', 'bin'), 'darwin')).toContain('~/.eyrie/bin');
    expect(pathHint(join(home, '.eyrie', 'bin'), 'darwin')).toContain('export PATH=');
    expect(pathHint('C:\\U\\bin', 'win32')).toContain('user PATH');
  });
});
