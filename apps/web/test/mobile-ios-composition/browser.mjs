import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium,webkit,devices}=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url)('playwright');
const engine=process.env.BROWSER==='webkit'?webkit:chromium;
const executablePath=engine===webkit?process.env.WEBKIT_PATH:process.env.CHROMIUM_PATH;
const browser=await engine.launch({headless:true,...(executablePath?{executablePath}:{})});
try{
 for(const [name,options,ios] of [
  ['iPhone',{...devices['iPhone 13']},true],
  ['Android',{...devices['Pixel 7']},false],
  ['desktop',{viewport:{width:1200,height:800}},false],
 ]){
  for(const mention of [false,true]){
   const context=await browser.newContext(options);
   await context.addInitScript(()=>{
    window.SpeechRecognition=class {
     start(){queueMicrotask(()=>this.onstart?.());}
     stop(){queueMicrotask(()=>this.onend?.());}
     abort(){this.stop();}
    };
   });
   const page=await context.newPage();
   await page.route('**/api/**',r=>r.fulfill({json:{}}));
   await page.goto(`http://127.0.0.1:21848/${mention?'?mention':''}`);
   const input=page.locator('.composer-editor-input');
   await input.waitFor();
   assert.equal(await page.getByRole('button',{name:/dictation/i}).count(),1,`${name}: Project chat exposes dictation or its unsupported-browser reason`);
   const font=await input.evaluate(el=>getComputedStyle(el).fontSize);
   assert.equal(await input.getAttribute('role'),'textbox');
   assert.equal(await input.getAttribute('aria-multiline'),'true');
   assert.equal(await input.getAttribute('aria-expanded'),null);
   assert.equal(await page.locator('html').getAttribute('lang'),'en');
   if(!process.env.BASELINE) assert.equal(font,ios?'16px':'15px',`${name} editor size`);
   if(name!=='desktop') {
    for(const width of [320,390,412]) {
     await page.setViewportSize({width,height:844});
     await page.getByRole('button',{name:'Start voice dictation',exact:true}).click();
     await page.getByRole('button',{name:'Pause voice dictation',exact:true}).waitFor();
     const toolbar=await page.locator('[data-composer-toolbar]').boundingBox();
     const send=await page.locator('[data-composer-send-actions]').boundingBox();
     assert.ok(Math.abs(toolbar.y+toolbar.height/2-send.y-send.height/2)<2,'Send remains on the toolbar row during dictation');
     assert.ok(send.x+send.width<=width,'Send stays horizontally visible');
     if(name==='iPhone'&&mention&&width===390) await page.screenshot({path:'/tmp/ios-composer-dictating.png'});
     await page.getByRole('button',{name:'Stop voice dictation',exact:true}).click();
     await page.getByRole('button',{name:'Start voice dictation',exact:true}).waitFor();
    }
   }
   if(ios) {
    // Inject the two independent visual-viewport dimensions, rather than only
    // resizing the layout viewport (which cannot reproduce iOS focus panning).
    for(const [height,offsetTop] of [[360,220],[330,280],[844,0],[360,180],[844,0]]) {
     await page.evaluate(({height,offsetTop})=>{
      Object.defineProperties(visualViewport,{height:{configurable:true,value:height},offsetTop:{configurable:true,value:offsetTop}});
      visualViewport.dispatchEvent(new Event('resize'));
      visualViewport.dispatchEvent(new Event('scroll'));
     },{height,offsetTop});
     await page.waitForTimeout(50);
     const frame=await page.locator('#root').boundingBox();
     assert.equal(Math.round(frame.y),offsetTop,'App follows visual viewport origin');
     assert.equal(Math.round(frame.height),height,'Pan offset must not inflate app height');
     const send=await page.locator('[data-composer-send-actions]').boundingBox();
     assert.ok(send.y>=offsetTop&&send.y+send.height<=offsetTop+height+1,'Send inside panned viewport');
    }
    await page.evaluate(()=>{delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event('resize'));});
   }
   await input.click();await page.keyboard.press('End');await page.keyboard.type('first');
   await page.keyboard.press('Enter');
   await page.waitForTimeout(100);
   const sent=()=>page.locator('#sent').textContent().then(JSON.parse);
   if(ios){
    assert.deepEqual(await sent(),[],'iOS Return must not send');
    await page.keyboard.press('Enter');await page.keyboard.type('second');
    await page.keyboard.press('Shift+Enter');await page.keyboard.type('third');
    await page.getByRole('button',{name:'Send message',exact:true}).click();
    await page.waitForTimeout(150);
    const messages=await sent();
    assert.equal(messages.length,1,'Send once');
    assert.equal(messages[0],`${mention?'#Boston ':''}first\n\nsecond\nthird`,'Exact newline serialization');
    await input.click();await page.keyboard.press('End');await page.keyboard.type('composition');
    await input.evaluate(el=>el.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertParagraph',bubbles:true,cancelable:true})));
    await page.waitForTimeout(50);
    await page.keyboard.insertText('after');
    await page.getByRole('button',{name:'Send message',exact:true}).click();
    await page.waitForTimeout(150);
    assert.equal((await sent()).length,2,'Explicit second Send');
    assert.ok((await sent())[1].endsWith('composition\nafter'),`Soft-keyboard beforeinput inserts exactly one newline: ${JSON.stringify(await sent())}`);
    await input.click();await page.keyboard.press('End');await page.keyboard.type('IME draft');
    await input.dispatchEvent('keydown',{key:'Enter',keyCode:229,isComposing:true,bubbles:true});
    assert.equal((await sent()).length,2,'Composing must not submit');
   }else{
    assert.equal((await sent()).length,1,`${name} Enter-to-send unchanged`);
    if(name==='Android'){
     await input.click();await page.keyboard.press('End');await page.keyboard.type('first');
     await page.keyboard.press('Shift+Enter');await page.keyboard.type('second');
     await page.getByRole('button',{name:'Send message',exact:true}).click();await page.waitForTimeout(150);
     assert.ok((await sent())[1].endsWith('first\nsecond'),'Mobile Chromium Shift+Enter must not duplicate newlines');
    }
   }
   await input.click();await page.keyboard.press('End');
   await page.keyboard.insertText(Array.from({length:35},(_,i)=>`line ${i}`).join('\n'));
   await page.waitForTimeout(100);
   assert.ok((await input.boundingBox()).height<=110,'Long drafts remain bounded');
   await page.getByRole('button',{name:'Add attachment or capability',exact:true}).click();
   const capabilityFilter=page.getByRole('textbox',{name:'Filter runtime capabilities'});
   await capabilityFilter.waitFor();
   assert.equal(await capabilityFilter.evaluate(el=>getComputedStyle(el).fontSize),ios?'16px':'14px','Plus-menu search uses iOS focus-zoom-safe text without changing other platforms');
   await page.keyboard.press('Escape');
   // Geometry simulation only: not an actual iOS/Android soft keyboard.
   for(const viewport of [{width:390,height:400},{width:844,height:390},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    for(let repeat=0;repeat<3;repeat++){
     await input.focus();
     await page.locator('#dismiss').focus();
    }
    await input.focus();
    await page.waitForTimeout(100);
    const box=await page.locator('#composer').boundingBox();
    assert.ok(box.y>=0&&box.y+box.height<=viewport.height+1,`${name}: composer fits reduced/rotated viewport`);
    const sendBox=await page.getByRole('button',{name:'Send message',exact:true}).boundingBox();
    assert.ok(sendBox&&sendBox.y>=0&&sendBox.y+sendBox.height<=viewport.height+1,'Send stays in simulated visible area');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No page overflow');
   }
   console.log(`PASS ${engine.name()} ${name} mention=${mention}: input, send, composition/unchanged Return, reduced-height/rotation geometry`);
   await context.close();
  }
 }
}finally{await browser.close();}
