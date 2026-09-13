import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE)('playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
try {
 for(const [width,height,drawer] of [[390,844,true],[390,600,true],[1200,800,false],[1200,500,false]]) {
  const page=await browser.newPage({viewport:{width,height}});
  await page.goto(`http://127.0.0.1:21848/?rail${drawer?'&drawer':''}`);
  const projects=page.locator('button[draggable="true"]');
  await projects.first().waitFor();
  for(const bounds of await projects.evaluateAll(els=>els.map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})))) assert.deepEqual(bounds,{width:48,height:48});
  const home=page.getByRole('button',{name:'Home',exact:true});
  const search=page.getByRole('button',{name:'Search',exact:true});
  const fixed=[await home.boundingBox(),await search.boundingBox()];
  const scroller=page.locator('nav .ponderosa-scroll');
  assert.ok(await scroller.evaluate(el=>el.scrollHeight>el.clientHeight),'Projects overflow into scroll area');
  await projects.last().scrollIntoViewIfNeeded();
  assert.ok(await scroller.evaluate(el=>el.scrollTop>0));
  assert.deepEqual([await home.boundingBox(),await search.boundingBox()],fixed,'Utility buttons stay fixed');
  await projects.first().scrollIntoViewIfNeeded();
  const data=await page.evaluateHandle(()=>new DataTransfer());
  const first=page.getByRole('button',{name:'Project 0',exact:true});
  const second=page.getByRole('button',{name:'Project 1',exact:true});
  await first.dispatchEvent('dragstart',{dataTransfer:data});
  const box=await second.boundingBox();
  await second.dispatchEvent('dragover',{dataTransfer:data,clientY:box.y+box.height-1});
  await second.dispatchEvent('drop',{dataTransfer:data,clientY:box.y+box.height-1});
  assert.equal(await projects.first().getAttribute('aria-label'),'Project 1','Existing reorder callback preserved');
  console.log(`PASS ${width}x${height} drawer=${drawer}: 48px circles, scroll, fixed utilities, reorder`);
  await page.close();
 }
} finally {await browser.close();}
