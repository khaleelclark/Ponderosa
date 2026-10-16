import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultEngineRegistrations } from '@ponderosa/engines';
import { createServer } from '../../apps/server/dist/app.js';
import { until } from '../shared/fixture.mjs';

import { withRealCodex, options } from '../shared/real-codex-fixture.mjs';

const noHostActions = 'Do not use files, shell, browser, network, provider-native helpers, or create any Agents. Use only the specified Ponderosa communication tools.';


test('checks 3, 17: real Codex reply and blind continued-session attachment consumption', options, t => withRealCodex(t, async ({ api, wait, createChat }) => {
  const chat = await createChat('Real attachment regression');
  const agent = await api('POST', `/api/projects/${chat.projectId}/agents`, { title: 'Fixture reader', engine: 'codex', conversationId: chat.id,
    initialMessage: 'Reply via ponderosa_message exactly READY. Do not use files, shell, browser, or contact/create Agents.', idempotencyKey: randomUUID(), awaitResult: true });
  const initial = await wait(agent.id);
  const conversation = await api('GET', `/api/conversations/${chat.id}`);
  const ready = conversation.messages.find(x => x.role === 'assistant' && x.authorAgentId === agent.id && x.text.trim() === 'READY');
  assert.ok(ready, 'Real Codex READY reply did not reach Chat');
  assert.ok(initial.messages.some(x => x.role === 'assistant' && x.communicationEventId === ready.id), 'Chat reply is absent from the Agent audit');
  const marker = `file-${randomUUID()}`;
  const asset = await api('POST', `/api/agents/${agent.id}/attachments`, Buffer.from(`Harmless marker: ${marker}`), { 'content-type': 'application/octet-stream', 'x-ponderosa-filename': 'fixture.txt', 'x-ponderosa-media-type': 'text/plain' });
  await api('POST', `/api/agents/${agent.id}/messages`, { text: 'Read only the explicitly attached fixture.txt through its supplied path; file/shell use is allowed only for that disposable file. Reply with ponderosa_message exactly READ: followed by the marker found inside. Do not inspect other files, open websites, contact/create Agents, or change anything.', attachmentIds: [asset.id], idempotencyKey: randomUUID() });
  const result = await wait(agent.id, initial.runs.map(x => x.id));
  assert.ok(result.messages.some(x => x.text.trim() === `READ:${marker}`));
}));

