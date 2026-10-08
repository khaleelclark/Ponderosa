import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
// The built web test recipe copies test files to scratch while retaining apps/web
// as cwd. Direct invocation resolves the original source beside this test.
const root=existsSync(new URL('./voice-conversation-browser.check.mjs',import.meta.url))
 ?fileURLToPath(new URL('../',import.meta.url)):process.cwd();
const require=createRequire(path.join(root,'../server/package.json'));
const runners=['voice-conversation-browser.check.mjs','request-storm-browser.check.mjs'];
for(const name of runners){
 const source=readFileSync(path.join(root,'test',name),'utf8');
 const expression=source.match(/const playwrightModule = await import\((.+)\);/)[1];
 const select=new Function('process','serverRequire','pathToFileURL',`return (${expression});`);
 test(`${name} default accepts a drive-qualified resolved filename and frozen file-URL control`,async()=>{
  const filename=path.win32.resolve('C:\\ci\\Ponderosa\\apps\\server\\node_modules\\playwright-core\\lib\\inprocess.js');
  const resolved={resolve:()=>filename};
  // Simulate Windows' standard-library filename conversion on this host. The
  // expression is extracted from the actual runner, rather than a copied helper.
  const selected=select({env:{}},resolved,p=>pathToFileURL(p,{windows:true}));
  assert.equal(selected,pathToFileURL(filename,{windows:true}).href);
  assert.equal(new URL(selected).protocol,'file:');assert.match(selected,/^file:\/\/\/C:\//);
  await assert.rejects(import(filename),{code:'ERR_UNSUPPORTED_ESM_URL_SCHEME'},'old native filename demonstrably fails before lookup');
  const native=select({env:{}},require,pathToFileURL);
  assert.equal(new URL(native).protocol,'file:');
  const module=await import(native);assert.ok(module.chromium??module.default.chromium,'actual frozen dependency loads');
 });
 test(`${name} retains the explicit module override verbatim`,async()=>{
  const override='data:text/javascript,export const chromium = "override-control";';
  const selected=select({env:{PONDEROSA_PLAYWRIGHT_PATH:override}},{resolve(){assert.fail('override must avoid default resolution')}},pathToFileURL);
  assert.equal(selected,override);assert.equal((await import(selected)).chromium,'override-control');
 });
 test(`${name} removes output on early module failure and preserves mkdtemp failure`,()=>{
  const temp=mkdtempSync(path.join(tmpdir(),'playwright-loader-regression-'));
  try{
   const env={...process.env,TMPDIR:temp,TEMP:temp,TMP:temp,PONDEROSA_PLAYWRIGHT_PATH:'file:///ponderosa-deliberately-missing-playwright-module.mjs'};
   const child=spawnSync(process.execPath,[path.join(root,'test',name)],{env,encoding:'utf8',timeout:15000});
   assert.equal(child.status,1,child.stderr);assert.match(child.stderr,/ERR_MODULE_NOT_FOUND/);assert.doesNotMatch(child.stderr,/ERR_INVALID_ARG_TYPE/);
   assert.deepEqual(readdirSync(temp),[],'module failure leaves no generated output directory');
   const blocked=path.join(temp,'not-a-directory');writeFileSync(blocked,'owned test fixture');
   const failed=spawnSync(process.execPath,[path.join(root,'test',name)],{env:{...env,TMPDIR:blocked,TEMP:blocked,TMP:blocked},encoding:'utf8',timeout:15000});
   assert.equal(failed.status,1,failed.stderr);assert.match(failed.stderr,/ENOTDIR|ENOENT/);assert.doesNotMatch(failed.stderr,/ERR_INVALID_ARG_TYPE/);
   assert.deepEqual(readdirSync(temp),['not-a-directory'],'no leaked output after mkdtemp failure');
  }finally{rmSync(temp,{recursive:true,force:true})}
 });
}
