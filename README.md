# Eyrie

[![CI](https://github.com/eyrie-hq/eyrie/actions/workflows/ci.yml/badge.svg)](https://github.com/eyrie-hq/eyrie/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE)

**A live architecture map of your codebase that updates as you (or your coding agent) change the code.**

Eyrie parses a repository locally, builds a code knowledge graph, derives a small architecture graph from it (pages → API routes → services → data → external services), and shows it as an interactive map. When a file is saved, only the affected part of the graph is recomputed and the change animates into the map: new components appear, edited ones pulse, and every save is recorded on a change tape at the bottom of the screen.

> Status: early. Phase 1 (static architecture map) and Phase 2 (live graph) work end to end for TypeScript/JavaScript, Python, Go, Java, C#, PHP, Ruby and Rust projects. JavaScript (Next.js, Node.js) has the deepest support. Coding agents reach the same graph over MCP through the one `eyrie` command, which the desktop app ships; the map itself answers questions, reports security findings and shows what an agent just changed. The desktop app runs on macOS, Windows and Linux; its builds are not yet signed by Apple or Microsoft. See [Roadmap](#roadmap).

An *eyrie* is a bird of prey's nest, built high on a crag — the vantage point you watch the whole territory from.

## Install

### Desktop app

Download the file for your system from [Releases](https://github.com/eyrie-hq/eyrie/releases):

| System | File |
| --- | --- |
| macOS, Apple silicon | `Eyrie-<version>-arm64.dmg` |
| macOS, Intel | `Eyrie-<version>-x64.dmg` |
| Windows, x64 | `Eyrie-<version>-x64-Setup.exe` |
| Debian, Ubuntu | `eyrie-desktop_<version>_amd64.deb`, or `_arm64.deb` |
| Fedora, openSUSE | `eyrie-desktop-<version>-1.x86_64.rpm`, or `.arm64.rpm` |

Each Mac build also comes as a ZIP of the same app.

**The first time you open it.** The builds are not signed by Apple or Microsoft yet, so each system warns you once:

- **macOS:** drag Eyrie to Applications and open it. When macOS says it cannot verify the app, open **System Settings → Privacy & Security**, choose **Open Anyway** next to Eyrie, and confirm.
- **Windows:** when SmartScreen says "Windows protected your PC", choose **More info → Run anyway**. The installer needs no administrator rights: it installs Eyrie for your user, adds it to the Start menu and opens it.
- **Linux:** install the package with your package manager, then open Eyrie from your applications menu or run `eyrie-desktop`.

```bash
sudo apt install ./eyrie-desktop_<version>_amd64.deb
```

```bash
sudo dnf install ./eyrie-desktop-<version>-1.x86_64.rpm
```

Eyrie opens on a list of projects: add a repository folder (or drop one on the window) and open it to see its map.

**Checking a download.** Every release lists the SHA-256 of each file in `SHA256SUMS`, and GitHub records which build of this repository produced it. Put the download next to `SHA256SUMS` and check one or both:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
```

```bash
gh attestation verify Eyrie-<version>-arm64.dmg --repo eyrie-hq/eyrie
```

**Updating.** There is no automatic update yet. Download the new version and install it over the old one; your projects and settings stay.

**Uninstalling, and where Eyrie keeps its data.** Uninstalling removes the app but leaves its data; delete the two folders as well to remove everything.

| System | Uninstall | Project list and settings | Index cache, shared with the CLI |
| --- | --- | --- | --- |
| macOS | Drag Eyrie from Applications to the Bin | `~/Library/Application Support/Eyrie` | `~/.eyrie` |
| Windows | Settings → Apps → Installed apps → Eyrie → Uninstall | `%APPDATA%\Eyrie` | `%USERPROFILE%\.eyrie` |
| Linux | `sudo apt remove eyrie-desktop` or `sudo dnf remove eyrie-desktop` | `~/.config/Eyrie` | `~/.eyrie` |

The app also carries the `eyrie` command for coding agents, and can install it for terminal use into `~/.eyrie/bin` (`%APPDATA%\Eyrie\bin` on Windows); see [Use it from a coding agent](#use-it-from-a-coding-agent-mcp).

### Tested on

Every release build is checked on GitHub's runners before it is attached to a release: the packaged app opens `fixtures/bookstore-app` with an empty cache, and what it indexes must match the engine run from source on the same machine. Nobody has yet installed a release on a clean desktop computer; reports are welcome.

| Build | Checked on | What was checked |
| --- | --- | --- |
| macOS, Apple silicon | macOS 15.7 (runner); macOS 26.6 (by hand) | The app indexes the fixture; its ad hoc signature verifies. By hand also: the DMG and ZIP contents, and saved choices surviving a reopen and a relaunch |
| macOS, Intel | macOS 15.7 (runner) | The app indexes the fixture; its signature verifies |
| Windows, x64 | Windows Server 2025 (runner) | The packaged app indexes the fixture. The installer itself has not been run yet |
| Linux, x64 | Ubuntu 24.04 (runner) | The `.deb` installs with `apt` and the installed app indexes the fixture. The `.rpm` is built and inspected, not installed |
| Linux, arm64 | Ubuntu 24.04 (runner) | The same |

### From source

Requirements: Node.js 22.13 or newer, pnpm 9.

```bash
pnpm install
```

```bash
pnpm start -- /path/to/your/repo
```

This builds the UI, indexes the repository, and opens `http://127.0.0.1:4319/?token=…` in your browser. Leave it running and edit code in the repository; the map follows.

Options: `--port <n>`, `--host <h>`, `--token <t>`, `--no-open`, `--no-watch` (index once), `--reset` (ignore the cache), `--ai <backend>` and `--ai-model <m>` — the backend is `claude`, `codex`, `muse` or `openai`, and turns on notes on commits and answers to questions (see [Commit history and AI notes](#commit-history-and-ai-notes)).

The same command has two more jobs: `eyrie mcp` serves the repository to coding agents, and `eyrie init-agents` tells the repository's agents that it is there. `eyrie --help` lists everything.

## Use it from a coding agent (MCP)

**Eyrie is one command, not a separate server.** `eyrie [path]` indexes a repository and opens its live map; `eyrie mcp [path]` serves that same graph to coding agents over the [Model Context Protocol](https://modelcontextprotocol.io), on stdio; `eyrie init-agents [path]` tells the repository's agents the tools exist. The desktop app ships the very same command inside its resources, so there is no MCP-only build, no service to start and nothing listening on a port.

Each agent starts its own `eyrie mcp` process, with its own engine, named per project (`eyrie-<project>` when the app sets it up). They share one index cache with the app: SQLite waits rather than failing (a five-second busy timeout), and a cache that still cannot be read is skipped for that run, which is slower and never wrong. So the app and several agents can hold the same project open at once. With the map open, an agent's edit animates into it.

**Where the command comes from:**

| Source | Use it as | Notes |
| --- | --- | --- |
| The desktop app | `eyrie` | A project's ⋯ menu → **Connect Coding Agents** → **Install eyrie Command…** copies it to `~/.eyrie/bin` (`%APPDATA%\Eyrie\bin` on Windows), where it survives app updates. The same menu connects **Claude Code**, **Codex**, **Gemini CLI** or **Cursor** to that project for you, after showing you the exact command it will run |
| npm | `npx -y @eyrie-hq/cli` | Needs Node.js 22.13 or newer; one package serves every platform. **Not on npm yet:** publishing is held back to a later release |
| A source checkout | `pnpm --silent --dir /path/to/eyrie eyrie` | `pnpm --silent` keeps pnpm's own output off the protocol stream |

**Claude Code** and **Codex** have the same one-line setup:

```bash
claude mcp add eyrie -- eyrie mcp /path/to/your/repo
```

```bash
codex mcp add eyrie -- eyrie mcp /path/to/your/repo
```

**Gemini CLI** (`.gemini/settings.json` in the project, or `~/.gemini/settings.json`) and **Cursor** (`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`) read the same `mcpServers` block:

```json
{
  "mcpServers": {
    "eyrie": {
      "command": "eyrie",
      "args": ["mcp", "/path/to/your/repo"]
    }
  }
}
```

**VS Code** (GitHub Copilot in agent mode) reads `.vscode/mcp.json`, with `servers` instead of `mcpServers`:

```json
{
  "servers": {
    "eyrie": {
      "type": "stdio",
      "command": "eyrie",
      "args": ["mcp", "/path/to/your/repo"]
    }
  }
}
```

In every example, replace `eyrie` with one of the other two forms above if you have not installed the command. A client started from a desktop launcher may not inherit your shell's `PATH`, so give the full path (`~/.eyrie/bin/eyrie`) if it cannot find the command; the app's Connect menu always writes the full path.

Tested end to end with Claude Code and Codex; Gemini CLI, Cursor and VS Code use their standard MCP configuration and were not tested here. Windsurf, Zed and other clients take the same command and arguments in their own MCP settings.

**Agents rarely call tools they have no reason to.** `eyrie init-agents` adds a short marked section (`<!-- eyrie:start -->` … `<!-- eyrie:end -->`) to the repository's `AGENTS.md`, telling agents to ask what files belong to and what depends on them before editing, to record what they are doing, and to check what their edits changed afterwards. `--local` writes `CLAUDE.local.md` instead and adds it to `.git/info/exclude`, so nothing reaches a commit. A second run refreshes the section in place and changes nothing else. The desktop app offers this once per project, after its first map. This is the only part of Eyrie that writes into your repository.

The agent then has tools that answer from the same graph as the map, kept current as files are saved. All leave the repository alone; `ask` and `record_intent` additionally store in Eyrie's local `knowledge.db` (the question and its answer, the session):

| Tool | Answers |
| --- | --- |
| `architecture_overview` | Components by lane, size, the most connected components |
| `find_components`, `explain_component` | What a component is, its files and symbols, what it uses and what uses it, recent commits that touched it |
| `impact`, `trace` | Everything that depends on a component (what could break), or everything it reaches |
| `find_path` | The chain of dependencies between two components |
| `components_for_files` | Which components own the files the agent is about to edit |
| `recent_changes` | What the agent's edits changed in the architecture since the server started |
| `record_intent` | Records the task at the start and the summary at the end, so recent work keeps its why |
| `commit_history` | Recorded commits, the agents that co-authored them, and AI notes when turned on |
| `check` | Security findings over the whole project, or only the files given |
| `ask` | A plain-language question answered by a model that only used the tools above (needs `--ai`) |

A name that matches several components is refused with the candidates rather than guessed.

## Commit history and AI notes

Whenever Eyrie opens or scans a project, it records the commits it has not seen yet in the project's `knowledge.db`: the message, the author and any coding agent in a `Co-Authored-By` trailer, the files changed with line counts, and the architecture components those files belong to. While a project is open it checks for new commits every 5 seconds.

Optionally, Eyrie has each commit **noted** by an AI backend: what the commit is for, whether what it changed matches its message, and its architectural risk. A commit titled "fix: typo in checkout" that also edits the data model is flagged. Turn it on per project in the desktop app (**Analyse Commits** in the project's ⋯ menu: Claude, Codex or Muse), or with `--ai <backend>` (or `EYRIE_AI`) on the command line, where the backend is `claude`, `codex`, `muse` or `openai`. It is off by default. The same backend answers questions through the `ask` MCP tool, and is the default in the app's Ask tab, where a question can also pick its own backend (see [Ask, health and recent work](#ask-health-and-recent-work)). Codex is available on macOS only for now, because Eyrie runs it inside a macOS sandbox (see [Privacy and security](#privacy-and-security)). On Windows, Claude Code must be the `claude.exe` from Anthropic's native installer: Eyrie's instructions span several lines, and the npm package's `claude.cmd` cannot be given those.

Notes are opinions, kept beside the facts and labelled with the model that wrote them. Every observation must cite a file or component the commit actually touched, or the note is rejected. A note never becomes a dependency, a finding or a rule.

## Ask, health and recent work

Three things share one **insight drawer** on the left of the map: press `A`, or use the Insights group in the top bar; `Esc` closes it. None of them is a new lens — each marks components on whatever lens is open and dims the rest, so you stay where you were. Agents see the same three: `ask` and `check` are MCP tools, and Recent is built from what agents report through `record_intent`.

**Ask** — a plain-language question answered by a model that may only call Eyrie's read-only tools. It cannot read files. The answer comes back as numbered steps, each citing components; **a step citing anything the tools did not return is rejected rather than shown**, the same rule AI commit notes follow. Pick who answers per question — Claude Code, Codex, Muse or an OpenAI-compatible API — and that pick is the consent that turns AI on for that one question, so the server needs no `--ai`. Every answer names the model that wrote it and lists the tool calls it made; *Replay path* walks the cited path on the map, and the cited components stay ringed with their step numbers.

**Health** — security findings computed from the graph, with no model involved at all. Eight rules, five over one file and three that need the graph:

| Rule | Severity | What it means |
| --- | --- | --- |
| Hardcoded secret | high | A secret-shaped string literal is committed in source |
| Secret in a public env var | high | A client-visible variable (`NEXT_PUBLIC_*`, `VITE_*`, …) has a secret-sounding name, so the value ships to browsers |
| `.env` file exposed | medium | A `.env` file is tracked by git or not ignored |
| Supabase table without RLS | high | A migration creates a table without row-level security, leaving it open to any client with the anon key |
| Firebase rules in test mode | high | Rules allow reads or writes when `true` |
| **Public route reaches a write** | high | A route reaches a database write with no auth guard anywhere on the path |
| **Server env read in UI code** | medium | UI-lane code reads a server-only environment variable |
| **Webhook without verification** | high | A webhook handler never reaches a signature-verification call, so anyone can forge its events |

The three in bold are what a file-by-file scanner cannot express: they are paths through the architecture graph. Severity is always a word as well as a colour. Each finding carries the path it was found on, a `!` badge on its components, *Show on map*, and *Copy fix prompt* — the prompt to hand to whichever agent will fix it. The facts behind the rules (environment reads, auth guards, webhook verification, secret-shaped literals) are extracted per file alongside everything else; a secret-shaped literal is recorded as a location and the pattern that matched, never the value.

**Recent** — what an agent has been doing. When an agent calls `record_intent`, Eyrie opens a session: the task in its own words, which agent, and the window it covers. The components it changed in that window are listed with `+` (new) or `~` (changed), optionally each with a grounded note on how the change serves the task, and the session links to its commit once one lands, through the `Co-Authored-By` trailer. The live session's saves sit on a shaded band on the change tape.

Selecting a component also shows its findings and what changed in this session in the details panel; both link back to the matching row in the drawer.

## Supported languages

| Language | Files | Imports resolved through |
| --- | --- | --- |
| TypeScript / JavaScript | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` | relative paths, `tsconfig` / `jsconfig` paths, workspace packages, barrels |
| Python | `.py` | dotted modules, packages and `__init__.py` re-exports, relative imports |
| Go | `.go` | `go.mod` module paths; a package is its whole directory |
| Java | `.java` | packages, single-type, wildcard and static imports |
| C# | `.cs` | namespaces, `using` directives and aliases |
| PHP | `.php` | namespaces, `use` (including groups), `require` / `include` |
| Ruby | `.rb` `.rake` | `require` / `require_relative`, autoloaded constants (Rails) |
| Rust | `.rs` | `mod` files, `use` trees, `crate::` / `self::` / `super::` paths |
| Kotlin | `.kt` `.kts` | packages, single-type and wildcard imports |
| Swift | `.swift` | `import` modules; every file in a target sees the others |
| C | `.c` `.h` | quoted `#include`s (relative, then include directories); header prototypes are the link targets |
| C++ | `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.hxx` | quoted `#include`s, out-of-class `Type::member` definitions, `using` directives |
| Dart | `.dart` | relative and `package:` URIs (`lib/`-based, no pubspec parsing); `dart:` is the SDK |
| Vue | `.vue` | single-file components through the JS resolver; template tags are render edges |
| Objective-C | `.m` | quoted `#import`s (relative, then include directories); `.h` stays C++ |
| Lua | `.lua` | `require` paths (dotted, `init.lua`); `self` and colon methods |

Every language gets the same treatment: classes and functions, calls between them (including through fields such as `self.repo`, `$this->repo`, `@repo` and injected services), HTTP routes, database models with reads and writes, external SDKs and outbound HTTP calls. Mixed repositories (a Python or Go backend with a React frontend) are indexed into one map. See [What is detected](#what-is-detected) for the frameworks each language understands. JavaScript (Next.js, Node.js) has the deepest support.

Generated code is skipped (`*.pb.go`, `*_pb2.py`, `*.Designer.cs`, `*.d.ts`), and test files in each language's convention (`test_*.py`, `*_test.go`, `*Test.java`, `*Test.kt`, `*Tests.swift`, `test_*.c`, `*_test.dart`, `*Tests.m`, `*_spec.lua`, `*_spec.rb`, …) are kept out of the architecture view.

## What you see

- **Four lenses**, from the whole system down to one request: `1` System, `2` Architecture, `3` Data flow, `4` Sequence. Eyrie opens on System the first time and remembers your choice after that. *System* is the whiteboard view: components are grouped into one box per app or package (folders under `apps/`, `packages/`, `services/` or `libs/`) and per layer (UI, API, services, data), with each external service and any missing route kept as its own box, and links between boxes labelled with what they carry and how many component links they stand for. Select a box to see what it holds; click a component there to open it in the Architecture lens. *Architecture* is the map of every component the system is made of. *Data flow* keeps only the components that touch data — stores, and anything that reads, writes or ships it — and colours every link by what it carries: orange writes, cyan reads, dashed for a call that leaves the process, faint for an in-process hand-off. Reads are drawn pointing **out of the store**, so the arrows follow the data rather than the dependency. *Sequence* picks one entry point and lays its calls out as a sequence diagram: lifelines across the top, messages down the page, each with the file and line that makes the call (click it to open your editor). All four are derived from the same static analysis; see [Known limitations](#known-limitations) for what sequence order can and cannot tell you.
- **2D and 3D views** (press `V`). Eyrie opens in 2D until you choose 3D, and remembers the choice, in the desktop app too. Both use custom React Flow components for navigation and inspection. The 3D view adds a full-canvas Three.js city: components become lit blocks whose **height shows lines of code**, dependencies run along the ground, and upright labels remain readable as the camera rotates. Drag to pan, right-drag or `⌥`-drag to orbit, scroll or pinch to zoom, `Q`/`E` to rotate, `T` for a top-down plan, `R` to reset. The minimap navigates the projected city. If WebGL is unavailable, the view offers a switch back to 2D.
- **Lanes.** Components are arranged left to right in the order a request travels: UI → Edge (middleware) → API → Logic → Data → External. A ruler at the top names the lanes and points to lanes that are off-screen.
- **Colors carry meaning.** Blue frontend, green API, orange services, purple AI, cyan data, yellow external services, grey utilities. A missing API route (frontend calls `/api/x` and nothing serves it) is drawn in red.
- **Links.** Solid lines are calls, dashed lines are HTTP requests (they cross a network boundary), cyan lines read or write data.
- **Live changes.** New components get a green `+` badge, edited ones a yellow `~`, removed ones a red `−`. In 3D, new blocks rise into place and removed blocks briefly fade and sink. Selecting a component sends a bounded sweep along its dependencies; trace modes animate continuous request flow. The 2D lane ruler marks off-screen changes. Layout is stable: existing components keep their order when the map updates.
- **Change tape.** Every save becomes a tick: height is the size of the change, color its type. Hover a tick to light up what it touched; click to jump there. While an agent is working in a recorded session, its ticks sit on a shaded band.
- **Insight drawer** (`A`, or the Insights group in the top bar). *Ask* a question and get numbered steps that cite components; *Health* lists security findings from the graph; *Recent* shows what an agent changed and why. All three mark the map rather than replace the lens: `!` for a finding, step numbers for an answer, `+` and `~` for a session's changes, everything else dimmed. See [Ask, health and recent work](#ask-health-and-recent-work).
- **Details panel.** Click a component to see its purpose (from its doc comment, or generated from the code), source location with a code preview, **Open in editor**, what it calls, what uses it, the symbols inside, any findings against it, and what changed in it during the current agent session. The last two open the matching row in the drawer.
- **Trace and impact.** In the panel, *Depends on* follows the request through everything a component calls (with animated flow); *Impact* shows everything that could break if it changes, grouped into API, UI, services, data and external.
- **Search** (`⌘K` or `/`), category filters, `F` to fit, `Esc` to clear — the drawer first, if it is open.

## How it works

```
files ──► parser (tree-sitter) ──► facts per file ──► code graph ──► architecture graph ──┬─► UI (ELK layout; React Flow 2D,
             cached by content hash      (Graphology + SQLite)    (deterministic rules)   │       Three.js city; anime.js motion)
                                              ▲                                           ├─► MCP server ──► coding agents
file watcher ── changed files only ───────────┘ diffs ──► WebSocket events ──► animations │
                                                                                          ├─► checks (8 pure rules) ──► findings (no model involved)
git log ── new commits ──► knowledge.db ◄── components each commit touched ◄──────────────┘
                              ▲
                              └── optional, opt-in AI: notes on commits and on what a session changed,
                                  answers to questions (your Claude Code, Codex or Muse CLI,
                                  or any OpenAI-compatible API)
```

**Code graph first. Visualization second. AI third.** Every relationship and every finding comes from static analysis. AI is optional, off by default, and only annotates or answers: notes on recorded commits and on what an agent's session changed, and answers to questions. Each one must cite components the tools actually returned, or it is rejected. It never invents a dependency or a finding.

1. **Facts.** Each file is parsed once with tree-sitter (WASM) into *facts*: imports, exports, symbols, call/`new`/JSX references with their enclosing symbol, literal arguments (for `fetch('/api/...')`), route registrations, ORM models. Every language has its own adapter, but they all produce the same facts, so everything downstream is language-neutral. Facts depend only on the file's content, so they are cached in SQLite by hash; restarts reuse them.
2. **Code graph.** Facts become nodes (files, functions, classes, methods, components, hooks, API routes, middleware, data models, external services) and edges (`CONTAINS`, `IMPORTS`, `EXPORTS`, `CALLS`, `USES`, `EXTENDS`, `IMPLEMENTS`, `HTTP_CALL`, `READS_FROM`, `WRITES_TO`, `DEPENDS_ON`). Resolution follows relative imports, tsconfig/jsconfig `paths` and `baseUrl`, workspace packages, barrels and re-exports, class instances, `this.field` types, typed parameters and object-literal services. Outside JavaScript it also follows Python dotted modules and packages, Go packages (directories, via `go.mod`), Java / C# / PHP / Kotlin namespaces and wildcard imports, Swift modules, C / C++ / Objective-C quoted includes (with an include-directory fallback), Dart `package:` URIs, Lua `require` paths, Vue SFCs through the JS resolver, Rust `mod` trees and `use` paths, and Ruby autoloaded constants, plus names visible without an import (same Go package, same Java or C# namespace, same Swift target). `self`, receivers, `$this`, `@ivar` and injected fields all resolve like `this.field`. Every edge carries a confidence.
3. **Lenses.** Data flow and sequence are pure functions of the architecture graph, computed in the browser, so they stay live as you edit. Data flow keeps a component when it stores data, reads, writes or ships it, or when it sits on a path from an entry point to one that does; each edge is classified `read`, `write`, `readwrite`, `transfer` (it crosses a process boundary) or `carry`. Sequence walks the graph from one entry point, ordering each component's calls by the source line the graph recorded for them, and expanding a component's own calls only the first time it is reached. Its canvas uses custom React Flow lifeline nodes and message edges, with pan, zoom, fit/reset controls, and a pinned source column that follows the viewport vertically.
4. **Incremental updates.** While resolving a file, the graph records which other files it consulted. When a file changes, only it is re-resolved, plus, if its exported surface changed, the files that consulted it. Node ids are stable hashes of `repository + file path + symbol kind + qualified name`, so unchanged code keeps its identity across edits. Each update produces an exact diff (`node.created`, `edge.deleted`, …).
5. **Architecture graph.** Files are classified by framework conventions and names (Next.js `page`/`route`/`layout`/`middleware`, `'use server'`, Express routers, `*Service`, `*Repository`, `services/`, React components, hooks). Presentational components, hooks, helpers and SDK client wrappers are hidden and edges pass through them, so the map stays small and connected. Shared helpers used by many components, and modules on dependency paths in library-style repos, are shown. A typical app reduces to 20–50 components.
6. **Findings.** Eight pure rules run over the architecture graph and the security facts parsed alongside the rest (environment reads, auth guards, webhook verification, secret-shaped literals as locations only). Five look at one file; three are paths through the graph — a route reaching a write with no guard on the path, UI-lane code reading a server-only variable, a webhook handler that never reaches a verification call. A finding names its rule, severity, components, files, the evidence and a fix prompt.

### What is detected

| Area | Detected |
| --- | --- |
| Next.js | App Router `page`, `route` (per HTTP method), `layout`, `middleware`/`proxy`, Pages Router pages and `pages/api`, `next/dynamic` imports, server actions |
| HTTP | `fetch`, `axios` and `axios.create()` instances, `ky`, `ofetch`, `useSWR`, template and concatenated URLs, matched to routes including dynamic segments; external hosts mapped to providers |
| Node.js | Express/Hono/Fastify-style `app.get('/path', handler)` routes, CommonJS `require`/`module.exports` |
| Data | Prisma schema models with reads/writes per operation, Drizzle tables, Mongoose models, Supabase tables |
| Python | Flask / FastAPI decorator routes (with blueprint and router prefixes), Django `urlpatterns`; Django, SQLAlchemy and SQLModel models; `requests` / `httpx` calls |
| Go | `net/http` (including Go 1.22 `"POST /x"` patterns), gin, echo, chi, fiber and gorilla/mux routes; gorm models; `http.Get` calls |
| Java | Spring MVC (`@RequestMapping` + `@GetMapping`…), JAX-RS and Micronaut routes; JPA entities and Spring Data repositories |
| C# | ASP.NET controllers (`[Route]`, `[HttpGet]`, `[controller]` tokens) and minimal APIs (`MapGet`, `MapGroup`); EF Core `DbSet` models; `HttpClient` calls |
| PHP | Laravel routes (groups, prefixes, `match`, `resource`) and Symfony `#[Route]`; Eloquent models and relations |
| Ruby | Rails `routes.rb` (`resources`, `namespace`, `to:`) and Sinatra; ActiveRecord models and associations |
| Rust | axum `.route()`, actix-web / rocket attribute routes; diesel, sea-orm and sqlx models |
| Kotlin | Spring MVC routes, JPA entities and Spring Data repositories, like Java |
| Swift | Vapor routes; SwiftData `@Model` and Fluent models |
| C | CivetWeb / Mongoose `mg_*` route registrations; structs, typedefs, function-like macros |
| C++ | classes with out-of-class definitions, templates, `using` directives and namespace aliases |
| Dart | classes, mixins, enums and extension members; Flutter widgets are plain classes |
| Vue | `<script>` / `<script setup>` blocks, template component usage |
| Objective-C | `@interface` / `@implementation`, protocols, message sends |
| Lua | `require` modules, module tables, colon methods |
| External services | 50+ SDKs (OpenAI, Anthropic, Gemini, Stripe, Resend, Clerk, Supabase, Redis, S3, …) via imports or API hosts, recognised under each ecosystem's package names (pip, Go modules, Maven, NuGet, Composer, gems, crates) |
| Project setup | `tsconfig`/`jsconfig` paths (including `extends`), monorepo workspace packages, `go.mod` modules, frameworks from `pyproject.toml` / `requirements.txt`, `pom.xml` / `build.gradle`, `*.csproj`, `composer.json`, `Gemfile` and `Cargo.toml`, `.gitignore` and `.eyrieignore` |

## Privacy and security

**Eyrie has no accounts, no telemetry and no server of its own.** It stores two files per repository under `~/.eyrie/repos/<hash>/`: an analysis cache (`graph.db`: file paths, symbol names and the graph built from them) and `knowledge.db`, holding the commits it has recorded (messages, authors' and co-authors' names and email addresses as git has them, changed paths), the agent sessions reported through `record_intent`, the questions asked and the answers given, and any AI notes. Delete either at any time.

- **With AI notes off, the default, nothing leaves your machine.** Eyrie makes no network requests; fonts are bundled. The desktop app's window loads only Eyrie's own pages, served by its local engine; links open in your browser, and spellcheck is off, so Chromium downloads no dictionaries.
- **The Windows installer** downloads Eyrie's icon from this repository on GitHub once, while installing, to show in Installed apps. That is the installer (Squirrel) doing it, not Eyrie.
- **With AI on** for a project (commit notes, the Ask tab, the `ask` tool), Eyrie runs your chosen backend. It sends commit messages, author names, changed file paths with line counts and the names of the architecture components involved, and never source code.
  - **Claude Code** runs with no tools, no MCP servers and none of your settings, in an empty temporary folder, so the model can read nothing else and change nothing. It sends to Anthropic under your own account.
  - **Codex** keeps a command tool that cannot be turned off, and its own read-only sandbox still lets commands read any of your files. So Eyrie runs Codex itself inside a macOS sandbox: it can write nowhere except one empty workspace (holding a copy of Codex's login) and `/dev`, and it cannot read file contents or list folders in your home folder, your temporary folder or on external drives. Codex's command sandbox cannot start inside it, so no command runs at all, and Codex also runs read-only, without your config, rules, saved session, web search, connectors, plugins or its code-mode tools. Tested with Codex's own protections deliberately switched off: its patch tool and shell could write only inside the workspace, and reading `~/.ssh` was refused. System files outside your home folder, such as `/etc/hosts`, stay readable, and no command can run to read them. It sends to OpenAI under your own account.
  - **Muse** runs with writing, shell commands and web access turned off, in an empty temporary folder, so the model can read nothing else and change nothing. It sends to the model provider you signed in with, under your own account.
  - **OpenAI-compatible API** (command line only) posts to the endpoint you configure (`EYRIE_OPENAI_BASE_URL`, defaulting to OpenAI) with your API key (`EYRIE_OPENAI_API_KEY`). It sends to that endpoint under your own account.
- The server binds to `127.0.0.1`, requires a random per-run access token, and rejects requests whose `Host` header is not local (DNS-rebinding protection).
- The source endpoint only serves files that are in the index. `.env` files, keys and anything ignored by git are never readable through it.
- **The health check involves no model and no network.** The eight rules are pure functions over the graph and the facts already parsed from your files; findings stay on your machine. A secret-shaped literal is recorded as a location and the name of the pattern that matched, never the value.
- The MCP server has no network listener: it talks only to the agent that started it, over stdio, and every tool leaves the repository alone (`ask` and `record_intent` store in Eyrie's local `knowledge.db`: the question and its answer, the session and its components). `eyrie init-agents` is the one command that writes into the repository, and only the marked section it owns.
- `git` runs without a shell and with the settings a repository could use to run its own programs turned off.
- The data lives in `~/.eyrie/repos/<hash>/` (override with `EYRIE_HOME`). Delete that directory, or run with `--reset`, to start fresh. The desktop app also keeps its project list (`projects.json`) and your theme, view and lens (`prefs.json`) in its own folder, listed under [Install](#install).

Found a security problem? Please report it privately. See [SECURITY.md](SECURITY.md).

## Development

```text
packages/
  core/          shared types: facts, graph, stable ids, diffs, events
  parser/        tree-sitter (WASM) language adapters → facts (TS/JS, Python, Go, Java, C#, PHP, Ruby, Rust); Prisma schema reader
  graph/         module resolution, relationship resolution, incremental code graph, queries
  architecture/  code graph → architecture graph (classification, lifting, pass-through)
  lens/          views over the architecture graph: data flow, sequence, System; trace, impact and paths
  checks/        eight pure security rules over the architecture graph and the parsed facts → findings
  storage/       SQLite (node:sqlite) facts cache, nodes and edges
  engine/        scanning, ignore rules, config loading, watching, update pipeline
  knowledge/     knowledge.db: recorded git commits mapped onto components, agent sessions from record_intent; the ask loop; optional AI notes and answers (Claude Code, Codex, Muse or OpenAI-compatible API)
  server/        CLI, HTTP API, WebSocket and the MCP server (`eyrie mcp`)
apps/
  web/           React UI: ELK layout, React Flow navigation, Three.js 3D city, anime.js animation
  desktop/       Electron shell (Electron Forge): runs the engine in a utility process and shows the UI
  cli/           @eyrie-hq/cli: the published `eyrie` command and the desktop app's single executable
fixtures/
  bookstore-app/ sample Next.js app used by tests and demos
  unsafe-app/    one planted case per security rule, each with a safe variant
scripts/
  fetch-smoke-repo.sh  clones a real OSS app into .smoke/ for the smoke test
  ask-eval/            ten scored questions for Ask the map, with recorded runs
LICENSE          GNU AGPL-3.0
THIRD-PARTY-NOTICES.md  licences of bundled dependencies and fonts
```

```bash
pnpm test          # parser, graph, architecture, lens, engine (real file watcher) and server tests
pnpm typecheck
pnpm dev           # engine on :4319 (fixture app, token "dev") + UI with hot reload on :5173
pnpm desktop       # the desktop app (Electron); see apps/desktop/README.md
pnpm --filter @eyrie/desktop make    # installers for this machine, in apps/desktop/out/make
pnpm eyrie mcp fixtures/bookstore-app   # the MCP server on stdio, for trying it with a client
pnpm --filter @eyrie-hq/cli build       # the published `eyrie` command; `build:sea` for the single executable

pnpm smoke:fetch   # clone a real MIT-licensed Next.js app into .smoke/ (once)
pnpm smoke         # scan that real repo end to end; skips if it was never fetched
```

`pnpm test` is hermetic and offline: it runs against `fixtures/bookstore-app`, a small
hand-written Next.js app whose every asserted edge is a claim about how resolution
*should* behave. `pnpm smoke` is the opposite check — it scans a ~290-file third-party
repo to confirm Eyrie survives code nobody wrote for it, asserting shape and health
rather than specific edges. That repo is cloned into the gitignored `.smoke/`, never
vendored, so this project carries no third-party code.

The other languages are tested the same way, with small in-memory apps per language (`packages/*/test/languages.test.ts`). They were also checked by hand against real open-source apps: the FastAPI full-stack template, Spring petclinic, and the Go, C#, Laravel, Rails and Rust RealWorld implementations.

**Adding a language.** Add its tree-sitter grammar to `packages/parser`, register the extension in `languages.ts`, and write an extractor on top of `BaseExtractor` (`packages/parser/src/base.ts`) that emits the same facts as the others. Then teach `ModuleResolver` (`packages/graph/src/resolver.ts`) how its imports map to files. Nothing else needs to know about the language.

During `pnpm dev`, open `http://localhost:5173/?token=dev`.

**Releases.** Pushing a tag `v<version>` that matches `apps/desktop/package.json` runs [`release.yml`](.github/workflows/release.yml): it builds the desktop app on macOS (Apple silicon and Intel), Windows and Linux (x64 and arm64), each on its own kind of runner, checks each build with `pnpm --filter @eyrie/desktop smoke`, and attaches the installers, `SHA256SUMS` and build provenance to a draft release. A person reviews the draft and publishes it. Pull requests that change the desktop app run the same builds and keep the installers as workflow artifacts for a week.

To open files from the UI, Eyrie looks for `cursor`, `code`, `windsurf` or `zed` on your `PATH`; set `EYRIE_EDITOR` to choose one.

## Roadmap

- [x] **Phase 1: static architecture map.** Scanner, tree-sitter parsing, symbols, imports/exports, calls, React and Next.js detection, code graph, architecture graph, interactive map, details panel.
- [x] **Phase 2: live graph.** File watcher, incremental resolution with reverse-dependency invalidation, graph diffs, WebSocket events, animated updates, stable layout, change tape.
- [ ] **Phase 3: navigation.** Done: search, open in editor, jump to line, category filters, data-flow, sequence and System lenses. Next: nested group boundaries, expanding a box in place.
- [ ] **Phase 4: graph intelligence.** Done: trace (downstream) and impact (upstream) on the architecture graph, the shortest path between two components (MCP `find_path`), and highlighting — one mechanism that rings a set of components and draws a path heavier, shared by every lens, 2D and 3D. Next: path finding from the UI (pick two components), code-level impact.
- [ ] **Phase 5: AI understanding, and findings.** Done: commit history in `knowledge.db`; optional AI notes per commit and per component an agent changed; a health check of eight deterministic rules over the graph, with no model involved, in the app and as the MCP `check` tool; Ask the map, where a model may only call the read-only tools and an answer citing anything they did not return is rejected; four backends — Claude Code, Codex, Muse or any OpenAI-compatible API — off by default, pickable per question. Next: architecture rules beyond security, and findings with history, verdicts and exceptions ([Knowledge Loop](docs/06-implementation-plan/feature-knowledge/README.md)); recorded Ask eval scores across the backends.
- [ ] **Phase 6: Git intelligence.** Working-tree overlays, branch and commit architecture diffs, timeline.
- [ ] **Phase 7: coding-agent integration.** Done: one `eyrie` command with the MCP server inside it, shipped with the desktop app and wired up from a project's ⋯ menu; `eyrie init-agents`, so agents have a reason to call the tools; `record_intent` sessions with the components each one changed and why; the `check` tool, the second half of the agent guardrail; agent attribution from `Co-Authored-By` trailers. Next: Claude Code hooks that hand new findings back to the agent as it edits, and attributing saves made outside a recorded session.
- [ ] **Desktop app.** Done: an Electron shell (Electron Forge, [`apps/desktop`](apps/desktop/README.md)) around the same UI, running the engine in a utility process, with installers for macOS (DMG, ZIP), Windows (Squirrel) and Linux (deb, rpm) built and checked on each platform by the release workflow; the `eyrie` command bundled in the app, installable to a per-user folder, with Connect Coding Agents for Claude Code, Codex, Gemini CLI and Cursor ([plan](docs/06-implementation-plan/feature-mcp-desktop/README.md)). Next: signing and notarization, automatic updates, and background watching.

## Known limitations

- Resolution is syntactic. Without a type checker, calls through untyped values, dependency injection or dynamic dispatch can be missed or fall back to the class (with lower confidence).
- The sequence view orders calls by where they are written in the source. That is all static analysis can give: conditionals, loops and `await` can make the running order differ, and returns are not modelled. Workflow and lifecycle views (branches, retries, terminal states) would need control-flow analysis, which Eyrie does not do.
- Architecture classification is heuristic. It is tuned most for Next.js and Node.js apps, then for the frameworks listed above; other layouts may need rules. Add a doc comment (or a Python docstring) to a component's main export to set its description.
- Express router prefixes (`app.use('/api', router)`) are not joined to the routes registered on the router yet.
- Parsing is single-threaded; very large repositories take a while on first run (later runs use the cache).
- C and C++: system headers (`#include <…>`) are not followed into the project, and C++20 modules (`export module` / `import x;`) are not parsed.
- Objective-C: only `.m` files are parsed (`.h` stays with C++, `.mm` is skipped), so interfaces declared only in headers are not followed.
- Vue: only `<script>` blocks and template component tags are read; directives, `v-for` and `<style>` are ignored.
- Dart: `package:` imports resolve without reading `pubspec.yaml`, and explicit type arguments on method calls (`o.m<int>()`) are not followed.
- Outside JavaScript, what a dynamic language decides at run time is not followed: Ruby metaprogramming, PHP magic methods, Python `getattr`, Lua metatables and dynamic `require()`, DI containers configured outside the code, and Rust macro bodies (such as `sqlx::query!`).
- A frontend that calls the backend through a generated API client (OpenAPI SDKs) shows no HTTP links to the backend's routes; only direct `fetch` / `axios` calls are matched.
- The desktop builds are not signed by Apple or Microsoft, so each system warns the first time Eyrie opens, and there are no automatic updates yet.
- **`@eyrie-hq/cli` is not on npm yet.** The desktop builds ship first and the npm publish is held back to a later release, so the `npx -y @eyrie-hq/cli` lines above do not work today: use the `eyrie` command the desktop app installs, or a source checkout.
- **The health check is eight rules, not a scanner.** It finds what those rules describe and nothing else, and it only sees what the parser resolved: a guard it cannot follow (a framework's own middleware, a DI container, an import it could not resolve) reads as no guard. Its false-positive rate has been measured on `fixtures/bookstore-app` (4 findings, all true) and on Eyrie itself (9, none in production code); a run over a large third-party repository is still open.
- **Ask needs a model.** It is off until you pick a backend, each backend needs its own CLI signed in (or an API key), and answers are only as good as the questions the tools can answer — it cannot read your code, by design. The ten-question eval in `scripts/ask-eval/` validates the question set; scores from live models are not recorded yet.
- **Recent work only sees what an agent reports.** An agent that never calls `record_intent` leaves no session, and saves made outside one are still on the change tape but belong to nobody. Session-level attribution without the agent's help needs editor or hook integration, which does not exist yet.
- On Linux, a very large repository can use up the system's file-watch limit (`fs.inotify.max_user_watches`); Eyrie logs the error, and changes to some files stop reaching the map until the limit is raised.

## Related projects

This space moves fast. [GitNexus](https://github.com/abhigyanpatwari/GitNexus), [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything), [Depwire](https://depwire.dev) and [CodeViz](https://www.codeviz.ai/) build code graphs for agents and humans. Eyrie focuses on a small, deterministic architecture view that stays live while code changes.

## Contributing and support

Eyrie is maintained by Badhan Sen ([@Badhansen](https://github.com/Badhansen)).

- **Questions, bugs and feature requests:** [GitHub issues](https://github.com/eyrie-hq/eyrie/issues).
- **Security problems:** report privately, as described in [SECURITY.md](SECURITY.md).
- **Contributing:** start with [CONTRIBUTING.md](CONTRIBUTING.md). Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[GNU AGPL-3.0-only](LICENSE). You can read, run, modify and redistribute Eyrie freely. The one condition that matters: if you modify Eyrie and let other people use it over a network, you have to offer them your modified source too. Running it locally on your own code carries no obligation at all, and Eyrie never sends your code anywhere.

Eyrie depends on open-source packages and bundles two fonts under their own licences; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
