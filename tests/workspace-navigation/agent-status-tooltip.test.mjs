import assert from 'node:assert/strict';
import test from 'node:test';
import '../shared/web-typescript-loader.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { summarizeWorkspaceActivity } from '@ponderosa/core';
const { SidebarActivityBadge } = await import('../../apps/web/src/components/SidebarActivityBadge.tsx');
const { SidebarResourceRow } = await import('../../apps/web/src/components/SidebarResourceRow.tsx');

const render = props => renderToStaticMarkup(React.createElement(SidebarActivityBadge, props));
test('individual Agent status is concise for every canonical phase, unknown and stale evidence', () => {
  for (const [health, label] of [
    [{ status: 'running', executionId: 'run' }, 'Working'],
    [{ status: 'running' }, 'Waiting'],
    [{ status: 'needs_decision' }, 'Needs decision'],
    [{ status: 'compacting' }, 'Recovering'],
    [{ status: 'failed', reason: 'private_diagnostic_code' }, 'Error'],
    [{ status: 'idle' }, 'Idle'],
    [undefined, 'Unknown'],
  ]) {
    for (const fresh of [true, false]) {
      const html = render({ agent: { title: 'Boston', health }, activity: summarizeWorkspaceActivity([health], '2026-10-23T12:00:00Z'), fresh, showLabel: true });
      assert.ok(html.includes(`aria-label="Boston · ${label}${fresh ? '' : ' · Status updates delayed'}"`), label);
      assert.doesNotMatch(html, /Last confirmed|2026-10-23|private_diagnostic_code|0 waiting|1 working/);
    }
  }
});

test('one-member groups retain aggregate counts instead of becoming Agent tooltips', () => {
  const html = render({ activity: summarizeWorkspaceActivity([{ status: 'running', executionId: 'run' }], '2026-10-23T12:00:00Z'), fresh: true });
  assert.match(html, /1 working, 0 waiting/);
  assert.match(html, /Last confirmed 2026-10-23/);
});

test('row navigation and status have separate tooltip/focus regions', () => {
  const html = renderToStaticMarkup(React.createElement(SidebarResourceRow, {
    id: 'agent:one', href: '/agents/one', label: 'Open Boston in First Chat', title: 'Boston', detail: 'First Chat · #boston', icon: null,
    starred: false, onOpen() {}, onStar() {}, status: React.createElement(SidebarActivityBadge, { agent: { title: 'Boston', health: { status: 'needs_decision' } }, fresh: true, showLabel: true }),
  }));
  assert.match(html, /href="\/agents\/one"/);
  assert.match(html, /aria-label="Open Boston in First Chat"/);
  assert.ok(html.indexOf('</a>') < html.indexOf('data-agent-status='), 'status must not nest inside the identity tooltip');
  assert.match(html, /aria-label="Boston · Needs decision" tabindex="0"/);
});
