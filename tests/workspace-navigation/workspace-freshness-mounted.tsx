import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { api } from '../../apps/web/src/api';
import { useWorkspaceStream, type WorkspaceConnectionState } from '../../apps/web/src/hooks/useWorkspaceStream';
import type { WorkspaceStreamHandlers } from '../../apps/web/src/api/types';
import { useAgentStream } from '../../apps/web/src/hooks/useAgentStream';
import { WorkspaceRefreshProvider, useReportWorkspaceRefresh } from '../../apps/web/src/components/WorkspaceRefreshContext';
import type { StreamHandlers } from '../../apps/web/src/api/types';
import { queryKeys } from '../../apps/web/src/queryKeys';
import { WorkspaceConnectionNotice } from '../../apps/web/src/components/WorkspaceConnectionNotice';
import { createPonderosaTheme } from '../../apps/web/src/theme';

function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); };
// Only this synthetic browser cell owns the clock. No live service or runtime.
function clock() {
  const originalSet = window.setTimeout, originalClear = window.clearTimeout, originalNow = Date.now;
  let now = originalNow(), serial = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  window.setTimeout = ((run: () => void, delay = 0) => { const id = ++serial; timers.set(id, { at: now + Math.max(0, Number(delay)), run }); return id; }) as typeof setTimeout;
  window.clearTimeout = id => { timers.delete(id); };
  Date.now = () => now;
  return { async tick(ms: number) { const end = now + ms; for (let steps = 0; ; steps++) { assert(steps < 1000, 'bounded timer work'); await settle(); const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = Math.max(now, next[1].at); timers.delete(next[0]); next[1].run(); } now = end; await settle(); }, restore() { window.setTimeout = originalSet; window.clearTimeout = originalClear; Date.now = originalNow; } };
}

