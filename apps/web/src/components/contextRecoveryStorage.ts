import type {ProviderContextRecoveryStatus} from '@ponderosa/core';
export type RecoveryBoundary=NonNullable<ProviderContextRecoveryStatus['boundary']>;
/** Recovery command identity must survive reload; optional preference fallbacks cannot authorize it. */
export function readRecoveryKey(key:string):{key?:string;boundary?:RecoveryBoundary;productPath?:string;error?:string} {
 try {
  const value=localStorage.getItem(key);
  if(value?.startsWith('{')) {
   const saved=JSON.parse(value);
   if(typeof saved.key!=='string'||!saved.key||typeof saved.productPath!=='string'||
       !saved.boundary||typeof saved.boundary.providerSessionId!=='string'||typeof saved.boundary.sourceRunId!=='string'||
       !/^[a-f0-9]{64}$/u.test(saved.boundary.toolContractHash)||!Number.isSafeInteger(saved.boundary.sourceFence)) throw Error('Invalid recovery identity');
   return {key:saved.key,boundary:saved.boundary,productPath:saved.productPath};
  }
  return value?{key:value}:{};
 } catch {
  return {error:'Saved recovery key is unavailable. Restore browser storage and reload before requesting recovery.'};
 }
}
export function writeRecoveryKey(key:string,value:string,binding?:{boundary:RecoveryBoundary;productPath:string}):void {
 try {
  const saved=value&&binding?JSON.stringify({key:value,...binding}):value;
  localStorage.setItem(key,saved);
  if(localStorage.getItem(key)!==saved)throw Error('Recovery key readback differs');
 } catch {
  throw Error(value?'Recovery key could not be saved and verified. No recovery was requested.':'Dismissal returned, but its local key could not be cleared. Reload status before another action.');
 }
}
