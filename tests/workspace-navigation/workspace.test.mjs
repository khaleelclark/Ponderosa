import {AgentStore} from '@ponderosa/agents';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { withFixture, until, fixtureTestOptions as options } from '../shared/fixture.mjs';


test('checks 61, 62, 63: folder membership, rename, order, stars and collapse persist with conflict fencing', options, t => withFixture(t, async f => {
  const a = await f.createChat('Chat A'), b = await f.createChat('Chat B'), c = await f.createChat('Chat C');
  const url = '/api/workspace/preferences', initial = f.ok(await f.api('GET', url));
  const folders = [{ id: randomUUID(), name: 'First folder', expanded: true, conversationIds: [a.id, b.id] }, { id: randomUUID(), name: 'Second folder', expanded: true, conversationIds: [c.id] }];
  const saved = f.ok(await f.api('PATCH', url, { chatFolders: folders, chatFoldersRevision: initial.revision }));
  const moved = [{ ...folders[1], name: 'Renamed folder', expanded: false, starred: true, conversationIds: [c.id, b.id] }, { ...folders[0], conversationIds: [a.id] }];
  const reordered = f.ok(await f.api('PATCH', url, { chatFolders: moved, chatFoldersRevision: saved.revision, chatSort: 'custom', chatOrder: [c.id, b.id, a.id], starredResourceIds: [`conversation:${b.id}`] }));
  assert.equal((await f.api('PATCH', url, { chatFolders: folders, chatFoldersRevision: saved.revision })).status, 409);
  assert.equal((await f.api('PATCH', url, { chatFolders: [...moved, { id: randomUUID(), name: 'Duplicate membership', expanded: true, conversationIds: [b.id] }], chatFoldersRevision: reordered.revision })).status, 400);
  await f.reopen();
  const reopened = f.ok(await f.api('GET', url)); assert.deepEqual(reopened.chatFolders, moved); assert.deepEqual(reopened.chatOrder, [c.id, b.id, a.id]); assert.deepEqual(reopened.starredResourceIds, [`conversation:${b.id}`]);
  f.ok(await f.api('PATCH', url, { chatFolders: [moved[1]], chatFoldersRevision: reopened.revision }));
  for (const chat of [a, b, c]) assert.equal(f.ok(await f.api('GET', `/api/conversations/${chat.id}`)).conversation.projectId, chat.projectId, 'Display grouping changed storage ownership');
}));

test('check 63: recent resources retain stable identities and unknown routes do not replace them', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Remembered resource'), agent = await f.createIdleAgent(chat, 'Remembered Agent');
  f.ok(await f.api('POST', '/api/workspace/recent-resources/use', { kind: 'conversation', resourceId: chat.id }));
  f.ok(await f.api('POST', '/api/workspace/recent-resources/use', { kind: 'agent', resourceId: agent.id }));
  assert.equal((await f.api('POST', '/api/workspace/recent-resources/use', { kind: 'agent', resourceId: randomUUID() })).status, 404);
  await f.reopen();
  const recent = f.ok(await f.api('GET', '/api/workspace/recent-resources'));
  assert.ok(recent.resources.some(x => x.kind === 'conversation' && x.resourceId === chat.id)); assert.ok(recent.resources.some(x => x.kind === 'agent' && x.resourceId === agent.id));
}));

test('checks 64, 66: search filters and focus lookups identify the exact source message and Chat', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Search source'), other = await f.createChat('Other source'), agent = await f.createIdleAgent(chat, 'Search Agent');
  const marker = `needle${randomUUID().replaceAll('-', '')}`;
  const receipt = f.ok(await f.api('POST', `/api/conversations/${chat.id}/messages`, { text: `Shared ${marker}`, idempotencyKey: randomUUID() }));
  await f.send(agent.id, `Private ${marker}`); await f.settled(agent.id);
  const peer = await f.createIdleAgent(chat, 'Search peer'), sender = await f.hold(agent.id);
  f.plans.set(peer.id, [{ hold: true }]);
  f.ok(await f.tool(sender, 'ponderosa_message', { intent: 'collaboration', recipientAgentIds: [peer.id], urgency: 'urgent', text: `Collaboration ${marker}` }));
  for (const kind of ['conversation', 'agent']) {
    const found = f.ok(await f.api('GET', `/api/search?q=${marker}&kind=${kind}`));
    assert.ok(found.results.length > 0); assert.ok(found.results.every(x => x.chat.kind === kind && x.project.id === chat.projectId));
    assert.ok(!found.results.some(x => x.project.id === other.projectId));
    if (kind === 'conversation') {
      const hit = found.results.find(x => x.communicationEventId === receipt.communicationEventId); assert.ok(hit);
      const focus = f.ok(await f.api('GET', `/api/conversations/${chat.id}?limit=1&focusId=${encodeURIComponent(hit.messageId)}`));
      assert.ok(focus.messages.some(x => x.communicationEventId === hit.communicationEventId));
    }
  }
  assert.equal(f.ok(await f.api('GET', '/api/search?q=nonexistentfixtureword&kind=agent')).results.length, 0);
  assert.equal((await f.api('GET', `/api/search?q=${marker}&kind=invalid`)).status, 400);
}));

