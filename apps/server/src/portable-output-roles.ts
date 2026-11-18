import type {PortableOutputRoleDto} from '@ponderosa/core';
import {exactObjectFields,validatedObject} from './object-validation.js';
/** Ref identity is package-local; callers supply included canonical logical refs. */
export function validateOutputRoles(value:unknown,refs:ReadonlySet<string>):PortableOutputRoleDto[]|undefined {
 if(value===undefined)return;
 if(!Array.isArray(value)||value.length>refs.size)throw new Error('Invalid output role declarations');
 const seen=new Set<string>();let speakers=0;
 return value.map(candidate=>{const v=validatedObject(candidate,'Output role');exactObjectFields(v,['ref','output','speaker'],'Output role');
  if(typeof v.ref!=='string'||!refs.has(v.ref)||seen.has(v.ref)||typeof v.output!=='boolean'||typeof v.speaker!=='boolean'||(v.speaker&&!v.output)|| (v.speaker&&++speakers>1))throw new Error('Output roles require unique included refs and at most one output speaker');
  seen.add(v.ref);return {ref:v.ref,output:v.output,speaker:v.speaker};
 });
}
