import assert from 'node:assert/strict';
import test from 'node:test';
import { PONDEROSA_IMPORT_FILE_TOOL } from '@ponderosa/core';
import { environmentFactsPrompt } from '../dist/runtime-environment-facts.js';
import { previousPublicationSessionContract } from '../dist/previous-publication-session-contract.js';
import { communicationV3Prompt, communicationV3SessionPrompt, providerDynamicTools, providerToolContractHash } from '../dist/runtime-selection.js';

const oldGuidance = "No external report-output root is authorized. A read-only reviewer can return its report through a canonical reply, or ask the operator to configure an import root. Do not write a report into the writer's checkout, silently grant a root, or copy a rejected file automatically.";
const oldDescription = "Import one regular host file into this Run's Project files, making it available to the operator, ponderosa_message, and ponderosa_browser_upload when its format is supported. Pass a path relative to the Project workspace, or an absolute path inside an operator-configured import root. The server securely copies exact stable bytes into immutable Project-managed storage and returns the artifact ID. Symlinks, empty files, changing files, files outside authorized roots, and files larger than 64 MiB fail closed.";
function fixture(reportOutputRoot, legacyRoute) {
  const environmentFacts = { cwd: '/exact/workspace', platform: 'linux', executables: [{ name: 'node', availability: 'available' }],
    ...(reportOutputRoot ? { reportOutputRoot } : {}) };
  const environment = environmentFactsPrompt(environmentFacts);
  const prompt = lines => `Identity\nExact operator and Chat policy\n${lines.join('\n')}\n${environment.join('\n')}`;
  const currentSystemPrompt = prompt(communicationV3SessionPrompt());
  const previousPrompt = prompt(legacyRoute ? communicationV3Prompt(legacyRoute) : communicationV3SessionPrompt());
  const frozenSystemPrompt = environmentFacts.reportOutputRoot ? previousPrompt : previousPrompt.replace(environment.at(-1), oldGuidance);
  return { currentSystemPrompt, frozenSystemPrompt, environmentFacts, currentTools: providerDynamicTools() };
}

test('previous publication handoff reconstructs exact tools and frozen policy with or without an authorized report root', () => {
  for (const root of [undefined, '/authorized/ponderosa-review/agent']) {
    for (const route of [undefined, { intent: 'direct_to_user' }, { intent: 'broadcast' }]) {
      const input = fixture(root, route), before = structuredClone(input.currentTools);
      const contract = previousPublicationSessionContract(input);
      assert.ok(contract);
      assert.deepEqual(contract.communicationPrompt, route ? communicationV3Prompt(route) : communicationV3SessionPrompt());
      assert.deepEqual(contract.tools, before.map(tool => tool.name === 'ponderosa_import_file' ? { ...tool, description: oldDescription } : tool));
      assert.deepEqual(input.currentTools, before, 'fresh-session definitions are not mutated');
      assert.equal(PONDEROSA_IMPORT_FILE_TOOL.description, before.find(tool => tool.name === 'ponderosa_import_file').description);
      assert.notEqual(providerToolContractHash(contract.tools, contract.communicationPrompt), providerToolContractHash(before, contract.communicationPrompt));
    }
  }
});

test('previous publication compatibility rejects changed policy, identity, environment and duplicate blocks', () => {
  const input = fixture();
  for (const frozenSystemPrompt of [
    input.frozenSystemPrompt.replace('Identity', 'Changed identity'),
    input.frozenSystemPrompt.replace('Exact operator and Chat policy', 'Changed operator or Chat policy'),
    input.frozenSystemPrompt.replace('/exact/workspace', '/different/workspace'),
    input.frozenSystemPrompt.replace('available', 'not_found'),
    input.frozenSystemPrompt.replace('Do not write a report', 'You may write a report'),
    `${input.frozenSystemPrompt}\nAdditional instructions`, input.currentSystemPrompt,
  ]) assert.equal(previousPublicationSessionContract({ ...input, frozenSystemPrompt }), undefined);
  const block = environmentFactsPrompt(input.environmentFacts).join('\n');
  assert.equal(previousPublicationSessionContract({ ...input, currentSystemPrompt: `${input.currentSystemPrompt}\n${block}` }), undefined);
});

test('previous publication compatibility rejects missing, duplicated or changed import schema/description', () => {
  const input = fixture();
  for (const currentTools of [input.currentTools.filter(tool => tool.name !== 'ponderosa_import_file'),
    [...input.currentTools, PONDEROSA_IMPORT_FILE_TOOL],
    input.currentTools.map(tool => tool.name === 'ponderosa_import_file' ? { ...tool, description: 'Unknown policy' } : tool),
    input.currentTools.map(tool => tool.name === 'ponderosa_import_file' ? { ...tool, inputSchema: { type: 'object' } } : tool),
  ]) assert.equal(previousPublicationSessionContract({ ...input, currentTools }), undefined);
  const accepted = previousPublicationSessionContract(input);
  const changed = previousPublicationSessionContract({ ...input, currentTools: input.currentTools.map(tool =>
    tool.name === 'ponderosa_message' ? { ...tool, description: 'Changed unrelated tool' } : tool) });
  assert.notEqual(providerToolContractHash(changed.tools, changed.communicationPrompt),
    providerToolContractHash(accepted.tools, accepted.communicationPrompt), 'unrelated tool changes cannot match the accepted hash');
});
