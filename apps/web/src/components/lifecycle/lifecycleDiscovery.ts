import type {LifecycleDiscoveryPage} from '@ponderosa/core';
/** Cursor pages are one immutable inventory revision; never stitch changed evidence. */
export function lifecycleDiscoveryPage<T>(value:LifecycleDiscoveryPage<T>,expectedRevision?:string):LifecycleDiscoveryPage<T> {
 if(!value||!Array.isArray(value.items)||value.items.length>100||typeof value.revision!=='string'||!value.revision||expectedRevision!==undefined&&value.revision!==expectedRevision||value.nextCursor!==undefined&&(typeof value.nextCursor!=='string'||!value.nextCursor)||value.unverifiedEvidenceCount!==undefined&&(!Number.isSafeInteger(value.unverifiedEvidenceCount)||value.unverifiedEvidenceCount<0))throw Error('Lifecycle inventory changed or is invalid. Explicitly restart discovery; prior selections are stale.');
 return value;
}
