# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

All users are technical, run Eyrie on their own machine (from the command line, the desktop app, or through their coding agent), and already have the repository checked out. There is no non-technical persona and no multi-user surface.

| User | Job they are doing |
| --- | --- |
| **Developer new to a repository** | See the major components and how a request travels, without reading every file |
| **Developer operating a coding agent** | See what an agent just added, changed or removed, and whether it was wired into the right place |
| **Developer checking an app before it ships** | See the structural security mistakes the graph can prove: a public route that writes data with no auth guard on its path, a server secret reaching the browser, a webhook that never verifies its signature |
| **Developer about to make a risky change** | Know what calls a component and what breaks if it changes |
| **Tech lead / reviewer** | Check whether a change respects the intended layering (UI → API → logic → data) |

The situation is always the same: the repository is open on their machine, the tool is running beside their editor, and the code is actively changing underneath it — by their hand or an agent's.

## Product Purpose

Eyrie parses a repository locally, builds a code knowledge graph, derives a small architecture graph from it, and presents it as an interactive map that stays synchronised with the source. When a file is saved, only the affected region is recomputed and the change animates into the map.

Success means: an unfamiliar ~300-file repository becomes legible in under a minute; the map is still true after an hour of editing; and a developer can trust it enough to make an impact decision from it.

It is a desktop-class developer tool delivered today as a CLI that serves a local web UI (`pnpm start -- /path/to/repo` → `http://127.0.0.1:4319`). It is not a hosted service. Planned: one `eyrie` command shipped two ways, inside the desktop app and as the npm package `@eyrie-hq/cli`, so neither people nor agents need a source checkout ([06·M](docs/06-implementation-plan/feature-mcp-desktop/README.md), [06·H](docs/06-implementation-plan/agentic-health-graph/README.md)).

Non-goal: becoming a general code-search or code-review product. Eyrie answers *structural* questions. The planned Health check stays inside that line: it reports only what a parsed fact or a path in the graph proves, and calls itself a check, not a security audit.

## Positioning

Two claims a neighbouring product could not truthfully copy:

1. **The map is live, not generated.** Static diagram generators go stale the day they are produced. Eyrie re-resolves only the files that changed, plus the files that consulted them *only when their exported surface changed*, and emits an exact diff. Node ids are stable hashes of `repository + file path + symbol kind + qualified name`, so unchanged code keeps its identity across edits and layout does not reshuffle.
2. **Every edge traces to a parsed fact.** There is no inference-by-vibe. Each relationship comes from tree-sitter analysis and carries a confidence score. Determinism is the product: same commit ⇒ same graph.

The third position, increasingly the point: **codebases are now modified by agents, and developers need to see what just moved.** The change tape and diff animation exist for that.

## Operating Context

- Invoked from a terminal against a local git checkout; serves a local web UI the user leaves open beside their editor.
- One repository per running engine; one user per engine.
- The parse cache lives at `~/.eyrie/repos/<hash>/graph.db` (override with `EYRIE_HOME`). Deletable at any time.
- The UI is the only surface. Six lanes in request order — UI → Edge → API → Logic → Data → External — are product vocabulary, not a layout choice.
- Four lenses over one graph, from the whole system down to one request: System, Architecture, Data flow, Sequence. Plus a 2D map and a 3D "city" view where block height is lines of code.
- Round-trip to the editor is part of the workflow: `POST /api/open` launches the first of `cursor`, `code`, `windsurf`, `zed` found on `PATH`, or `EYRIE_EDITOR`, at the right line.
- Coding agents reach the same graph over MCP (`eyrie mcp`, stdio), so an agent can ask what a file belongs to and what depends on it before an edit, and what its edits changed afterwards. Agents can also ask grounded questions (`ask`), get findings for the files they just changed (`check`), and record the task they are working on (`record_intent`).
- Two `localStorage` keys hold UI preferences the user set themselves. No other client state.

## Capabilities and Constraints

**Shipped (Phases 1–2, end to end):** repository indexing with content-hash caching; the six-lane architecture map; all four lenses; 2D and 3D views; live updates with diff-driven animation and the change tape; details panel (purpose, source preview, open in editor, calls / used by, symbols); trace (downstream) and impact (upstream); search, category filters, fit, keyboard navigation. Also shipped: the MCP server for coding agents; commit history in a durable `knowledge.db` (each commit mapped onto the components it touched, with agent co-authors from `Co-Authored-By`); optional AI notes per commit through the user's Claude Code or Codex CLI; the desktop app's Projects page. Also shipped ([06·M](docs/06-implementation-plan/feature-mcp-desktop/README.md), [06·H](docs/06-implementation-plan/agentic-health-graph/README.md)): one `eyrie` command for the app and npm; agent onboarding with `eyrie init-agents`; the insight drawer (Ask the map, the Health check, Recent work by agent session) with `ask`, `check` and `record_intent` MCP tools.