test('checks 49, 51, 54, 56: real Codex worker question escalates to a blocking Decision and resumes its exact Request', options, t => withRealCodex(t, async f => {
  const chat = await f.createChat('Real worker question regression'), manager = await f.createAgent(chat, 'Question manager');
  const worker = await f.createAgent(chat, 'Question worker', manager.id), questionNonce = `question-${randomUUID()}`, taskTag = `task-${randomUUID()}`;
  await f.send(worker.id, `Your private question marker is ${questionNonce}. Reply now via ponderosa_message intent direct_to_user text PRIVATE_READY. When delegated a Request, first call ponderosa_update_request with question "QUESTION:<your-private-question-marker>:What is the operator's answer token?". End the turn and wait for the correlated answer; do not guess. Once answered, report completed using ponderosa_update_request text "WORKER:<your-private-question-marker>:<actual-answer-text>" exactly. Never substitute a standalone message. ${noHostActions}`);
  const warm = await f.wait(worker.id);
  assert.ok(warm.messages.some(x => x.role === 'assistant' && x.text === 'PRIVATE_READY'));
  const coordinate = { recipientAgentId: worker.id, text: `${taskTag}: Ask your requester for the operator's answer token using a correlated question, then return the answer in your instructed WORKER format. ${noHostActions}`, completionMode: 'join', wakePolicy: 'final_only' };
  await f.send(manager.id, `Call ponderosa_coordinate once with ${JSON.stringify(coordinate)} and end the turn. When the worker's coordination_question arrives, ask the operator using ponderosa_decision mode text blocking true, question containing the worker's exact question. Do not guess an answer or answer the worker yet. End the turn until that exact Decision is answered. After its response arrives, call ponderosa_update_request kind answer with the exact requestId and inReplyToUpdateId of the pending worker question; use the actual Decision response text verbatim. End the turn until the Join completes. Finally send exactly one ponderosa_message intent direct_to_user taskDelivery final text "QUESTION_DONE:<worker-question-marker>:<answer-returned-by-worker>". Preserve the question correlation across the Decision. ${noHostActions}`);
  const decision = await until(async () => {
    const decisions = await f.api('GET', `/api/decisions?agentId=${manager.id}&status=pending`);
    return decisions.find(x => x.question.includes(questionNonce));
  }, 'real worker question surfaced as operator Decision', 150000);
  assert.equal(decision.mode, 'text'); assert.equal(decision.blocking, true); assert.equal(decision.projectId, chat.projectId); assert.equal(decision.conversationId, chat.id);
  const pending = await f.api('GET', `/api/agents/${manager.id}`), request = pending.coordinationV3.requests.find(x => x.direction === 'outbound' && x.counterpartyAgentId === worker.id);
  assert.ok(request); assert.equal(request.state, 'awaiting_answer');
  assert.ok(decision.continuationRequestIds?.includes(request.id), 'Blocking Decision lost the exact worker-question continuation');
  assert.equal(pending.coordinationV3.joins.length, 1); assert.equal(pending.coordinationV3.joins[0].state, 'open');
  assert.ok(!(await f.events(chat)).some(x => x.sender.agentId === manager.id && x.text.startsWith('QUESTION_DONE:')), 'Final report published before user answer');
  const wrong = await f.inject({ method: 'POST', url: `/api/decisions/${randomUUID()}/respond`, payload: { text: 'wrong-target' } });
  assert.equal(wrong.statusCode, 404);
  const answer = `operator-${randomUUID()}`;
  assert.ok(!f.submitted.some(x => x.prompt.includes(answer)), 'Operator answer already present in provider input');
  const responded = await f.api('POST', `/api/decisions/${decision.id}/respond`, { text: answer });
  const replay = await f.api('POST', `/api/decisions/${decision.id}/respond`, { text: answer });
  assert.deepEqual(replay.response, responded.response); assert.equal(responded.status, 'resolved'); assert.equal(responded.response.text, answer);
  const expected = `QUESTION_DONE:${questionNonce}:${answer}`;
  await until(async () => (await f.api('GET', `/api/agents/${manager.id}`)).messages.some(x => x.role === 'assistant' && x.text === expected), 'real question/Decision/worker final handoff', 150000);
  const d = await f.wait(manager.id), child = await f.wait(worker.id, warm.runs.map(x => x.id));
  const lifecycle = (await f.api('GET', `/api/projects/${chat.projectId}/agent-work/items/request/${request.id}`)).requestLifecycle;
  assert.ok(lifecycle); assert.equal(lifecycle.request.requesterAgentId, manager.id); assert.equal(lifecycle.request.recipientAgentId, worker.id); assert.equal(lifecycle.request.state, 'completed');
  const questions = lifecycle.updates.filter(x => x.kind === 'question'), answers = lifecycle.updates.filter(x => x.kind === 'answer'), completed = lifecycle.updates.filter(x => x.kind === 'completed');
  assert.equal(questions.length, 1); assert.equal(answers.length, 1); assert.equal(completed.length, 1);
  assert.equal(questions[0].actorId, worker.id); assert.equal(questions[0].resultingState, 'awaiting_answer'); assert.ok(questions[0].text.includes(questionNonce));
  assert.equal(answers[0].actorId, manager.id); assert.equal(answers[0].inReplyToUpdateId, questions[0].id); assert.equal(answers[0].text, answer);
  assert.equal(completed[0].actorId, worker.id); assert.equal(completed[0].text, `WORKER:${questionNonce}:${answer}`);
  assert.ok(Date.parse(answers[0].createdAt) >= Date.parse(responded.response.respondedAt)); assert.ok(Date.parse(completed[0].createdAt) >= Date.parse(answers[0].createdAt));
  const authored = await f.events(chat), final = authored.filter(x => x.sender.agentId === manager.id && x.text === expected);
  assert.equal(final.length, 1); assert.ok(Date.parse(final[0].createdAt) >= Date.parse(completed[0].createdAt));
  assert.equal(d.coordinationV3.joins[0].state, 'satisfied');
  assert.ok(child.coordinationV3.activations.some(x => x.kind === 'coordination_answer' && x.state === 'consumed'));
  const firstWorkerPacket = f.submitted.find(x => x.agentId === worker.id && x.prompt.includes(taskTag));
  assert.ok(firstWorkerPacket); assert.ok(!firstWorkerPacket.prompt.includes(answer));
  assert.ok(f.submitted.some(x => x.agentId === worker.id && x.prompt.includes(answer)), 'Correlated answer never accepted by real worker');
  const conversation = await f.api('GET', `/api/conversations/${chat.id}`);
  assert.equal(conversation.decisionEvents.filter(x => x.kind === 'decision_response' && x.decision.id === decision.id).length, 1, 'Response replay duplicated canonical decision response');
  t.diagnostic('Worker question, blocking operator Decision, exact correlated answer, completed Request and single manager final all verified');
}));