export async function workspaceFreshnessMountedRegression(): Promise<void> {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  const savedSubscribe = api.subscribeWorkspace, savedAgentSubscribe = api.subscribeAgent, visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const onlineDescriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  let online = true; Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  const time = clock();
  let visibility = 'visible', handlers!: WorkspaceStreamHandlers, connection!: WorkspaceConnectionState;
  let agentHandlers!: StreamHandlers, agentSubscriptions = 0, agentClosed = 0;
  let subscriptions = 0, closed = 0, failA = false, holdA = false, resolveA: (() => void) | undefined;
  const calls = { a: 0, b: 0, unrelated: 0 };
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  api.subscribeWorkspace = (_cursor, next) => { subscriptions++; handlers = next; return { close() { closed++; } }; };
  api.subscribeAgent = (_id, _cursor, next) => { agentSubscriptions++; agentHandlers = next; return { close() { agentClosed++; } }; };
  function Fixture() {
    const agent = useAgentStream('synthetic-agent', 'a');
    useReportWorkspaceRefresh(agent.connectionStatus !== 'live' ? 'Test Agent live activity is reconnecting.' : undefined, () => agent.retry?.());
    useQuery({ queryKey: queryKeys.agents.health('a'), initialData: [], queryFn: async () => { calls.a++; if (holdA) await new Promise<void>(resolve => { resolveA = resolve; }); if (failA) throw Error('status refresh failed'); return []; } });
    useQuery({ queryKey: queryKeys.agents.health('b'), initialData: [], queryFn: async () => { calls.b++; return []; } });
    useQuery({ queryKey: ['unrelated-active'], initialData: [], queryFn: async () => { calls.unrelated++; return new Promise<never>(() => {}); } });
    connection = useWorkspaceStream();
    return <><output>{connection.status}:{String(connection.phaseEvidenceFresh)}</output><WorkspaceConnectionNotice connection={connection} hasSavedData /></>;
  }
  let instance = 'synthetic-ui004';
  const status = (cursor: number, extra = {}) => handlers.onStatus?.({ cursor, instanceId: instance, ...extra });
  let id = 0;
  const event = (projectId: string, replayed = false) => handlers.onEvent({ id: ++id, replayed, event: { type: 'coordination_changed', projectId, agentId: 'agent', conversationIds: [] }, at: '2026-11-09T00:00:00Z' } as never);
  const visible = async (value: string) => { visibility = value; document.dispatchEvent(new Event('visibilitychange')); await settle(); if (value === 'visible') { agentHandlers.onOpen?.(); agentHandlers.onStatus?.({ cursor: 0, instanceId: 'agent-ui004' }); await settle(); } };
  const warning = () => [...host.querySelectorAll('button')].find(button => /Reconnecting|Offline|Delayed/.test(button.textContent ?? ''));
  try {
    localStorage.removeItem('ponderosa.workspace.cursor.v2'); localStorage.removeItem('ponderosa.workspace.instance.v1');
    flushSync(() => root.render(<ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><WorkspaceRefreshProvider><Fixture /></WorkspaceRefreshProvider></QueryClientProvider></ThemeProvider>));
    await settle(); agentHandlers.onOpen?.(); agentHandlers.onStatus?.({ cursor: 0, instanceId: 'agent-ui004' }); status(0); await time.tick(150);
    assert(connection.status === 'live' && connection.phaseEvidenceFresh, 'initial live requires canonical post-boundary reads');
    assert(calls.unrelated === 0, 'unrelated active query is outside phase proof');
    const beforeB = calls.b;
    holdA = true; event('a'); await time.tick(5_000); assert(resolveA, 'phase A read is in flight');
    for (let n = 0; n < 5; n++) { event('a'); event('b'); await time.tick(1_000); }
    assert(calls.b > beforeB, 'sustained events refresh B despite hung A');
    assert(!connection.phaseEvidenceFresh, 'in-flight boundary cannot manufacture fresh phase');
    holdA = false; resolveA!(); await time.tick(0);
    assert(!connection.phaseEvidenceFresh, 'older successful fetch never erases a newer same-query boundary');
    await time.tick(5_000);
    assert(connection.phaseEvidenceFresh, 'finite batches finish without global quiet');
    await visible('hidden'); handlers.onError?.(new Event('error')); await time.tick(90_000);
    assert(!warning(), 'hidden suspension never matures a visible warning');
    await visible('visible'); status(id + 2); await time.tick(150);
    assert(connection.status !== 'live', 'open status ahead of cursor is not recovery');
    event('a', true); event('b', true); await time.tick(650);
    assert(connection.status === 'live', 'verified replay and canonical refresh clear recovery promptly');
    assert(!warning(), 'successful resume has no warning flash');
    // Finite recovery may complete while newer events still need their next
    // bounded canonical read. Waiting for global silence would warn falsely.
    handlers.onError?.(new Event('error')); holdA = true; status(id); await time.tick(150);
    event('a'); await time.tick(1_000); event('a');
    holdA = false; resolveA!(); await time.tick(0);
    assert(connection.status === 'live' && !connection.phaseEvidenceFresh && !warning(), 'finite recovery completes while newer same-query work remains honestly stale');
    await time.tick(5_000); assert(connection.phaseEvidenceFresh, 'new boundary receives its own canonical read');
    agentHandlers.onError?.(new Event('error')); await time.tick(7_999); assert(!warning(), 'Agent-only brief disconnect stays quiet');
    await time.tick(1); assert(warning(), 'Agent-only sustained outage is visible with healthy workspace');
    warning()!.click(); await time.tick(0);
    assert(document.body.textContent?.includes('Test Agent live activity'), 'details identify the affected Agent');
    const retry = [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry');
    assert(retry, 'specific stream has Retry'); retry.click(); await time.tick(0);
    assert(agentSubscriptions === 2 && subscriptions === 1, 'Agent Retry renews only its owned stream');
    agentHandlers.onOpen?.(); agentHandlers.onStatus?.({ cursor: 0, instanceId: 'agent-ui004' }); await time.tick(0);
    assert(!warning(), 'verified Agent catch-up clears its local warning');
    holdA = true; event('a'); await time.tick(5_000); await time.tick(8_000);
    assert(warning()?.textContent?.includes('Agent Statuses'), 'hung visible read produces a resource-specific warning without a transport outage');
    holdA = false; resolveA!(); await time.tick(0); assert(!warning(), 'completed verified read clears stalled-resource warning');
    const confirmed = connection.lastSuccessfulSyncAt;
    failA = true; event('a'); await time.tick(5_000); await time.tick(8_000);
    assert(warning()?.textContent?.includes('Agent Statuses'), 'resource failure names affected data');
    assert(connection.lastSuccessfulSyncAt === confirmed, 'failed resource never advances confirmed time');
    failA = false; await time.tick(5_000); assert(!warning(), 'verified resource recovery clears warning');
    handlers.onError?.(new Event('error')); await time.tick(7_999); assert(!warning(), 'brief foreground reconnect stays quiet');
    await time.tick(1); assert(warning(), 'sustained foreground outage remains visible');
    online = false; window.dispatchEvent(new Event('offline')); await time.tick(0);
    assert(warning()?.textContent === 'Offline', 'offline indication reflects actual browser connectivity');
    online = true; window.dispatchEvent(new Event('online')); await time.tick(0);
    assert(warning()?.textContent === 'Reconnecting', 'online does not falsely certify recovery');
    status(id); await time.tick(150); assert(connection.status === 'live' && !warning(), 'recovery needs no reload');
    for (let n = 0; n < 3; n++) { await visible('hidden'); await time.tick(90_000); await visible('visible'); status(id); await time.tick(150); assert(!warning(), 'focus churn stays quiet'); }
    assert(subscriptions === 1, 'visibility does not create a second hook subscription');
    assert(calls.a < 20 && calls.b < 20, 'refresh requests stay bounded');
    status(0, { reset: true }); await time.tick(150); assert(connection.phaseEvidenceFresh, 'reset requires fresh canonical proof');
    holdA = true; event('a'); await time.tick(5_000);
    instance = 'synthetic-ui004-next'; status(0); await time.tick(50);
    holdA = false; resolveA!(); await time.tick(0);
    assert(connection.status !== 'live', 'old-server read cannot certify a new instance before replacement status');
    await time.tick(8_000); assert(warning(), 'replacement stream without status still warns after foreground grace');
    status(0); await time.tick(150); assert(connection.status === 'live' && !warning(), 'new-instance status and fresh reads recover');
    assert(subscriptions === 2, 'instance replacement creates exactly one replacement subscription');
    flushSync(() => root.unmount()); await time.tick(90_000); assert(agentClosed === 2, 'Agent retry and unmount each close their owned source'); assert(closed === 2, 'instance replacement and unmount close each owned subscription exactly once');
    document.dispatchEvent(new Event('visibilitychange')); await time.tick(8_000); assert(subscriptions === 2, 'disposed lifecycle cannot reopen');
  } finally {
    if (host.childNodes.length) flushSync(() => root.unmount()); client.clear(); api.subscribeWorkspace = savedSubscribe; api.subscribeAgent = savedAgentSubscribe;
    visibilityDescriptor ? Object.defineProperty(document, 'visibilityState', visibilityDescriptor) : Reflect.deleteProperty(document, 'visibilityState');
    onlineDescriptor ? Object.defineProperty(navigator, 'onLine', onlineDescriptor) : Reflect.deleteProperty(navigator, 'onLine');
    time.restore(); host.remove();
  }
}
