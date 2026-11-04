---
version: 1
slug: "apps-web-src-components-drawer-tsx"
primary_target: "apps/web/src/components/Drawer.tsx"
related_targets: ["apps/web/src/components/AskTab.tsx","apps/web/src/components/HealthTab.tsx","apps/web/src/components/RecentTab.tsx"]
---

# Surface brief: insight drawer tabs (Ask, Health, Recent)

Scope: the drawer tab contents in `apps/web/src/components/` (AskTab, HealthTab, RecentTab). Drawer shell, map, top bar untouched. Visitor mode: Operate. Audience: engineers operating Eyrie; job: ask the map, clear findings, review agent sessions; constraints: 340px drawer, Eyrie world fixed, no new colors.

## Direction contract

THESIS: The drawer is an inspector, not a feed. Every tab reads as compact rows that push open into evidence inline; the category-default card gallery is refused.

OWN-WORLD: Eyrie graphite + Archivo/Fragment Mono + severity/marks palette, unchanged. Rows carry mono meta rails, severity glyphs, and model stamps; open rows reveal evidence drawers in ink-1.

STORY: The visitor scans a tab in seconds, opens the one row that matters, sees its evidence and map path without leaving the drawer, and acts (show on map, copy fix, ask follow-up).

FIRST VIEWPORT: Ask opens with a command-grade input pinned on top, backend segmented switch beneath it, then answer rows newest-first; Health opens with a count strip then finding rows; Recent with the live session row pinned, earlier rows below. The primary action (ask input / first row) sits at the top of every tab.

FORM: Inspector stack, position 5 of 7, seed key f7ae9ae7.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
