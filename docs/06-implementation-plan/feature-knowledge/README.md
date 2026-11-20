# 06·K — Architecture Knowledge Loop

| Field | Value |
| --- | --- |
| Product | Eyrie |
| Owner | Badhan Sen |
| Status | **Partly built.** The System lens, a review prototype (`pnpm arch`), the product's `knowledge.db` with recorded commits and optional AI commit notes, and an MCP server for coding agents exist. The loop itself — policies, findings in the product, adaptation, AI explanations of findings — is proposed |
| Last updated | 2026-10-18 |
| Answers | How does Eyrie keep an architecture honest while the code changes, and show a developer what matters? |
| Replaces | The original AI-features proposal (a PDF, kept with the research material outside this repository), its review, and a separate build plan — all folded in here |
| Related | [PRD](../../01-product-requirements/README.md) · [TRD](../../02-technical-requirements/README.md) · [Backend Schema](../../05-backend-schema/README.md) · [Implementation Plan](../README.md) · [PRODUCT.md](../../../PRODUCT.md) · [`pnpm arch`](../../../scripts/arch-review/README.md) |

## 1. Summary

The original proposal asked for three AI features: component summaries, an impact-analysis chat and an architecture review agent. Checked against the code and the research, the stronger version is a **feedback-adaptive architecture watcher**:

1. Eyrie already keeps a live model of the code.
2. The team states the **intended** architecture as explicit rules in a small file in the repository.
3. After every save, deterministic checks compare the two and record **findings**, with exact evidence.
4. Optional AI explains findings from that evidence. It never decides what counts as a violation.
5. A person confirms, fixes, or marks a finding as an intended exception. An exception becomes a narrow, reviewed policy change that cannot hide a known violation.

What improves over time is the relevance of the guidance, at preserved detection. The code improves when a person acts on it.

## 2. What is built

| Piece | Where | State |
| --- | --- | --- |
| **System lens** — the whiteboard view: one box per app or package and per layer, external services and missing routes as their own boxes, labelled links. Key `4` | [`packages/lens/src/system.ts`](../../../packages/lens/src/system.ts), web app | Shipped |
| **Review prototype** — 13 deterministic checks, a durable SQLite store (`.eyrie/knowledge.db`) with finding history, and a protocol for people and AI agents to add issues, proposals and reviews with `path:line` evidence. Triage and decisions are human-only | [`scripts/arch-review/`](../../../scripts/arch-review/README.md) | Developer tool, outside the product packages |
| **Route scoping fix** — a relative `fetch('/api/…')` inside one Next.js app no longer links to a sibling app's route | `packages/graph/src/code-graph.ts` (`matchRoute`) | Shipped, with a regression test |
| **Commit history** — on every open and scan, and whenever HEAD moves while a project is open, the commits not yet recorded go into a durable, add-only `knowledge.db`, each mapped onto the architecture components its files belong to, with coding agents read from `Co-Authored-By` | [`packages/knowledge`](../../../packages/knowledge/src/knowledge.ts) | Shipped: CLI, desktop open and scan, MCP |
| **AI commit notes** — the first AI role, opt-in per project: intent, whether the change matches its message, risk, and up to three observations, each citing a file or component of that commit or the note is stored `rejected`. A note is an annotation, never a finding. The first answer the explainer role (§9) can build on | [`packages/knowledge/src/analysis.ts`](../../../packages/knowledge/src/analysis.ts) | Shipped; Claude Code CLI and Codex CLI (macOS) backends |
| **Trace, impact and paths outside the browser** — moved from the web app into `@eyrie/lens` (prerequisite noted below) | [`packages/lens/src/focus.ts`](../../../packages/lens/src/focus.ts) | Shipped |
| **MCP server** — `eyrie mcp`: read-only tools over the live graph for coding agents, including `components_for_files` before an edit and `recent_changes` after it; the first half of the guardrail in §16 | [`packages/server/src/mcp.ts`](../../../packages/server/src/mcp.ts) | Shipped (stdio; not yet in the packaged desktop app) |

