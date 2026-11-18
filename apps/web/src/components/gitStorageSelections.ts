import type {GitStorageSelection} from '@ponderosa/core';
export function gitStorageSelectionError(bindings:readonly GitStorageSelection[],agentIds:ReadonlySet<string>):string|undefined {
 if(bindings.length>1000)return 'Choose at most 1,000 Git folder mappings.';
 const ids=new Set<string>(),roles=new Set<string>();
 for(const binding of bindings){
  if(!agentIds.has(binding.worktreeAgentId)||!agentIds.has(binding.storageAgentId))return 'Choose included Agents for both working and storage folders.';
  const relative=binding.relativePath;
  if(relative!=='.'&&(!relative||new TextEncoder().encode(relative).length>4096||/[\\:\x00-\x1f\x7f]/.test(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..')))return 'Enter a contained relative Git folder, such as .git; use . for the selected folder itself.';
  const role=binding.worktreeAgentId+':'+binding.role+(binding.role==='module'?':'+binding.id:'');
  if(ids.has(binding.id)||roles.has(role))return 'Each Git mapping and working-folder role must be distinct.';
  ids.add(binding.id);roles.add(role);
 }
}
