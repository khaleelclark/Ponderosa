import assert from 'node:assert/strict';
import test from 'node:test';
import { PONDEROSA_IMPORT_FILE_TOOL } from '@ponderosa/core';
import { environmentFactsPrompt } from '../dist/runtime-environment-facts.js';
import { previousPublicationSessionContracts } from '../dist/previous-publication-session-contract.js';
import { communicationV3Prompt, communicationV3SessionPrompt, providerDynamicTools, providerToolContractHash } from '../dist/runtime-selection.js';

const oldGuidance = "No external report-output root is authorized. A read-only reviewer can return its report through a canonical reply, or ask the operator to configure an import root. Do not write a report into the writer's checkout, silently grant a root, or copy a rejected file automatically.";
const oldDescription = "Import one regular host file into this Run's Project files, making it available to the operator, ponderosa_message, and ponderosa_browser_upload when its format is supported. Pass a path relative to the Project workspace, or an absolute path inside an operator-configured import root. The server securely copies exact stable bytes into immutable Project-managed storage and returns the artifact ID. Symlinks, empty files, changing files, files outside authorized roots, and files larger than 64 MiB fail closed.";
const approvalDescription = "Import one regular host file into managed downloadable storage, making it available to the operator, ponderosa_message, and ponderosa_browser_upload when its format is supported. Workspace files and server-wide operator-configured import roots retain their existing permissions. An external file stays rejected while a single-file publication Decision is pending. End the Run without copying it into the workspace; after approval resumes you, retry this exact path. Approval binds this Agent, owning Chat, one publication operation, and server-verified bytes; it does not grant a directory or future imports. The server returns the immutable artifact ID and reuses its receipt on retry. Symlinks, empty, changed, or oversized files fail closed; the existing 64 MiB limit remains.";
const approvalGuidance = "No external report-output root is authorized. Use ponderosa_import_file on the exact external deliverable to request a single-file publication Decision, or return a report through a canonical reply. Approval publishes only the verified file, not a directory or future imports. End the Run while approval is pending; retry the same path after its exact Decision continuation resumes. Do not write a report into the writer's checkout, silently grant a root, or copy a rejected file automatically.";
const rootGuidance = "The reportOutputRoot is an Agent-owned publication location under an existing operator-authorized import root, outside this checkout. It is not automatically created. A read-only reviewer may write its report there and use ponderosa_import_file; do not write into the writer's checkout or broaden import roots. File APIs still enforce symlink containment.";
function fixture(reportOutputRoot, legacyRoute, version = 'pre-publication') {
  const environmentFacts = { cwd: '/exact/workspace', platform: 'linux', executables: [{ name: 'node', availability: 'available' }],
    ...(reportOutputRoot ? { reportOutputRoot } : {}) };
  const environment = environmentFactsPrompt(environmentFacts);
  const prompt = lines => `Identity\nExact operator and Chat policy\n${lines.join('\n')}\n${environment.join('\n')}`;
  const currentSystemPrompt = prompt(communicationV3SessionPrompt());
  const previousPrompt = prompt(legacyRoute ? communicationV3Prompt(legacyRoute) : communicationV3SessionPrompt());
  const frozenSystemPrompt = previousPrompt.replace(environment.at(-1), environmentFacts.reportOutputRoot
    ? rootGuidance : version === 'approval' ? approvalGuidance : oldGuidance);
  return { currentSystemPrompt, frozenSystemPrompt, environmentFacts, currentTools: providerDynamicTools() };
}

test('both deployed publication contracts reconstruct exact tools and frozen policy with or without an output root', () => {
  for (const version of ['pre-publication', 'approval']) {
  for (const root of [undefined, '/authorized/ponderosa-review/agent']) {
    for (const route of [undefined, { intent: 'direct_to_user' }, { intent: 'broadcast' }]) {
      const input = fixture(root, route, version), before = structuredClone(input.currentTools);
      const description = version === 'approval' ? approvalDescription : oldDescription;
      const contracts = previousPublicationSessionContracts(input);
      const contract = contracts.find(item => item.tools.find(tool => tool.name === 'ponderosa_import_file').description === description);
      assert.ok(contract);
      assert.deepEqual(contract.communicationPrompt, route ? communicationV3Prompt(route) : communicationV3SessionPrompt());
      assert.deepEqual(contract.tools, before.map(tool => tool.name === 'ponderosa_import_file' ? { ...tool, description } : tool));
      assert.deepEqual(input.currentTools, before, 'fresh-session definitions are not mutated');
      assert.equal(PONDEROSA_IMPORT_FILE_TOOL.description, before.find(tool => tool.name === 'ponderosa_import_file').description);
      assert.notEqual(providerToolContractHash(contract.tools, contract.communicationPrompt), providerToolContractHash(before, contract.communicationPrompt));
    }
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
  ]) assert.deepEqual(previousPublicationSessionContracts({ ...input, frozenSystemPrompt }), []);
  const block = environmentFactsPrompt(input.environmentFacts).join('\n');
  assert.deepEqual(previousPublicationSessionContracts({ ...input, currentSystemPrompt: `${input.currentSystemPrompt}\n${block}` }), []);
});

test('previous publication compatibility rejects missing, duplicated or changed import schema/description', () => {
  const input = fixture();
  for (const currentTools of [input.currentTools.filter(tool => tool.name !== 'ponderosa_import_file'),
    [...input.currentTools, PONDEROSA_IMPORT_FILE_TOOL],
    input.currentTools.map(tool => tool.name === 'ponderosa_import_file' ? { ...tool, description: 'Unknown policy' } : tool),
    input.currentTools.map(tool => tool.name === 'ponderosa_import_file' ? { ...tool, inputSchema: { type: 'object' } } : tool),
  ]) assert.deepEqual(previousPublicationSessionContracts({ ...input, currentTools }), []);
  const accepted = previousPublicationSessionContracts(input)[0];
  const changed = previousPublicationSessionContracts({ ...input, currentTools: input.currentTools.map(tool =>
    tool.name === 'ponderosa_message' ? { ...tool, description: 'Changed unrelated tool' } : tool) })[0];
  assert.notEqual(providerToolContractHash(changed.tools, changed.communicationPrompt),
    providerToolContractHash(accepted.tools, accepted.communicationPrompt), 'unrelated tool changes cannot match the accepted hash');
});
