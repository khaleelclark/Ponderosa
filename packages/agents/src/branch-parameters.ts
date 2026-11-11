import type { BranchConfiguration, BranchDefinition } from '@ponderosa/core';
import { branchKey, branchText } from './branch-definition.js';

export const DEFAULT_BRANCH_CONFIGURATION: BranchConfiguration = {
  parameters: {}, limits: { maxCallDepth: 100, maxLoopIterations: 100, maxTraversals: 100 },
};
export function validateBranchConfiguration(value: unknown, definition: BranchDefinition, requireConfigured=false): BranchConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Branch configuration');
  const v = value as BranchConfiguration;
  if (Object.keys(v).some(k => !['parameters','limits','secretBindings','checkpointMode'].includes(k)) || !v.parameters || typeof v.parameters !== 'object' || Array.isArray(v.parameters)) throw new Error('Invalid Branch configuration');
  if (v.checkpointMode !== undefined && !['async','sync','exit'].includes(v.checkpointMode)) throw new Error('Invalid checkpoint mode');
  const limits = { ...DEFAULT_BRANCH_CONFIGURATION.limits, ...v.limits };
  for (const [key,n] of Object.entries(limits)) if (!['maxCallDepth','maxLoopIterations','maxTraversals'].includes(key) || !Number.isSafeInteger(n) || n < 1 || n > 1_000_000) throw new Error(`Invalid limit: ${key}`);
  const parameters: BranchConfiguration['parameters'] = {};
  for (const key of Object.keys(v.parameters)) if (!definition.parameters?.[key] || definition.parameters[key]!.type === 'secret') throw new Error(`Unsupported parameter value: ${key}`);
  for (const [key,p] of Object.entries(definition.parameters ?? {})) {
    branchKey(key);
    if (p.type === 'secret') continue;
    const supplied = Object.hasOwn(v.parameters,key) ? v.parameters[key] : p.default;
    if (supplied === undefined) { if (p.required&&requireConfigured) throw new Error(`Parameter is required: ${key}`); continue; }
    if ((p.type === 'text' || p.type === 'path') ? typeof supplied !== 'string' : p.type === 'number' ? typeof supplied !== 'number' || !Number.isFinite(supplied) : typeof supplied !== 'boolean') throw new Error(`Invalid parameter: ${key}`);
    parameters[key] = typeof supplied === 'string' ? branchText(supplied) : supplied;
  }
  const secretBindings: Record<string,string> = {};
  if (v.secretBindings !== undefined && (!v.secretBindings || typeof v.secretBindings !== 'object' || Array.isArray(v.secretBindings))) throw new Error('Invalid secret bindings');
  for (const [key,binding] of Object.entries(v.secretBindings ?? {})) {
    if (definition.parameters?.[key]?.type !== 'secret') throw new Error('Unknown secret binding');
    // Opaque Engine-owned bindings only; no credential values or Script consumers.
    secretBindings[key] = branchKey(binding);
  }
  return { parameters, limits, ...(v.checkpointMode === undefined ? {} : {checkpointMode:v.checkpointMode}), ...(Object.keys(secretBindings).length ? {secretBindings} : {}) };
}
export function interpolateBranchText(text: string, definition: BranchDefinition, configuration: BranchConfiguration): string {
  return branchText(text.replace(/\{\{parameter:([a-zA-Z0-9_.:-]+)\}\}/gu, (_match,key: string) => {
    if (definition.parameters?.[key]?.type === 'secret') throw new Error('Secrets cannot be interpolated into text');
    if (!Object.hasOwn(configuration.parameters,key)) throw new Error(`Parameter is missing: ${key}`);
    return String(configuration.parameters[key]);
  }));
}

/** Simple explicit references, with native scalar types for whole-value references. */
export function resolveBranchParameterReferences(value:unknown,definition:BranchDefinition,configuration:BranchConfiguration):unknown {
 if(typeof value==='string'){
  const match=/^\{\{parameter:([a-zA-Z0-9_.:-]+)\}\}$/.exec(value);
  const text=interpolateBranchText(value,definition,configuration);
  return match?configuration.parameters[match[1]!]:text;
 }
 if(Array.isArray(value))return value.map(item=>resolveBranchParameterReferences(item,definition,configuration));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolveBranchParameterReferences(item,definition,configuration)]));
 return value;
}
