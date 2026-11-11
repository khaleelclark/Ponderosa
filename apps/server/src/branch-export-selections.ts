import type {BranchExportFileSelections,GitStorageSelection} from '@ponderosa/core';
import {stableJson} from '@ponderosa/agents';
import {validateGitStorageSelections} from './portable-reviewed-user-data.js';

/** The shared export form repeats one global selection; repetition is not another capture. */
export function collectBranchGitStorageSelections(selections:BranchExportFileSelections):GitStorageSelection[]{
 const byId=new Map<string,GitStorageSelection>();
 for(const selection of Object.values(selections))for(const binding of selection.gitStorageBindings??[]){
  validateGitStorageSelections([binding]);const prior=byId.get(binding.id);
  if(prior&&stableJson(prior)!==stableJson(binding))throw new Error('Conflicting global Git storage binding ID');
  if(!prior)byId.set(binding.id,binding);
 }
 return [...byId.values()];
}