test('checks 23, 65, 66, 68: working-file search pages stay bound to query and owner, and browsing can refresh', options, t => withFixture(t, async f => {
  const a = await f.createChat('Files A'), b = await f.createChat('Files B');
  await mkdir(path.join(a.workingDirectory, 'notes')); await mkdir(path.join(b.workingDirectory, 'notes'));
  for (const name of ['match-a.txt', 'match-b.txt', 'match-c.txt']) await writeFile(path.join(a.workingDirectory, 'notes', name), `A ${name}`);
  await writeFile(path.join(b.workingDirectory, 'notes', 'match-private.txt'), 'B private');
  const base = `/api/search/files?projectId=${a.projectId}&conversationId=${a.id}&q=match&limit=1`, ids = []; let cursor, first;
  do {
    const page = f.ok(await f.api('GET', base + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''))); first ??= page;
    assert.ok(page.results.every(x => x.project.id === a.projectId && x.conversationId === a.id)); ids.push(...page.results.map(x => x.path)); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(ids.sort(), ['notes/match-a.txt', 'notes/match-b.txt', 'notes/match-c.txt']);
  assert.equal(new Set(ids).size, 3);
  assert.equal((await f.api('GET', base.replace('q=match', 'q=changed') + `&cursor=${encodeURIComponent(first.nextCursor)}`)).status, 400);
  assert.equal((await f.api('GET', base.replace(a.id, b.id))).status, 404);
  const browse = () => f.api('GET', `/api/conversations/${a.id}/files?path=notes`).then(f.ok);
  assert.equal((await browse()).entries.length, 3);
  await writeFile(path.join(a.workingDirectory, 'notes', 'new.txt'), 'New file'); assert.equal((await browse()).entries.length, 4);
  assert.equal(f.ok(await f.api('GET', `/api/conversations/${a.id}/files`)).kind, 'dir');
  assert.equal((await f.api('GET', `/api/conversations/${a.id}/files?path=../outside.txt`)).status, 400);
}));

