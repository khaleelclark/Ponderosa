import test from 'node:test';
import assert from 'node:assert/strict';
import {localMemoryTools, validateMemoryCall} from '../../apps/server/dist/local-memory-catalog.js';

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
    assert.match(item.description, /Host stamps actor\/Run\/source provenance/);
    assert.match(item.description, /Chat and global writes follow human capability settings/);
  }
  assert.throws(() => validateMemoryCall('save', {text:'fact'}));
  assert.throws(() => validateMemoryCall('save', {text:'fact',destination:'chat',provenance:{actor:'forged'}}));
  assert.throws(() => validateMemoryCall('search', {query:'fact',source:'all'}));
  assert.deepEqual(validateMemoryCall('save', {text:'fact',destination:'global'}), {text:'fact',destination:'global'});
});
