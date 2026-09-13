import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE)('playwright');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
try {
 for(const width of [320,390,412,1280]) {
  const page=await browser.newPage({viewport:{width,height:844}});
  await page.goto('http://127.0.0.1:21849');
  if(width<900) await page.getByRole('button',{name:'Expand workspace header',exact:true}).click();
  const title=page.getByRole('heading');
  await title.waitFor();
  const boxes=await Promise.all(['Provider usage','Open browser','Collapse workspace header'].map(name=>page.getByRole('button',{name,exact:true}).boundingBox()));
  assert.ok(boxes.every(b=>b&&Math.abs(b.y-boxes[0].y)<1),'actions share a row');
  assert.ok(boxes.every(b=>b.x>=0&&b.x+b.width<=width),'actions stay in viewport');
  if(width<600) {
   assert.ok(boxes.every(b=>b.width>=44&&b.height>=44),'touch targets retained');
   assert.ok(await title.evaluate(el=>el.scrollWidth>el.clientWidth&&getComputedStyle(el).textOverflow==='ellipsis'),'title truncates');
   const t=await title.boundingBox();
   assert.ok(Math.abs(t.y-boxes[0].y)<20,'title and actions on same row');
  }
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
  await page.getByRole('button',{name:'Collapse workspace header',exact:true}).click();
  await page.getByRole('button',{name:'Expand workspace header',exact:true}).click();
  await page.getByRole('button',{name:'Open browser',exact:true}).waitFor();
  console.log(`PASS ${width}px: header geometry, title, targets, collapse/expand`);
  if(width===390) await page.screenshot({path:'/tmp/mobile-header.png'});
  await page.close();
 }
} finally {await browser.close();}
