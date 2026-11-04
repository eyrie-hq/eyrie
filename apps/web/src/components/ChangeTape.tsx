import { useEffect, useMemo, useRef } from 'react';
import { store, useStore, type ChangeFrame } from '../state/store';

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function magnitude(f: ChangeFrame): number {
  return f.files.length + 3 * (f.added.length + f.removed.length) + f.linksAdded + f.linksRemoved;
}

function tone(f: ChangeFrame): 'new' | 'removed' | 'modified' {
  if (f.added.length) return 'new';
  if (f.removed.length) return 'removed';
  return 'modified';
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "Added src/x.ts → +1 component (ShippingService), +2 links". */
export function describeFrame(f: ChangeFrame): { action: string; result: string } {
  const verb = { add: 'Added', change: 'Edited', unlink: 'Deleted' } as const;
  let action: string;
  if (f.files.length === 1) action = `${verb[f.files[0]!.change]} ${f.files[0]!.file}`;
  else if (f.files.length <= 3) action = `Changed ${f.files.map((x) => x.file.split('/').pop()).join(', ')}`;
  else if (f.files.length) action = `Changed ${plural(f.files.length, 'file')}`;
  else action = 'Project settings changed';
  const parts: string[] = [];
  if (f.added.length) parts.push(`+${plural(f.added.length, 'component')} (${f.added.map((a) => a.label).join(', ')})`);
  if (f.removed.length) parts.push(`−${plural(f.removed.length, 'component')} (${f.removed.map((r) => r.label).join(', ')})`);
  if (f.linksAdded) parts.push(`+${plural(f.linksAdded, 'link')}`);
  if (f.linksRemoved) parts.push(`−${plural(f.linksRemoved, 'link')}`);
  if (!parts.length) parts.push(f.touched.length ? `${plural(f.touched.length, 'component')} edited, structure unchanged` : 'no architectural change');
  return { action, result: parts.join(', ') };
}

export function ChangeTape() {
  const frames = useStore((s) => s.frames);
  const hoverFrame = useStore((s) => s.hoverFrame);
  const stats = useStore((s) => s.stats);
  const recent = useStore((s) => s.recent);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [frames.length]);

  const session = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const f of frames) {
      added += f.added.length;
      removed += f.removed.length;
    }
    return { added, removed };
  }, [frames]);

  const shown = frames.find((f) => f.seq === hoverFrame) ?? frames[frames.length - 1];
  const max = Math.max(4, ...frames.map(magnitude));
  // Ticks inside a live agent session sit on a shaded band.
  const live = useMemo(() => (recent?.sessions ?? []).filter((s) => !s.endedAt).map((s) => ({ from: s.startedAt, task: `${s.agent} · ${s.task}` })), [recent]);
  const sessionOf = (at: number) => live.find((w) => at >= w.from)?.task;

  return (
    <footer className="flex h-[60px] shrink-0 items-stretch border-t border-rule bg-ink-1" aria-label="Change history">
      <div className="hidden w-44 shrink-0 flex-col justify-center gap-0.5 border-r border-rule px-4 sm:flex">
        <span className="font-mono text-[10px] tracking-[0.16em] text-faint uppercase">Changes</span>
        <span className="text-[12px] text-dim">
          {frames.length ? (
            <>
              <b className="font-[650] text-text">{frames.length}</b> {frames.length === 1 ? 'save' : 'saves'}
              {session.added ? <span className="text-new"> +{session.added}</span> : null}
              {session.removed ? <span className="text-removed"> −{session.removed}</span> : null}
            </>
          ) : (
            'This session'
          )}
        </span>
      </div>

      <div ref={scroller} className="scroll-thin relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden" onMouseLeave={() => store.setHoverFrame(null)}>
        {/* the tape baseline */}
        <div className="pointer-events-none absolute inset-x-0 bottom-[13px] border-t border-dashed border-rule" />
        <ol className="flex h-full min-w-full items-end justify-end gap-[3px] px-4 pb-[13px]">
          {frames.map((f) => {
            const h = 6 + Math.round((Math.log1p(magnitude(f)) / Math.log1p(max)) * 30);
            const t = tone(f);
            const { action, result } = describeFrame(f);
            const inSession = sessionOf(f.at);
            return (
              <li key={f.seq} className={`flex h-full items-end ${inSession ? 'tick-session' : ''}`}>
                <button
                  type="button"
                  aria-label={`${time(f.at)}: ${action}. ${result}${inSession ? `. In session: ${inSession}` : ''}`}
                  onMouseEnter={() => store.setHoverFrame(f.seq)}
                  onFocus={() => store.setHoverFrame(f.seq)}
                  onBlur={() => store.setHoverFrame(null)}
                  onClick={() => {
                    const target = f.added[0]?.id ?? f.touched[0];
                    if (target) store.select(target, true);
                  }}
                  className="group flex h-full w-[24px] items-end justify-center"
                  title={`${time(f.at)}${inSession ? ` · ${inSession}` : ''}`}
                >
                  <span
                    className={`tick block w-[4px] rounded-[1.5px] transition-opacity ${hoverFrame !== null && hoverFrame !== f.seq ? 'opacity-35' : ''}`}
                    style={{ height: h, background: `var(--color-${t})` }}
                  />
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="flex w-[62%] shrink-0 flex-col justify-center gap-0.5 border-l border-rule px-4 sm:w-[min(52%,620px)]" aria-live="polite">
        {shown ? (
          <>
            <div className="flex min-w-0 items-baseline gap-2.5">
              <span className="shrink-0 font-mono text-[10.5px] text-faint tabular-nums">{time(shown.at)}</span>
              <span className="truncate font-mono text-[11.5px] text-text">{describeFrame(shown).action}</span>
            </div>
            <div className="flex min-w-0 items-baseline gap-2.5">
              <span className="shrink-0 font-mono text-[10.5px] text-faint tabular-nums">{shown.ms}ms</span>
              <span className="truncate text-[12px] text-dim">→ {describeFrame(shown).result}</span>
            </div>
          </>
        ) : (
          <p className="text-[12px] leading-snug text-dim">
            Watching {stats ? plural(stats.files, 'file') : 'the repository'}.
            <span className="hidden sm:inline">
              {' '}
              Save a change and the map updates here: new in <span className="text-new">green</span>, edited in <span className="text-modified">yellow</span>, removed in{' '}
              <span className="text-removed">red</span>.
            </span>
          </p>
        )}
      </div>
    </footer>
  );
}