for (const variant of ['choice', 'something_else', 'decline']) test(`checks 54, 55, 56: real Codex Decision ${variant} response is scoped and replay-safe`, options, t => withRealCodex(t, async f => {
  const chat = await f.createChat('Real Decision regression'), otherChat = await f.createChat('Other Decision scope');
  const agent = await f.createAgent(chat, 'Decision owner'), bystander = await f.createAgent(chat, 'Unrelated idle Agent');
  const marker = `decision-${randomUUID()}`, args = { idempotencyKey: randomUUID(), mode: variant === 'decline' ? 'approval' : 'choice', question: `Fixture Decision ${marker}`, blocking: true,
    ...(variant !== 'decline' ? { options: [{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }] } : {}) };
  await f.send(agent.id, `Call ponderosa_decision exactly once with ${JSON.stringify(args)}. This is a harmless fixture question; no file, browser, management or account action is authorized by it. End the turn until the exact Decision response arrives. Then reply via ponderosa_message intent direct_to_user with text "DECISION:${marker}:<response.text if provided, otherwise response.optionId>" exactly. For an approval denial, honor the denial and perform no dependent action; your only response is that acknowledgement. Do not invent permission or another answer, repeat the question, or contact the unrelated Agent. ${noHostActions}`);
  const decision = await until(async () => (await f.api('GET', `/api/decisions?agentId=${agent.id}&status=pending`)).find(x => x.question === args.question), 'real Codex durable Decision', 150000);
  assert.equal(decision.agentId, agent.id); assert.equal(decision.projectId, chat.projectId); assert.equal(decision.conversationId, chat.id); assert.equal(decision.mode, args.mode); assert.equal(decision.blocking, true); assert.equal(decision.allowOther, true);
  assert.equal(decision.approvalScope, undefined, 'Provider-authored prose manufactured host permission');
  const before = await f.wait(agent.id);
  assert.ok(!before.messages.some(x => x.role === 'assistant' && x.text.startsWith(`DECISION:${marker}:`)), 'Agent answered before the pending Decision was resolved');
  assert.equal((await f.inject({ method: 'GET', url: `/api/projects/${otherChat.projectId}/agent-work/items/decision/${decision.id}` })).statusCode, 404);
  assert.equal((await f.inject({ method: 'POST', url: `/api/decisions/${decision.id}/respond`, payload: { optionId: 'not-an-option' } })).statusCode, 400);
  assert.ok((await f.api('GET', `/api/decisions?agentId=${agent.id}&status=pending`)).some(x => x.id === decision.id), 'Invalid answer resolved the Decision');
  const response = variant === 'something_else' ? { text: `other-${randomUUID()}` } : { optionId: variant === 'choice' ? 'second' : 'do_not_approve' };
  const responded = await f.api('POST', `/api/decisions/${decision.id}/respond`, response);
  // A conflicting late response must preserve the original resolution and wake.
  const replay = await f.api('POST', `/api/decisions/${decision.id}/respond`, { text: `late-${randomUUID()}` });
  assert.equal(responded.status, 'resolved'); assert.deepEqual(replay.response, responded.response);
  const value = response.text ?? response.optionId, expected = `DECISION:${marker}:${value}`;
  await until(async () => (await f.api('GET', `/api/agents/${agent.id}`)).messages.some(x => x.role === 'assistant' && x.text === expected), 'real Codex consumed exact Decision answer', 150000);
  const d = await f.wait(agent.id, before.runs.map(x => x.id)), idle = await f.api('GET', `/api/agents/${bystander.id}`);
  assert.equal(idle.runs.length, 0); assert.equal(idle.coordinationV3.activations.length, 0, 'Decision response woke an unrelated Agent');
  const freshHuman = d.coordinationV3.activations.filter(x => x.kind === 'human_message' && !before.coordinationV3.activations.some(old => old.id === x.id));
  assert.equal(freshHuman.length, 1); assert.equal(freshHuman[0].state, 'consumed');
  assert.ok(f.submitted.some(x => x.agentId === agent.id && x.prompt.includes(decision.id) && x.prompt.includes(value)), 'Exact Decision response not submitted to owner');
  const authored = await f.events(chat);
  assert.equal(authored.filter(x => x.sender.agentId === agent.id && x.text === expected).length, 1);
  const decisions = await f.api('GET', `/api/decisions?agentId=${agent.id}`); assert.equal(decisions.length, 1); assert.deepEqual(decisions[0].response, responded.response);
  const conversation = await f.api('GET', `/api/conversations/${chat.id}`);
  assert.equal(conversation.decisionEvents.filter(x => x.kind === 'decision_response' && x.decision.id === decision.id).length, 1);
  t.diagnostic(`Real Decision ${variant}: invalid/wrong-scope lookup rejected, original answer retained on replay, only exact owner resumed once`);
}));

