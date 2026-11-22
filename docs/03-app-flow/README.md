# 03 — App Flow Document

| Field | Value |
| --- | --- |
| Product | Eyrie |
| Owner | Badhan Sen |
| Status | Describes implemented flows; planned branches marked |
| Last updated | 2026-10-08 |
| Answers | What happens when a user takes an action? |
| Related | [PRD](../01-product-requirements/README.md) · [TRD](../02-technical-requirements/README.md) · [Design Brief](../04-design-brief/README.md) |

Eyrie has no pages and no navigation in the website sense. It is one screen with lenses and modes. "Flow" here means: entry points, the shape of the single view, what every control does, and what the UI shows while the engine works or fails.

## 1. Entry points

| Entry | Command / action | Lands on |
| --- | --- | --- |
| Primary | `pnpm start -- /path/to/repo` | Builds UI, indexes, opens `http://127.0.0.1:4319/?token=…` |
| Development | `pnpm dev` | Engine on `:4319` (fixture repo, token `dev`) + UI on `:5173`; open `http://localhost:5173/?token=dev` |
| Headless index | `pnpm start -- <repo> --no-open` | Serves without opening a browser |
| One-shot | `pnpm start -- <repo> --no-watch` | Indexes once, no watching |
| Clean rebuild | `pnpm start -- <repo> --reset` | Ignores the cache and re-parses everything |
| Returning user | Reload the tokenised URL | Restores last lens and 2D/3D choice from `localStorage` |

There is no deep-linkable component URL yet. State that survives a reload is limited to lens and view mode.

## 2. Startup flow

```text
CLI invoked with a repo path
├── path missing or not a directory → print error, exit non-zero
├── port busy → error naming --port and --port 0, exit non-zero
└── ok
     ├── pick port (4319, else next free)
     ├── mint random token (unless --token)
     ├── open SQLite at ~/.eyrie/repos/<hash>/graph.db
     │    ├── SCHEMA_VERSION changed → drop and rebuild tables
     │    └── facts_version changed  → clear the file cache
     ├── scan repo (honour .gitignore + .eyrieignore)
     ├── load project config (tsconfig/jsconfig paths, workspaces, frameworks)
     ├── parse files  ── cache hit → reuse facts ──┐
     │                  cache miss → tree-sitter ──┤
     ├── build code graph ◄────────────────────────┘
     ├── derive architecture graph
     ├── serve UI + API, broadcast status: indexing → ready
     └── unless --no-watch: start chokidar
```

### Browser connection flow

```text
Browser opens /?token=…
├── Host not local                → 403 Forbidden host
├── token missing or wrong        → 401 on /api/*; WebSocket upgrade refused
└── token valid
     ├── GET /api/state  → repo, stats, seq, architecture
     ├── WebSocket opens → `hello` (seq, repo, stats, architecture)
     ├── engine still indexing → `status: indexing` → show indexing state
     ├── engine failed         → `status: error` + message → show error state
     └── `status: ready`       → render the map
```

**Reconnection:** if the socket drops and reopens, `hello` carries the current `seq`. A gap against the client's last `seq` means batches were missed, so the client refetches `/api/state` rather than applying a partial diff.

## 3. The single screen

```text
┌──────────────────────────────────────────────────────────────┐
│ TopBar: repo name · lens 1–4 · search ⌘K · filters · fit F   │
├──────────────────────────────────────────────┬───────────────┤
│ Lane ruler:  UI │ Edge │ API │ Logic │ Data  │               │
│                                              │   Details     │
│              Map (2D) or City (3D)           │   panel       │
│                                              │  (on select)  │
├──────────────────────────────────────────────┴───────────────┤
│ Change tape: one tick per save                               │
└──────────────────────────────────────────────────────────────┘
```

## 4. Controls, actions and destinations

### Keyboard

| Key | Action |
| --- | --- |
| `1` / `2` / `3` / `4` | System / Architecture / Data flow / Sequence lens |
| `V` | Toggle 2D ↔ 3D |
| `F` | Fit the graph to the viewport |
| `⌘K` or `/` | Open search (`/` ignored while typing in a field) |
| `Enter` (in search) | Select the first result |
| `Esc` | Close search; otherwise clear the selection |
| `Q` / `E` | Rotate (3D) |
| `T` | Top-down plan (3D) |
| `R` | Reset camera (3D) |

### Pointer

| Action | Result |
| --- | --- |
| Drag | Pan (2D and 3D) |
| Scroll / pinch | Zoom |
| Right-drag or `⌥`-drag | Orbit (3D) |
| Click a node | Select → open details panel |
| Click empty canvas / `Esc` | Clear selection |
| Hover a change-tape tick | Highlight what that save touched |
| Click a change-tape tick | Jump to that change |
| Click a lane-ruler dot | Reveal an off-screen change |
| Click a category filter | Show/hide that category |
| Click a source ref / sequence message | `POST /api/open` → editor at that line |

## 5. Primary journeys

### A. Understand an unfamiliar repository