**First self-review of Eyrie** (`pnpm arch scan` at `3cfaad8`): no package or file cycles; nothing reachable from the browser bundle imports a Node built-in; 4 warnings and 38 informational findings. The ones that matter for this feature:

- Import edges between two files are merged into one, keeping only the first statement's line and type-only flag, so a later runtime import can be hidden. **Open.**
- Trace and impact exist only in the browser; the engine cannot answer "what does this affect". Prerequisite for build step 7. **Resolved 2026-10-18:** both live in `@eyrie/lens`, used by the UI and the MCP server.
- Change history lives only in browser memory (last 240 batches).
- `@eyrie/core` and `@eyrie/storage` have no tests of their own; storage holds the cache-invalidation logic.

The full record lives in the local database; `pnpm arch report` regenerates it.

## 3. What "improvement" means

It does **not** mean an agent that rewrites the codebase. That is code authoring, it contradicts "Eyrie reads; your editor writes" in [PRODUCT.md](../../../PRODUCT.md), and the self-improving-agent research that does it depends on sandboxes and benchmark-validated changes.

It **does** mean one testable property: **more relevant guidance without losing real violations.**

| Measure | How |
| --- | --- |
| Relevance | Findings judged relevant ÷ findings shown |
| Detection | Recall against independently labelled violations, including seeded ones |
| The failure that matters | A labelled true violation hidden by a policy change. Counted as a miss, never as noise reduction |
| Repair vs. suppression | Reported separately. Relaxing a rule is not fixing the code |
| Effort | Verdicts and approvals per accepted policy change |

## 4. Research base and prior art

| Work | What we take |
| --- | --- |
| Murphy, Notkin, Sullivan — *Software Reflexion Models*, IEEE TSE 2001 | The comparison of an intended model with extracted dependencies: convergences, divergences, absences |
| Koschke, Simon — *Hierarchical Reflexion Models*, WCRE 2003; Knodel, Popescu — WICSA 2007 | Nested components; how reflexion compares with rule-based conformance checking |
| Terra, Valente — *Dependency Constraint Language*, SPE 2009 | The rule forms in §6: *cannot*, *can only*, *only … can*, *must* |
| Buckley et al. — *JITTAC*, ICSE 2013 | Real-time reflexion in the IDE: continuous checking is prior art |
| ArchUnit freezing rules; dependency-cruiser `--baseline`; Nx module boundaries | Baselines and JS/TS dependency rules are prior art; exceptions are edited by hand, with no view of what else they hide |
| Sadowski et al. — *Tricorder*, ICSE 2015 | Developer feedback tunes analysis. Here feedback tunes a project's **policy**, not the analyzer |
| Kephart, Chess 2003; Blair et al. — *Models@run.time* 2009; Li et al. — *GenAI for Self-Adaptive Systems*, TAAS 2024 | The loop shape (monitor, analyse, plan, execute, knowledge), a live model, and a person on the loop |
| Fontana et al. — *Arcan*, 2017 | Smells with data-driven thresholds |
| Jansen, Bosch — WICSA 2005; Dhar et al. — ICSA 2024 | Decisions as records; LLM-drafted decisions need review |
| Li, Liang, Avgeriou, Wang — arXiv 2023–2026 | Showing detected violation symptoms raised developers' detection from 25.9% to 64.7% |
| De Luca et al. — *CIAO*, ICSA 2026; Zhang et al. — *SemRef*, 2026; Keim, Kaplan — ICSE-Companion 2026 | Structure from analysis, prose from models; automated architectural knowledge management |
| Archify | A readable high-level diagram; Eyrie's System lens derives the same level from code instead of authoring it |

**Positioning.** Checking, baselines and real-time reflexion exist. What is new here is the **adaptation protocol** (§8) and its evaluation: turning one adjudicated finding into the narrowest policy change, showing its collateral, and refusing changes that hide known violations.

## 5. The loop

