import type { AgentPortablePackageDto } from '@ponderosa/core';
import { branchKey, branchText } from './branch-definition.js';
import { stableJson } from './coordination-v3-canonical-json.js';
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Invalid portable Branch template fields');
  return value as Record<string, unknown>;
}
/** Reuse the existing Agent package format, allowing only desired template state. */
export function validateBranchTemplate(value: unknown): AgentPortablePackageDto {
  const p = object(value, ['schema','mode','kind','exportedAt','sourceLabel','rootRef','agents']);
  if (p.schema !== 'ponderosa.agent-package.v1' || p.mode !== 'template' || !['agent','organization'].includes(String(p.kind))) throw new Error('Branches require an Agent or organization template package');
  if (typeof p.exportedAt !== 'string' || !Number.isFinite(Date.parse(p.exportedAt))) throw new Error('Invalid template date');
  branchText(p.sourceLabel); branchKey(p.rootRef);
  if (!Array.isArray(p.agents) || !p.agents.length || p.agents.length > 100 || (p.kind === 'agent' && p.agents.length !== 1)) throw new Error('Invalid template size');
  const nodes = new Map<string, Record<string, unknown>>();
  for (const raw of p.agents) {
    const n = object(raw, ['ref','title','engine','model','effort','initialInstructions','managerRef','managementPermissions']);
    const ref = branchKey(n.ref); if (nodes.has(ref)) throw new Error('Duplicate template ref'); nodes.set(ref,n);
    if (typeof n.title !== 'string' || !n.title.trim() || [...n.title].length > 60) throw new Error('Invalid template Agent title');
    branchKey(n.engine); for (const key of ['model','effort']) if (n[key] !== undefined && (typeof n[key] !== 'string' || !String(n[key]).trim() || String(n[key]).length > 200)) throw new Error('Invalid template runtime selection');
    if (n.initialInstructions !== undefined) branchText(n.initialInstructions);
    if (n.managerRef !== undefined) branchKey(n.managerRef);
    const permissions = object(n.managementPermissions,['allowAutomaticDescendantDeletion','allowAutomaticDescendantReorganization']);
    if (Object.values(permissions).length !== 2 || Object.values(permissions).some(value => value !== false)) throw new Error('Ephemeral templates must retain managed-resource lifecycle authority in the Branch');
  }
  if (!nodes.has(String(p.rootRef))) throw new Error('Template root is missing');
  for (const [ref,node] of nodes) {
    if (ref === p.rootRef) { if (node.managerRef !== undefined) throw new Error('Template root cannot have a manager'); continue; }
    const visited = new Set([ref]); let current = node;
    while (current.ref !== p.rootRef) {
      const parent = String(current.managerRef);
      if (visited.has(parent) || !nodes.has(parent)) throw new Error('Template hierarchy must reach its one root without cycles');
      visited.add(parent); current = nodes.get(parent)!;
    }
  }
  return JSON.parse(stableJson(p)) as AgentPortablePackageDto;
}
