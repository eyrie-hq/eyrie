# 02 — Technical Requirements Document (TRD)

| Field | Value |
| --- | --- |
| Product | Eyrie |
| Owner | Badhan Sen |
| Status | Describes the implemented system; planned items are marked |
| Last updated | 2026-10-18 |
| Answers | How is Eyrie built and operated? |
| Related | [PRD](../01-product-requirements/README.md) · [Backend Schema](../05-backend-schema/README.md) · [App Flow](../03-app-flow/README.md) |

## 1. Architecture

Eyrie is a pnpm monorepo. One long-running local process (the engine + server) owns analysis and state; a browser UI is a pure view over it, and coding agents query the same engine over MCP.

```text
files ──► parser (tree-sitter WASM) ──► facts per file ──► code graph ──► architecture graph ──┬─► UI (browser / desktop)
             cached by content hash         (Graphology + SQLite)   (deterministic rules)       │   ELK layout; React Flow 2D;
                                              ▲                                                 │   Three.js city; anime.js
file watcher ── changed files only ───────────┘   diffs ──► WebSocket events ──► animations     ├─► MCP server (stdio) ──► coding agents
                                                                                                │
git log ── commits not yet recorded ──► knowledge.db ◄── components each commit touched ◄───────┘
                                          ▲
                                          └── optional AI notes per commit (opt-in; Claude Code or Codex CLI)
```

**Core principle: code graph first, visualisation second, AI third.** Static analysis establishes facts. The map is a view of the graph, never the source of truth. AI annotates — today, optional notes on recorded commits — and never invents a dependency, a finding or a rule.

### Package boundaries

| Package | Responsibility | Key deps |
| --- | --- | --- |
| `@eyrie/core` | Shared types only: facts, graph nodes/edges, stable ids, diffs, events, paths | none |
| `@eyrie/parser` | tree-sitter language adapters → facts; Prisma schema reader | `web-tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript` |
| `@eyrie/graph` | Module resolution, relationship resolution, incremental code graph, queries | `graphology` |
| `@eyrie/architecture` | Code graph → architecture graph: classification, lifting, pass-through edges | core, graph |
| `@eyrie/lens` | Pure views over the architecture graph: data flow, sequence, System (components grouped by app or package and layer), and trace, impact and paths, shared by the browser and the MCP server | core |
| `@eyrie/storage` | SQLite persistence: facts cache, nodes, edges, meta | `node:sqlite` (built-in) |
| `@eyrie/engine` | Scanning, ignore rules, project config, watching, update pipeline | `chokidar`, `ignore`, `json5` |
| `@eyrie/knowledge` | Durable project knowledge (`knowledge.db`): commits read with `git`, mapped onto the architecture components they touched; optional AI notes on them behind one backend interface (Claude Code CLI; Codex CLI on macOS) | core, `node:sqlite` |
| `@eyrie/server` | CLI, HTTP API, WebSocket, static hosting, editor launch, MCP server (`eyrie mcp`) | `ws` |
| `@eyrie/web` | React UI: layout, 2D renderer, 3D city, animation, state | `react` 19, `elkjs`, `d3-*`, `animejs`, `lucide-react` |

Dependencies point one way: `core ← parser/graph/storage ← architecture ← lens ← engine ← server`, with `knowledge` depending on `core` alone and used by `server`; it needs only the architecture graph, never the engine. The web app depends only on `core` and `lens`, which is what lets the lenses run in the browser and stay live while editing.

## 2. Frontend

- **Framework:** React 19, built with Vite 8 (Tailwind v4 via `@tailwindcss/vite`), served as static assets by the engine's own HTTP server.
- **Layout:** `elkjs` computes the lane-ordered architecture layout. Layout is *stable*: existing components keep their order when the graph updates.
- **2D renderer:** React Flow (`@xyflow/react`) with custom node and edge components, so node rendering and interaction stay under our control.
- **3D view:** a full-canvas Three.js (WebGL) city; block height encodes lines of code. Without WebGL the view offers a switch back to 2D.
- **Animation:** `animejs` for diff-driven motion (halos, pulses, block rise/sink, trace flow).
- **State:** a small hand-rolled store (`apps/web/src/state/store.ts`). Lens and 2D/3D preference persist in `localStorage` (`eyrie-lens`, `eyrie-view`).
- **Icons:** `lucide-react`.
- **Fonts:** bundled via `@fontsource-variable/archivo` and `@fontsource/fragment-mono` — never fetched from a CDN (see [Design Brief](../04-design-brief/README.md)).

## 3. Backend (engine + server)

Single Node.js process, no separate API tier.