```
                 ┌──────────────────────── Knowledge ─────────────────────┐
                 │ repo: .eyrie/architecture.yml (policy), decisions        │
                 │ local: knowledge.db (findings, history, feedback, jobs)  │
                 └───────▲───────────────▲──────────────▲──────────────────┘
                         │               │              │
 file saved ──▶ MONITOR ─┴──▶ ANALYZE ───┴──▶ EXPLAIN ──┴──▶ DECIDE ──▶ ADAPT ─┐
                watcher,      deterministic   optional,      a person:    candidate,
                graph diff    checks, every   budgeted,      fix, confirm preview, gate,
                (exists)      save            evidence-only  or exception approve
                 ▲                                                            │
                 └────────────── next save is checked against ◀──────────────┘
                                 the approved policy version
```

**Hard rules**, inherited from the Phase 5 gate in [docs/06](../README.md):

1. **Findings are deterministic.** Only checks create findings. AI explains and may draft wording; it never creates a finding, an edge or a rule.
2. **AI off is a complete product.** A budget limit defers explanations, never findings.
3. **Unknown is not conformance.** Where resolution coverage is incomplete for a rule, its status is `unknown`.
4. **Nothing writes to user source.** Accepted policy is stored as versions; whether it is also written to `.eyrie/` in the repository is open decision 2.

## 6. Policy: the intended architecture

### 6.1 File

Explicit rules, versioned with the code and reviewed in pull requests. The grammar is illustrative:

```yaml
# .eyrie/architecture.yml
version: 1
modules:
  orders:   { paths: ["src/app/orders/**", "src/services/order*"] }
  payments: { paths: ["src/services/*payment*"] }

rules:
  - id: payments-through-gateway
    cannot: { from: { module: orders }, to: { external: Stripe } }
    because: ADR-0007
  - id: ui-reads-through-api
    cannot: { from: { lane: ui }, to: { lane: data } }
    except:
      - { from: { kind: page, serverOnly: true }, because: ADR-0003 }
  - id: orders-use-payments
    must: { from: { module: orders }, to: { module: payments } }
```

### 6.2 Semantics

| Form | Meaning | Finding |
| --- | --- | --- |
| `cannot(X, Y)` | Nothing matching X depends on Y | Divergence, per offending link |
| `only(X, Y)` | X depends only on Y | Divergence, per offending link |
| `only-from(X, Y)` | Only X may depend on Y | Divergence, per offending link |
| `must(X, Y)` | Every X depends on some Y | Absence — only when coverage for X is complete, otherwise `unknown` |

- **Selectors:** module (path globs), lane, kind, single component, fact predicates such as `serverOnly`. **Dependency kinds** are explicit per rule (import, call, HTTP, read/write). **Direct** dependencies only, at first.
- **Unmapped files** are a coverage gap, never a violation. **Overlapping modules** are rejected when the policy loads.
- **Exceptions narrow exactly one rule** (`rule ∧ ¬scope`), carry a reason and decision link, and may expire; on expiry the affected findings return as `reopened`. They cannot widen another rule, so precedence is never ambiguous.

### 6.3 Starting without noise

On the ~290-file smoke repository (`next-prisma-tailwind-ecommerce` at `3f21c75`, Eyrie at `3cfaad8`, counted mechanically), naive rules would report **26** "UI reads the data layer" findings — all Next.js server pages — and **61** components with no callers, **43** of them entry points. So:

- **Baseline** what fails on day one, as ArchUnit and dependency-cruiser do. Baselining changes presentation, never the truth of a finding.
- **Inferred rules are suggestions, labelled as observations of today's code**, and need an owner's confirmation. Accepting the current graph wholesale would normalise existing erosion.

## 7. Findings

A finding is identified by `hash(rule id, form, subject identities)` — never by line numbers or evidence — so it keeps its identity across edits and restarts. Four attributes stay independent:

