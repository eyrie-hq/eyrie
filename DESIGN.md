---
name: Eyrie
description: A precise, live architecture atlas for understanding how code moves through a repository.
colors:
  ink-0: "#0d1012"
  ink-1: "#13171a"
  ink-2: "#191e22"
  ink-3: "#20262b"
  rule: "#252b30"
  rule-strong: "#343b41"
  text: "#e7e9e4"
  dim: "#9aa3a7"
  faint: "#899398"
  frontend: "#7aa7ff"
  api: "#58d68d"
  service: "#f5a25d"
  ai: "#b79bff"
  data: "#47c9d6"
  external: "#e9c46a"
  utility: "#8b959a"
  broken: "#ff6b6b"
  new: "#58d68d"
  modified: "#e9c46a"
  removed: "#ff6b6b"
typography:
  display:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 750
    lineHeight: 1.2
  headline:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 750
    lineHeight: 1.3
  title:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 620
    lineHeight: 1.35
  graph-title:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 650
    lineHeight: "20px"
  city-title:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: "24px"
  body:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    lineHeight: 1.5
  compact:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    lineHeight: 1.6
  small:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    lineHeight: 1.5
  micro:
    fontFamily: "Fragment Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "10.5px"
    lineHeight: 1.4
  label:
    fontFamily: "Fragment Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "10px"
    lineHeight: 1.4
rounded:
  badge: "2px"
  node: "7px"
  card: "8px"
  panel: "12px"
  overlay: "14px"
components:
  lens-option:
    backgroundColor: "{colors.ink-3}"
    textColor: "{colors.text}"
    rounded: "4px"
    padding: "4px 10px"
    height: "32px"
  category-filter:
    backgroundColor: "{colors.ink-2}"
    textColor: "{colors.text}"
    rounded: "9999px"
    padding: "0 10px"
    height: "32px"
  search-field:
    backgroundColor: "{colors.ink-0}"
    textColor: "{colors.text}"
    rounded: "6px"
    padding: "0 32px 0 32px"
    height: "32px"
  graph-node:
    backgroundColor: "{colors.ink-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.node}"
    padding: "10px 12px"
    width: "216px"
    height: "80px"
  details-panel:
    backgroundColor: "{colors.ink-1}"
    textColor: "{colors.text}"
    rounded: "0px"
    padding: "20px"
---

# Design System: Eyrie

## Overview

**Creative North Star: "The Live Architecture Atlas"**

Eyrie is a precise instrument for seeing a codebase from above. Its interface is quiet and information-dense: graphite surfaces recede, thin rules organize the frame, and semantic colour marks the structure that matters. The graph itself is the image; controls and chrome stay legible without competing with it.

The map remains alive as source code changes. Motion reports those changes and helps preserve orientation; it is never ambient decoration. The visual language should feel precise, quiet, technical, alive, and trustworthy. It should not resemble a marketing dashboard, a mind-mapping toy, or a generic node editor.

**Key Characteristics:**
- A fixed, full-height instrument shell around a pannable architecture map.
- Category colours are semantic claims; each hue keeps one meaning.
- Real repository identifiers use monospace; Eyrie's prose uses Archivo.
- State changes remain legible without colour alone.

## Colors

The palette pairs graphite or cool-paper neutrals with a distinct semantic colour for each architecture category and change state. Dark is the default; light mode is a complete token override driven by `prefers-color-scheme`.

### Primary
- **Vantage Blue** (`#7aa7ff` dark, `#2f6fdf` light): Frontend category identity and the global visible focus indicator.

### Secondary
- **Signal Green** (`#58d68d` dark, `#1f9d5a` light): API category and newly added graph components.
- **Service Amber** (`#f5a25d` dark, `#c96a14` light): Service category and write-oriented data-flow edges.
- **Intelligence Lilac** (`#b79bff` dark, `#7a52e0` light): AI category.
- **Data Cyan** (`#47c9d6` dark, `#0f8f9c` light): Data category and data-flow reads.
- **External Gold** (`#e9c46a` dark, `#a87f0a` light): External category and modified state.
- **Utility Grey** (`#8b959a` dark, `#6a7378` light): Utility category.
- **Fault Red** (`#ff6b6b` dark, `#d93c3c` light): Broken references and removed state.