**Responsibilities:** scan the repo, honour ignore rules, load project config, parse changed files, resolve relationships, maintain the code graph, derive the architecture graph, diff on every update, broadcast events, serve the UI and the read-only source endpoint, launch the user's editor, record new git commits into `knowledge.db` (on start and whenever HEAD moves) and, when the user turned it on, have them noted in the background.

### HTTP API

All `/api/*` requests require the per-run token (query `?token=` or header `x-eyrie-token`) and a local `Host`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/state` | Full snapshot: `{ repo, stats, seq, architecture }` |
| GET | `/api/arch/:id` | Architecture node details |
| GET | `/api/code/:id` | Code-graph node details |
| GET | `/api/source?file=&start=&end=` | Source lines — **only for indexed files** |
| GET | `/api/commits?limit=&component=&agent=` | Recorded commits, newest first, each with the components it touched, its co-authoring agents and its latest AI note: `{ summary, commits }` |
| POST | `/api/open` | `{ file, line }` → launch editor; `501` if no editor found |

### MCP server

`eyrie mcp [path]` serves one repository to coding agents over the Model Context Protocol (newline-delimited JSON-RPC 2.0 on stdio; revisions 2024-11-05 to 2025-11-25). It runs its own engine with the watcher on, answers the handshake at once and holds tool calls until the first index is ready, so a large repository does not time out the client. stdout carries the protocol only; logs go to stderr.

Every tool is read-only and answers from the live graph: `architecture_overview`, `find_components`, `explain_component`, `impact` (upstream), `trace` (downstream), `find_path`, `components_for_files`, `recent_changes` (architecture diffs since the server started, with removed components still named) and `commit_history`. A component reference is an id, an exact name or one of its files; one that matches several components is refused with the candidates, never guessed. Implemented without an MCP SDK (`packages/server/src/mcp.ts`), so the CLI gains no dependencies.

Error contract: `401` missing/invalid token, `403` non-local `Host`, `404` unknown endpoint or non-indexed file, `500` with `{ error }`. Request bodies are capped at 64 KB.

### WebSocket

Server → client messages (`@eyrie/core/events`):

| Message | Payload |
| --- | --- |
| `hello` | `seq`, `repo`, `stats`, full `architecture` |
| `status` | `indexing` \| `ready` \| `error`, optional `message` |
| `batch` | `seq`, `at`, `ms`, changed `files`, `events[]`, `truncated`, `stats` |

`events[]` is the exact diff: `file.changed`, `node.created/updated/deleted`, `edge.created/updated/deleted`, `architecture.updated` (carrying an `ArchDiff`). Code-level events are omitted and `truncated` set when a batch is very large; the architecture diff is always included, so the UI can always reconcile. `seq` lets a reconnecting client detect that it missed batches and refetch `/api/state`.

## 4. Parsing and resolution

- **Parser:** tree-sitter compiled to WASM, so there is no native build step. Each file is parsed once into *facts*: imports, exports, symbols, call/`new`/JSX references with their enclosing symbol, literal arguments (for `fetch('/api/...')`), route registrations, Prisma models.
- **Facts are content-addressed.** They depend only on file content, so they are cached in SQLite by hash and reused across restarts. A `facts_version` bump invalidates the whole file cache.
- **Resolution** follows relative imports, `tsconfig`/`jsconfig` `paths` and `baseUrl` (including `extends` chains, parsed with JSON5), workspace packages, barrels and re-exports, class instances, `this.field` types, typed parameters and object-literal services. **Every edge carries a confidence** (1 = syntactically certain, lower = heuristic).
- **Limitation, accepted:** resolution is syntactic. Without a type checker, calls through untyped values, DI or dynamic dispatch can be missed or fall back to the class with lower confidence.

### Incremental updates

The graph records, per file, which other files it consulted during resolution. On change: re-resolve that file only; additionally re-resolve its consumers **only if its exported surface changed**. Node ids are stable hashes of `repository + file path + symbol kind + qualified name`, so unchanged code keeps its identity across edits and the UI can animate rather than re-render.

## 5. Storage

SQLite via Node's built-in `node:sqlite` — no native module, no server. `PRAGMA journal_mode = WAL`, `synchronous = NORMAL`. Writes are batched in an explicit transaction per update.

Two databases per repository, side by side in `~/.eyrie/repos/<hash>/` (overridable with `EYRIE_HOME`):

- `graph.db` — the **disposable** parse cache and code graph. A schema change drops and rebuilds it.
- `knowledge.db` — **durable** project knowledge: recorded commits and AI notes. Nothing in it can be rebuilt from the code alone (notes cost money; history can be rewritten), so migrations only add, tracked with `PRAGMA user_version`.

Full schema in the [Backend Schema document](../05-backend-schema/README.md). The desktop app also keeps its project list as `projects.json` in its user-data folder.

## 6. Runtime, hosting and environments

Eyrie is **not hosted**. There is no production environment in the web sense; the user's machine is the only environment.

| Environment | How it runs |
| --- | --- |
| Development | `pnpm dev` — engine on `:4319` against `fixtures/bookstore-app` with token `dev`, plus Vite UI with HMR on `:5173`. Open `http://localhost:5173/?token=dev` |
| Local use | `pnpm start -- /path/to/repo` — builds the UI, indexes, serves and opens the browser |
| Coding agents | `eyrie mcp /path/to/repo` as an MCP server, e.g. `claude mcp add eyrie -- pnpm --silent --dir <eyrie> eyrie mcp /path/to/repo` |
| Desktop | `pnpm desktop` — the Electron app ([`apps/desktop`](../../apps/desktop/README.md)): a Projects page, the engine in a utility process per open project or scan |
| Test | `pnpm test` (vitest, hermetic and offline, against the fixture) |
| Smoke | `pnpm smoke:fetch` then `pnpm smoke` — scans a real third-party repo cloned into the git-ignored `.smoke/` |
| Architecture review | `pnpm arch scan` / `pnpm arch report` — deterministic checks on this repository with a local, git-ignored history in `.eyrie/knowledge.db`; see [`scripts/arch-review`](../../scripts/arch-review/README.md) |