| Attribute | Values |
| --- | --- |
| Observation | `present`, `absent`, `unknown` |
| Triage | `untriaged`, `confirmed`, `intended`, `mapping-wrong`, `detector-wrong` |
| Baseline | member or not |
| Lifecycle | append-only events: `observed`, `resolved-by-source`, `suppressed-by-policy(v)`, `reopened`, `retired-by-check-change` |

Every record carries project, checkout and snapshot identity, analyzer version and policy version. A dismissal never deletes a finding; a suppression is never a repair; a finding that disappears because the check logic changed is *retired*, not *resolved*. Hubs and apparently unreferenced code are review candidates, not violations: framework conventions and dynamic loading produce those shapes legitimately.

## 8. Adaptation protocol

Only one kind of feedback relaxes policy:

| Verdict | Response |
| --- | --- |
| `confirmed` | Stays; may be linked to a decision |
| `intended` | Generates a candidate exception |
| `mapping-wrong` | Proposes a mapping edit, reviewed separately |
| `detector-wrong` | Records an analyzer defect; never handled by policy |

1. Pin the finding, its evidence, the policy and decision versions.
2. Record the verdict and a reason. No reason, no generalised exception.
3. **Generate the narrowest candidate.** For a witness `a → b` under rule `r`, candidates widen in steps: L0 the exact files; L1 the two components; L2 a fact predicate shared by the selected sources, intersected with the rule's selector (e.g. `kind = page ∧ serverOnly`); L3 the two modules. Never above L3, never "disable the rule". A model may phrase the rationale; it does not choose the level.
4. **Preview the collateral**: every currently present finding the candidate would also suppress, each to be acknowledged or the candidate narrowed.
5. **Gate it** on a locked regression set of labelled findings: reject if it suppresses any true violation. The set grows with every `confirmed` verdict and with seeded violations, and is never used to generate candidates.
6. **An owner approves**; a new policy version activates with reason, scope, gate report and optional expiry.
7. **Roll back** to the predecessor if a later confirmed violation was hidden.

On the smoke repository, an L2 candidate `kind = page ∧ serverOnly` covers the 26 UI-reads-data findings with empty collateral, and the rule keeps reporting any other UI component that reads the data layer.

## 9. Roles

One runner, one queue; roles coordinate through the database rather than by talking to each other.

| Role | Kind | Does |
| --- | --- | --- |
| Change classifier | Deterministic | Marks what in a batch is architecturally significant |
| Policy checker | Deterministic | Evaluates §6 rules |
| Smell checks | Deterministic | Cycles (strongly connected components), data-driven hubs, unreferenced code from code-level imports, missing routes |
| Explainer | AI, optional | Explains a finding from its evidence and linked decisions — the **only AI role in the first prototype** |
| Later | AI, optional | Summaries for thin components, decision drafting (always needs acceptance), digests, Q&A over deterministic queries |

A finding can produce a **hand-off brief** (evidence, decision, impact) for the developer's own coding agent. Eyrie never runs a write-capable agent.

## 10. AI integration

**Backends**, behind one interface (`run({ system, prompt, schema, timeoutMs, signal }) → { json, model, usage }`, `AiBackend` in `packages/knowledge/src/analysis.ts`). The plan was an HTTP API first, because it is tool-free; **decided 2026-10-18: the Claude Code CLI first**, because it needs no API key held by Eyrie and uses the account the user already has. It runs as `claude --print --output-format json --json-schema … --system-prompt … --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources local --no-session-persistence --disable-slash-commands`, with the prompt on stdin, in an empty temporary folder, without the parent's `CLAUDECODE` variables — so no tools, MCP servers, user or project settings (no hooks or plugins), saved session or project files. Verified with Claude Code 2.1.267.

