// Maintenance-only capture. Tests load committed SQL and never invoke Git.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import ts from 'typescript';
const root=fileURLToPath(new URL('../../../../../',import.meta.url));
const output=fileURLToPath(new URL('./',import.meta.url));
const refs=['9afdf1f2cbf21effa5372c693af99bf3fd599925','0e7ee833d5f633e0d681c36c7880191cc7e30b94'];
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'});
const hash=value=>createHash('sha256').update(value).digest('hex');
const literal=value=>value===null?'NULL':typeof value==='number'||typeof value==='bigint'?String(value):Buffer.isBuffer(value)?"X'"+value.toString('hex')+"'":"'"+String(value).replaceAll("'","''")+"'";
const quote=name=>'"'+name.replaceAll('"','""')+'"';
const manifest={};
for(const ref of refs){
 const dir=mkdtempSync(join(tmpdir(),'pinecone-legacy-capture-'));
 const module=join(root,'packages/agents/dist',`.capture-legacy-${process.pid}-${ref.slice(0,8)}.mjs`);
 let client;
 try{
  const schemaDir=join(dir,'schema');mkdirSync(schemaDir);
  for(const file of git('ls-tree','-r','--name-only',ref,'packages/agents/src/schema').trim().split('\n'))writeFileSync(join(schemaDir,file.split('/').at(-1)),git('show',ref+':'+file));
  const source=git('show',ref+':packages/agents/src/db.ts');
  const fixed=source.replace('const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "schema");',`const schemaDir = ${JSON.stringify(schemaDir)};`);
  assert.notEqual(fixed,source,'historical opener changes only its schema-directory path');
  writeFileSync(module,ts.transpileModule(fixed,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
  ({client}=(await import(pathToFileURL(module).href)).openDb(join(dir,'empty.sqlite')));
  const graph=client.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const shadow=new Set(client.pragma('table_list').filter(t=>t.type==='shadow').map(t=>t.name));
  const order={table:0,index:1,view:2,trigger:3};
  const statements=[`-- Fresh schema captured from ${ref}; contains no user database or records.`];
  const objects=graph.filter(row=>!shadow.has(row.name)&&!shadow.has(row.tbl_name)).sort((a,b)=>order[a.type]-order[b.type]||a.name.localeCompare(b.name));
  for(const row of objects)statements.push(row.sql+';');
  const seededTables={};
  for(const table of objects.filter(row=>row.type==='table')){
   const rows=client.prepare('SELECT * FROM '+quote(table.name)).all();
   if(rows.length)seededTables[table.name]=rows.length;
   for(const row of rows){const columns=Object.keys(row);statements.push('INSERT INTO '+quote(table.name)+' ('+columns.map(quote).join(',')+') VALUES ('+columns.map(c=>literal(row[c])).join(',')+');')}
  }
  const sql=statements.join('\n\n')+'\n',file=ref.slice(0,8)+'.sql';
  writeFileSync(join(output,file),sql);
  manifest[ref]={file,sourceDbBlob:git('rev-parse',ref+':packages/agents/src/db.ts').trim(),sourceSchemaTree:git('rev-parse',ref+':packages/agents/src/schema').trim(),sqlSha256:hash(sql),schemaSha256:hash(JSON.stringify(graph)),schemaObjects:graph.length,seededTables};
 }finally{client?.close();rmSync(module,{force:true});rmSync(dir,{recursive:true,force:true})}
}
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest));
