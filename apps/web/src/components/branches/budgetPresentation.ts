import type {BranchExecutionBudgetDto} from '@ponderosa/core';
/** No default 0/unlimited while authority is unavailable. */
export function budgetPresentation(query:{data?:BranchExecutionBudgetDto;error?:unknown;isFetching?:boolean}) {
 if(query.error)return {message:'Budget unavailable'};
 if(!query.data)return {message:'Loading automatic execution budget…'};
 const b=query.data;
 if(b.policy!==null&&(!b.policy||!Number.isSafeInteger(b.used)||!Number.isSafeInteger(b.allowance)||!Number.isSafeInteger(b.policy.limit)))return {message:'Budget unavailable'};
 const message=b.policy?`${b.used} used · ${b.policy.limit} base + ${b.allowance} extra executions`:'Unlimited automatic executions';
 return {message:query.isFetching?`Refreshing budget… Last observed: ${message}`:message};
}
export function validBudgetNumber(value:string) {
 const n=Number(value);return value.trim()!==''&&Number.isSafeInteger(n)&&n>=1&&n<=1_000_000_000;
}
