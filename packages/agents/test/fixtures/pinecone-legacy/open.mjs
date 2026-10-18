import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
const manifest=JSON.parse(readFileSync(new URL('./manifest.json',import.meta.url),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
/** Exact historical schema/seed state without requiring private or shallow Git history. */
export function openHistoricalDb(ref,file){
 const record=manifest[ref];assert(record,'unknown frozen historical schema');
 const sql=readFileSync(new URL(record.file,import.meta.url),'utf8');
 assert.equal(hash(sql),record.sqlSha256,'historical SQL fixture checksum');
 const client=new Database(file);
 try{
  client.pragma('foreign_keys = OFF');client.exec(sql);client.pragma('foreign_keys = ON');
  const graph=client.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  assert.equal(hash(JSON.stringify(graph)),record.schemaSha256,'exact historical schema graph');
  assert.deepEqual(client.pragma('foreign_key_check'),[]);
  return {client};
 }catch(error){client.close();throw error}
}