### Neutral
- **Graphite Zero** (`#0d1012` dark, `#f4f5f2` light): Main canvas and application background.
- **Graphite One** (`#13171a` dark, `#fbfbf9` light): Top bar and details-panel surface.
- **Graphite Two** (`#191e22` dark, `#ffffff` light): Node and raised-control surfaces.
- **Graphite Three** (`#20262b` dark, `#eceeea` light): Hover and selected-control surface.
- **Rule** (`#252b30` dark, `#dfe2dd` light): Hairline dividers and quiet borders.
- **Strong Rule** (`#343b41` dark, `#c9cdc7` light): Emphasized borders and lane structure.
- **Warm Chalk** (`#e7e9e4` dark, `#15191c` light): Main text and high-contrast graph marks.
- **Muted Alloy** (`#9aa3a7` dark, `#525b60` light): Supporting text and identifiers.
- **Faint Alloy** (`#899398` dark, `#626b70` light): Tertiary labels and hints, with sufficient contrast on the ordinary neutral surfaces in both schemes.

### Named Rules
**The One Hue, One Meaning Rule.** A category colour is never decorative or reassigned to another category. Define every new colour in both schemes and derive state tints with `color-mix(in oklab, ...)` where possible.

**The Readable Category Text Rule.** A category colour used as text, such as a node's kind label, is `color-mix(in oklab, var(--c) 75%, var(--color-text))`, never the bare colour: bare, most light-scheme categories fall below 4.5:1 at 10px. Borders, swatches and outlines keep the bare colour.

**The Meaning Has Two Channels Rule.** Never communicate a change or edge type with colour alone. Change state also has a `+`, `~`, or `−` badge; edge kinds use line patterns as well as colour.

## Typography

**Display Font:** Archivo Variable (with `ui-sans-serif`, `system-ui`, sans-serif fallbacks)

**Body Font:** Archivo Variable (with `ui-sans-serif`, `system-ui`, sans-serif fallbacks)

**Label/Mono Font:** Fragment Mono (with `ui-monospace`, `SF Mono`, Menlo, monospace fallbacks)

Both families are bundled locally through `@fontsource*`; the interface does not fetch fonts at runtime. Archivo carries UI prose and labels. Fragment Mono marks file paths, routes, line numbers, symbols, and other literal repository identifiers.

### Hierarchy
- **Display** (750, 20px, 1.2): The largest, rare heading in a centered connection or access state.
- **Headline** (750, 15px, about 1.3): Repository identity and compact view headings.
- **Title** (620, 13px, about 1.35): Compact section content.
- **Graph Title** (650, 14px, 20px): React Flow component labels.
- **City Title** (650, 18px, 24px in scene coordinates): Roof-aligned React Flow labels on Three.js blocks; labels use the block camera projection and scale with scene zoom, not viewport width.
- **Body** (400, 13px, 1.5): Explanatory copy and normal interface text.
- **Compact** (400–650, 12px, 1.6): Drawer and panel rows, finding cards, buttons. Dense rows may step to 12.5px where a full step up would break alignment.
- **Small** (400–600, 11px, 1.5): Bylines, chips, secondary rows. Dense panel rows may step to 11.5px for the same reason.
- **Micro** (400–700, 10.5px mono, 1.4): Timestamps, severities, commit hashes, and other compact metadata.
- **Label** (400, 10px, 1.4, uppercase where semantic): Lane names, metadata, and section labels; monospace is reserved for technical identifiers and compact metadata.

Archivo's width axis provides emphasis and fit: `.wide` uses 125% stretch for selected labels, while `.condensed` uses 87.5% for identifiers that need to fit. Keep the hierarchy compact; the graph is the primary reading surface.