```text
Start engine → map renders (System lens on a first visit)
├── read the parts: each app's UI, API, services and data, external services
├── select a box → what it holds; click a component → Architecture lens (2)
├── read lane ruler: UI → Edge → API → Logic → Data → External
├── read colour: blue frontend, green API, orange service, purple AI,
│                cyan data, yellow external, grey utility, red broken
├── click a component → details panel
│    ├── purpose (doc comment or derived)
│    ├── source location + code preview → Open in editor
│    ├── Calls / Used by → click to walk the graph
│    └── Symbols inside
├── Architecture: enable Show only highlighted in the toolbar
│    └── select another component or open an Ask answer or step → the map and lane counts update
└── press 3 (Sequence) → pick an entry point → read the call order,
     click any message to open the exact line
```

### B. Decide whether a change is safe

```text
Select the component you are about to change
├── "Depends on"  → animated downstream trace: everything it reaches
└── "Impact"      → upstream consumers, grouped: API · UI · services · data · external
     ├── empty      → nothing depends on it
     └── non-empty  → review each group, open the files that matter
```

### C. Watch a change land (human or agent)

```text
Edit and save a file in the watched repo
├── chokidar fires → engine re-resolves that file
│    └── exported surface changed → also re-resolve files that consulted it
├── diff computed → `batch` broadcast
└── UI animates
     ├── new component      → green halo + `+` badge   (3D: block drops in, bounces)
     ├── edited component   → yellow `~` + pulse       (3D: height bounces)
     ├── removed component  → red `−`                  (3D: block sinks)
     ├── change off-screen  → coloured dot on the lane ruler
     ├── layout unchanged for existing components
     └── change tape gains a tick (height = size, colour = type)
```

### D. Find a specific component

```text
⌘K (or /) → type a name or path
├── results → Enter or click → component selected and revealed
├── no results → empty state, refine the query
└── Esc → close search, selection unchanged
```

### E. Trust the data-flow picture

```text
Press 2 (Data flow)
├── graph keeps only components that store, read, write or ship data,
│    plus those on a path from an entry point to one that does
└── edges colour-coded by what they carry
     ├── orange  write
     ├── cyan    read — drawn pointing OUT of the store, so arrows follow the data
     ├── dashed  transfer: the call leaves the process
     └── faint   carry: in-process hand-off
```

## 6. Decision points

| Decision | Branches |
| --- | --- |
| Token present and valid? | Render ↔ `401` / refused upgrade |
| `Host` local? | Serve ↔ `403 Forbidden host` |
| Cache valid for this file hash? | Reuse facts ↔ re-parse |
| Exported surface changed? | Invalidate dependents ↔ re-resolve this file only |
| Batch very large? | Send architecture diff with `truncated: true` ↔ send full code-level events |
| Frontend `fetch('/api/x')` matches a route? | Normal edge ↔ node drawn red (`broken`) |
| Component is presentational / a hook / an SDK wrapper? | Hidden, edge passes through ↔ shown as a component |
| Helper used by many components, or on a dependency path in a library-style repo? | Shown ↔ lifted away |
| Editor found on `PATH` or `EYRIE_EDITOR` set? | Launch ↔ `501`, UI reports no editor |
| Lens = sequence and selection has outgoing edges? | That component becomes the sequence entry point ↔ keep current entry |
| Switching to the System lens with a component selected? | Its box is selected instead ↔ leaving the System lens clears a selected box |

## 7. Interface states

| State | Shown when | What the user sees |
| --- | --- | --- |
| Indexing | `status: indexing` (first run, or `--reset`) | Indexing indicator; map fills in when ready |
| Ready | `status: ready` | The map |
| Empty graph | Repo indexed but nothing classified | Map area with nothing to draw — expected for a non-TS/JS or unconventional repo |
| No search results | Query matches nothing | Empty result list |
| No impact | Component has no upstream consumers | Empty Impact group |
| Broken route | `fetch` to a path no route serves | Node rendered red |
| Engine error | `status: error` with message | Error state carrying the engine's message |
| Disconnected | WebSocket closed | Map stays on screen (last known graph) and stops updating |
| Editor unavailable | `/api/open` → `501` | Open-in-editor reports failure; code preview still available in the panel |
| Source unavailable | File not in the index → `404` | No preview; nothing outside the index is ever served |

## 8. Recovery paths

| Failure | Recovery |
| --- | --- |
| Wrong/missing token | Reopen the URL printed by the CLI, which carries the token |
| Port already in use | Restart with `--port <n>` or `--port 0` |
| Stale or corrupt cache | `--reset`, or delete `~/.eyrie/repos/<hash>/` |
| Map looks wrong after many edits | Reload the page — the client refetches `/api/state` |
| Socket dropped | Reconnect sends `hello`; a `seq` gap triggers a full refetch |
| Component description unhelpful | Add a doc comment to the component's main export |
| Component misclassified | Known limitation: classification is heuristic and tuned for Next.js/Node.js. Record the case; rules may become configurable |
| No editor opens | Set `EYRIE_EDITOR`, or install one of `cursor`, `code`, `windsurf`, `zed` on `PATH` |

## Completion checklist

- [x] Every important task has an end-to-end journey.
- [x] Controls, actions and destinations are listed.
- [x] Error, empty and success states are included.
- [x] Journeys match the features in the PRD.
- [ ] Open: deep-linkable selection (share a URL that opens one component) is not implemented.
