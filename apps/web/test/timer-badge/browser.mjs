import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE)('playwright');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
try{for(const width of [390,1280]){
 const p=await browser.newPage({viewport:{width,height:844}});await p.goto('http://127.0.0.1:21851');await p.getByRole('status').waitFor();
 assert.ok(await p.getByRole('status').evaluate(chip=>{const timer=chip.querySelector('.MuiBox-root');return getComputedStyle(timer).fontFamily===getComputedStyle(timer.parentElement).fontFamily&&getComputedStyle(timer).minWidth==='0px';}),'timer inherits font without reserved width');
 const measured=await p.getByRole('status').evaluate(chip=>{
  const timer=chip.querySelector('.MuiBox-root');const samples=[];
  for(const text of ['0:01','0:08','0:11','9:59']){timer.textContent=text;const r=chip.getBoundingClientRect();samples.push([r.x,r.width,r.height]);}return samples;
 });assert.ok(measured.every(v=>JSON.stringify(v)===JSON.stringify(measured[0])),'timer geometry stable');
 for(let i=0;i<4;i++){
  const button=p.getByRole('button',{name:new RegExp(`^Project ${i},`)});const b=await button.boundingBox();const badge=button.locator('.MuiBadge-badge');const r=await badge.boundingBox();
  assert.equal(b.width,48);assert.equal(b.height,48);assert.ok(Math.abs(r.x+r.width-(b.x+b.width+4))<1);assert.ok(r.y+r.height/2<b.y+10);assert.equal(await badge.evaluate(e=>getComputedStyle(e).borderTopWidth),'1px');assert.ok(r.x>=0&&r.x+r.width<72);
 }
 await p.screenshot({path:`/tmp/timer-badge-${width}.png`});console.log('PASS',width,'stable timer; corner badges 1/12/99+/dot; 48px targets');await p.close();
}}finally{await browser.close();}
