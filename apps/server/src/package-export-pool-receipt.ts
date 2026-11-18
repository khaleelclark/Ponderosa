import type Database from 'better-sqlite3';

/** These callbacks persist issuance before any pool creation. An uncertain
 * intent is never automatically cleared, retried, or matched to a pathname. */
export function packageExportPoolCallbacks(db:Database.Database){
 return {
  readMarker():{state:'intent'|'ready';receipt:unknown}|undefined{
   const row=db.prepare('SELECT state,receipt FROM package_export_pool WHERE singleton=1').get() as {state:string;receipt:string|null}|undefined;
   if(!row)return;
   if(row.state==='intent'&&row.receipt===null)return {state:'intent',receipt:null};
   if(row.state!=='ready'||typeof row.receipt!=='string'||row.receipt.length>8192)throw new Error('Export pool issuance receipt is malformed; the pool remains held.');
   let receipt:unknown;try{receipt=JSON.parse(row.receipt);}catch{throw new Error('Export pool issuance receipt is malformed; the pool remains held.');}
   return {state:'ready',receipt};
  },
  beginCreation():void{
   db.transaction(()=>{
    if(db.prepare('SELECT 1 FROM package_export_pool WHERE singleton=1').get())throw new Error('Export pool issuance already exists or is unconfirmed; it remains held.');
    db.prepare("INSERT INTO package_export_pool(singleton,state,receipt) VALUES(1,'intent',NULL)").run();
   }).immediate();
  },
  completeCreation(receipt:unknown):void{
   const encoded=JSON.stringify(receipt);
   if(typeof encoded!=='string'||encoded.length>8192)throw new Error('Export pool issuance receipt is invalid; the pool remains held.');
   db.transaction(()=>{
    const update=db.prepare("UPDATE package_export_pool SET state='ready',receipt=? WHERE singleton=1 AND state='intent' AND receipt IS NULL").run(encoded);
    if(update.changes!==1)throw new Error('Export pool issuance changed; the pool remains held.');
   }).immediate();
  },
 };
}
