import type { Mark } from '../state/store';
import type { Focus } from './analysis';
import type { Layout } from './layout';

export interface Highlight {
  selected: string | null;
  focus: Focus | null;
  /** Animate requests flowing along the focused edges. */
  flow: boolean;
  matches: Set<string> | null;
  /** Nodes touched by the hovered change-tape frame. */
  frame: Set<string> | null;
  /** What the insight drawer points at: ringed ids with marks, and a path whose edges run heavier. */
  insight: { source: string; ids: Set<string>; labels: Map<string, string>; path: string[] } | null;
}

export interface RendererCallbacks {
  onSelect(id: string | null): void;
}

/** A view of the architecture layout. The 2D canvas and the 3D scene both implement it. */
export interface GraphRenderer {
  render(layout: Layout, marks: Map<string, Mark>, opts: { animate: boolean }): void;
  setMarks(marks: Map<string, Mark>): void;
  setHighlight(hl: Highlight): void;
  fit(duration?: number): void;
  zoomBy(factor: number): void;
  reveal(id: string): void;
  ensureVisible(id: string): void;
  destroy(): void;
}

export interface CityRenderer extends GraphRenderer {
  rotateBy(degrees: number): void;
  toggleTilt(): void;
  home(): void;
}
