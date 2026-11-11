/** Locally issued canonical import evidence. Never part of a portable package. */
export interface GeneratedHookIdentity {
 device:string;inode:string;mode:string;nlink:string;uid:string;gid:string;size:string;mtimeNs:string;ctimeNs:string;
}
export interface CanonicalGeneratedHooksProof {
 schema:'ponderosa.generated-hook-namespace.v1';
 operationId:string;
 sourceOriginalSha256:string;
 root:{device:string;inode:string};
 namespace:GeneratedHookIdentity;
 links:Array<{name:string;text:string;identity:GeneratedHookIdentity}>;
}
