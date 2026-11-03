# 06·H — Agentic health graph

| Field | Value |
| --- | --- |
| Product | Eyrie |
| Owner | Badhan Sen |
| Status | **Implemented** on `muse/meta-global-ai-hackathon-v1`: Tasks 0–5 and the insight drawer (§9) are built, tested and wired. Remaining: live-model Ask eval scores, and the smoke-repo false-positive run below. |
| Last updated | 2026-11-03 |
| Answers | How do coding agents and people get Eyrie's graph where they work: one install, answers grounded in the graph, security findings, and what an agent just changed and why? |
| Related | [Implementation Plan](../README.md) · [MCP in the desktop app](../feature-mcp-desktop/README.md) · [Knowledge Loop](../feature-knowledge/README.md) · [DESIGN.md](../../../DESIGN.md) · [README: MCP](../../../README.md#use-it-from-a-coding-agent-mcp) · [Mock-ups](mock/) |

## 1. Summary

Five tasks, in build order:

1. **`@eyrie-hq/cli`**: one `eyrie` command, published to npm and shipped inside the desktop app.
2. **Tell agents Eyrie exists**: a marked section in `CLAUDE.local.md` / `AGENTS.md` so agents actually call the MCP tools.
3. **Ask the map**: questions answered by a model that may only use Eyrie's read-only tools, with the cited sub-graph highlighted. The first backend is a Meta model through the Meta Model API.
4. **Health check from the graph**: deterministic security findings, including graph rules that a file-by-file scanner cannot express.
5. **Recent work with the why**: agent sessions, the components they changed, and a labelled note on how each change serves the task.

All five keep the rule from [PRODUCT.md](../../../PRODUCT.md) and the Knowledge Loop: **every relationship and every finding comes from static analysis; AI only annotates**, labelled with its model and citing what it touched.

Floorplan (`haydenschmitty/floorplan`, MIT) prompted Tasks 3–5: its "Ask the map", Health check and Recent work. The difference kept here is that Floorplan's components are named and grouped by an LLM, while Eyrie's come from the graph and update on every save.

## 2. How this fits the other records

- **Task 1 follows [MCP in the desktop app](../feature-mcp-desktop/README.md).** That record decides option A: a separate `eyrie` command, each MCP server running its own engine. Option C (proxy to the running app) stays deferred. Its §4 precondition comes first: the shared-cache fix for `database is locked` when several engines open one cache.
- **Task 4's findings should land in the Knowledge Loop's findings store,** not a parallel one, so Health findings get the same history, verdicts and exceptions. See open question 1.
- **Task 4's MCP `check` tool is the second half of the agent guardrail** in Knowledge Loop §16. `components_for_files` and `recent_changes` are the first half.

## 3. Build order

| # | Task | Needs | Hackathon |
| --- | --- | --- | --- |
| 0 | Shared-cache fix ([06·M §4](../feature-mcp-desktop/README.md)) | nothing | yes, it blocks 1 |
| 1 | `@eyrie-hq/cli` | 0 | **yes** |
| 2 | Tell agents Eyrie exists | 1 | if time |
| 3 | Ask the map (Meta backend) | existing MCP tools | **yes** |
| 4 | Health check from the graph | parser facts (inside the task) | no |
| 5 | Recent work with the why | 1, 2, existing `recent_changes` | no |

Tasks 3, 4 and 5 share one UI: the insight drawer (§9).

## 4. Task 1: `@eyrie-hq/cli`, one command for the app and npm

Every other task reaches agents through it, and it lets anyone try Eyrie with one line.

**Build**

- Add `apps/cli` with `"name": "@eyrie-hq/cli"` and `"bin": { "eyrie": "dist/cli.js" }`. A tsup/esbuild build bundles `packages/server/src/cli.ts`, the `@eyrie/*` workspace packages, the tree-sitter `.wasm` files and the built web UI into `dist/`. Resolve asset paths from `import.meta.url`, never from the repository root. No native modules are involved (`node:sqlite`, WASM grammars), so one package serves every platform. `engines.node` stays `>=22.13`.
- Desktop: Electron Forge copies the same `dist/` plus a bundled Node (or a single-executable build) into the app's resources. Install locations follow [06·M §5](../feature-mcp-desktop/README.md). A **Connect coding agents** menu item:
    - installs `eyrie` into a per-user `PATH` folder
    - after asking, runs `claude mcp add` / `codex mcp add`, or writes the Gemini CLI / Cursor `mcpServers` JSON
    - replaces today's *Copy MCP Command* items.
- Release: one tag publishes npm (`npm publish --provenance --access public`) and builds the app with that same CLI inside. One version number for CLI, app and engine.
- Agent setup becomes `claude mcp add eyrie -- npx -y @eyrie-hq/cli mcp .` (npm) or `claude mcp add eyrie -- eyrie mcp .` (installed with the app).

**Done when**

- In CI, `npm pack` then `npx ./eyrie-hq-cli-*.tgz mcp fixtures/bookstore-app` answers `architecture_overview` on macOS, Windows and Linux.
- The packaged app's `eyrie mcp` gives the same answer.
- The app and two `eyrie mcp` processes on one repository all index it with the cache on: no `database is locked` in any log.
- With the app open, an agent's edit animates the map. This already works through the file watcher; no proxy is needed.

## 5. Task 2: Tell agents Eyrie exists

Adding an MCP server is not enough: agents rarely call tools they have no reason to.

**Build**

- `eyrie init-agents [repo]`, plus an app prompt after a project's first map. It writes a short marked section (`<!-- eyrie:start --> … <!-- eyrie:end -->`) to `CLAUDE.local.md` or `AGENTS.md`:
    - call `components_for_files` before editing
    - call `impact` before changing shared code
    - call `recent_changes` (and, once Task 4 lands, `check`) after editing
- Add `CLAUDE.local.md` to `.git/info/exclude`, so nothing reaches a commit. A second run updates the section in place.
- Optional: thin Claude Code (`.claude-plugin`) and Codex (`.codex-plugin`) marketplace manifests that register the MCP server and carry the same instructions.

**Done when**

- On a fixture repository with the section, scripted Claude Code and Codex runs call `components_for_files` before their first edit, as shown in the MCP JSON-RPC log.
- Without the section, the same runs do not. That difference is the evidence the task works.

## 6. Task 3: Ask the map, on a Meta model

**Build**

- `packages/knowledge/src/meta.ts`, implementing `AiBackend` next to `claude.ts` and `codex.ts`, registered in `backends.ts` as `meta`. The API key comes from an environment variable or the app's keychain setting, never from the repository.
- `packages/knowledge/src/ask.ts`, the ask loop. The model receives the question and **only** Eyrie's read-only tools as function calls: `architecture_overview`, `find_components`, `explain_component`, `find_path`, `impact`, `trace`. It cannot read files.
    - Output: `{ answer, steps: [{ text, componentIds[] }] }`.
    - An answer citing a component id that no tool call returned is rejected, the same rule AI commit notes follow.
    - Every answer is stored and shown with the model that wrote it and the tool calls it made.
- A server endpoint, and an MCP tool `ask` so agents can use it too.
- UI: the Ask tab of the insight drawer (§9), opened with `A` (`⌘K` and `/` stay search).

**Done when**

- About 10 questions on `fixtures/bookstore-app` with known answers ("How does checkout reach the database?") are scored automatically: each answer's cited components against a truth set from `find_path`.
- The same set is run on `meta`, `claude` and `codex`, and the scores are recorded.

**Open:** which Meta Model API endpoint and model.

## 7. Task 4: Health check from the graph

**Build**

1. **New facts in `packages/parser`.** Eyrie does not extract these today:
    - environment-variable reads (`process.env.X`, `os.environ`, `os.Getenv`, …)
    - secret-shaped string literals, stored as a location only, never the value
    - webhook verification calls (`stripe.webhooks.constructEvent`, `svix.verify`, …)
    - auth guards (Next.js middleware matchers, `getServerSession`, `@login_required`, `[Authorize]`, `requireAuth`, …)
2. **Rules** as pure functions over the architecture graph (a new `packages/checks`, or the Knowledge Loop's checks; open question 1). A finding is `{ id, rule, severity, componentIds, files, evidence, fixPrompt }`.
    - Per-file rules: hardcoded secret, secret in a `NEXT_PUBLIC_*` variable, `.env` tracked or not ignored, Supabase table without row-level security in migrations, Firebase test-mode rules.
    - Graph rules, which a file scanner cannot express:
        - a public route that reaches a `WRITES_TO` with no auth guard anywhere on the path
        - a UI-lane component that reaches a server-only environment variable
        - a webhook route whose handler never reaches a verification call
3. **Surfaces:** the Health tab and finding badges (§9), and an MCP tool `check`, optionally limited to the files an agent just changed.

**Done when**

- `fixtures/unsafe-app` holds one planted case per rule and a matching safe variant. Tests assert every planted case is found and no safe variant is flagged.
- The smoke repositories have been run and the false-positive rate recorded.

## 8. Task 5: Recent work with the why

**Build**

- MCP tool `record_intent({ task, summary? })`, called by the agent at the start of a task and optionally at the end.
- A `sessions` table in `knowledge.db`: intent, agent (from the MCP client info), start and end time, and the component diffs from `recent_changes` in that window.
- Optional AI note per changed component ("how this change serves the task"), through any backend including `meta`. Existing rules hold: it cites a touched file or is rejected, it is labelled with its model, and it never becomes a fact.
- UI: the Recent work tab (§9), linking a session to its commit once one lands, through the existing `Co-Authored-By` attribution.

**Done when**

- A scripted agent session on `bookstore-app`, with Task 2's section in place, produces a session whose changed components exactly match the graph diff.
- Every note cites a touched file, or is stored as rejected.

## 9. UI: the insight drawer

Mock-ups: [`mock/`](mock/) (see §10). Visual rules are [DESIGN.md](../../../DESIGN.md)'s; nothing here adds a colour.

**Decision: a drawer with three tabs, not new lenses.** A lens changes *how the graph is drawn*. Ask, Health and Recent work change *which components are marked*, on whatever lens is open. As lenses they would take the user off the map.

```
┌ Eyrie / bookstore-app │ System · Architecture · Data flow · Sequence │ 22 components │ ⚠ 3 Health │ ● 4 Recent │ Ask A │ Search ┐
├───────────────────────┬────────────────────────────────────────────────────────────────┬──────────────────────┤
│ Insight drawer 340px  │ Map: UI → Edge → API → Logic → Data → External                  │ Details panel 300px  │
│ [Ask│Health│Recent]   │ marks on nodes: ! finding · + new · ~ changed · 1…n answer step │ (existing Panel)     │
│ the tab's list        │ highlighted set: ring + tint, edges on the path drawn heavier   │ + Findings           │
│                       │ everything else dimmed                                          │ + Changed in session │
├───────────────────────┴────────────────────────────────────────────────────────────────┴──────────────────────┤
│ Change tape: ticks per save; the current agent session's ticks sit on a shaded band                             │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Placement**

- **Top bar:** three counters after the stats: `⚠ n Health`, `● n Recent`, `Ask A`. Each opens the drawer on its tab. `A` is unbound today; `⌘K` and `/` remain search.
- **Drawer on the left,** because the details Panel holds the right. Both can be open together. On narrow screens it stacks above the map, as the Panel already moves below it.
- **Panel sections** for the selected component: *Findings* (Task 4) and *Changed in this session* (Task 5, with its note). The drawer lists everything; the Panel shows one component.
- **Change tape:** the active session's ticks on a shaded band (Task 5).

**Tabs**

| Tab | Contents | On the map |
| --- | --- | --- |
| Ask | Question field and submit; answer with numbered steps; "answered by [model] · n tool calls"; the tool calls listed; *Replay path*, *Copy answer*; earlier questions | Cited components ringed in Vantage Blue with step numbers 1…n; the path's edges drawn heavier; the rest dimmed |
| Health | Count, "checked … ago"; severity chips; one card per finding: severity (dot **and** word), title, one-sentence evidence, the path in mono, *Show on map*, *Copy fix prompt* | `!` badge (Fault Red circle) on each finding's component; the selected finding's path ringed red; the rest dimmed |
| Recent work | Live session card: agent, start time, task (from `record_intent`), each changed component with `+`/`~` and its note, "notes by [model]", commit state; earlier sessions collapsed | Session components ringed in Signal Green with `+` (new) or `~` (changed) badges; the edges they touched drawn heavier |

**One highlight mechanism.** All three tabs produce *a set of components, optionally a path, and some text*. Add one field to the web store (`apps/web/src/state/store.ts`, beside `selected` and `focus`) rather than three:

```ts
highlight: {
  source: 'ask' | 'health' | 'recent';
  ids: string[];                     // components to ring
  path?: [from: string, to: string][]; // edges to draw heavier
  marks?: Record<string, '!' | '+' | '~' | number>;
} | null;
```

Lenses, 2D, 3D and trace modes read it the same way, so highlighting behaves identically everywhere.

**Tokens, from DESIGN.md**

| Use | Token | Notes |
| --- | --- | --- |
| Health ring, `!` badge | `broken` (Fault Red) | Badge is a circle with `!`: shape and glyph, not colour alone |
| Ask ring, step numbers | Vantage Blue (frontend) | Already the focus colour; steps are numbered |
| Recent ring, `+` badge | `new` (Signal Green) | Square badge |
| `~` badge | `modified` (External Gold) | Square badge |
| Highlight tint | `color-mix(in oklab, <node surface> 90%, <ring>)` | The mock uses fixed hexes (`#302629`, `#232c38`, `#1f302d`) for dark mode only |
| Dimmed components | opacity ≈ 0.32–0.5 | Mock: Ask 0.32, Health 0.38, Recent 0.5 |
| Severity text | `color-mix(in oklab, <colour> 75%, var(--color-text))` | The Readable Category Text Rule |

Severity is always a word *and* a colour (`HIGH`, `MEDIUM`), per the Meaning Has Two Channels rule.

## 10. The mock-ups

[`mock/`](mock/) holds the three screens as Design Component files from a Claude Design canvas: [`health.dc.html`](mock/health.dc.html), [`ask.dc.html`](mock/ask.dc.html), [`recent-work.dc.html`](mock/recent-work.dc.html). They show the full app shell on `fixtures/bookstore-app` (dark theme, 1600 px wide), and the drawer tabs link to each other.

For an agent implementing this:

- **Read them for structure, copy and token values.** They do not run here: they load the canvas runtime (`./support.js`) and use its `<x-dc>`, `<sc-for>` and `<sc-if>` tags. Build the real UI in React in `apps/web`, from the existing components (`TopBar.tsx`, `Panel.tsx`, `ChangeTape.tsx`) and Tailwind tokens, not by porting the markup.
- **The data in them is illustrative.** The findings, the Ask answer and the store-credit session are written for the mock-up, not produced by Eyrie. The component names and paths are real files in `fixtures/bookstore-app`.
- **Edges are hand-placed** in an SVG over the lanes. The real map keeps using ELK routing and React Flow.
- The live canvas, to view or comment on: https://claude.ai/artifact/4pHwk9WTEVeXML1strNe8p (private until the owner shares it).

## 11. Open questions

1. ~~Do Health findings go into the Knowledge Loop's findings store …?~~ **Decided: a separate `packages/checks`.** The Knowledge Loop's checks package does not exist in the repo; the rules are pure functions over the architecture graph there, with `Finding` as specified (`id, rule, severity, componentIds, files, evidence, fixPrompt`).
2. ~~Which Meta Model API endpoint and model does Task 3 use …?~~ **Deferred.** Task 3 ships generic `muse` (user's signed-in Muse CLI) and `openai` (any OpenAI-compatible API via `EYRIE_OPENAI_BASE_URL`) backends instead of a Meta-specific one; a Meta Model API endpoint plugs into `openai` unchanged. AI stays off by default (`--ai` / `EYRIE_AI`).
3. ~~Bundled Node or single-executable …?~~ **Decided: single-executable (SEA).** The CLI builds to one file with the grammars and web UI beside it, verified over MCP.
4. ~~Does `ask` belong in the MCP server, or only in the app?~~ **Decided: both.** The MCP `ask` tool and `POST /api/ask` share one loop; the tool description tells agents to prefer the direct tools for single facts.

## 12. Implementation record

- **Task 4 evidence.** `fixtures/unsafe-app` plants one case per rule with a safe variant; `packages/server/test/check.test.ts` runs the real engine on it and asserts every planted case is found and no safe variant is flagged. The planted `hardcoded-secret` literal is materialised at test run time, so no secret-shaped string rests in the repo. False-positive runs: `fixtures/bookstore-app` gives 4 findings, all true positives (unguarded checkout/order routes; the verified Stripe webhook is correctly quiet); a self-scan of Eyrie (226 files) gives 9 findings — the 5 file-level planted cases plus 4 `assigned-secret` shapes inside test scaffolding strings — and nothing in production code. The smoke-repo run is still open.
- **Task 5 evidence.** `packages/server/test/recent.test.ts` scripts an agent session on `bookstore-app` (record intent, edit, end) and asserts the session's changed components equal the net `recent_changes` window, grounded notes are stored `ok` with their model, an invented citation is stored `rejected`, and the session links to its `Co-Authored-By`-attributed commit. One deviation: the Panel's *Changed in session* shows the note and the files, not the mock's `+18 −4 lines` counts (line attribution needs a diff the engine does not keep).
- **Task 3 evidence.** `scripts/ask-eval/` holds 10 scored questions; the question set validates (every answer resolves, 2–6 hops). Live-model scores on `claude`, `codex`, `muse` and `openai` are still open: they need signed-in CLIs outside the sandbox.