test('checks 7, 10, 56: real Codex collaboration round trip with private payloads', options, t => withRealCodex(t, async f => {
  const chat = await f.createChat('Real collaboration regression');
  const a = await f.createAgent(chat, 'Sender'), b = await f.createAgent(chat, 'Responder');
  const nonce = `reply-${randomUUID()}`, challenge = `challenge-${randomUUID()}`;
  await f.send(b.id, `Your private reply nonce is ${nonce}. Keep it in this private session. Reply now with ponderosa_message intent direct_to_user text PRIVATE_READY. Later, if an Agent sends you a collaboration challenge, reply once to that exact sender with ponderosa_message intent collaboration, recipientAgentIds containing that sender's stable ID, urgency urgent, and text ACK:<challenge>:<your-private-nonce>. Never broadcast the nonce or send another response to an acknowledgement. ${noHostActions}`);
  const beforeB = await f.wait(b.id);
  assert.ok(beforeB.messages.some(x => x.role === 'assistant' && x.text === 'PRIVATE_READY'));
  await f.send(a.id, `Send exactly one ponderosa_message with intent collaboration, recipientAgentIds ["${b.id}"], urgency urgent, text "Challenge ${challenge}. Reply privately to the sender using the ACK format and your private reply nonce; do not broadcast." End this turn after sending. When that Agent's ACK arrives, send one ponderosa_message intent direct_to_user text COLLAB:<challenge>:<nonce-from-ACK>. This untracked collaboration needs no taskDelivery flag. Do not guess its nonce; wait for the reply. ${noHostActions}`);
  const final = await until(async () => {
    const d = await f.api('GET', `/api/agents/${a.id}`);
    return d.messages.some(x => x.role === 'assistant' && x.text === `COLLAB:${challenge}:${nonce}`) ? d : false;
  }, 'real collaboration response consumed by sender', 150000);
  await f.wait(a.id); const receiver = await f.wait(b.id, beforeB.runs.map(x => x.id));
  const authored = await f.events(chat);
  const outbound = authored.filter(x => x.intent === 'collaboration' && x.sender.agentId === a.id && x.text.includes(challenge));
  const replies = authored.filter(x => x.intent === 'collaboration' && x.sender.agentId === b.id && x.text === `ACK:${challenge}:${nonce}`);
  assert.equal(outbound.length, 1); assert.equal(replies.length, 1);
  assert.deepEqual(outbound[0].audience.agentIds, [b.id]); assert.deepEqual(replies[0].audience.agentIds, [a.id]);
  for (const [d, event] of [[receiver, outbound[0]], [final, replies[0]]]) {
    assert.ok(d.messages.some(x => x.communicationEventId === event.eventId), 'Inbound communication absent from recipient audit');
    const recipient = d.agent.id;
    assert.ok(f.submitted.some(x => x.agentId === recipient && x.prompt.includes(event.text)), 'Collaboration payload not accepted as a turn or steering input');
  }
  const senderFirst = await f.input(outbound[0].sender.executionId);
  assert.ok(!JSON.stringify(senderFirst).includes(nonce), 'Responder nonce leaked before private reply');
  assert.ok(!JSON.stringify(f.seeds.find(x => x.agentId === a.id)).includes(nonce), 'Responder nonce leaked into initial sender seed history');
  const team = await f.api('GET', `/api/conversations/${chat.id}/collaboration`);
  for (const event of [outbound[0], replies[0]]) assert.ok(team.messages.some(x => x.communicationEventId === event.eventId));
  const shared = await f.api('GET', `/api/conversations/${chat.id}`);
  for (const event of [outbound[0], replies[0]]) assert.ok(!shared.messages.some(x => x.communicationEventId === event.eventId), 'Raw collaboration leaked into main Chat');
  assert.ok(!authored.some(x => x.intent === 'broadcast' && (x.text.includes(challenge) || x.text.includes(nonce))), 'Private payload became shared knowledge');
  t.diagnostic('Two canonical collaboration messages reached exact recipients; responder-only nonce returned to user; raw collaboration remains in Team/audit');
}));

