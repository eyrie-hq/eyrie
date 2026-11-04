import { History, MessageCircleQuestion, ShieldCheck, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { store, useStore, type DrawerTab } from '../state/store';
import { AskTab } from './AskTab';
import { HealthTab } from './HealthTab';
import { RecentTab } from './RecentTab';

const TABS: { id: DrawerTab; label: string; icon: typeof ShieldCheck }[] = [
  { id: 'ask', label: 'Ask', icon: MessageCircleQuestion },
  { id: 'health', label: 'Health', icon: ShieldCheck },
  { id: 'recent', label: 'Recent', icon: History },
];

/**
 * The insight drawer: what the map knows beyond the picture. Each tab points
 * at the map through the store's one highlight field — an answer's steps, one
 * finding, or a session's changed components — and selecting an entry again
 * restores its highlight.
 */
export function Drawer() {
  const drawer = useStore((s) => s.drawer);
  const healthCount = useStore((s) => s.health?.findings.length ?? null);
  const sessions = useStore((s) => s.recent?.sessions ?? null);
  if (!drawer.open) return null;
  const liveCount = sessions?.filter((s) => !s.endedAt).length ?? 0;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = TABS.findIndex((t) => t.id === drawer.tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    store.setDrawerTab(TABS[next]!.id);
    (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
  };
  return (
    <aside className="insight-drawer" aria-label="Insights">
      <div className="insight-tabs">
        <div role="tablist" aria-label="Insights">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = drawer.tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`insight-tab-${t.id}`}
                aria-selected={active}
                aria-controls="insight-panel"
                tabIndex={active ? 0 : -1}
                className={active ? 'is-active' : undefined}
                onClick={() => store.setDrawerTab(t.id)}
                onKeyDown={onKeyDown}
              >
                <Icon size={13} aria-hidden="true" />
                <span>{t.label}</span>
                {t.id === 'health' && healthCount !== null && healthCount > 0 ? (
                  <span className="insight-tab-badge alert" aria-label={`${healthCount} findings`}>
                    {healthCount}
                  </span>
                ) : null}
                {t.id === 'recent' && liveCount > 0 ? (
                  <span className="insight-tab-live" aria-label={`${liveCount} live`}>
                    <span className="insight-tab-live-dot" aria-hidden="true" />
                    {liveCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <button type="button" className="insight-close" aria-label="Close insights" title="Close (Esc)" onClick={() => store.closeDrawer()}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="insight-body" role="tabpanel" id="insight-panel" aria-labelledby={`insight-tab-${drawer.tab}`}>
        {drawer.tab === 'ask' ? <AskTab /> : drawer.tab === 'health' ? <HealthTab /> : <RecentTab />}
      </div>
    </aside>
  );
}
