import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
const {deploymentEffectFacts}=await import('../../apps/web/src/components/branches/deployment-effects.tsx');
test('publication facts preserve execution, history, lifecycle and host authority consequences',()=>{
 const facts=deploymentEffectFacts([
 'Accepted executions keep their version and binding revision.',
 'Persistent Agents belong to this Branch through their Chat. Their living history is preserved.',
 'Detached bindings preserve Agents and user folders. Template Agents are created per invocation and deleted after cleanup.',
 'Agents and Scripts use the host account’s authority. A human gate controls workflow order, not other host activity.',
 ]);
 const values=Object.fromEntries(facts.map(fact=>[fact.label,fact.value]));
 assert.equal(values['Accepted Executions'],'Version and binding revision retained');
 assert.equal(values['Persistent Agents'],'Owned by this workflow via their Chat');
 assert.equal(values['Agent History'],'Preserved');
 assert.equal(values['Removed Bindings'],'Agents and user folders preserved');
 assert.equal(values['Template Agents'],'Created per invocation · deleted after cleanup');
 assert.equal(values['Agents And Scripts'],'Host account authority');
 assert.equal(values['Human Gates'],'Workflow order only · other host activity unaffected');
});
test('publication facts retain traversal warnings, queued backlog and unknown future consequences',()=>{
 for(const [note,expected]of [
  ['Traversal preflight: a successful run needs at least 3 visits of the configured 100 traversal limit.',['At least 3 visits','100']],
  ['Traversal preflight: a successful run needs at least 101 visits, above the configured 100 traversal limit. Increase the Branch limit before running.',['At least 101 visits','100 · increase before running']],
  ['Traversal preflight: estimated baseline 3 visits. Conditions or loops make the full count uncertain; check the configured 100 traversal limit before running.',['3 visits · full count uncertain (conditions or loops)','100 · check before running']],
  ['2 already queued Runs remain. Schedule changes affect future checks; they do not clear, merge or cancel this backlog.',['2 retained · no clearing, merging or cancellation','Future checks only']],
  ['1 already queued Run remain. Schedule changes affect future checks; they do not clear, merge or cancel this backlog.',['1 retained · no clearing, merging or cancellation','Future checks only']],
  ['Future consequential server note.',['Future consequential server note.']],
 ])assert.deepEqual(deploymentEffectFacts([note]).map(fact=>fact.value),expected);
});