**Requirements:** Node.js ≥ 22.13 (for `node:sqlite`), pnpm 9.15.0. ES modules throughout, TypeScript ~5.9.

**CLI:** `eyrie [path]` (map) or `eyrie mcp [path]` (MCP over stdio). Options: `--port <n>` (default 4319, or next free; `0` = any), `--host <h>` (default `127.0.0.1`), `--token <t>` (default random per run), `--no-open`, `--no-watch`, `--reset`, `--ai <backend>` (`claude` or `codex`; also `EYRIE_AI`; off by default), `--ai-model <m>`, `-h`.

## 7. Integrations

| Integration | Direction | Notes |
| --- | --- | --- |
| Editor launch | Outbound process spawn | `cursor`, `code`, `windsurf`, `zed` discovered on `PATH`; `EYRIE_EDITOR` overrides |
| File watcher | OS | `chokidar` |
| Git | Read-only process spawn | `git log` for commits not yet recorded, with the settings a repository could use to run programs turned off (`core.fsmonitor`, external diff, textconv). Overlays and branch diffs remain planned (Phase 6) |
| MCP | Inbound from coding agents, stdio | `eyrie mcp`; read-only tools over the live graph (see §3) |
| Claude Code CLI | Outbound process spawn, **opt-in per project** | Commit notes. `claude --print` with no tools, no MCP servers, no user or project settings, no saved session, in an empty temporary folder; the prompt goes in on stdin. It receives commit messages, changed paths with line counts and component names — never source code — and sends them to Anthropic under the user's own account |
| Codex CLI | Outbound process spawn, **opt-in per project, macOS only** | Commit notes. Codex 0.160's command tool cannot be disabled and its `read-only` sandbox still lets commands read any file, so `codex exec` (read-only sandbox, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, approvals `never`, web search off, connector/plugin/browser/computer-use/sub-agent features off, `--output-schema` with a strict schema) runs inside `sandbox-exec` with a profile that denies `file-write*` everywhere except a fresh workspace (holding a copy of Codex's login, copied back if refreshed) and `/dev`, and denies `file-read-data` under the home folder, the per-user temp folder and `/Volumes` outside that workspace. Codex's own command sandbox cannot start inside it, so no command runs; with `code_mode_host` disabled its exec and patch tools do not run either. With Codex's own sandbox and those features deliberately turned back on, `apply_patch` and shell writes succeed only in the workspace and reading `~/.ssh` is refused, so the OS layer holds alone. A run whose event stream shows a completed command is discarded. Sends the same fields as Claude Code, to OpenAI |
| Other AI backends (planned) | — | HTTP APIs and other agent CLIs behind the same `AiBackend` interface |

**With AI notes off (the default) there are no network integrations.** No analytics, no error reporting, no update check, no CDN. Turning notes on is the only way Eyrie causes data to leave the machine, through the user's own Claude Code or Codex CLI.

## 8. Authentication and authorisation

There are no user accounts. The trust boundary is "a process on this machine, started by this user":

