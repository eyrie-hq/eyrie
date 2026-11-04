import { useViewport } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import type { Layout, Point } from '../graph/layout';
import type { Mark } from '../state/store';
import { CityScene, type CityEmphasis } from './CityScene';
import type { CityAngle } from './projection';

interface Props {
  layout: Layout;
  origin: Point;
  angle: CityAngle;
  emphasis: CityEmphasis;
  selected: string | null;
  marks: Map<string, Mark>;
  flow: boolean;
  sweep: number;
  insight: { ids: Set<string>; color: string } | null;
  sceneRef: React.RefObject<CityScene | null>;
  onError(): void;
}

export function CityLayer({ layout, origin, angle, emphasis, selected, marks, flow, sweep, insight, sceneRef, onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewport = useViewport();
  useEffect(() => {
    const el = host.current!;
    let scene: CityScene;
    try { scene = new CityScene(el); }
    catch { onError(); return; }
    sceneRef.current = scene;
    const resize = new ResizeObserver(([entry]) => scene.resize(entry!.contentRect.width, entry!.contentRect.height));
    resize.observe(el);
    const lost = (event: Event) => { event.preventDefault(); onError(); };
    el.addEventListener('webglcontextlost', lost, true);
    return () => {
      resize.disconnect();
      el.removeEventListener('webglcontextlost', lost, true);
      scene.destroy();
      sceneRef.current = null;
    };
  }, [sceneRef, onError]);
  useEffect(() => { sceneRef.current?.build(layout, origin); }, [layout, origin, sceneRef]);
  useEffect(() => { sceneRef.current?.orient(angle); }, [angle, sceneRef]);
  useEffect(() => { sceneRef.current?.setViewport(viewport); }, [viewport, sceneRef]);
  useEffect(() => { sceneRef.current?.emphasize(emphasis, selected, marks, flow, sweep, insight); }, [layout, emphasis, selected, marks, flow, sweep, insight, sceneRef]);
  useEffect(() => {
    const repaint = () => {
      const scene = sceneRef.current;
      scene?.build(layout, origin);
      scene?.orient(angle);
      scene?.setViewport(viewport);
      scene?.emphasize(emphasis, selected, marks, flow, sweep, insight);
    };
    // Repaint when data-theme attribute changes (user toggled theme).
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) if (m.attributeName === 'data-theme') { repaint(); break; }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    // Also repaint when the OS theme changes (relevant when preference is "system").
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', repaint);
    return () => { observer.disconnect(); mq.removeEventListener('change', repaint); };
  }, [layout, origin, angle, viewport, emphasis, selected, marks, flow, sweep, insight, sceneRef]);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const refresh = () => sceneRef.current?.refreshMotion();
    motion.addEventListener('change', refresh);
    return () => motion.removeEventListener('change', refresh);
  }, [sceneRef]);
  return <div ref={host} className="city-webgl" />;
}