**Codex, added 2026-10-18 (macOS only).** Checked against Codex 0.160 before building it: `--sandbox read-only` blocks writes but lets commands read any file the user can (`~/.ssh`, Codex's own login, `~/Documents`), and the command tool cannot be removed (`--disable unified_exec` has no effect; disabling `multi_agent` leaves the collaboration tools). Without more, an instruction hidden in a commit message could have a private file read and sent to OpenAI. So `codex exec` runs with its own lock-down flags (read-only, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, approvals never, web search off, the features that add connectors, plugins, skills, browser and computer use, sub-agents and images disabled; this cut the tool list from 159 to 12) **inside an OS sandbox**: `sandbox-exec` with a profile that denies `file-write*` everywhere except a fresh workspace (holding the schema and a copy of Codex's login, copied back if Codex refreshes it) and `/dev`, and denies `file-read-data` under the home folder, the per-user temp folder and `/Volumes` outside that workspace. Three layers then stop a model acting on the machine: with `code_mode_host` disabled, Codex's exec and patch tools fail ("code-mode host is disabled"); Codex's command sandbox cannot start inside the OS sandbox (`sandbox_apply: Operation not permitted`); and the OS sandbox holds on its own — tested with Codex's sandbox set to `danger-full-access` and its tools re-enabled, `apply_patch` and shell writes succeeded only inside the workspace (outside: "Failed to write file", "operation not permitted") and listing `~/.ssh` was refused. A run whose events show a completed command is discarded anyway. Residual exposure: file metadata everywhere, and the contents of system files outside the home folder (`/etc/hosts`), are readable to the Codex process itself, with no tool left that could read them. Codex needs a strict schema (closed objects, every property required), so optional fields are sent as nullable. This is the isolation §10 asked of every CLI backend, enforced by the OS. Other operating systems need their own sandbox before Codex is offered there.

**Codex on Windows.** The per-question Ask picker can use the native Codex CLI inside MXC. Eyrie gives the CLI a scratch directory and a dedicated ChatGPT login under `%LOCALAPPDATA%\Eyrie\codex-ask`. The proxy allows ChatGPT and OpenAI authentication traffic. MXC also allows host loopback with the proxy enabled, so Eyrie disables native tools and runs the CLI's own commands in a read-only sandbox. Answers with native tool events are discarded. Windows startup defaults and commit or session notes use the existing backend selection.

An HTTP API and Antigravity (`agy -p … --json-schema`; its headless mode can write files in its folder) follow behind the same interface, each verified per version at build time. Antigravity's headless mode allows writing files in its working folder, and an open issue reports `agy -p` hanging without a TTY.

**Isolation.** A scratch working directory is not a sandbox: a process can still use absolute paths or spawn others. CLI backends run only with OS-enforced read-only or sandbox modes, and are tested for outside writes, absolute-path reads, subprocesses, cancellation and instructions hidden in repository text. Repository text is data in prompts, never instructions.