test('checks 92, 94: real Codex fresh rollover preserves a fact supplied only before refresh', options, t => withRealCodex(t, async f => {
  const chat = await f.createChat('Real rollover memory regression'), agent = await f.createAgent(chat, 'Rollover reader');
  const fact = `harmless-${randomUUID()}`;
  await f.send(agent.id, `The harmless fixture fact is ${fact}. Remember this fact for a later question. Reply now via ponderosa_message intent direct_to_user text FACT_READY, without repeating the fact. Preserve it in any future continuation handoff. ${noHostActions}`);
  const initial = await f.wait(agent.id); assert.ok(initial.messages.some(x => x.role === 'assistant' && x.text === 'FACT_READY'));
  const original = f.seeds.find(x => x.agentId === agent.id); assert.ok(original.sessionId);
  const refreshed = await f.api('POST', `/api/agents/${agent.id}/compact`); assert.equal(refreshed.mode, 'durable_rollover'); assert.ok(refreshed.rolloverId);
  const completed = await until(async () => (await f.agentEvents(chat, agent.id)).find(x => x.type === 'context_rollover_completed' && x.rolloverId === refreshed.rolloverId), 'canonical replacement session verified', 150000);
  assert.notEqual(completed.replacementProviderSessionId, completed.previousProviderSessionId);
  const handedOff = await f.wait(agent.id, initial.runs.map(x => x.id));
  const followup = `What was the harmless fixture fact supplied before the refresh? Reply only with ponderosa_message intent direct_to_user text "FACT:<actual earlier fact>". Do not guess or request the fact again. ${noHostActions}`;
  assert.ok(!followup.includes(fact)); await f.send(agent.id, followup);
  await until(async () => (await f.api('GET', `/api/agents/${agent.id}`)).messages.some(x => x.role === 'assistant' && x.text === `FACT:${fact}`), 'exact earlier-fact reply', 150000);
  const result = await f.wait(agent.id, handedOff.runs.map(x => x.id));
  assert.ok(result.messages.some(x => x.role === 'assistant' && x.text === `FACT:${fact}`), 'Fresh session failed to recover the earlier-only fact');
  const replacement = f.seeds.filter(x => x.agentId === agent.id).at(-1);
  assert.ok(replacement.sessionId && replacement.sessionId !== original.sessionId, 'Provider session was reused instead of refreshed');
  const events = await f.events(chat);
  assert.equal(events.filter(x => x.sender.agentId === agent.id && x.text === `FACT:${fact}`).length, 1);
  assert.ok(result.runs.some(x => !handedOff.runs.some(old => old.id === x.id)));
  t.diagnostic('Manual durable rollover created a fresh real Codex session; follow-up recovered a pre-refresh-only private fact');
}));

