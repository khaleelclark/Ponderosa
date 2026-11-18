import type { BranchDefinition, BranchPackageDto, BranchRequirementsDto } from '@ponderosa/core';
import { validateBranchDefinition } from './branch-definition.js';
/** Requirements identify only logical refs; installation IDs and local values are never exported. */
export function branchRequirements(definition: BranchDefinition): BranchRequirementsDto {
  const agents=new Set<string>(),directories=new Set<string>(),engines=new Set<string>();
  for(const step of definition.steps){
    if(step.kind==='agent' && 'ref' in step.target)agents.add(step.target.ref);
    if(step.kind==='script')directories.add(step.cwdRef);
    if(step.failure?.action==='recover')agents.add(step.failure.agentRef);
  }
  if(definition.policy.failure.action==='recover')agents.add(definition.policy.failure.agentRef);
  for(const template of Object.values(definition.templates??{}))for(const node of template.agents)engines.add(node.engine);
  return {agents:[...agents].sort(),directories:[...directories].sort(),engines:[...engines].sort(),triggers:definition.trigger.kind==='manual'?[]:[definition.trigger.configRef]};
}
export function exportBranchPackage(definition: BranchDefinition, now=new Date().toISOString()): BranchPackageDto {
  return {schema:'ponderosa.branch-package.v1',exportedAt:now,definition:validateBranchDefinition(definition)};
}
export function importBranchPackage(value: unknown): { definition: BranchDefinition; requirements: BranchRequirementsDto } {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Expected a Branch package');
  const p=value as Record<string,unknown>;
  if(Object.keys(p).some(key=>!['schema','exportedAt','definition'].includes(key)) || p.schema!=='ponderosa.branch-package.v1' || typeof p.exportedAt!=='string' || !Number.isFinite(Date.parse(p.exportedAt)))throw new Error('Invalid Branch package; runtime data and local bindings are not portable');
  const definition=validateBranchDefinition(p.definition);return {definition,requirements:branchRequirements(definition)};
}
