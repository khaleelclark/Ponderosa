import {createHash} from 'node:crypto';
import {sourcePathKey} from './portable-source-paths.js';

import type {GeneratedHookIdentity} from '@ponderosa/core';

export const GENERATED_HOOK_NAMESPACE='.ponderosa-portable-review/active-git-hooks';
export type {CanonicalGeneratedHooksProof,GeneratedHookIdentity} from '@ponderosa/core';

export function generatedHookName(sourceConfigPath:string,rawValue:string):string {
 return createHash('sha256').update(JSON.stringify([sourcePathKey(sourceConfigPath),rawValue])).digest('hex');
}
export function generatedHookIdentity(stat:{dev:bigint;ino:bigint;mode:bigint;nlink:bigint;uid:bigint;gid:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint}):GeneratedHookIdentity {
 return {device:stat.dev.toString(),inode:stat.ino.toString(),mode:stat.mode.toString(),nlink:stat.nlink.toString(),uid:stat.uid.toString(),gid:stat.gid.toString(),size:stat.size.toString(),mtimeNs:stat.mtimeNs.toString(),ctimeNs:stat.ctimeNs.toString()};
}