### Named Rules
**The Identifier Rule.** Use monospace for literal repository data and sans serif for Eyrie's interface language. Do not blur the distinction.

## Layout

The application fills the viewport height with a compact top bar, a central canvas, an optional details panel, and a change tape. The canvas absorbs available space. Opening details overlays or occupies a fixed side panel without causing the map to reflow. On narrow screens the details panel moves to the bottom and the insight drawer overlays the top of the map at half the viewport height; fewer lanes fit in view rather than shrinking graph nodes.

The lane order is fixed product vocabulary: UI → Edge → API → Logic → Data → External. React Flow owns both viewports, accessible component interactions, and pannable minimaps; ELK remains the shared layout and routing authority. A 2D lane ruler identifies off-screen lanes and changed components, with arrow controls to reveal each lane. The 2D nodes and 3D floors are 216px wide and 80px deep. Fitting the 2D map never reduces scale below 0.85. The 3D overview fits projected bounds on desktop, while narrow views retain a 0.85 minimum for inspection. The minimap recedes on narrow screens, and the mobile inspector reserves room for the selected node. Three.js draws a full-bleed orthographic city at a default yaw of -28 degrees and elevation of 52 degrees. The WebGL camera and React Flow labels share one projection and viewport transform, so pan, zoom, and orbit remain aligned.

Controls and dividers use compact, measured spacing: the top bar has 16px horizontal padding, the details panel uses 20px internal padding, and React Flow nodes use 10px vertical and 12px horizontal padding with a 3px content gap. The canvas owns pan and zoom; it has no page-level scroll. `F` fits the graph at any viewport size.

## Elevation & Depth

Depth is conveyed first by tonal surface shifts and thin borders, not broad drop shadows. The 2D map stays visually flat; selection adds a category-coloured outline and surface tint. Three.js gives the city actual extruded geometry, directional lighting, restrained cast shadows, and floor-level dependency tracks with proper block occlusion. Floor and lane materials retain their exact theme tokens; lighting affects blocks rather than bleaching the canvas. Selection strengthens the block tint and outline. Avoid adding ambient shadows to ordinary chrome.

**The Tonal-First Rule.** Use surface tone and a one-pixel rule to separate ordinary layers. Reserve shadows and glow for the 3D model or a selected graph element.

## Shapes

The form language is compact and technical. Badges and ticks use 2px corners; 2D graph nodes use 7px; drawer finding and session cards use 8px; the mobile details panel uses 8px top corners; overlay silhouettes use 12–14px; dots are circular. Controls may use 4–6px corners, while category filters and connection-status indicators are intentionally pill-shaped. Three.js city blocks use crisp geometry and category-coloured outlines. Their roof-aligned custom React Flow labels are unframed by default, with a restrained neutral surface on hover or selection and 3px corners. Do not round every surface to the same radius.

## Components

### Buttons and Segmented Controls

Controls are precise and restrained; the category colour carries graph state. Lens and trace controls form compact segmented groups with a thin rule, a subtle inset surface, and a filled selected option. Keep visible text labels on primary navigation controls where space allows. Use a visible focus ring: 2px solid Vantage Blue with 2px offset.

### Chips

Category filters in the navbar are compact, unframed swatch controls with a short label and a monospace count. Hover reveals a restrained surface and rule; disabled filters use a dashed border and an outlined swatch. Keep category names paired with colour.

### Cards / Containers

The details panel is an unshadowed `ink-1` surface with a one-pixel rule at its edge. On desktop it is 384px wide; on narrow viewports it sits at the bottom with an 8px top radius and a maximum height of `min(60dvh, calc(100dvh - 340px))`, preserving canvas space above the inspector. Sections remain in stable order so the user can scan purpose, source, calls, dependents, and symbols.

### Inputs / Fields

Navbar search is a 38px-high `ink-0` field (34px on mobile) with a quiet rule, a left-aligned search icon, and a trailing result count and clear action when populated. Focus changes the border to the stronger rule while retaining the global focus-visible outline. Keep the input label accessible even when the placeholder is visible.

