import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {inventoryProjectDomain} from '../tools/project-domain-inventory.mjs';

test('source inventory enumerates tracked matches without declaring historical exceptions or removal qualified',()=>{
 const root=mkdtempSync(join(tmpdir(),'chat-domain-inventory-'));
 try{
  execFileSync('git',['init','-q',root]);mkdirSync(join(root,'schema'),{recursive:true});
  writeFileSync(join(root,'source.ts'),'const projectId = "stable";\nconst projection = true;\nconst Projection = true;\nconst getProject = () => null;\n');
  writeFileSync(join(root,'project-example.md'),'Historical project text remains.\n');
  writeFileSync(join(root,'ignored.ts'),'const projectId = "untracked";\n');
  execFileSync('git',['-C',root,'add','source.ts','project-example.md']);
  execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
  const before=readFileSync(join(root,'source.ts')),status=execFileSync('git',['-C',root,'status','--porcelain'],{encoding:'utf8'});
  const report=inventoryProjectDomain(root);
  assert.equal(report.status,'inventory_only');assert.equal(report.activeDomainRemovalVerified,false);assert.equal(report.exceptionsReviewed,false);
  assert.equal(report.sourceWorktreeDirty,true);assert.match(report.files[0].sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(report.files.map(file=>file.path),['project-example.md','source.ts']);
  assert.deepEqual(report.files.find(file=>file.path==='source.ts').lines,[1,4],'projection/Projection are unrelated, while Project callers are included');
  assert.deepEqual(readFileSync(join(root,'source.ts')),before);assert.equal(execFileSync('git',['-C',root,'status','--porcelain'],{encoding:'utf8'}),status);
 }finally{rmSync(root,{recursive:true,force:true});}
});