**Planned:** collapse/expand and semantic zoom (3); path finding in the UI and code-level impact (4); architecture rules, findings and AI explanations of them (5, the Knowledge Loop); git overlays, branch/commit diffs, timeline (6); agent hooks (7); an Electron desktop app (Electron Forge) running the engine in a utility process. A first, unsigned version packages and runs on macOS from `apps/desktop`; it is not distributed.

**Detection is heuristic but inspectable.** Classification follows framework conventions and names (Next.js App/Pages Router, `'use server'`, Express-style routers, `*Service`/`*Repository`, React components, hooks). Presentational components, hooks, helpers and SDK wrappers are lifted out and edges pass through them, so a typical app reduces to 20–50 components. A doc comment on a component's main export overrides the derived description.

**Hard constraints:**

- Languages: TypeScript/JavaScript, Python, Go, Java, C#, PHP, Ruby and Rust. JavaScript (Next.js, Node.js) has the deepest support; Kotlin, Swift and C/C++ are not parsed.
- No control-flow analysis — so no branch, retry or terminal-state workflow views.
- No editing code from the map. Eyrie reads; your editor or agent writes. The one planned exception is agent setup, and only when the user asks: Eyrie may add itself to a coding agent's MCP configuration and write a marked, git-excluded section in `CLAUDE.local.md` or `AGENTS.md`. It never writes source code.
- No cloud component, no account system, no telemetry.
- From source: Node.js 22.13+ and pnpm 9. The planned npm CLI needs only Node.js 22.13+; the desktop app needs neither.
- Server binds `127.0.0.1`, requires a random per-run token, and rejects non-local `Host` headers (403) as DNS-rebinding protection. The source endpoint serves a file only if it is in the index, so `.env` files, keys and git-ignored paths are unreachable through it.

**Confirmed change to the privacy posture, now in effect.** With AI notes off — the default — Eyrie makes **no network requests at all**. With notes turned on for a project, Eyrie runs the user's own Claude Code or Codex CLI, which sends commit messages, author names, changed paths with line counts and component names (never source code) to Anthropic or OpenAI under the user's account. Neither model may act on the machine: Claude Code runs with no tools, and Codex, whose command tool cannot be removed, runs inside a macOS sandbox in which no command can start. That is the only path by which data leaves the machine, and it is opt-in per project with the content stated before it is turned on. Remote inference remains an accepted direction for further AI features. Consequences future work must honour:

- Do not write copy claiming Eyrie *will never* make network requests, or that code can never leave the machine. State today's behaviour as today's behaviour.
- AI annotates the graph — summaries, grouping suggestions, Q&A. It never becomes a source of truth for whether a dependency exists, and never decides what counts as a finding. An answer may cite only components that Eyrie's own tools returned. That boundary is not affected by where the model runs.
- Planned AI backends that call a provider's API directly (first the Meta Model API, for Ask the map) follow the same rules as the notes: off by default and opt-in per project; the key held by the user outside the repository; the content sent named before it is turned on (the question, component names, paths and graph tool results, never source code); the model named on every answer.
- No telemetry remains out of scope regardless. The AI decision covers inference, not analytics.
- This decision supersedes the open question in [docs/01 §9](docs/01-product-requirements/README.md); the README privacy section and PRD scope list still assert the absolute and will need updating.

**Explicitly open:** whether classification rules become user-extensible via config; whether unjoined Express router prefixes (`app.use('/api', router)`) are a correctness fix or a documented limitation; whether the app's bundled `eyrie` command is a bundled Node or a single executable.

## Brand Commitments

- **Name:** Eyrie. An *eyrie* is a bird of prey's nest built high on a crag — the vantage point you watch the whole territory from. The metaphor is load-bearing and already shapes the interface's tone.
- **Operator:** a personal open-source project, maintained by Badhan Sen, distributed as source under **GNU AGPL-3.0-only**. No business entity and no commercial intent. Future surfaces must not imply a company, team, or vendor relationship, and must not invent a company name or contact route.
- **Voice:** precise and unembellished. The existing README and the seven documents in [docs/](docs/) are the voice of record: they state what is shipped, what is partial and what is planned, and carry known limitations rather than hiding them.
- **Order of priorities, in the project's own words:** code graph first, visualization second, AI third.
- **Fixed vocabulary** the UI and docs share: lanes `ui`/`edge`/`api`/`logic`/`data`/`external`; categories `frontend`/`api`/`service`/`ai`/`data`/`external`/`infra`/`utility`.
- **Bundled fonts:** Archivo Variable and Fragment Mono, shipped via `@fontsource*` (both OFL-1.1). No runtime webfont fetch.