**Inference gate**, in order: a template answer from the evidence (zero tokens) → a cached explanation whose full dependency manifest is unchanged (zero new tokens) → one bounded call, when requested or for a significant finding after a quiet period → deferral, with evidence still shown. Mandatory evidence (the witness, the rule, the decision's scope and version) is never truncated; if it does not fit, the explanation waits. Agent CLIs add a large fixed overhead per call — Antigravity's own documentation shows about 10k input tokens for a one-sentence answer — so their usage is reported separately from the evidence budget.

**Validation.** Schema-valid; factual claims cite evidence IDs; names and numbers match the packet; advice is labelled as advice; a result is published only if its inputs did not change since it was requested.

**Privacy.** Off by default and per project; the UI names the backend and model wherever AI output appears; packets hold names, paths, signatures, doc comments and graph relationships, not whole files. Shipping any backend requires rewording the README privacy section and the PRD scope, and a pass through [docs/05 §10](../../05-backend-schema/README.md).

## 11. Storage and identity

| Store | Lifetime | Holds |
| --- | --- | --- |
| `graph.db` (exists) | **Disposable cache**; a `SCHEMA_VERSION` bump drops it | Parse facts, code graph |
| `knowledge.db` | **Durable**; versioned migrations that only add (`PRAGMA user_version`) | Built: recorded commits and AI commit notes, at `~/.eyrie/repos/<hash>/knowledge.db` next to `graph.db` ([docs/05](../../05-backend-schema/README.md)). Planned: runs, findings and their observations and events, feedback, policy versions, decisions, explanations, jobs, trends. The `pnpm arch` prototype keeps its own database in the repository's `.eyrie/` until it moves in |
| `.eyrie/` in the repo | Versioned with the code | Policy file, accepted decisions, baseline (open decision 1) |

The prototype's store ([`scripts/arch-review/db.ts`](../../../scripts/arch-review/db.ts)) already implements runs, fingerprinted findings with per-run observations, append-only events, issues, proposals, reviews and decisions, with observation and triage kept separate. Moving it into a `@eyrie/knowledge` package is the first build step.

**Identity.** A logical project id (explicit, local) plus a checkout id, so concurrent checkouts never share mutable state; a snapshot id from a content manifest, because a commit hash does not identify an uncommitted working tree. A git root commit is not enough: forks share it and shallow clones may lack it. Entities keep immutable ids with versioned path aliases; a rename inferred from identical content applies going forward, ambiguous moves go to a person, and historical evidence keeps the path it was observed at.

**Retention.** Change history 30 days; finished jobs 7 days; superseded explanations pruned to three per target. Deleting the project's data folder removes everything. No telemetry.

**External memory** ([TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)) is an optional sink and source, never a requirement: export accepted decisions and per-module architecture pages; import decisions as *proposed*. Its own code graph is not used — Eyrie's graph stays the only structural source of truth — and its agent proxy is never required.

## 12. Desktop app (Phase D)

An Electron app ([`apps/desktop`](../../../apps/desktop/README.md), built with Electron Forge) running the engine in a utility process per watched project (loopback, random port, per-run token, as today), watching in the background from the tray. Notifications are off by default and, when on, limited to new, non-baseline, warning-or-worse findings after a quiet period. GUI apps on macOS get a minimal `PATH`, so the login shell's `PATH` is read once (the first version does this) and explicit binary paths are allowed. API keys live in the OS keychain only. `node:sqlite` needs Node 22.13+; Electron 44 runs Node 24, so no separate Node ships with the app. A signed binary is gated by the AGPL-3.0 / `elkjs` licensing review in [docs/06 §5](../README.md).

## 13. UI surfaces

- **System lens** (shipped): boxes by app or package and layer, labelled links, a details panel listing what each box holds with a way down to every component; search, marks and the change tape roll up to boxes. **Next:** nested group boundaries drawn as boxes around boxes, expanding a box in place, and the written overlay (names, owners, link labels) checked against the code.
- **Findings** (planned): a panel, new first, with evidence, explanation and actions (*Confirm*, *Intended — with reason*, *Mapping wrong*, *Detector wrong*, *Hand off*); badges on components and boxes that are part of their accessible name; divergences drawn with a dash pattern **and** a glyph, never colour alone; markers on the change tape where findings appear or resolve; a loop-health view (relevance, suppressed violations, explanation rejection rate).

## 14. Today and needed

| Need | Today | Gap |
| --- | --- | --- |
| Live model of the code | ✅ Incremental graph and diffs | Import-edge merging hides later runtime imports (§2) |
| High-level view | ✅ System lens | Nested boundaries, expand in place, written overlay |
| Deterministic checks | ✅ 13 checks in the prototype | Policy checker for §6 rules |
| Durable findings with history | ✅ Prototype store | Move into the product as `@eyrie/knowledge`; project/checkout identity |
| Trace and impact | ✅ Shared in `@eyrie/lens`, used by the UI and the MCP server | Code-level impact |
| Change history | Browser memory, 240 batches | Server-side record |
| Feedback, adaptation | Prototype records triage and decisions | Candidate generation, preview, gate, versioned policy |
| AI explanations | ✅ Commit notes: one backend (Claude Code CLI), validation against the commit's evidence, per-input hashes, retries | Explanations of findings; inference gate and caching by dependency manifest |
| Agent access | ✅ MCP server, read-only | A `check` tool and agent hooks that return new findings to the agent (§16) |
| Desktop shell | First version: one window, one project, engine in a utility process; packages on macOS | Tray, background watching, several projects, signing |

## 15. Build order

Each step has a completion condition, as in [docs/06](../README.md).

| Step | Deliverable | Done when |
| --- | --- | --- |
| 1 | **Durable findings and history** in the product: `@eyrie/knowledge` with migrations, project/checkout/snapshot identity; the existing missing-route signal as the first finding kind; read-only, token-protected findings endpoints; a basic findings list | A missing-route finding survives restart, resolves when the handler is added, reopens when it is removed — with one identity throughout; unknown coverage never resolves a finding; two checkouts do not share state |
| 2 | **Explicit constraints**: one `cannot` rule between explicitly mapped modules | The rule produces a finding with source evidence and policy version; removing the dependency resolves it |
| 3 | **Findings panel and baseline** | Evidence opens the source; baseline, lifecycle and verdict are separate and existing problems stay inspectable |
| 4 | **Feedback and linked decisions** | Verdicts and reasons persist; accepted decision versions link to components; dismissal never implies resolution |
| 5 | **Scoped exception proposals** (§8) | An `intended` finding produces a narrow template candidate; the preview lists collateral; the gate and approval precede activation; rollback restores the previous version |
| 6 | **Replay and measurement** | Fixed and adaptive policies run over identical pinned snapshots; reports separate repairs, suppressions, relevance, recall and effort |
| 7 | **Inference gate and cached explanations** | Templates and valid caches avoid calls; mandatory evidence is kept whole; full-request accounting and freshness checks work before any model is called |
| 8 | **One optional explainer** | AI off stays complete; failures leave evidence visible; unsupported claims are rejected; total usage includes retries |

**First demonstration** (the milestone that proves the loop): a pinned fixture with an Orders-to-provider `cannot` rule → introduce the import and see the finding with evidence → restart and see the history → record a justified migration exception and preview its scope → approve it and confirm a prohibited import elsewhere is still reported → roll back and see the original finding return.

**Deferred** until the loop works: the desktop shell, several AI backends, digests, broad Q&A, external memory. They widen the product without testing whether adaptation helps.

## 16. The agent guardrail

The direction this loop serves for coding agents: **let a coding agent move fast without quietly breaking a codebase's architecture.** A guardrail speaks at the three moments an agent can still act on it, and deterministic checks decide; AI only explains.

| Moment | How | State |
| --- | --- | --- |
| Before an edit | The agent asks over MCP what the files belong to (`components_for_files`) and what depends on them (`impact`) | Shipped |
| After each save | The engine re-indexes in milliseconds; the agent sees what moved (`recent_changes`). Next: a `check` tool and a Claude Code hook that hands a new violation straight back to the agent | Partly shipped |
| At commit and pull request | Every commit is recorded with the components it touched and the agent that co-authored it; an optional note flags a commit whose changes do not match its message. Next: `eyrie check main..HEAD`, failing only on new, non-baseline findings | Partly shipped |

Without rules (§6) the guardrail can report cycles, hubs and mismatches, but cannot know what "breaking" means for a codebase; baseline and suggested rules are what make the first run useful.

## 17. Risks

| Risk | Mitigation |
| --- | --- |
| Noisy first run switches the loop off | Explicit rules, baseline, inferred rules only as suggestions (§6.3) |
| Adaptation hides real violations | Narrowest candidate, collateral preview, regression gate, rollback (§8) |
| AI states what the graph cannot know | Findings deterministic; evidence IDs; claims about runtime order or values out of scope |
| An agent CLI writes into the repository | Tool-free adapter first; CLIs only under OS-enforced read-only modes, tested |
| Knowledge from one branch or checkout leaks into another | Project, checkout and snapshot identity on every record (§11) |
| Renames orphan history | Immutable ids with path aliases; ambiguous moves reviewed |
| Scope creep into code review | Findings stay structural: dependencies, layers, cycles, coupling |
| Privacy claims drift | Off by default; README, PRD and docs/05 §10 updated in the same change that ships a backend |

## 18. Open decisions

1. **Where policy, decisions and baseline live**: in the repository under `.eyrie/` (shared, per branch, reviewed in PRs) or only on the machine. Eyrie's own `.gitignore` ignores `.eyrie/` today.
2. **May Eyrie write `.eyrie/*` on an explicit Accept?** A narrow exception to "Eyrie reads; your editor writes" — or Eyrie shows the content and the developer saves it.
3. **First AI backend and default state.** Decided 2026-10-18: the Claude Code CLI, then the Codex CLI inside a macOS sandbox, both locked down as in §10; off by default, on per project after the user is told what is sent.
4. **Desktop notifications**: on, off, or off by default.
5. **Distribution**: does the desktop app become primary (blocking decision 4 in [docs/06](../README.md))?

## References

- Murphy, Notkin, Sullivan. *Software Reflexion Models.* IEEE TSE 27(4), 2001. <https://ieeexplore.ieee.org/document/917525/>
- Koschke, Simon. *Hierarchical Reflexion Models.* WCRE 2003. <https://dl.acm.org/doi/10.5555/950792.951359>
- Knodel, Popescu. *A Comparison of Static Architecture Compliance Checking Approaches.* WICSA 2007. <https://ieeexplore.ieee.org/document/4077029/>
- Terra, Valente. *A Dependency Constraint Language to Manage Object-Oriented Software Architectures.* SPE 2009. <https://www.dcc.ufmg.br/~mtov/pub/2009_spe.pdf>
- Buckley, Mooney, Rosik, Ali. *JITTAC.* ICSE 2013. doi:10.1109/ICSE.2013.6606700
- ArchUnit, *Freezing Arch Rules.* <https://www.archunit.org/userguide/html/000_Index.html#_freezing_arch_rules>
- dependency-cruiser, CLI (`--baseline`). <https://github.com/sverweij/dependency-cruiser/blob/main/doc/cli.md>
- Nx, *Enforce Module Boundaries.* <https://nx.dev/docs/features/enforce-module-boundaries>
- Sadowski et al. *Tricorder.* ICSE 2015. doi:10.1109/ICSE.2015.76
- Kephart, Chess. *The Vision of Autonomic Computing.* IEEE Computer, 2003.
- Blair, Bencomo, France. *Models@run.time.* IEEE Computer 42(10), 2009. <https://ieeexplore.ieee.org/document/5280648/>
- Li et al. *Generative AI for Self-Adaptive Systems.* ACM TAAS, 2024. <https://dl.acm.org/doi/10.1145/3686803>
- Fontana et al. *Arcan.* 2017. <https://boa.unimib.it/retrieve/e39773b3-de57-35a3-e053-3a05fe0aac26/PID4705339.pdf>
- Jansen, Bosch. *Software Architecture as a Set of Architectural Design Decisions.* WICSA 2005.
- Dhar, Vaidhyanathan, Varma. *Can LLMs Generate Architectural Design Decisions?* ICSA 2024. <https://arxiv.org/abs/2403.01709>
- Li, Liang, Avgeriou, Wang. *Towards Automated Identification of Violation Symptoms of Architecture Erosion.* <https://arxiv.org/abs/2306.08616>
- De Luca et al. *CIAO.* ICSA 2026. <https://arxiv.org/abs/2604.08293>
- Zhang et al. *SemRef.* 2026. <https://arxiv.org/abs/2607.23774>
- Keim, Kaplan. *From Scattered to Structured.* ICSE-Companion 2026. <https://arxiv.org/abs/2601.19548>
- Antigravity CLI, *Headless mode.* <https://antigravity.google/docs/cli/headless/>
- Archify gallery. <https://archify.si/gallery/artifacts/production-deployment.architecture>