### Navigation

The top bar uses two deliberate rows: repository identity, labeled lens options, search, and live status on the `ink-1` primary row; framework and source counts alongside category filters on the quieter `ink-0` context row. One-pixel rules divide the rows and canvas. Intermediate widths place lenses and search beneath identity; mobile stacks labeled lenses and search, hides secondary repository counts, and lets category filters scroll horizontally. Lens radios use one tab stop with arrow-key navigation.

### Sequence Canvas

The Sequence lens uses React Flow with fixed 180px participant headers on 220px column tracks and 48px message rows. Lifeline nodes and ordered message ports preserve source order; the 150px source gutter (110px on mobile) stays pinned horizontally and tracks viewport pan and zoom vertically. Participant headers and message labels open the component inspector; file-and-line buttons open the editor. Read/write/HTTP meanings retain the semantic edge vocabulary. Pan, zoom, fit, and reset are available without making the trace editable. Keep the static-order caveat visible on every viewport.

### System View

The System lens reuses the map: same lanes, layout, 2D and 3D. A box that groups several components is drawn as a stack — a second, offset outline in the box's category colour — and its kind line reads layer and count (`Frontend · 25`). Links between boxes carry a small mono label chip on the line (`HTTP ×17`, `reads · writes ×30`) in `--color-dim` on `ink-1` with a one-pixel rule; it brightens with the link when traced and fades with it when dimmed. External services and missing routes keep their ordinary component cards, so a broken route stays red at every zoom level. The details panel for a box lists what it holds, each entry opening that component in the Architecture lens.

### Architecture Nodes

Nodes are the signature component and the main visual content. Each 2D node is 216px wide with a 7px radius, an `ink-2` body, a restrained category-tinted fill and border, a sans-serif component label, and a monospace path or route. The React Flow node adds a category-coloured kind icon and a separate change glyph, preserving the distinction between category and change state. Selection strengthens the category border and surface tint; broken references use a red dashed border. City labels occupy a stable 216px by 68px scene-space box on the projected block roof, with 4px vertical and 10px horizontal padding. Their lettering and focus outlines share the roof-plane transform, reversing orientation on the far side to remain reader-facing. Blocks retain the established source-backed height function, including special heights for data models, external services, and broken references. New blocks rise briefly; removed blocks fade and sink with their removed glyph before disappearing. There is no ambient camera motion. WebGL failure keeps accessible labels and provides a 2D recovery action.

### Edges and Change Tape

Edges use quiet neutral strokes by default and brighten on focus. Selecting a node in the Neighbors mode sends a single bounded sweep along its connected edges in both 2D and 3D; changing selection cancels the previous sweep. HTTP and transfer edges are dashed; data-flow reads and writes use their established semantic hues. The change tape records one tick per save; height represents change magnitude and colour represents change type. New, modified, and removed states use both colour and glyph. Motion is brief and respects reduced motion.

## Do's and Don'ts

### Do:
- **Do** preserve the UI → Edge → API → Logic → Data → External lane order.
- **Do** define colour tokens for both dark and light schemes.
- **Do** use monospace for source paths, routes, line numbers, and symbols.
- **Do** keep visible keyboard focus and honour reduced motion in CSS and JavaScript.
- **Do** use colour together with a badge, dash pattern, label, or other non-colour signal.
- **Do** keep every pointer target at least 24px on each side; text buttons and tape ticks keep their small look with a larger hit area.
- **Do** preserve stable node identity and position when code outside the changed region is unchanged.

### Don't:
- **Don't** use category hues as decoration or swap their meanings.
- **Don't** add ambient movement or animate unchanged graph layout.
- **Don't** use shadows as the default separator for panels and controls.
- **Don't** shrink graph nodes to fit a narrow viewport; let the lane ruler indicate off-screen content.
- **Don't** lower tertiary text contrast below 4.5:1 on its neutral surface in either colour scheme.
