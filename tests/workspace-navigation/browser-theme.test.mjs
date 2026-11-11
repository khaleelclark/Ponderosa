import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import '../shared/web-typescript-loader.mjs';
const {browserThemeBootstrap,applyBrowserTheme,THEME_BACKGROUNDS,COLOR_MODE_STORAGE_KEY}=await import('../../apps/web/src/browserTheme.ts');
const {createPonderosaTheme,loadColorMode}=await import('../../apps/web/src/theme.ts');

function page(saved,prefersDark,{blocked=false,media=true}={}){
 const metas=new Map(['theme-color','color-scheme'].map(name=>[name,{content:'startup',setAttribute(name,value){assert.equal(name,'content');this.content=value}}]));
 const document={documentElement:{style:{}},querySelector:selector=>metas.get(selector.match(/name="([^"]+)"/)[1])};
 const window={...(media?{matchMedia:query=>{assert.equal(query,'(prefers-color-scheme: dark)');return{matches:prefersDark}}}:{})};
 Object.defineProperty(window,'localStorage',{get(){if(blocked)throw Error('Storage denied');return{getItem:key=>{assert.equal(key,COLOR_MODE_STORAGE_KEY);return saved}}}});
 return {window,document,metas};
}
function matchesTheme(context,mode){
 const background=createPonderosaTheme(mode).palette.background.default;
 assert.equal(context.document.documentElement.style.colorScheme,mode);
 assert.equal(context.document.documentElement.style.backgroundColor,background);
 assert.equal(context.metas.get('theme-color').content,background);
 assert.equal(context.metas.get('color-scheme').content,mode);
 assert.deepEqual(Object.keys(context.document.documentElement.style).sort(),['backgroundColor','colorScheme'],'Theme hints must not alter viewport/layout/overflow styles');
}

test('prepaint theme matches the existing resolved theme with saved overrides, system modes and unavailable storage',()=>{
 for(const [saved,system,options,expected] of [['dark',false,{},'dark'],['light',true,{},'light'],[null,true,{},'dark'],['invalid',false,{},'light'],['invalid',true,{},'dark'],[null,true,{blocked:true},'dark'],[null,false,{blocked:true},'light'],[null,false,{media:false},'light']]){
  const context=page(saved,system,options);vm.runInNewContext(browserThemeBootstrap(),context);matchesTheme(context,expected);
  const previous=globalThis.window;try{globalThis.window=context.window;assert.equal(loadColorMode(),expected)}finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous}
 }
});

test('runtime theme switching synchronizes root canvas and browser metadata through the same owner',()=>{
 const context=page('dark',false);vm.runInNewContext(browserThemeBootstrap(),context);
 for(const mode of ['light','dark','light']){context.mode=mode;context.background=createPonderosaTheme(mode).palette.background.default;vm.runInNewContext(`(${applyBrowserTheme.toString()})(mode,background)`,context);matchesTheme(context,mode)}
 // An unavailable/missing meta element must not break startup or theme changes.
 context.document.querySelector=()=>null;vm.runInNewContext(browserThemeBootstrap(),context);assert.equal(context.document.documentElement.style.colorScheme,'dark');
});

test('built PWA applies a single CSP-safe blocking theme script before deferred app code with matching startup colors',()=>{
 const root=new URL('../../apps/web/dist/',import.meta.url),html=readFileSync(new URL('index.html',root),'utf8'),manifest=JSON.parse(readFileSync(new URL('manifest.webmanifest',root),'utf8'));
 const scripts=[...html.matchAll(/<script\b[^>]*src="(\/theme-init\.[a-f0-9]+\.js)"[^>]*><\/script>/g)];assert.equal(scripts.length,1);
 const [tag,src]=scripts[0];assert.doesNotMatch(tag,/\b(?:defer|async|type="module")\b/);assert.ok(html.indexOf('name="theme-color"')<scripts[0].index);assert.ok(html.indexOf('name="color-scheme"')<scripts[0].index);assert.ok(scripts[0].index<html.search(/<script\b[^>]*defer/));
 assert.equal((html.match(/name="theme-color"/g)??[]).length,1,'One authoritative browser theme color');
 assert.equal(manifest.background_color,THEME_BACKGROUNDS.dark);assert.equal(manifest.theme_color,THEME_BACKGROUNDS.dark);assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/');assert.equal(manifest.scope,'/');
 assert.match(html,/width=device-width, initial-scale=1, viewport-fit=cover/);assert.match(html,new RegExp(`background-color: ${THEME_BACKGROUNDS.dark}; color-scheme: dark`));
 for(const mode of ['light','dark']){const context=page(mode,mode==='light');vm.runInNewContext(readFileSync(new URL(src.slice(1),root),'utf8'),context);matchesTheme(context,mode)}
});


test('filled notices retain readable text for every severity in both themes',async()=>{
 const {getContrastRatio}=await import('@mui/material/styles');
 for(const mode of ['light','dark'])for(const severity of ['error','warning','info','success']){
  const theme=createPonderosaTheme(mode),foreground=theme.components.MuiAlert.styleOverrides.filled({theme,ownerState:{severity}}).color;
  // MUI filled Alerts use main in light mode and dark in dark mode.
  const background=theme.palette[severity][mode==='dark'?'dark':'main'];
  assert.ok(getContrastRatio(foreground,background)>=4.5,`${mode} ${severity} notice contrast`);
 }
});
