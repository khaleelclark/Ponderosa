import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { AgentDto, AgentHealthDto, EngineDto } from '@ponderosa/core';
import { api } from '../src/api';
import { queryKeys } from '../src/queryKeys';
import { useWorkspaceStream } from '../src/hooks/useWorkspaceStream';
import { createPonderosaTheme } from '../src/theme';
import { MasterRespondingIndicator } from '../src/components/ConversationComposerStatus';
import { ProviderStatusDetails } from '../src/components/ProviderStatusDialog';
let handlers: Parameters<typeof api.subscribeWorkspace>[1], seq = 0, reads = 0;
api.subscribeWorkspace = (_cursor, next) => { handlers = next; return { close() {} }; };
const resourceAdmission = { state: 'held', protected: true, reason: 'host_resource_pressure', observedAt: '2026-10-03T12:00:00.000Z', availableBytes: 128 * 1024 ** 2, reserveBytes: 256 * 1024 ** 2 } as EngineDto['resourceAdmission'];
const engine = { id: 'codex', displayName: 'Synthetic', enabled: true, authentication: 'error', reachability: 'unverified', intakeReady: false, models: [], resourceAdmission, authReason: 'timeout', authSource: 'cli_status', authObservedAt: '2026-10-03T12:00:00.000Z', authDetail: 'Authentication could not be verified.' } as EngineDto;
const agent = { id: 'agent', title: 'Quiet Agent' } as AgentDto;
const activity = { state: 'responding', executionId: 'exact', startedAt: new Date(Date.now() - 600_000).toISOString(), lastActivityAt: new Date(Date.now() - 300_000).toISOString() } as NonNullable<AgentHealthDto['runtimeActivity']>;
function Probe() {
  useWorkspaceStream();
  useQuery({ queryKey: queryKeys.engines.all, queryFn: async () => { document.body.dataset.reads = String(++reads); return [engine]; } });
  return <main>
    <button onClick={() => handlers.onStatus?.({ instanceId: 'fixture', cursor: seq, reset: false })}>Connect</button>
    <button onClick={() => handlers.onError?.(new Event('error'))}>Disconnect</button>
    <button onClick={() => handlers.onEvent?.({ id: ++seq, ts: new Date().toISOString(), event: { type: 'provider_status_changed', engineId: 'codex' } })}>Recover provider</button>
    <button onClick={() => { for (let i = 0; i < 100; i++) handlers.onEvent?.({ id: ++seq, ts: new Date().toISOString(), event: { type: 'agent_event', projectId: 'project', agentId: 'agent', conversationIds: [], category: 'state', eventType: 'tool_call', seq: i } }); }}>Tool burst</button>
    <MasterRespondingIndicator agents={[agent]} healthByAgentId={new Map([['agent', { runtimeActivity: activity } as AgentHealthDto]])}/>
    <ProviderStatusDetails engines={[engine]} onTestAccess={() => {}}/>
  </main>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider theme={createPonderosaTheme('dark')}><CssBaseline/><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })}><Probe/></QueryClientProvider></ThemeProvider>);