test('checks 13, 57: older message and work-log pages retain exact IDs without duplicates', options, t => withFixture(t, async f => {
  const chat = await f.createChat('History pages'), agent = await f.createIdleAgent(chat, 'History Agent');
  const runIds = [];
  for (const text of ['First message', 'Second message', 'Third message']) { await f.send(agent.id, text); const d = await f.settled(agent.id, runIds); runIds.splice(0, runIds.length, ...d.runs.map(x => x.id)); }
  const ids = []; let cursor;
  do {
    const page = f.ok(await f.api('GET', `/api/agents/${agent.id}/history/runOutput?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    ids.push(...page.items.map(x => x.id)); assert.ok(page.items.every(x => runIds.includes(x.executionId))); cursor = page.history.cursor;
  } while (cursor);
  assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
  const full = await f.detail(agent.id), target = full.messages.at(-1);
  const focused = f.ok(await f.api('GET', `/api/agents/${agent.id}?limit=1&focusId=${encodeURIComponent(target.id)}`));
  assert.ok(focused.messages.some(x => x.id === target.id));
  const input = f.ok(await f.api('GET', `/api/runs/${runIds[0]}/provider-input?exact=1`)); assert.ok(input.exactPrompt);
}));

test('check 90: usage ranges and owner filters report known totals and unavailable metrics honestly', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Usage source'), other = await f.createChat('Unused scope'), agent = await f.createAgent(chat, 'Counted Agent');
  const usage = f.ok(await f.api('GET', `/api/agents/${agent.id}/usage`));
  assert.equal(usage.finalizedRuns, 1); assert.equal(usage.reportedRuns, 1); assert.equal(usage.inputTokens, 20); assert.equal(usage.outputTokens, 8);
  assert.equal(usage.metricAvailability.inputTokens, 'available'); assert.equal(usage.metricAvailability.reasoningOutputTokens, 'unavailable');
  assert.equal(f.ok(await f.api('GET', `/api/conversations/${other.id}/usage`)).finalizedRuns, 0);
  assert.equal(f.ok(await f.api('GET', `/api/agents/${agent.id}/usage?from=2099-01-01T00:00:00.000Z`)).finalizedRuns, 0);
  assert.equal((await f.api('GET', `/api/agents/${agent.id}/usage?from=invalid`)).status, 400);
  assert.equal((await f.api('GET', `/api/agents/${agent.id}/usage?from=2026-01-02&to=2026-01-01`)).status, 400);
}));

test('check 90: scope token totals require every finalized Run to report each metric', options, t => {
 let store;
 return withFixture(t,async f=>{
  const chat=await f.createChat('Mixed token coverage'),first=await f.createAgent(chat,'First reporter'),second=await f.createAgent(chat,'Partial reporter');
  store.sqlite.prepare('UPDATE runs SET cached_input_tokens=0 WHERE agent_id=?').run(first.id);
  store.sqlite.prepare('UPDATE runs SET input_tokens=NULL, cached_input_tokens=NULL WHERE agent_id=?').run(second.id);
  const usage=f.ok(await f.api('GET',`/api/conversations/${chat.id}/usage`));
  assert.equal(usage.finalizedRuns,2); assert.equal(usage.reportedRuns,2); assert.equal(usage.coverage,1);
  assert.equal(usage.inputTokens,20,'Known partial input is retained for callers');
  assert.equal(usage.metricAvailability.inputTokens,'unavailable','A partial sum is not a complete scope total');
  assert.equal(usage.metricAvailability.cachedInputTokens,'unavailable','One explicit zero does not cover a missing Run');
  assert.equal(usage.outputTokens,16); assert.equal(usage.metricAvailability.outputTokens,'available');
  assert.equal(usage.totalTokens,56); assert.equal(usage.metricAvailability.totalTokens,'available');
  await import('../shared/web-typescript-loader.mjs');
  const {createRequire}=await import('node:module');
  const requireWeb=createRequire(new URL('../../apps/web/package.json',import.meta.url));
  const React=requireWeb('react'),{renderToStaticMarkup}=requireWeb('react-dom/server');
  const {TokenUsageDetails}=await import('../../apps/web/src/components/TokenUsageButton.tsx');
  const markup=renderToStaticMarkup(React.createElement(TokenUsageDetails,{data:usage})).replace(/<style[^>]*>[\s\S]*?<\/style>/g,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  assert.match(markup,/Input Unavailable/,'The real usage view must not show a partial input as a total');
  assert.match(markup,/Output 16/,'The complete metric stays visible');
  assert.match(markup,/Reported Usage By Provider/);
  assert.match(markup,/Total-token Coverage 2 \/ 2 Runs/);
  const incomplete=renderToStaticMarkup(React.createElement(TokenUsageDetails,{data:{...usage,reportedRuns:199,finalizedRuns:200,coverage:199/200}})).replace(/<style[^>]*>[\s\S]*?<\/style>/g,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  assert.match(incomplete,/Total-token Coverage 199 \/ 200 Runs/,'Incomplete coverage must never round up to 100%');
  assert.doesNotMatch(incomplete,/100%/);
  const exact=renderToStaticMarkup(React.createElement(TokenUsageDetails,{data:{...usage,outputTokens:12345,durationMs:1001}})).replace(/<style[^>]*>[\s\S]*?<\/style>/g,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  assert.ok(exact.includes(`Output ${new Intl.NumberFormat().format(12345)}`),'Token totals are not silently rounded');
  assert.match(exact,/Aggregate Run Time 1s 1ms/,'Duration retains exact milliseconds');
  const single=f.ok(await f.api('GET',`/api/agents/${first.id}/usage`));
  assert.equal(single.cachedInputTokens,0); assert.equal(single.metricAvailability.cachedInputTokens,'available','Reported zero is valid');
  const empty=f.ok(await f.api('GET',`/api/conversations/${chat.id}/usage?from=2099-01-01T00:00:00.000Z`));
  assert.equal(empty.metricAvailability.inputTokens,'unavailable');
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('check 90: provider request counts require exact receipt coverage instead of invented zeros', options, t => {
 let store;
 return withFixture(t,async f=>{
  const chat=await f.createChat('Request telemetry scope'),first=await f.createAgent(chat,'First counted Agent'),second=await f.createAgent(chat,'Second counted Agent');
  const save=(agent,json)=>store.sqlite.prepare('UPDATE runs SET provider_request_usage_json=? WHERE agent_id=?').run(json,agent.id);
  const usage=async agent=>f.ok(await f.api('GET','/api/agents/'+agent.id+'/usage'));
  const total=async()=>f.ok(await f.api('GET','/api/conversations/'+chat.id+'/usage'));
  for(const invalid of [null,'','{','{}','null','[null]','[[]]','[{"unknown":1}]','[{"totalTokens":-1}]','[{"inputTokens":1.5}]','[{"totalTokens":"12"}]']){
   save(first,invalid);const value=await usage(first);assert.equal(value.finalizedRuns,1);assert.equal(value.inputTokens,20);assert.equal(Object.hasOwn(value,'providerRequests'),false,'Unknown or malformed receipt must stay unavailable: '+invalid);
  }
  save(first,'[]');assert.equal((await usage(first)).providerRequests,0,'Explicit empty receipts establish zero');
  save(first,'[{"inputTokens":20,"outputTokens":8,"totalTokens":28},{}]');assert.equal((await usage(first)).providerRequests,2,'Each actual receipt counts, even if that request did not expose token fields');
  save(second,null);assert.equal(Object.hasOwn(await total(),'providerRequests'),false,'Known requests cannot disguise another finalized Run missing receipts');
  save(second,'[{"totalTokens":28}]');assert.equal((await total()).providerRequests,3);
  assert.equal(f.ok(await f.api('GET','/api/conversations/'+chat.id+'/usage?from=2099-01-01T00:00:00.000Z')).providerRequests,0,'An empty finalized scope has an exact zero count');
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('check 90: aggregate Run time stays unavailable for incomplete or reversed wall-clock observations', options, t => {
 let store;
 return withFixture(t,async f=>{
  const chat=await f.createChat('Wall-clock telemetry');
  const create=title=>f.createIdleAgent(chat,title);
  const append=(agent,start,end)=>{const executionId=randomUUID();store.appendEvent(agent.id,{type:'agent_lifecycle',status:'running',reason:'active_run',executionId,engine:'codex'},start);store.appendEvent(agent.id,{type:'agent_lifecycle',status:'completed',reason:'turn_completed',executionId},end);return executionId;};
  const usage=async agent=>f.ok(await f.api('GET','/api/agents/'+agent.id+'/usage'));
  const zero=await create('Known zero interval');append(zero,'2026-11-03T10:00:00.000Z','2026-11-03T10:00:00.000Z');assert.equal((await usage(zero)).durationMs,0);
  append(zero,'2026-11-03T11:00:00.000Z','2026-11-03T11:00:01.250Z');assert.equal((await usage(zero)).durationMs,1250);
  const backwards=await create('Backwards clock');append(backwards,'2026-11-03T10:00:00.000Z','2026-11-03T10:00:01.000Z');append(backwards,'2026-11-03T11:00:00.000Z','2026-11-03T10:59:59.000Z');assert.equal(Object.hasOwn(await usage(backwards),'durationMs'),false,'One real reversed canonical lifecycle interval makes the aggregate unknown');
  const incomplete=await create('Incomplete time projection'),id=append(incomplete,'2026-11-03T10:00:00.000Z','2026-11-03T10:00:01.000Z');
  for(const [start,end] of [['2026-11-03T10:00:00.000Z',null],['invalid','2026-11-03T10:00:01.000Z'],['2026-11-03T10:00:00.000Z','invalid'],['-271821-04-20T00:00:00.000Z','+275760-09-13T00:00:00.000Z']]){
   store.sqlite.prepare('UPDATE runs SET started_at=?,completed_at=? WHERE agent_id=? AND id=?').run(start,end,incomplete.id,id);assert.equal(Object.hasOwn(await usage(incomplete),'durationMs'),false);
  }
  const overflow=await create('Unsafe duration aggregate');for(let index=0;index<2;index++)append(overflow,'-100000-01-01T00:00:00.000Z','+100000-01-01T00:00:00.000Z');
  assert.equal(Object.hasOwn(await usage(overflow),'durationMs'),false,'Individually safe intervals cannot create an unsafe aggregate');
  const empty=f.ok(await f.api('GET','/api/agents/'+zero.id+'/usage?from=2099-01-01T00:00:00.000Z'));assert.equal(empty.finalizedRuns,0);assert.equal(empty.durationMs,0);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('checks 59, 89: acknowledgement does not answer a Decision; resolution and category clearing affect the intended notification', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Needs attention'), a = await f.createIdleAgent(chat, 'Question A'), b = await f.createIdleAgent(chat, 'Question B');
  const sA = await f.hold(a.id), sB = await f.hold(b.id);
  const dA = f.ok(await f.tool(sA, 'ponderosa_decision', { question: 'First pending question', mode: 'text', blocking: true }));
  const dB = f.ok(await f.tool(sB, 'ponderosa_decision', { question: 'Second pending question', mode: 'text', blocking: true }));
  const list = () => f.api('GET', '/api/notifications').then(f.ok), before = await list();
  const nA = before.items.find(x => x.decision?.id === dA.id), nB = before.items.find(x => x.decision?.id === dB.id);
  assert.ok(nA && nB); assert.equal(before.openActionCount, 2);
  assert.equal((await f.api('POST', `/api/notifications/${nA.id}/read`)).status, 409);
  f.ok(await f.api('POST', '/api/notifications/acknowledge-batch', { notificationIds: [nA.id, nA.id] }));
  const acknowledged = await list(); assert.equal(acknowledged.openActionCount, 2); assert.equal(acknowledged.unacknowledgedActionCount, 1);
  assert.equal(f.ok(await f.api('GET', `/api/decisions?agentId=${a.id}&status=pending`)).length, 1);
  f.ok(await f.api('POST', '/api/notifications/dismiss-all', { kind: 'updates' })); assert.equal((await list()).openActionCount, 2);
  f.ok(await f.api('POST', `/api/decisions/${dA.id}/respond`, { text: 'Exact first answer' }));
  const after = await list(); assert.equal(after.openActionCount, 1); assert.ok(after.items.some(x => x.id === nB.id && x.status === 'open'));
  assert.equal(f.ok(await f.api('GET', `/api/decisions?agentId=${b.id}&status=pending`))[0].id, dB.id);
}));

test('check 89: Agent notification override and inherited Chat mode persist without changing other scopes', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Notification inheritance'), other = await f.createChat('Other settings'), agent = await f.createIdleAgent(chat, 'Inheriting Agent');
  f.ok(await f.api('PUT', `/api/notification-settings/conversation/${chat.id}`, { mode: 'muted' }));
  f.ok(await f.api('PUT', `/api/notification-settings/agent/${agent.id}`, { mode: 'all' }));
  f.ok(await f.api('PUT', `/api/notification-settings/agent/${agent.id}`, { mode: 'inherit' }));
  await f.reopen(); const prefs = f.ok(await f.api('GET', '/api/workspace/preferences'));
  assert.equal(prefs.notificationScopes[`conversation:${chat.id}`], 'muted'); assert.equal(prefs.notificationScopes[`agent:${agent.id}`], undefined); assert.equal(prefs.notificationScopes[`conversation:${other.id}`], undefined);
  assert.equal((await f.api('PUT', `/api/notification-settings/conversation/${chat.id}`, { mode: 'inherit' })).status, 400);
}));


test('Chat roster and collection searches treat percent, underscore and backslash as literal text',options,t=>withFixture(t,async f=>{
 const marker='060 %_'+String.fromCharCode(92)+' literal';
 const chat=await f.createChat('Chat '+marker),target=await f.createIdleAgent(chat,'Agent '+marker);
 await f.createIdleAgent(chat,'Agent 060 anything literal');
 for(const url of [`/api/conversations/${chat.id}/members`,`/api/projects/${chat.projectId}/agents`,`/api/projects/${chat.projectId}/conversations`,`/api/projects/${chat.projectId}/team-directory`,'/api/projects']){
  const result=f.ok(await f.api('GET',`${url}?search=${encodeURIComponent(marker)}&limit=1`));
  if(url.endsWith('/team-directory'))assert.equal(result.totalAgents,1);
  else{assert.equal(result.length,1);if(url.endsWith('/agents')||url.endsWith('/members'))assert.equal(result[0].id,target.id);else if(url.endsWith('/conversations'))assert.equal(result[0].id,chat.id);else assert.equal(result[0].id,chat.projectId);}
 }
}));

test('ordinary Agent activity is unread without notification noise by default, with alerts opt-in and durable', options, t => withFixture(t, async f => {
  const preferences = () => f.api('GET', '/api/workspace/preferences').then(f.ok);
  assert.deepEqual((await preferences()).notifications, { directResponses: false, broadcasts: false });
  const chat = await f.createChat('Quiet activity');
  const agents = await Promise.all([1, 2, 3].map(n => f.createIdleAgent(chat, `Quiet Agent ${n}`)));
  const notices = () => f.api('GET', '/api/notifications?limit=100').then(f.ok);
  const before = new Set((await notices()).items.map(n => n.id));
  for (let round = 0; round < 10; round++) {
    await Promise.all(agents.map(async agent => {
      const previous = (await f.detail(agent.id)).runs.map(run => run.id);
      await f.send(agent.id, `Quiet burst ${round}`);
      await f.settled(agent.id, previous);
    }));
  }
  assert.equal((await notices()).items.filter(n => !before.has(n.id)).length, 0);
  for (const agent of agents) {
    const detail = await f.detail(agent.id);
    assert.equal(detail.messages.filter(m => m.role === 'assistant' && m.text === 'Explicit fixture reply').length, 10);
  }
  const projection = () => f.api('POST', '/api/notifications/projection', { projectIds: [chat.projectId], conversationIds: [chat.id] }).then(f.ok);
  assert.equal((await projection()).conversations[chat.id].quietUnreadCount, 30);
  assert.equal((await projection()).conversations[chat.id].totalCount, 0, 'quiet activity must not create a badge');
  await f.reopen();
  assert.equal((await projection()).conversations[chat.id].quietUnreadCount, 30);
  const ids = (await Promise.all(agents.map(agent => f.detail(agent.id)))).flatMap(detail => detail.messages).filter(message => message.role === 'assistant').map(message => message.communicationEventId);
  assert.equal(ids.length, 30);
  assert.equal(f.ok(await f.api('POST', '/api/notifications/read-visible', { communicationEventIds: ids })).read, 30);
  await f.reopen();
  assert.equal((await projection()).conversations[chat.id].quietUnreadCount ?? 0, 0);
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { notifications: { directResponses: true, broadcasts: false } }));
  const previous = (await f.detail(agents[0].id)).runs.map(run => run.id);
  await f.send(agents[0].id, 'Explicitly enabled alert');
  await f.settled(agents[0].id, previous);
  assert.equal((await notices()).items.filter(n => !before.has(n.id) && n.kind === 'direct_responses').length, 1);
  await f.reopen();
  assert.deepEqual((await preferences()).notifications, { directResponses: true, broadcasts: false });
}));

for (const scope of ['conversation', 'agent']) for (const mode of ['muted', 'attention']) {
  test(`enabled response alerts retain independent unread for ${scope} ${mode}`, options, t => withFixture(t, async f => {
    const chat = await f.createChat('Scoped unread'), agent = await f.createIdleAgent(chat, 'Scoped Agent');
    f.ok(await f.api('PATCH', '/api/workspace/preferences', { notifications: { directResponses: true, broadcasts: false } }));
    f.ok(await f.api('PUT', `/api/notification-settings/${scope}/${scope === 'agent' ? agent.id : chat.id}`, { mode }));
    const projection = () => f.api('POST', '/api/notifications/projection', { projectIds: [chat.projectId], conversationIds: [chat.id], chatFolders: [{ id: 'scope-folder', conversationIds: [chat.id] }] }).then(f.ok);
    const send = async text => {
      const previous = (await f.detail(agent.id)).runs.map(run => run.id);
      await f.send(agent.id, text); await f.settled(agent.id, previous);
      return (await f.detail(agent.id)).messages.filter(m => m.role === 'assistant').at(-1).communicationEventId;
    };
    const first = await send('Muted unread one');
    assert.equal((await projection()).conversations[chat.id].totalCount, 0);
    assert.equal((await projection()).conversations[chat.id].quietUnreadCount, 1);
    assert.equal((await projection()).chatFolders['scope-folder'].quietUnreadCount, 1);
    await f.reopen();
    assert.equal((await projection()).conversations[chat.id].quietUnreadCount, 1);
    const second = await send('Unread arriving after visible snapshot');
    assert.equal(f.ok(await f.api('POST', '/api/notifications/read-visible', { communicationEventIds: [first, first] })).read, 1);
    assert.equal((await projection()).conversations[chat.id].quietUnreadCount, 1, 'exact visible IDs preserve later unread');
    assert.equal(f.ok(await f.api('POST', '/api/notifications/read-visible', { communicationEventIds: [second] })).read, 1);
    f.ok(await f.api('PUT', `/api/notification-settings/${scope}/${scope === 'agent' ? agent.id : chat.id}`, { mode: 'all' }));
    const third = await send('Enabled and visible alert');
    const search = f.ok(await f.api('GET', '/api/search?kind=conversation'));
    assert.equal(search.recentChats.find(row => row.chat.id === chat.id).unreadCount, 1, 'search deduplicates alert and quiet identity');
    const counts = (await projection()).conversations[chat.id];
    assert.equal(counts.totalCount, 1);
    assert.equal((await projection()).chatFolders['scope-folder'].totalCount, 1);
    assert.equal((await projection()).chatFolders['scope-folder'].quietUnreadCount ?? 0, 0);
    assert.equal(counts.quietUnreadCount ?? 0, 0, 'alert and quiet records share one identity');
    assert.equal(f.ok(await f.api('POST', '/api/notifications/read-visible', { communicationEventIds: [third, third] })).read, 1);
    assert.equal(f.ok(await f.api('POST', '/api/notifications/read-visible', { communicationEventIds: [third] })).read, 0);
    await f.reopen();
    assert.equal((await projection()).conversations[chat.id].totalCount, 0);
    assert.equal((await projection()).conversations[chat.id].quietUnreadCount ?? 0, 0);
  }));
}

test('deleted Chat unread cannot be projected, searched or acknowledged after restart', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Deleted unread Chat'), agent = await f.createIdleAgent(chat, 'Deleted unread Agent');
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { notifications: { directResponses: true, broadcasts: false } }));
  f.ok(await f.api('PUT', `/api/notification-settings/conversation/${chat.id}`, { mode: 'muted' }));
  await f.send(agent.id, 'Unread before deletion'); await f.settled(agent.id);
  const ids = (await f.detail(agent.id)).messages.filter(m => m.role === 'assistant').map(m => m.communicationEventId);
  assert.equal(f.ok(await f.api('DELETE', `/api/conversations/${chat.id}`, { expectedAgentIds: [agent.id] })).deleted, true);
  await f.reopen();
  assert.equal(f.ok(await f.api('POST', '/api/notifications/read-visible', { communicationEventIds: ids })).read, 0);
  assert.equal((await f.api('POST', '/api/notifications/projection', { projectIds: [chat.projectId], conversationIds: [chat.id] })).status, 404);
  assert.ok(!f.ok(await f.api('GET', '/api/search')).recentChats.some(row => row.chat.id === chat.id || row.chat.id === agent.id));
}));


for(const product of ['dev','branches'])test('authored notification scopes obey independent settings and inherited modes in '+product,{timeout:60000},async t=>withFixture(t,async f=>{
 const base=product==='branches'?'/api/branches/engine':'/api';
 const branch=product==='branches'?f.ok(await f.api('POST','/api/branches',{name:'Notification scope fixture',idempotencyKey:randomUUID()})):undefined;
 const chat=branch?f.ok(await f.api('POST','/api/branches/'+branch.id+'/chats',{label:'Authored scope fixture',defaultEngine:'codex'},{'idempotency-key':randomUUID()})):await f.createChat('Authored scope fixture');
 const create=title=>f.api('POST',base+'/projects/'+chat.projectId+'/agents',{title,engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()}).then(f.ok);
 const source=await create('Source'),peer=await create('Mention recipient');
 f.plans.set(source.id,[{hold:true}]);f.ok(await f.api('POST',base+'/agents/'+source.id+'/messages',{text:'Hold for authored setting verification',idempotencyKey:randomUUID()}));await until(()=>f.sessions.get(source.id),'held notification source');
 // Keep the recipient busy: this verifies passive FYI delivery without letting
 // the fixture's automatic idle-worker result steer our notification publisher.
 f.plans.set(peer.id,[{hold:true}]);f.ok(await f.api('POST',base+'/agents/'+peer.id+'/messages',{text:'Hold while receiving FYI',idempotencyKey:randomUUID()}));await until(()=>f.sessions.get(peer.id),'held FYI recipient');
 const session=f.sessions.get(source.id),projection=()=>f.api('POST',base+'/notifications/projection',{projectIds:[chat.projectId],conversationIds:[chat.id]}).then(f.ok);
 const rows=async()=> (await readFile(path.join(f.dataDir,'projects',chat.projectId,'communication-events.jsonl'),'utf8')).trim().split(String.fromCharCode(10)).map(JSON.parse);
 let previous=[];
 const cases=[
  ...[false,true].flatMap(directResponses=>[false,true].map(broadcasts=>({directResponses,broadcasts,chatMode:'all',agentMode:'inherit',allowed:Number(directResponses)+Number(broadcasts)}))),
  {directResponses:true,broadcasts:true,chatMode:'muted',agentMode:'inherit',allowed:0},
  {directResponses:true,broadcasts:true,chatMode:'muted',agentMode:'all',allowed:2},
  {directResponses:true,broadcasts:true,chatMode:'all',agentMode:'attention',allowed:0},
  {directResponses:true,broadcasts:true,chatMode:'all',agentMode:'inherit',allowed:2},
 ];
 for(const [index,c] of cases.entries()){
  if(previous.length)f.ok(await f.api('POST',base+'/notifications/read-visible',{communicationEventIds:previous}));
  f.ok(await f.api('PATCH',base+'/workspace/preferences',{notifications:{directResponses:c.directResponses,broadcasts:c.broadcasts}}));
  f.ok(await f.api('PUT',base+'/notification-settings/conversation/'+chat.id,{mode:c.chatMode}));
  f.ok(await f.api('PUT',base+'/notification-settings/agent/'+source.id,{mode:c.agentMode}));
  const marker='SCOPE-'+product+'-'+index+'-'+randomUUID();
  for(const [intent,text,extra] of [
   ['direct_to_user',marker+'-direct',{}],
   ['broadcast',marker+'-broadcast',{}],
   ['collaboration','#'+peer.handle+' '+marker+'-mention',{recipientAgentIds:[peer.id],messagePurpose:'fyi'}],
  ]){
   const sent=await f.tool(session,'ponderosa_message',{intent,text,...extra,idempotencyKey:randomUUID()});
   assert.equal(sent.status,200,JSON.stringify({index,intent,error:sent.body,sourceSteerCount:f.steers.filter(item=>item.agentId===source.id).length,peerSteerCount:f.steers.filter(item=>item.agentId===peer.id).length}));
  }
  const authored=(await rows()).filter(event=>event.text.includes(marker));assert.equal(authored.length,3);
  const mention=authored.find(event=>event.intent==='collaboration');assert.equal(mention.audienceSelector,'mention');assert.deepEqual(mention.audience.agentIds,[peer.id]);assert.equal(mention.identity.recipientHandles[peer.id],peer.handle);
  const notices=f.ok(await f.api('GET',base+'/notifications?limit=100')).items;
  assert.equal(notices.some(item=>item.communicationEventId===mention.eventId),false,'Agent mention is Team collaboration, not an operator alert');
  const view=(await projection()).conversations[chat.id];
  assert.equal(view.totalCount,c.allowed,JSON.stringify(c));assert.equal(view.quietUnreadCount??0,2-c.allowed,'ordinary activity stays unread without multiplying alert identities');
  const human=authored.filter(event=>event.intent!=='collaboration');
  if(c.chatMode==='all'&&c.agentMode==='inherit')for(const event of human){
   const enabled=event.intent==='user_dm'?c.directResponses:c.broadcasts;
   assert.equal(notices.some(item=>item.communicationEventId===event.eventId),enabled,'only the matching authored category enables this alert');
  }
  previous=human.map(event=>event.eventId);
 }
 assert.equal(f.turns.filter(turn=>turn.agentId===peer.id).length,1,'FYI mention keeps the existing recipient Run');assert.equal(f.steers.filter(item=>item.agentId===peer.id).length,0,'FYI mention does not interrupt its busy recipient');
}));

test('workflow unread projection uses current canonical Chat membership, preserves explicit groups and keeps product scope',{timeout:60000},async t=>withFixture(t,async f=>{
 const base='/api/branches/engine',branch=f.ok(await f.api('POST','/api/branches',{name:'Grouped quiet unread',idempotencyKey:randomUUID()}));
 const createChat=label=>f.api('POST','/api/branches/'+branch.id+'/chats',{label,defaultEngine:'codex'},{'idempotency-key':randomUUID()}).then(f.ok);
 const createMessage=async chat=>{
  const agent=f.ok(await f.api('POST',base+'/projects/'+chat.projectId+'/agents',{title:'Grouped author',engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()}));
  f.plans.set(agent.id,[{hold:true}]);f.ok(await f.api('POST',base+'/agents/'+agent.id+'/messages',{text:'Hold for grouped unread verification',idempotencyKey:randomUUID()}));await until(()=>f.sessions.get(agent.id),'grouped source');
  const text='GROUP-'+randomUUID();f.ok(await f.tool(f.sessions.get(agent.id),'ponderosa_message',{intent:'broadcast',text,idempotencyKey:randomUUID()}));
  return (await readFile(path.join(f.dataDir,'projects',chat.projectId,'communication-events.jsonl'),'utf8')).trim().split(String.fromCharCode(10)).map(JSON.parse).find(event=>event.text===text).eventId;
 };
 const first=await createChat('First member'),second=await createChat('Second member'),firstId=await createMessage(first);await createMessage(second);
 const input={projectIds:[],conversationIds:[],branchIds:[branch.id,branch.id],chatFolders:[{id:'branch:'+branch.id,conversationIds:[first.id]}]};
 const projection=()=>f.api('POST',base+'/notifications/projection',input).then(f.ok);
 let view=await projection();assert.deepEqual(Object.keys(view.branches),[branch.id]);assert.equal(view.branches[branch.id].totalCount,0);assert.equal(view.branches[branch.id].quietUnreadCount,2);
 assert.equal(view.chatFolders['branch:'+branch.id].quietUnreadCount,1,'caller folder cannot collide with internal workflow grouping');assert.deepEqual(Object.keys(view.conversations),[first.id],'no full workflow Chat membership crosses the projection boundary');
 const third=await createChat('Later member');await createMessage(third);view=await projection();assert.equal(view.branches[branch.id].quietUnreadCount,3,'fresh canonical membership includes later Chats without a client directory fetch');
 const foreign=f.ok(await f.api('POST','/api/notifications/projection',{projectIds:[],conversationIds:[],branchIds:[branch.id]}));assert.equal(foreign.branches[branch.id].quietUnreadCount??0,0);assert.equal(foreign.branches[branch.id].totalCount,0);
 f.ok(await f.api('POST',base+'/notifications/read-visible',{communicationEventIds:[firstId]}));view=await projection();assert.equal(view.branches[branch.id].quietUnreadCount,2);assert.equal(view.chatFolders['branch:'+branch.id].quietUnreadCount??0,0);
 for(const branchIds of [Array(201).fill(branch.id),'not-an-array',[1]])assert.equal((await f.api('POST',base+'/notifications/projection',{projectIds:[],conversationIds:[],branchIds})).status,400);
}));