test('checks 40, 46, 56: real Codex managed worker creation replay and correlated opening result', options, t => withRealCodex(t, async f => {
  const chat = await f.createChat('Real managed creation regression'), manager = await f.createAgent(chat, 'Creation manager');
  const marker = `managed-${randomUUID()}`, resultText = `MANAGED_WORKER:${marker}`;
  const args = { idempotencyKey: randomUUID(), title: 'Visible Codex worker', engine: 'codex', lifetime: { kind: 'indefinite' }, awaitResult: true,
    text: `This is your one tracked opening assignment. Call ponderosa_update_request kind completed text "${resultText}" exactly, then end the turn. Do not substitute a standalone message. ${noHostActions}` };
  const permittedCreation = 'Do not use files, shell, browser, network, or provider-native helpers. Create only the one requested visible worker through ponderosa_create_managed_agent.';
  await f.send(manager.id, `Call ponderosa_create_managed_agent with ${JSON.stringify(args)}. Immediately retry that same tool once with exactly the same arguments and idempotencyKey; it must return the same visible Agent, Request and Join. Then end the turn and wait for that Join. Do not repeat creation after resumption, create another worker, delegate another Request, or poll. When the canonical worker result arrives, send exactly one ponderosa_message intent direct_to_user taskDelivery final text "MANAGED_DONE:<actual worker result text>". ${permittedCreation}`);
  const expected = `MANAGED_DONE:${resultText}`;
  await until(async () => (await f.api('GET', `/api/agents/${manager.id}`)).messages.some(x => x.role === 'assistant' && x.text === expected), 'real managed worker result integrated', 150000);
  const d = await f.wait(manager.id), agents = await f.api('GET', `/api/projects/${chat.projectId}/agents`);
  assert.equal(agents.length, 2, 'Creation replay produced another visible Agent');
  const worker = agents.find(x => x.id !== manager.id);
  assert.equal(worker.title, args.title); assert.equal(worker.activeEngine, 'codex'); assert.equal(worker.managerAgentId, manager.id); assert.equal(worker.conversationId, chat.id);
  const calls = f.toolCalls.filter(x => x.agentId === manager.id && x.name === 'ponderosa_create_managed_agent');
  assert.equal(calls.length, 2, 'Provider did not perform the requested creation retry');
  for (const call of calls) { assert.deepEqual(call.arguments, args); assert.equal(call.result.success, true); }
  const creations = calls.map(x => JSON.parse(x.result.text));
  assert.equal(creations[0].agent.id, worker.id); assert.equal(creations[1].agent.id, worker.id); assert.equal(creations[1].replayed, true);
  assert.equal(creations[0].requestId, creations[1].requestId); assert.equal(creations[0].joinId, creations[1].joinId);
  const requests = d.coordinationV3.requests.filter(x => x.direction === 'outbound');
  assert.equal(requests.length, 1); assert.equal(requests[0].counterpartyAgentId, worker.id); assert.equal(requests[0].state, 'completed');
  assert.equal(d.coordinationV3.joins.length, 1); assert.equal(d.coordinationV3.joins[0].state, 'satisfied'); assert.equal(d.coordinationV3.joins[0].total, 1);
  const child = await f.wait(worker.id);
  assert.equal(child.runs.length, 1, 'Creation replay dispatched the opening assignment again');
  assert.ok(child.coordinationV3.requests.some(x => x.id === requests[0].id && x.direction === 'inbound' && x.counterpartyAgentId === manager.id && x.state === 'completed'));
  const authored = await f.events(chat);
  const opening = authored.filter(x => x.sender.agentId === manager.id && x.text === args.text);
  assert.equal(opening.length, 1); assert.equal(opening[0].intent, 'collaboration'); assert.deepEqual(opening[0].audience.agentIds, [worker.id]);
  const results = authored.filter(x => x.sender.agentId === worker.id && x.correlationId === requests[0].id && x.text === resultText);
  assert.equal(results.length, 1); assert.deepEqual(results[0].audience.agentIds, [manager.id]);
  const final = authored.filter(x => x.sender.agentId === manager.id && x.text === expected);
  assert.equal(final.length, 1); assert.equal(final[0].intent, 'user_dm');
  assert.ok(Date.parse(final[0].createdAt) >= Date.parse(d.coordinationV3.joins[0].updatedAt));
  const joins = d.coordinationV3.activations.filter(x => x.kind === 'coordination_join_satisfied' && x.state === 'consumed');
  assert.equal(joins.length, 1);
  const packets = await Promise.all(d.runs.map(run => f.input(run.id)));
  const joinInputs = packets.filter(packet => packet.sourceManifest?.activationIds.includes(joins[0].id));
  assert.ok(joinInputs.some(packet => packet.exactPrompt?.includes(resultText)), 'Canonical worker result was never submitted with its Join');
  const finalInput = packets.find(packet => packet.executionId === final[0].sender.executionId);
  const finalSubmission = f.submitted.filter(x => x.agentId === manager.id && x.prompt === finalInput?.exactPrompt).at(-1);
  assert.ok(finalSubmission?.sessionId, 'Final reply has no observed provider-session input');
  assert.ok(joinInputs.some(packet => packet.exactPrompt?.includes(resultText) &&
    f.submitted.some(x => x.agentId === manager.id && x.prompt === packet.exactPrompt && x.sessionId === finalSubmission.sessionId)),
  'Final reply did not use the provider session that received the canonical worker result');
  t.diagnostic('One visible provider-created worker, one opening assignment, one Join and one manager final despite creation retry');
}));

