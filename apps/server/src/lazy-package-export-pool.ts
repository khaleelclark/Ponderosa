import type Database from 'better-sqlite3';
import type {StateAdmission} from '@ponderosa/agents';
import type {ExportPool} from './sqlite-package-export-downloads.js';
import {packageExportPoolCallbacks} from './package-export-pool-receipt.js';
import {openPackageExportPool,type PackageExportPool} from './package-export-pool.js';

/** The app can start even if pool custody is unavailable. Acquire a live
 * admission only when an export needs durable staging and retain it until close. */
export function lazyPackageExportPool(dataDir:string,db:Database.Database,acquire:()=>StateAdmission):ExportPool{
 let pool:PackageExportPool|undefined,admission:StateAdmission|undefined,closed=false;
 function get():PackageExportPool{
  if(closed)throw new Error('Export pool is closed');
  if(pool)return pool;
  const permit=acquire();
  try{
   permit.assertRoot(dataDir);
   if(permit.client!==db)throw new Error('Export pool and database authorities differ');
   const next=permit.withDirectoryAuthority(authority=>openPackageExportPool(authority,packageExportPoolCallbacks(db)));
   admission=permit;pool=next;return next;
  }catch(error){permit.close();throw error;}
 }
 return {
  assert(){get().assert();},size(){return get().size();},allocatedBytes(){return get().allocatedBytes();},
  read(offset,length){return get().read(offset,length);},write(offset,bytes){get().write(offset,bytes);},
  sync(){get().sync();},
  close(){if(closed)return;closed=true;try{pool?.close();}finally{admission?.close();pool=undefined;admission=undefined;}},
 };
}
