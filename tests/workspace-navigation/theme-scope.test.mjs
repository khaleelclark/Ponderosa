import assert from 'node:assert/strict';
import test from 'node:test';
import '../shared/web-typescript-loader.mjs';
const {ponderosaSurfaceVariables,createPonderosaTheme}=await import('../../apps/web/src/theme.ts');
const {composerSurfaceWidth,composerSurfaceSx}=await import('../../apps/web/src/components/chat/Composer.styles.ts');

test('Assistant and Output reuse the standard green composer colors, focus and readable bubbles',()=>{
 assert.equal(composerSurfaceWidth.md,'min(1180px, calc(100% - 48px))');
 assert.equal(composerSurfaceWidth.xl,'min(1240px, calc(100% - 64px))');
 assert.deepEqual(composerSurfaceSx.borderRadius,{xs:2,sm:2.25});
 assert.equal(composerSurfaceSx['&:focus-within'],undefined);
 for(const mode of ['light','dark']){
  const standard=createPonderosaTheme(mode),assistant=createPonderosaTheme(mode,'assistant');
  assert.equal(standard.palette.primary.main,mode==='light'?'#123126':'#7CBF8A');
  for(const name of ['primary','secondary','background','text','action','success','info','warning','error'])
   assert.deepEqual(assistant.palette[name],standard.palette[name],`${mode}/${name}: one palette across roots and portals`);
  assert.equal(standard.components.MuiDialog,undefined,'iOS-style dialogs are outside ordinary Ponderosa');
  assert.ok(assistant.components.MuiDialog);
  assert.equal(standard.components.MuiButton.styleOverrides.root.borderRadius,10);
  assert.equal(standard.typography.body1.fontSize,'0.9375rem');
  assert.equal(assistant.components.MuiButton.styleOverrides.root.borderRadius,10);
  const variables=ponderosaSurfaceVariables(mode);
  assert.equal(variables['--ponderosa-message-bubble'],mode==='light'?'#EFF0EB':'#27332F');
  assert.equal(variables['--ponderosa-message-bubble-text'],standard.palette.text.primary);
  assert.equal(variables['--ponderosa-prose-link'],standard.palette.primary.main);
  for(const [name,value] of Object.entries(variables))for(const theme of [standard,assistant])
   assert.equal(theme.components.MuiCssBaseline.styleOverrides.body[name],value,`${mode}/${name}: scoped content and body share tokens`);
  assert.deepEqual(assistant.components.MuiCssBaseline.styleOverrides['::selection'],standard.components.MuiCssBaseline.styleOverrides['::selection']);
  assert.deepEqual(assistant.components.MuiButtonBase.styleOverrides,standard.components.MuiButtonBase.styleOverrides);
  assert.deepEqual(assistant.components.MuiMenu.styleOverrides,standard.components.MuiMenu.styleOverrides);
 }
});
