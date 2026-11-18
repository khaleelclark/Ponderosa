// Minimal WebDriver command bridge for the existing qualification flow. Clipboard
// uses the browser's real permissioned Clipboard API plus trusted Control+V.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
const keyMap={'\ue009':'Control','\ue008':'Shift','\ue007':'Enter','\ue003':'Backspace'};
let context,page;const elements=new Map();let next=0;
const decode=value=>value&&typeof value==='object'&&value['element-6066-11e4-a52e-4f735466cecf']?elements.get(value['element-6066-11e4-a52e-4f735466cecf']):value;
const server=createServer(async(req,res)=>{try{
 let raw='';for await(const bytes of req)raw+=bytes;const data=raw?JSON.parse(raw):{},path=req.url.replace(/^\/session\/mobile/,'');let value=null;
 if(req.url==='/status')value={ready:true};
 else if(req.url==='/session'&&req.method==='POST'){
  context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true,permissions:['clipboard-read','clipboard-write'],userAgent:'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/'+browser.version()+' Mobile Safari/537.36'});page=await context.newPage();elements.clear();value={sessionId:'mobile',capabilities:{browserName:'chromium',browserVersion:browser.version(),emulation:{isMobile:true,hasTouch:true,deviceScaleFactor:3,viewport:{width:390,height:844}},physicalDevice:false}};
 }else if(path===''&&req.method==='DELETE'){await context.close();context=null;}
 else if(path==='/window/rect'){await page.setViewportSize({width:data.width,height:data.height});value=data;}
 else if(path==='/url')await page.goto(data.url,{waitUntil:'load'});
 else if(path==='/clipboard')await page.evaluate(text=>navigator.clipboard.writeText(text),data.text);
 else if(path==='/execute/sync'){
  const result=await page.evaluateHandle(({script,args})=>new Function(script).apply(null,args),{script:data.script,args:data.args.map(decode)});
  if(result.asElement()){const id=String(++next);elements.set(id,result.asElement());value={'element-6066-11e4-a52e-4f735466cecf':id};}else{value=await result.jsonValue();await result.dispose();}
 }else if(path==='/actions'){
  for(const source of data.actions)for(const action of source.actions){const key=keyMap[action.value]??action.value;if(action.type==='keyDown')await page.keyboard.down(key);else if(action.type==='keyUp')await page.keyboard.up(key);else throw Error('Unsupported native action '+action.type);}
 }else if(path==='/screenshot')value=(await page.screenshot()).toString('base64');
 else if(path.match(/^\/element\/[^/]+\/click$/)){const id=path.split('/')[2];await elements.get(id).tap({timeout:5000});}
 else if(path.match(/^\/element\/[^/]+\/value$/)){const id=path.split('/')[2],e=elements.get(id);await e.focus();for(const char of data.text)await page.keyboard.press(keyMap[char]??char);}
 else throw Error('Unsupported command '+req.method+' '+req.url);
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({value}));
}catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({value:{error:'unknown error',message:error.message}}));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{const child=spawn('python3',['tests/workspace-navigation/webkit-every-input.py'],{stdio:'inherit',env:{...process.env,QUALIFICATION_DRIVER:'chromium-mobile',WEBDRIVER_ORIGIN:`http://127.0.0.1:${server.address().port}`}});const [code]=await once(child,'exit');process.exitCode=code;}
finally{if(context)await context.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
