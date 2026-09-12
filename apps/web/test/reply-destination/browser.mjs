import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url)('playwright');
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
try {
  for(const scenario of ['unchanged','target-disappears','target-restored','same-agent-reply','different-agent-reply','manual-mention','reload-draft','unavailable','rename','durable-reload','durable-rename','reply-before-ack']) {
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    let draft={conversationId:'diagnostic-chat',ownerId:'',text:'',attachmentIds:[],mentionBindings:[],revision:0,updatedAt:new Date().toISOString(),clientId:''};
    await page.route('**/api/**',async route=>{
      const req=route.request(),url=new URL(req.url());
      if(url.pathname.endsWith('/draft')) {
        if(req.method()==='PUT') {
          const body=req.postDataJSON();
          assert.equal(body.expectedRevision,draft.revision);
          draft={...body,conversationId:'diagnostic-chat',revision:draft.revision+1,updatedAt:new Date().toISOString()};
        }
        return route.fulfill({json:{...draft,ownerId:draft.ownerId||url.searchParams.get('ownerId')}});
      }
      return route.fulfill({json:{}});
    });
    const query=scenario.startsWith('durable')?'?durable=1':scenario==='reply-before-ack'?'?deferred=1':'';
    await page.goto('http://127.0.0.1:21845/'+query);
    const input=page.locator('.composer-editor-input');await input.waitFor();await page.waitForTimeout(400);
    assert.ok((await input.innerText()).includes('#Boston'),scenario+' initial token');
    if(scenario==='manual-mention')await page.getByRole('button',{name:'Mention Boston',exact:true}).click();
    await input.click();await page.keyboard.press('End');await page.keyboard.type('my reply');
    if(['target-disappears','target-restored','manual-mention'].includes(scenario))await page.getByRole('button',{name:'Lose target'}).click();
    if(['target-restored','manual-mention'].includes(scenario)){await page.waitForTimeout(100);await page.getByRole('button',{name:'Restore Boston'}).click();}
    if(scenario==='same-agent-reply')await page.getByRole('button',{name:'Another reply'}).click();
    if(scenario==='different-agent-reply'){
      await page.getByRole('button',{name:'Arches reply'}).click();await page.waitForTimeout(100);
      assert.equal(await input.evaluate(e=>e.contains(document.activeElement)),false,'background reply must not steal focus');
    }
    if(scenario==='unavailable')await page.getByRole('button',{name:'Remove Boston'}).click();
    if(scenario==='rename'||scenario==='durable-rename')await page.getByRole('button',{name:'Rename and reuse handle'}).click();
    if(['reload-draft','durable-reload','durable-rename'].includes(scenario)) {
      await page.waitForTimeout(1000);
      if(scenario.startsWith('durable')){assert.ok(draft.text.includes('#Boston'));assert.equal(draft.mentionBindings[0].agentId,'boston');}
      await page.reload();await input.waitFor();await page.waitForTimeout(400);
    }
    await page.waitForTimeout(200);
    assert.ok((await input.innerText()).includes('my reply'));
    await input.focus();await page.keyboard.press('Enter');await page.waitForTimeout(350);
    if(scenario==='unavailable') {
      assert.equal(await page.locator('#sent').innerText(),'');
      assert.ok((await page.locator('body').innerText()).includes('available Agent'));
    } else {
      const sent=JSON.parse(await page.locator('#sent').innerText());
      assert.equal(sent.context.mentionedAgents.length,1,scenario);
      assert.equal(sent.context.mentionedAgents[0].agentId,'boston',scenario);
      assert.equal(sent.context.newAgentRequested,false,scenario);
      if(scenario==='reply-before-ack') {
        await page.getByRole('button',{name:'Arches reply'}).click();await page.waitForTimeout(100);
        assert.ok((await input.innerText()).includes('#Boston'));
        await page.getByRole('button',{name:'Finish send'}).click();await page.waitForTimeout(300);
        assert.ok((await input.innerText()).includes('#Arches'));
        assert.ok(!(await input.innerText()).includes('my reply'));
      }
    }
    assert.deepEqual(errors,[]);console.log('PASS',scenario);await page.close();
  }
} finally {await browser.close();}
