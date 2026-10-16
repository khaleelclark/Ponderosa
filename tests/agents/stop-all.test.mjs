import assert from 'node:assert/strict';
import test from 'node:test';
import '../shared/web-typescript-loader.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { AgentsTab, stopActiveAgentRuns } = await import('../../apps/web/src/components/AgentsTab.tsx');
const { MutationNotificationProvider } = await import('../../apps/web/src/components/MutationNotifications.tsx');
const { api } = await import('../../apps/web/src/api/index.ts');

const targets = [
  { agentId: 'scoped-parent', runId: 'observed-parent-run' },
  { agentId: 'scoped-child', runId: 'observed-child-run' },
];

test('check 37: Stop All targets only the displayed organization’s exact observed Runs and reports each failure', async t => {
  const original = api.cancelRun, calls = [];
  t.after(() => { api.cancelRun = original; });
  api.cancelRun = async (agentId, request) => {
    calls.push({ agentId, ...request });
    if (agentId === 'scoped-child') throw new Error('Controlled refusal; target remains live');
    return { cancelled: true };
  };
  assert.deepEqual(await stopActiveAgentRuns(targets), { stopped: 1, failed: 1 });
  assert.deepEqual(calls.map(({ agentId, targetRunId }) => ({ agentId, runId: targetRunId })), targets);
  assert.ok(calls.every(call => typeof call.idempotencyKey === 'string' && call.idempotencyKey.length > 0));
  assert.equal(new Set(calls.map(call => call.idempotencyKey)).size, targets.length, 'Independent cancellations need independent replay identities');
  assert.ok(!calls.some(call => call.agentId === 'unrelated-agent'), 'An unrelated organization was targeted');
  const priorKeys = calls.map(call => call.idempotencyKey);
  calls.length = 0;
  assert.deepEqual(await stopActiveAgentRuns(targets), { stopped: 1, failed: 1 });
  assert.deepEqual(calls.map(call => call.idempotencyKey), priorKeys, 'Retry must retain the exact cancellation identities');
});

test('check 37: an incomplete organization cannot offer a misleading Stop All action', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const agents = targets.map(({ agentId }) => ({ id: agentId, projectId: 'project', conversationId: 'chat', title: agentId, handle: agentId, activeEngine: 'codex', state: 'active', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' }));
  const props = { agents, engines: [], conversations: [], projectId: 'project', scopeConversationId: 'chat', statusByAgentId: new Map(agents.map(a => [a.id, 'working'])), healthByAgentId: new Map(targets.map(({ agentId, runId }) => [agentId, { runtimeActivity: { executionId: runId } }])), onOpenAgent() {}, onNewAgent() {}, onLoadOrganizationData: async () => {} };
  const render = complete => renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(MutationNotificationProvider, null, React.createElement(AgentsTab, { ...props, organizationDataComplete: complete }))));
  try {
    assert.match(render(true), />Stop All</, 'The complete positive control must offer Stop All for its active Runs');
    assert.doesNotMatch(render(false), />Stop All</, 'A partial roster must not claim an all-organization stop');
  } finally { client.clear(); }
});
