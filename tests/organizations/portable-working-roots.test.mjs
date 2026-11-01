import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePortableAgentPackage} from '../../apps/server/dist/portable-agent-package-validation.js';

const node=(ref,root,owner=false)=>({ref,title:ref,engine:'codex',workingRootRef:root,
  managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},
  ...(owner?{workingFolder:{directories:[],excludedPaths:['.git']},workingFiles:[]}:{}),
});
const bundle=()=>({schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'folders',rootRef:'root',agents:[node('root','shared',true),{...node('child','shared'),managerRef:'root'},{...node('separate','private',true),managerRef:'root'}]});

test('organization roots preserve shared membership and independent empty folders',()=>{
  const source=bundle();
  assert.deepEqual(validatePortableAgentPackage(source).package,source);
  assert.equal(new Set(source.agents.map(agent=>agent.workingRootRef)).size,2);
});
test('organization roots reject missing manifests, duplicate originals owners and unbound members',()=>{
  const absent=bundle();delete absent.agents[2].workingFolder;
  assert.throws(()=>validatePortableAgentPackage(absent),/exactly one folder/);
  const duplicate=bundle();duplicate.agents[1].workingFolder={directories:[],excludedPaths:[]};
  assert.throws(()=>validatePortableAgentPackage(duplicate),/exactly one folder/);
  const unbound=bundle();delete unbound.agents[1].workingRootRef;
  assert.throws(()=>validatePortableAgentPackage(unbound),/identify every Agent/);
});
