import test from 'node:test';
import assert from 'node:assert/strict';
import {localMemoryTools, validateMemoryCall} from '../../apps/server/dist/local-memory-catalog.js';
import {communicationV3SessionPrompt} from '../../apps/server/dist/runtime-selection.js';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {withFixture} from '../shared/fixture.mjs';
import {ownedChroma} from './portability-fixture.mjs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

const tool = operation => localMemoryTools.find(item => item.name === 'ponderosa_local_memory_' + operation);
test('first-use search advertises one authorized combined search with optional source', () => {
  const search = tool('search');
  assert.match(search.description, /one search with source omitted/);
  assert.match(search.description, /both authorized Chat and global memory together/);
  assert.match(search.description, /revoked global-read grant leaves Chat-only results/);
  assert.match(search.description, /do not infer provenance from result text/);
  assert.deepEqual(search.inputSchema.required, ['query']);
  assert.deepEqual(validateMemoryCall('search', {query:'known fact'}), {query:'known fact'});
  assert.deepEqual(validateMemoryCall('search', {query:'known fact',source:'chat'}), {query:'known fact',source:'chat'});
});
test('guidance preserves physical lineage, explicit destinations and host-only provenance', () => {
  assert.match(tool('save').description, /global for installation-wide memory/);
  assert.match(tool('save').description, /private.*unsupported for global/);
  assert.match(tool('update').description, /new physical version/);
  assert.match(tool('forget').description, /not a hard delete/);
  for (const item of localMemoryTools) {
    assert.match(item.description, /Ponderosa's Chat\/global memory store, separate from other memory services/);
    assert.match(item.description, /Host stamps actor\/Run\/source provenance/);
    assert.match(item.description, /Chat and global writes follow human capability settings/);
  }
  assert.throws(() => validateMemoryCall('save', {text:'fact'}));
  assert.throws(() => validateMemoryCall('save', {text:'fact',destination:'chat',provenance:{actor:'forged'}}));
  assert.throws(() => validateMemoryCall('search', {query:'fact',source:'all'}));
  assert.deepEqual(validateMemoryCall('save', {text:'fact',destination:'global'}), {text:'fact',destination:'global'});
});

test('invalid memory arguments identify fixed parameters without echoing authored values', () => {
  assert.throws(()=>validateMemoryCall('save',{text:'private authored text'}),/Missing required memory parameter: destination/);
  assert.throws(()=>validateMemoryCall('search',{query:'private authored text',top_k:21}),/top_k must be an integer from 1 to 20/);
  assert.throws(()=>validateMemoryCall('search',{query:'private authored text',include_history:'False'}),/include_history must be boolean/);
  assert.throws(()=>validateMemoryCall('search',{query:'private authored text',source:'everywhere'}),/source must be chat or global/);
  const extra={query:'private authored text',['private unknown field']:'private value'};
  assert.throws(()=>validateMemoryCall('search',extra),error=>error.name==='MemoryArgumentError'&&!/private/.test(error.message));
  assert.throws(()=>validateMemoryCall('search',{query:'   '}),error=>error.name==='MemoryArgumentError'&&/query/.test(error.message)&&!/  /.test(error.message));
});


test('actual provider admission identifies Ponderosa memory before discovery without granting restricted or unconfigured tools', {timeout:90000}, async t => {
  const memoryInstruction=communicationV3SessionPrompt().find(line=>line.startsWith('Ponderosa Chat/global facts'));
  assert.ok(memoryInstruction);
  for(const mode of ['available','restricted','unconfigured']){
    let opened;
    const options={onProviderOpen:input=>{opened=input;},...(mode==='unconfigured'?{}:{localMemoryForRoot:async root=>({
      chromaUrl:await ownedChroma(),collectionPrefix:'guidance_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true,
    })})};
    await withFixture(t,async f=>{
      const chat=await f.createChat('Memory guidance'),agent=await f.createIdleAgent(chat,'Reader');
      if(mode==='restricted')f.ok(await f.api('PUT','/api/agents/'+agent.id+'/capabilities',{revision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead]}));
      const session=await f.hold(agent.id);
      assert.ok(opened.systemPrompt.includes(memoryInstruction),'store identity must precede deferred native tool discovery');
      const detail=await f.detail(agent.id),run=detail.runs[0],recorded=f.ok(await f.api('GET','/api/runs/'+run.id+'/provider-input?exact=1'));
      assert.equal(recorded.exactSystemPrompt.split(memoryInstruction).length-1,1,'the admitted system prompt records guidance exactly once');
      const search=opened.dynamicTools.find(tool=>tool.name==='ponderosa_local_memory_search');
      assert.equal(Boolean(search),mode==='available');
      if(search){
        assert.equal(search.description,tool('search').description);
        assert.ok(memoryInstruction.includes(search.name),'guidance names the actual admitted Codex search tool');
        assert.ok(memoryInstruction.includes('mcp__ponderosa__'+search.name.replace(/^ponderosa_/,'')),'guidance names the same tool in the Claude MCP namespace');
        assert.deepEqual(search.inputSchema.required,['query']);
      }else{
        const denied=await session.tool('ponderosa_local_memory_search',{query:'Synthetic stored fact'});
        assert.equal(denied.success,false);assert.match(denied.text,/Unavailable Ponderosa tool/);
      }
      const catalog=f.ok(await f.api('GET','/api/agents/'+agent.id+'/capabilities'));
      const write=catalog.catalog.find(item=>item.id===CAPABILITY_IDS.memoryWrite);
      assert.equal(write.label,'Write memory');assert.match(write.description,/Chat or installation-global memory/);
      assert.equal(catalog.effective.restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryWrite),false);
      f.ok(await f.tool(session,'ponderosa_message',{text:'Guidance admission inspected'}));session.finish();await f.settled(agent.id);
    },options);
  }
});
