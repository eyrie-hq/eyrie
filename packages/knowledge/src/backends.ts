/** AI backends by the name users pass: `--ai claude`, `EYRIE_AI=codex`, or the desktop app's per-project setting. */
import type { AiBackend } from './analysis.js';
import { claudeCodeBackend } from './claude.js';
import { codexBackend } from './codex.js';
import { museBackend } from './muse.js';
import { openaiBackend } from './openai.js';

export const AI_BACKENDS = ['claude', 'codex', 'muse', 'openai'] as const;
export type AiBackendName = (typeof AI_BACKENDS)[number];

/** The backend for a name, or null for none. Throws for a name Eyrie does not know, or one this platform cannot run. */
export function createAiBackend(name: string | null | undefined, opts: { model?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): AiBackend | null {
  if (!name || name === 'off' || name === 'none') return null;
  if (name === 'claude') return claudeCodeBackend(opts);
  if (name === 'codex') return codexBackend(opts);
  if (name === 'muse') return museBackend(opts);
  if (name === 'openai') return openaiBackend(opts);
  throw new Error(`Unknown AI backend "${name}". Available: ${AI_BACKENDS.join(', ')}, or off.`);
}
