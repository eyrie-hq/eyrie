import { useEffect, useState } from 'react';
import { ChangeTape } from './components/ChangeTape';
import { Drawer } from './components/Drawer';
import { Panel } from './components/Panel';
import { TopBar } from './components/TopBar';
import { GraphView } from './graph/GraphView';
import { accessToken, connect, useStore } from './state/store';

export function App() {
  const [token] = useState(accessToken);
  const status = useStore((s) => s.status);
  const loaded = useStore((s) => s.loaded);
  const empty = useStore((s) => s.loaded && s.nodes.size === 0);

  useEffect(() => (token ? connect(token) : undefined), [token]);

  if (!token || status === 'unauthorized') return <NoAccess hasToken={!!token} />;

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="relative flex min-h-0 flex-1">
        <Drawer />
        <div className="relative min-w-0 flex-1">
          <GraphView />
          {!loaded ? <Notice title="Indexing the repository">Reading files and resolving relationships. Large repositories take a little longer the first time.</Notice> : null}
          {empty ? (
            <Notice title="No components found">
              Eyrie reads TypeScript and JavaScript today. Point it at a folder with .ts, .tsx, .js or .jsx files, for example <code className="font-mono">eyrie ./my-app</code>.
            </Notice>
          ) : null}
          {loaded && !empty ? <Hint /> : null}
        </div>
        <Panel />
      </main>
      <ChangeTape />
    </div>
  );
}

function Hint() {
  const selected = useStore((s) => s.selected);
  const view = useStore((s) => s.view);
  const lens = useStore((s) => s.lens);
  if (selected || lens === 'sequence') return null;
  if (lens === 'system') {
    return (
      <p className="pointer-events-none absolute bottom-3 left-4 hidden max-w-[62%] rounded bg-ink-0/75 px-2 py-1 font-mono text-[10.5px] leading-relaxed text-faint backdrop-blur-sm md:block">
        Each box groups one part of the system · select a box to see what it holds · <kbd>2</kbd> every component
      </p>
    );
  }
  if (lens === 'dataflow') {
    return (
      <p className="pointer-events-none absolute bottom-3 left-4 hidden max-w-[62%] rounded bg-ink-0/75 px-2 py-1 font-mono text-[10.5px] leading-relaxed text-faint backdrop-blur-sm md:block">
        <Swatch color="var(--color-service)" /> writes · <Swatch color="var(--color-data)" /> reads, pointing out of the store · dashed crosses the network · faint passes data along
      </p>
    );
  }
  return (
    <p className="pointer-events-none absolute bottom-3 left-4 hidden max-w-[52%] rounded bg-ink-0/75 px-2 py-1 font-mono text-[10.5px] leading-relaxed text-faint backdrop-blur-sm md:block">
      {view === '3d' ? (
        <>
          Block height shows lines of code · drag to pan · right-drag or <kbd>⌥</kbd>-drag to orbit · <kbd>Q</kbd>/<kbd>E</kbd> rotate · <kbd>R</kbd> reset · <kbd>V</kbd> 2D
        </>
      ) : (
        <>
          Click a component to inspect it · <kbd>⌘K</kbd> search · <kbd>A</kbd> ask · <kbd>F</kbd> fit · <kbd>V</kbd> 3D · drag to pan, scroll to zoom
        </>
      )}
    </p>
  );
}

function Swatch({ color }: { color: string }) {
  return <span className="inline-block h-[2px] w-3 align-middle" style={{ background: color }} />;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
      <div className="max-w-sm text-center">
        <h2 className="wide text-[15px] font-[700]">{title}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-dim">{children}</p>
      </div>
    </div>
  );
}

function NoAccess({ hasToken }: { hasToken: boolean }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-md">
        <p className="font-mono text-[10px] tracking-[0.18em] text-faint uppercase">Eyrie</p>
        <h1 className="wide mt-2 text-[20px] font-[750]">{hasToken ? 'This access link has expired' : 'Open Eyrie from your terminal'}</h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-dim">
          Eyrie only serves your code to the browser tab it opened. Run <code className="rounded bg-ink-2 px-1 py-0.5 font-mono text-text">eyrie</code> in your project and use the link it prints; the link
          includes a one-time access token{hasToken ? ', and a new one is created each time Eyrie starts' : ''}.
        </p>
      </div>
    </div>
  );
}
