/**
 * The desktop app's list of projects, kept as JSON in the app's user-data
 * folder. It holds only what the user added and what the last index found;
 * the parse cache itself stays in ~/.eyrie/repos/<hash>, shared with the CLI.
 * Needs nothing from Electron, so it is tested in Node.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { IndexSummary } from './protocol.js';

/** What the last scan, or the last open, found. */
export interface ProjectScan {
  /** When it finished (epoch ms). */
  at: number;
  ms: number;
  files: number;
  symbols: number;
  /** Architecture components and the links between them. */
  components: number;
  links: number;
  frameworks: string[];
  /** Commits recorded in the project's knowledge.db, and how many have an AI note. */
  commits?: number;
  analysed?: number;
}

export interface Project {
  id: string;
  /** Absolute path of the repository. */
  root: string;
  /** The folder name until an index reads the project's own name. */
  name: string;
  addedAt: number;
  openedAt?: number;
  scan?: ProjectScan;
  /** Why the last scan or open failed; cleared by the next one that succeeds. */
  error?: string;
  /** The AI backend that notes this project's commits (`claude`), when the user turned it on. */
  ai?: string;
  /** When the app last offered to tell this project's coding agents about Eyrie (epoch ms). Asked once, after the first map. */
  agentsPromptedAt?: number;
}

interface StoredList {
  version: 1;
  projects: Project[];
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Keeps entries that have the fields every reader relies on; drops anything else a damaged file holds. */
function validProject(value: unknown): value is Project {
  const p = value as Partial<Project> | null;
  return !!p && typeof p.id === 'string' && typeof p.root === 'string' && typeof p.name === 'string' && typeof p.addedAt === 'number';
}

export class ProjectStore {
  private projects: Project[] = [];

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredList>;
      if (Array.isArray(stored.projects)) this.projects = stored.projects.filter(validProject);
    } catch {
      /* unreadable: start empty, and the next save replaces it */
    }
  }

  /** Most recently opened first, then most recently added. */
  list(): Project[] {
    return [...this.projects].sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0) || b.addedAt - a.addedAt);
  }

  get(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  findByRoot(root: string): Project | undefined {
    const abs = resolve(root);
    return this.projects.find((p) => p.root === abs);
  }

  /** Adds a folder, or returns the project that already has it. Throws if `root` is not a folder. */
  add(root: string, now = Date.now()): { project: Project; added: boolean } {
    const abs = resolve(root);
    const existing = this.findByRoot(abs);
    if (existing) return { project: existing, added: false };
    if (!isDirectory(abs)) throw new Error(`Not a folder: ${abs}`);
    const project: Project = { id: randomUUID(), root: abs, name: basename(abs) || abs, addedAt: now };
    this.projects.push(project);
    this.save();
    return { project, added: true };
  }

  remove(id: string): boolean {
    const before = this.projects.length;
    this.projects = this.projects.filter((p) => p.id !== id);
    if (this.projects.length === before) return false;
    this.save();
    return true;
  }

  markOpened(id: string, now = Date.now()): void {
    this.patch(id, { openedAt: now });
  }

  /** Records what a scan or an open found, and clears an earlier error. */
  recordIndex(id: string, summary: IndexSummary, now = Date.now()): void {
    const { repo, stats, ms, knowledge } = summary;
    const scan: ProjectScan = { at: now, ms, files: stats.files, symbols: stats.symbols, components: stats.archNodes, links: stats.archEdges, frameworks: [...repo.frameworks] };
    if (knowledge) {
      scan.commits = knowledge.commits;
      scan.analysed = knowledge.analysed;
    }
    this.patch(id, { name: repo.name || this.get(id)?.name, error: undefined, scan });
  }

  /** Turns AI notes on (a backend name) or off (undefined) for a project. */
  setAi(id: string, ai: string | undefined): void {
    this.patch(id, { ai });
  }

  /** Records that the Connect-agents prompt was shown; it is asked once per project. */
  markAgentsPrompted(id: string, now = Date.now()): void {
    this.patch(id, { agentsPromptedAt: now });
  }

  recordError(id: string, message: string): void {
    this.patch(id, { error: message });
  }

  private patch(id: string, changes: Partial<Project>): void {
    const project = this.get(id);
    if (!project) return;
    Object.assign(project, changes);
    for (const key of Object.keys(changes) as (keyof Project)[]) if (project[key] === undefined) delete project[key];
    this.save();
  }

  /** Writes a temporary file and renames it over the list, so a crash never leaves half a file. */
  private save(): void {
    const body: StoredList = { version: 1, projects: this.projects };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}
