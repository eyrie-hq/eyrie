# 05 — Backend Schema Document

| Field | Value |
| --- | --- |
| Product | Eyrie |
| Owner | Badhan Sen |
| Status | Matches `packages/storage/src/index.ts` at `SCHEMA_VERSION = '1'` and `packages/knowledge/src/store.ts` at `user_version` 1 |
| Last updated | 2026-10-18 |
| Answers | How is data stored, related and accessed? |
| Related | [TRD](../02-technical-requirements/README.md) · [Implementation Plan](../06-implementation-plan/README.md) |

## 1. What data exists — and what deliberately does not

Eyrie stores **no accounts and no content of its own**. Per repository it keeps two local SQLite files:

- `graph.db` — a **disposable** cache of analysis derived from the source. Everything in it can be deleted and rebuilt from the code.
- `knowledge.db` — **durable** project knowledge: the commits Eyrie has recorded (copied from the repository's git history, including author and co-author names and email addresses) and, when the user turned it on, AI notes on them. Commits can be read again from git while the history exists; notes cannot be rebuilt without paying for them again.

| Not stored | Why |
| --- | --- |
| Users, sessions, credentials | There is no account system; the trust boundary is the OS user (see TRD §8) |
| Anything on a server we operate | There is no server; Eyrie stores nothing remotely |
| Telemetry or usage data | No analytics and no usage reporting. The only data that leaves the machine is what the user sends to Anthropic by turning on AI notes (TRD §7) |
| Source code in `knowledge.db` | Commits are stored as messages, paths, line counts and component references, never file contents |

**Durable truth about the code lives in the repository, which Eyrie never writes to.** That is the governing property of `graph.db`. `knowledge.db` is the one store that is a record rather than a cache, and its rules differ accordingly (§3, §7, §9).

## 2. Storage engine and location

| Property | Value |
| --- | --- |
| Engine | SQLite via Node's built-in `node:sqlite` (`DatabaseSync`) — no native module |
| Files | `~/.eyrie/repos/<hash>/graph.db` and `~/.eyrie/repos/<hash>/knowledge.db`, where `<hash>` identifies the repository root (the project folder, which may be a sub-folder of a git work tree) |
| Override | `EYRIE_HOME` relocates the whole store |
| Pragmas | `journal_mode = WAL`, `synchronous = NORMAL` |
| Tests | Opened as `:memory:` |
| Access | `graph.db`: one engine process, single writer. `knowledge.db`: may be opened by more than one process at once (the desktop app's open project and a scan, or an MCP server), so it also sets `busy_timeout = 5000`; inserts are idempotent (`INSERT OR IGNORE` on the commit hash) |

Row shapes are "columns for querying, JSON for fidelity": indexed scalars are promoted to real columns, and the full typed object is kept in a `data` / `facts` TEXT column so nothing is lost to a lossy projection.

## 3. Tables

### `meta` — compatibility knobs

| Column | Type | Notes |
| --- | --- | --- |
| `key` | TEXT | **PK** |
| `value` | TEXT | NOT NULL |

Two keys matter: `schema_version` (table shape) and `facts_version` (parser output shape). See §7. `graph_digest:<repo_id>` holds the SHA-256 of the graph rows the last `replaceGraph` wrote, so a restart with an identical graph skips the rewrite; `applyDiff` deletes it.

### `repositories` — the indexed repository

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT | **PK** — stable repository id |
| `name` | TEXT | NOT NULL — from root `package.json` `name`, else directory basename |
| `root_path` | TEXT | NOT NULL — absolute path on this machine |
| `created_at` | INTEGER | NOT NULL — epoch ms |
| `updated_at` | INTEGER | NOT NULL — epoch ms |

Upserted on every run (`ON CONFLICT(id)` refreshes `name`, `root_path`, `updated_at`). The schema permits several repositories per database; in practice each repository gets its own file.

### `files` — the facts cache

| Column | Type | Notes |
| --- | --- | --- |
| `repo_id` | TEXT | NOT NULL — **PK** part |
| `path` | TEXT | NOT NULL — **PK** part, repo-relative POSIX path |
| `language` | TEXT | From the parsed facts |
| `hash` | TEXT | NOT NULL — content hash; **the cache key** |
| `size` | INTEGER | Bytes |
| `mtime` | INTEGER | Rounded epoch ms |
| `last_parsed` | INTEGER | Epoch ms of the parse that produced `facts` |
| `facts` | TEXT | NOT NULL — JSON `FileFacts` |

**PK `(repo_id, path)`.** This table is why restarts are fast: facts depend only on file content, so a matching `hash` means the parse can be skipped entirely.

### `nodes` — code-graph nodes

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT | NOT NULL — **PK** part; stable hash (see §5) |
| `repo_id` | TEXT | NOT NULL — **PK** part |
| `file` | TEXT | Nullable — defining file; null for repository/external nodes |
| `kind` | TEXT | NOT NULL — `CodeNodeKind` (§4) |
| `name` | TEXT | NOT NULL |
| `qualified_name` | TEXT | NOT NULL |
| `start_line` | INTEGER | Nullable |
| `end_line` | INTEGER | Nullable |
| `data` | TEXT | NOT NULL — JSON `CodeNode` (includes `key`, `exported`, `meta`) |

**PK `(repo_id, id)`** · **INDEX `nodes_file (repo_id, file)`** — the index that makes "re-resolve one file" cheap.

### `edges` — code-graph edges

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT | NOT NULL — **PK** part |
| `repo_id` | TEXT | NOT NULL — **PK** part |
| `source_id` | TEXT | NOT NULL |
| `target_id` | TEXT | NOT NULL |
| `kind` | TEXT | NOT NULL — `CodeEdgeKind` (§4) |
| `confidence` | REAL | NOT NULL — `1` = syntactically certain, lower = heuristic |
| `owner` | TEXT | Nullable — the file whose facts produced this edge; drives invalidation |
| `data` | TEXT | NOT NULL — JSON `CodeEdge` (includes `line`, `meta`) |

**PK `(repo_id, id)`** · **INDEX `edges_source (repo_id, source_id)`** · **INDEX `edges_target (repo_id, target_id)`** — downstream traversal uses the first, upstream (impact) the second.

### `snapshots` — point-in-time markers

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER | **PK AUTOINCREMENT** |
| `repo_id` | TEXT | NOT NULL |
| `commit_hash` | TEXT | Nullable |
| `created_at` | INTEGER | NOT NULL — epoch ms |
| `metadata` | TEXT | Nullable — JSON |

Written by `recordSnapshot()`. This is the forward hook for **Phase 6 (Git intelligence)**: architecture diffs between commits and the timeline view will read from here. It is intentionally thin until that phase defines what a snapshot must contain.

### `knowledge.db`

Owned by `@eyrie/knowledge` (`KnowledgeStore`). Foreign keys on.

#### `commits` — the git history Eyrie has seen

| Column | Type | Notes |
| --- | --- | --- |
| `hash` | TEXT | **PK** — full commit hash |
| `parents` | TEXT | NOT NULL — space-separated hashes |
| `author_name`, `author_email` | TEXT | NOT NULL — as recorded in git |
| `authored_at`, `committed_at` | INTEGER | NOT NULL — epoch ms. Index on `committed_at DESC` |
| `subject` | TEXT | NOT NULL — first line of the message |
| `body` | TEXT | NOT NULL — the rest, trimmed (includes trailers) |
| `agents` | TEXT | NOT NULL — JSON array of coding agents named as author or in `Co-Authored-By` (`Claude`, `Codex`, `Copilot`, `Cursor`, `Gemini`, `Devin`, `Aider`) |
| `files` | TEXT | NOT NULL — JSON `[{ path, added, deleted }]`, relative to the project folder; `null` counts for binary files; merges list their changes against the first parent |
| `components` | TEXT | NOT NULL — JSON `[{ id, label, kind, lane, category }]`: architecture components owning the changed files, **as the graph stood when the commit was recorded** (ids are stable; labels are a snapshot) |
| `recorded_at` | INTEGER | NOT NULL — epoch ms |

Written by `ProjectKnowledge.record()`: the newest 200 commits on HEAD that touched the project folder the first time, then only hashes not yet present. Rewritten history adds the new commits and keeps the old ones.

#### `analyses` — AI notes, append-only

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER | **PK AUTOINCREMENT** |
| `commit_hash` | TEXT | NOT NULL — **FK → `commits.hash`**. Index on `(commit_hash, created_at DESC)` |
| `backend` | TEXT | NOT NULL — `claude-code` or `codex` |
| `model` | TEXT | Nullable — the model the backend reported (`claude-sonnet-5`), or the one requested with `--ai-model`; null when Codex used its default |
| `input_hash` | TEXT | NOT NULL — hash of exactly what was sent, so a note is tied to its input |
| `created_at` | INTEGER | NOT NULL — epoch ms |
| `status` | TEXT | NOT NULL — `ok`, `rejected` (failed validation: it cited a file or component the commit lacks, or was malformed) or `failed` (the request failed; retried up to three times) |
| `note` | TEXT | Nullable — JSON `{ intent, matchesMessage: yes\|partly\|no\|unclear, mismatch?, risk: low\|medium\|high, observations: [{ text, evidence: ["file:…" \| "component:…"] }] }` |
| `error` | TEXT | Nullable — why it failed or was rejected |
| `usage` | TEXT | Nullable — JSON token counts and cost, on the first note of each request |

A note is never a finding, an edge or a rule. Readers show the newest `ok` note, labelled with `backend · model`.

#### `meta`

`key`/`value` TEXT, as in `graph.db`. `last_head` is the HEAD seen by the latest recording.

## 4. Vocabulary (enumerations)

These are string enums in `@eyrie/core`, enforced in TypeScript rather than by SQL constraints.

**`CodeNodeKind`** — `repository`, `folder`, `file`, `class`, `interface`, `type`, `enum`, `function`, `method`, `variable`, `react_component`, `hook`, `api_route`, `middleware`, `database_model`, `queue`, `event`, `background_job`, `external_service`

**`CodeEdgeKind`** — `CONTAINS`, `IMPORTS`, `EXPORTS`, `CALLS`, `USES`, `IMPLEMENTS`, `EXTENDS`, `DEPENDS_ON`, `HTTP_CALL`, `READS_FROM`, `WRITES_TO`, `PUBLISHES`, `SUBSCRIBES`, `TRIGGERS`

**Architecture layer (derived, not persisted):** `ArchKind` (`page`, `component`, `hook`, `middleware`, `api_route`, `server_action`, `service`, `repository`, `module`, `database_model`, `external_service`, `queue`, `background_job`), `ArchCategory` (`frontend`, `api`, `service`, `ai`, `data`, `external`, `infra`, `utility`), `ArchLane` (`ui`, `edge`, `api`, `logic`, `data`, `external`).

**The architecture graph is not stored.** It is derived deterministically from the code graph on every build, so it can never disagree with its source. The two lenses (data flow, sequence) are pure functions computed in the browser.

## 5. Keys and relationships

```text
repositories 1 ──┬─< files      (repo_id, path)
                 ├─< nodes      (repo_id, id) ── file ─► files.path  (soft)
                 ├─< edges      (repo_id, id) ── source_id/target_id ─► nodes.id  (soft)
                 │                            └─ owner ─► files.path (soft)
                 └─< snapshots  (repo_id)
```

- **Node ids are stable content-free hashes** of `repository + file path + symbol kind + qualified name`. Unchanged code keeps its identity across edits, which is what lets the UI animate a diff instead of re-rendering, and what makes layout stable.
- Nodes also carry a readable `key` (`<path>#<kind>:<qualifiedName>`, or a namespaced key for non-file nodes) for debugging and for cross-referencing by other tools.
- **Relationships are not declared as SQL foreign keys.** This is deliberate: an update is applied as a diff within one transaction, and ordering constraints (delete edges before nodes, write nodes before edges) are enforced in `applyDiff()`. Referential integrity is a property of the graph builder, not of the cache.
- `edges.owner` is the invalidation lever: when a file changes, the edges it produced can be found and replaced without touching anyone else's.

## 6. Write paths and consistency

Every mutation runs inside an explicit `BEGIN` / `COMMIT` with `ROLLBACK` on error.

| Operation | Behaviour |
| --- | --- |
| `upsertRepository` | Insert or refresh the repository row |
| `loadFiles` | Load the whole facts cache for a repo into memory as a `Map` |
| `saveFiles(files, removed)` | Upsert parsed files and delete removed paths, in one transaction; no-op when both are empty |
| `replaceGraph` | After a full build. Skipped when the digest of the rows equals `graph_digest:<repo_id>` and the row counts match (a restart of an unchanged repository). Otherwise, when no other repository has rows in the file, the `nodes` and `edges` tables are dropped, recreated, filled with plain inserts and indexed afterwards; with several repositories, the repo's rows are deleted and rewritten |
| `applyDiff` | Incremental: clear the repo's `graph_digest`, delete removed **edges first**, then removed nodes, then upsert added + updated nodes, then edges — so no edge ever references a node that has not been written |
| `recordSnapshot` | Append a snapshot row |
| `counts` | `files` / `nodes` / `edges` counts, surfaced as `stats` on `/api/state`, `hello` and every `batch` |

A crash mid-update leaves the previous committed state intact; the next run re-parses from the facts cache and rebuilds.

## 7. Schema changes and migration

There is no migration ladder, by design — **nothing here is durable truth, so rebuilding is always correct and always cheap relative to writing a migration.**

| Knob | Trigger | Effect |
| --- | --- | --- |
| `SCHEMA_VERSION` (`'1'`) | Table shape changes | `DROP` `repositories`, `files`, `nodes`, `edges`, `snapshots`, then recreate. Full re-index on next run |
| `facts_version` | Parser output shape changes | `DELETE FROM files` only — graph tables survive but every file is re-parsed |

`meta` is created before the version check and is never dropped, so the versions themselves always survive. All DDL is `CREATE TABLE IF NOT EXISTS`, making open-and-migrate idempotent.

**Rule for contributors:** changing any column, table or id-derivation requires bumping `SCHEMA_VERSION`; changing what the parser emits into `FileFacts` requires bumping `facts_version`. Forgetting either leaves users with a silently stale cache — the one genuinely user-visible failure mode this schema has.

**`knowledge.db` is the exception:** it is a record, so it is never dropped. Its migrations are an ordered list in `packages/knowledge/src/store.ts`, applied in order inside a transaction each and tracked in `PRAGMA user_version`. A migration may only add tables, columns or indexes; changing the meaning of an existing column means adding a new one.

## 8. Access control

There is no row-level security, because there is no multi-user surface. Access is controlled at two layers instead:

| Layer | Control |
| --- | --- |
| Filesystem | The database lives under the user's home directory with OS permissions. Only that user's processes can read it |
| Process | One engine owns the file; it is the only writer |
| Network | The API binds `127.0.0.1`, requires the random per-run token, and rejects non-local `Host` headers |
| Read surface | API exposes only derived graph data plus `GET /api/source` for files **already in the index** |
| Write surface | `POST /api/open` is the only mutating endpoint, and it only launches an editor on an indexed path. `GET /api/commits` and the MCP server read `knowledge.db`; only the engine side writes it |

**What is *not* in the index is not reachable.** Scanning honours `.gitignore` and `.eyrieignore`, so `.env` files, keys and build output are never parsed, never stored and never servable. This is enforced in the engine, not in the UI — hiding a control would not be access control.

## 9. Data lifecycle

| Concern | Policy |
| --- | --- |
| Retention | `graph.db`: indefinite but disposable; the cache is an optimisation, never a record. `knowledge.db`: indefinite; there is no pruning yet |
| Deletion | Delete `~/.eyrie/repos/<hash>/` (or the whole `~/.eyrie/`), which removes both files; or delete `knowledge.db` alone to forget recorded commits and notes. No orphaned state remains elsewhere, except notes' inputs already sent to Anthropic or OpenAI, which follow the user's own account terms with them |
| Reset without deleting | `--reset` ignores the cache and re-parses every file |
| Removed files | Dropped from `files` on the next scan; their nodes and edges are removed by the diff |
| Backups | **None taken.** `graph.db` is derivable from the repository. `knowledge.db` is not entirely: losing it loses AI notes (commits are read again from git) |
| Recovery | Delete the database and re-run. Expect a slower first index (parsing is single-threaded), then cached speed |
| Portability | The database contains absolute paths (`repositories.root_path`), so it is machine-local and not meant to be copied between machines |
| Growth | Roughly proportional to parsed file count; `facts` JSON dominates the file size |

## 10. If this ever gains real user data

**It now does, in a limited way, and this section records the decision.** `knowledge.db` holds the names and email addresses of commit authors and co-authors, copied from the repository's git history that the user already has on their machine, and optionally AI notes produced from commit messages and paths sent to Anthropic or OpenAI through the user's own Claude Code or Codex CLI. The entity and field list is in §3 and the lifecycle in §9. Nothing is sent to a server Eyrie operates.

Still open, as this section always required: a fresh pass through [07 — Launch Readiness](../07-launch-readiness/README.md) items 5–8 (data mapping, privacy notice, retention, privacy requests), which were written for "no personal data at all", and a retention rule for `knowledge.db`. Until that pass, the README states exactly what is stored and sent rather than "no personal data".

## Completion checklist

- [x] Stored data, fields and relationships are documented against the implementation.
- [x] Consistency rules (transactions, diff ordering, confidence) are defined.
- [x] Access control is described at every layer, and enforced in the backend.
- [x] Retention, deletion, backup and recovery are addressed.
- [x] Schema-change procedure is explicit (`SCHEMA_VERSION` / `facts_version`).
- [ ] Open: `snapshots.metadata` contents are undefined until Phase 6 specifies them.