- Random per-run access token required on every `/api/*` request and on the WebSocket upgrade.
- Bind to `127.0.0.1` by default.
- `Host` header must be `localhost`, `127.0.0.1`, `::1` or the configured host — this is DNS-rebinding protection, which a token alone does not provide.
- Read-only surface: the only mutating endpoint is `/api/open`, and it can only open a path that is already in the index.
- The MCP server has no network listener at all: it speaks stdio to the process that started it, so it inherits that process's trust, and every tool is read-only.

## 9. Quality requirements

| Area | Target |
| --- | --- |
| Correctness | Every asserted edge in `fixtures/bookstore-app` is a claim about how resolution *should* behave; `pnpm test` must stay green and offline |
| Robustness | `pnpm smoke` on a ~290-file third-party repo must complete and produce a healthy graph (shape and health assertions, not specific edges) |
| Types | `pnpm typecheck` clean across the monorepo and the web app |
| Determinism | Identical input ⇒ identical graph and identical node ids |
| Responsiveness | Incremental update visible within a couple of seconds of save; cached restart far faster than first run |
| Accessibility | Visible focus ring on every interactive element; every mouse action reachable by keyboard; both colour schemes meet contrast targets (see Design Brief) |
| Browser support | Current Chrome, Safari and Firefox. Requires CSS `color-mix()`, CSS 3D transforms and `prefers-color-scheme` |
| Known cost | Parsing is single-threaded; very large repos are slow on first run and fast afterwards |

## 10. Security and operations

- **Secrets:** Eyrie holds none. The only secret in play is the run token, which lives in memory and in the opened URL.
- **Source exposure:** `/api/source` and `/api/open` resolve only against the index. `.env` files, keys and anything git-ignored are never readable through the server. Static file serving normalises paths and refuses anything outside the built web directory.
- **Input validation:** JSON bodies capped at 64 KB; ids matched against `^[\w-]+$` before lookup; `start`/`end` coerced to numbers.
- **Ignore rules:** `.gitignore` and `.eyrieignore` (at any depth) are honoured during scanning, so secrets and build output are not even parsed. Editing either while Eyrie runs reloads every ignore file, drops newly ignored files from the index, adds files a rule no longer hides, and restarts the watcher.
- **Repositories are untrusted input:** `git` runs without a shell and with fsmonitor, external diff and textconv off; AI prompts carry repository text as data inside a JSON packet, and a note citing any file or component the commit did not touch is stored as `rejected`, never shown as fact.
- **Logging:** stdout only (stderr in MCP mode), for the operator who started the process. No log shipping.
- **Backups and recovery:** `graph.db` is disposable. `--reset` ignores it; deleting `~/.eyrie/repos/<hash>/` forces a clean re-index and also deletes `knowledge.db` (recorded commits are read again; AI notes would have to be paid for again). The repository is the only other durable state and Eyrie never writes to it.
- **Incidents:** there is no shared service to page anyone about. Failure mode is a local process that stops; the user restarts it.

## 11. Deployment and maintenance

- **Distribution today:** clone the repo, `pnpm install`, `pnpm start`. `pnpm start` builds the UI first, so a user always serves a current bundle.
- **Versioning:** `SCHEMA_VERSION` and `facts_version` are the two compatibility knobs; bumping either triggers an automatic local rebuild (see Backend Schema).
- **Desktop (in progress):** an Electron app (Electron Forge, `apps/desktop`) wraps the same UI and runs the engine in a utility process, through the same `launch()` as the CLI. It packages and runs on macOS; it is not signed or distributed.
- **Licence:** GNU AGPL-3.0-only. Modifying Eyrie and offering it to others *over a network* obliges you to offer your source. Running it locally carries no obligation. This constrains any future hosted offering — a deliberate choice.

## 12. Constraints and rationale

| Constraint | Rationale |
| --- | --- |
| Local-first, zero network | The product is "point this at your proprietary code". A network call would undermine it |
| Node ≥ 22.13 | Lets us use built-in `node:sqlite` instead of a native module, keeping install friction near zero |
| tree-sitter via WASM | No compiler toolchain needed on the user's machine |
| No general graph library in the UI | Rendering, lanes, lifting and animation are the product; a generic library would fight all four |
| CSS 3D instead of WebGL | One rendering model, smaller bundle, works alongside the DOM-based 2D view |
| Static analysis only | Determinism and trust. An LLM-derived edge cannot be relied on for impact analysis |
| TS/JS only | Depth over breadth while resolution rules are still being tuned |
| AGPL-3.0-only | Keeps derivative *network services* open |

## Completion checklist

- [x] Technical choices support the PRD.
- [x] Integrations and environment requirements are defined.
- [x] Quality targets are measurable.
- [x] Deployment, maintenance and recovery responsibilities are assigned.
- [ ] Open: whether classification rules become user-configurable, and whether Phase 5 permits any non-local model.