for (const terminal of [false, true]) test(`checks 46, 47, 48, 50, 56: real Codex delegation ${terminal ? 'blocked and failed outcomes' : 'successful fan-out'}`, options, t => withRealCodex(t, async f => {
  const chat = await f.createChat('Real delegation regression'), manager = await f.createAgent(chat, 'Manager');
  const workers = await Promise.all(['Worker A', 'Worker B'].map(title => f.createAgent(chat, title, manager.id)));
  const nonces = workers.map(() => `worker-${randomUUID()}`), kinds = terminal ? ['blocked', 'failed'] : ['completed', 'completed'];
  const warm = [];
  for (let i = 0; i < workers.length; i++) {
    await f.send(workers[i].id, `Your private fixture nonce is ${nonces[i]}. Keep it in this session; do not expose it yet. Reply now via ponderosa_message intent direct_to_user text PRIVATE_READY. On a later correlated Request, use ponderosa_update_request kind ${kinds[i]} text "${i === 0 ? 'A' : 'B'}:${kinds[i]}:<your-private-nonce>". This is a harmless declared ${kinds[i]} fixture outcome; do not attempt real work. Do not replace that correlated result with a standalone message. ${noHostActions}`);
    warm.push(await f.wait(workers[i].id));
    assert.ok(warm[i].messages.some(x => x.role === 'assistant' && x.text === 'PRIVATE_READY'));
  }
  const requests = workers.map((w, i) => ({ recipientAgentId: w.id, text: `Report fixture result ${i === 0 ? 'A' : 'B'} using your privately supplied nonce and outcome; use ponderosa_update_request, not a standalone message. ${noHostActions}`, lifetime: { kind: 'indefinite' } }));
  const coordinate = terminal ? { idempotencyKey: randomUUID(), requests, join: { mode: 'all', satisfyingOutcomes: ['blocked', 'failed'], wakePolicy: 'final_only' } }
    : { delegations: requests.map(({ recipientAgentId, text }) => ({ recipientAgentId, text })), completionMode: 'join', wakePolicy: 'final_only' };
  await f.send(manager.id, `Call ponderosa_coordinate once with these exact arguments: ${JSON.stringify(coordinate)}. There is one aggregate all-results Join. End the turn and wait for its result; do not poll, create another Join, guess nonces, or repeat delegation on resumption. When both canonical results arrive, integrate their actual outcome and nonce into exactly one ponderosa_message intent direct_to_user taskDelivery final with text "RESULTS:A:<actual-A-outcome>:<A-nonce>|B:<actual-B-outcome>:<B-nonce>". A blocked or failed result is not success; report it truthfully. ${noHostActions}`);
  const expected = `RESULTS:A:${kinds[0]}:${nonces[0]}|B:${kinds[1]}:${nonces[1]}`;
  await until(async () => {
    const d = await f.api('GET', `/api/agents/${manager.id}`);
    return d.messages.some(x => x.role === 'assistant' && x.text === expected);
  }, 'real manager synthesis of canonical worker results', 150000);
  const d = await f.wait(manager.id);
  const outbound = d.coordinationV3.requests.filter(x => x.direction === 'outbound');
  assert.equal(outbound.length, 2, 'Delegation was repeated or a worker was omitted');
  assert.equal(d.coordinationV3.joins.length, 1, 'Fan-out must use one aggregate Join');
  const join = d.coordinationV3.joins[0];
  assert.equal(join.mode, 'all'); assert.equal(join.wakePolicy, 'final_only'); assert.equal(join.state, 'satisfied'); assert.equal(join.total, 2);
  assert.equal(join.completed, terminal ? 0 : 2);
  const authored = await f.events(chat), final = authored.filter(x => x.sender.agentId === manager.id && x.text === expected);
  assert.equal(final.length, 1); assert.equal(final[0].intent, 'user_dm');
  assert.ok(Date.parse(final[0].createdAt) >= Date.parse(join.updatedAt), 'Manager final preceded canonical Join outcome');
  const results = [];
  for (let i = 0; i < workers.length; i++) {
    const request = outbound.find(x => x.counterpartyAgentId === workers[i].id);
    assert.ok(request); assert.equal(request.state, kinds[i]);
    const child = await f.wait(workers[i].id, warm[i].runs.map(x => x.id));
    assert.equal(child.agent.managerAgentId, manager.id);
    assert.ok(child.coordinationV3.requests.some(x => x.id === request.id && x.direction === 'inbound' && x.counterpartyAgentId === manager.id && x.state === kinds[i]));
    const resultText = `${i === 0 ? 'A' : 'B'}:${kinds[i]}:${nonces[i]}`;
    const updates = authored.filter(x => x.sender.agentId === workers[i].id && x.correlationId === request.id && x.text === resultText);
    assert.equal(updates.length, 1, 'Expected one correlated worker result');
    assert.equal(updates[0].intent, 'collaboration'); assert.deepEqual(updates[0].audience.agentIds, [manager.id]); results.push(updates[0]);
    assert.ok(d.messages.some(x => x.communicationEventId === updates[0].eventId), 'Worker result absent from manager audit');
  }
  const packets = await Promise.all(d.runs.map(x => f.input(x.id)));
  const initial = packets.find(x => x.exactPrompt && !nonces.some(n => x.exactPrompt.includes(n)));
  assert.ok(initial, 'Worker-only nonces leaked into initial manager input');
  const finalInput = await f.input(final[0].sender.executionId);
  for (let i = 0; i < nonces.length; i++) assert.ok(finalInput.exactPrompt?.includes(`${i === 0 ? 'A' : 'B'}:${kinds[i]}:${nonces[i]}`), 'Canonical worker outcome absent from final manager input');
  const resumedActivations = d.coordinationV3.activations.filter(x => x.kind === 'coordination_join_satisfied');
  assert.equal(resumedActivations.length, 1, 'Expected one final-only Join result activation');
  assert.equal(resumedActivations[0].state, 'consumed', 'Join result not consumed');
  const shared = await f.api('GET', `/api/conversations/${chat.id}`);
  const team = await f.api('GET', `/api/conversations/${chat.id}/collaboration`);
  for (const event of results) {
    assert.ok(!shared.messages.some(x => x.communicationEventId === event.eventId), 'Raw worker result leaked into main Chat');
    assert.ok(team.messages.some(x => x.communicationEventId === event.eventId), 'Worker result absent from Team');
  }
  assert.ok(!authored.some(x => x.intent === 'broadcast' && nonces.some(n => x.text.includes(n))), 'Private worker nonce became shared knowledge');
  t.diagnostic(`Two real worker ${kinds.join('/')} outcomes, one satisfied Join, one truthful manager final with worker-only nonces`);
}));