## Evidence on Hand

- **The working tool itself.** Phases 1–2 run end to end; `pnpm dev` or `pnpm start -- <repo>` demonstrates it on any TS/JS repo.
- **[fixtures/bookstore-app](fixtures/bookstore-app)** — a hand-written Next.js app where every asserted edge is a claim about how resolution *should* behave. `pnpm test` is hermetic and offline against it.
- **Real-repo smoke test** — `pnpm smoke` scans a ~290-file third-party MIT Next.js app (`accretence/next-prisma-tailwind-ecommerce`) cloned into the git-ignored `.smoke/`, asserting graph shape and health. Deliberately never vendored, so this project carries no third-party code.
- **[docs/](docs/)** — seven documents: PRD, TRD, App Flow, Design Brief, Backend Schema, Implementation Plan, and a completed 20-point Launch Readiness review. The Design Brief documents the shipped design system with real token values from `apps/web/src/styles.css`.
- **Measured contrast ratios** for every token in both colour schemes, in [docs/07 §11](docs/07-launch-readiness/README.md).
- **Licence inventory** of the installed dependency tree, in [docs/07 §15](docs/07-launch-readiness/README.md).

**Absences that must not be fabricated:** no users, no customers, no testimonials, no press, no adoption numbers, no benchmarks, no pricing, no hosted demo, no public website, no published binary or npm package, no launch date. The "20–50 components for a typical app" figure is currently **unevidenced** and flagged as such in docs/07 §13 — measure it before repeating it as a claim.

**Launch status: Hold.** Two actions are open before public launch ([docs/07](docs/07-launch-readiness/README.md) actions 10 and 11): screen-reader structure and information, and readability — `--color-faint` fails AA at the sizes it is used. Do not describe Eyrie as launched or publicly available.

## Product Principles

1. **Static analysis is the only source of truth for structure.** AI may annotate the graph; it may never assert that a dependency exists. Every edge traces to a parsed fact with a confidence score. Findings work the same way: a deterministic rule decides what is a finding; AI may only explain one.
2. **A stale map is worse than no map.** Liveness is the feature. Incremental correctness — invalidating exactly the dependents and nothing more — is what makes it possible.
3. **Stable identity over fresh layout.** Unchanged components keep their position and their id. The user's mental model of the map is an asset the tool must not disturb.
4. **Local by default; explicit about every exception.** The engine, cache and UI are local, the server is locked to the loopback interface, and anything that later leaves the machine must be something the user turned on knowingly and the interface names plainly.
5. **Eyrie reads; your editor or agent writes.** It answers structural questions and hands off: to the editor at the right line, or to a coding agent as a ready-made prompt. It does not expand into search, review, or authoring. Agent setup files, written only on request, are the one exception.

## Accessibility & Inclusion

**Target: WCAG 2.2 AA for the web UI** (set in docs/07 §11). Desktop and laptop only — there is no mobile layout and no phone support claim.

Established commitments any new work must keep:

- **Keyboard parity.** Every pointer action has a key: lenses `1`–`4`, view `V`, fit `F`, search `⌘K` / `/`, clear `Esc`, 3D camera `Q`/`E`/`T`/`R`. Graph nodes are real controls in both the 2D canvas and the 3D city — focusable, labelled, activated by `Enter`/`Space`.
- **Visible focus, never removed.** Global `:focus-visible`, 2px solid, 2px offset.
- **Reduced motion honoured in both layers** — CSS media query *and* a `matchMedia` check in JS, so programmatic animation is skipped too. The end state must be reached either way.
- **Never meaning in colour alone.** Change state also carries a `+` / `~` / `−` badge; edge semantics also carry dash patterns.
- **Contrast measured, not assumed,** in both colour schemes.

Known gaps, carried honestly: `--color-faint` does not reach 4.5:1 in either scheme (2.89–3.61:1) and is used as 9.5–10px text; never tested with a screen reader; `role="application"` on the map is a deliberate trade that suppresses browse mode; a node's accessible name carries label and kind but not its relationships; type is sized in `px` not `rem`, so browser font-size preference does not scale the UI.
