import type {CapabilityPolicyRecord} from "@ponderosa/core";

export type CapabilityDraft={restricted:string[];baseline:string[];revision:number};
const sameRestrictions=(a:string[],b:string[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());

export function capabilityDraftDirty(draft:CapabilityDraft|undefined):boolean{
  return Boolean(draft&&!sameRestrictions(draft.restricted,draft.baseline));
}
export function reconcileCapabilityDraft(current:CapabilityDraft|undefined,policy:CapabilityPolicyRecord):CapabilityDraft{
  const next={restricted:policy.restrictedCapabilityIds,baseline:policy.restrictedCapabilityIds,revision:policy.revision};
  return !current||!capabilityDraftDirty(current)?next:current;
}
