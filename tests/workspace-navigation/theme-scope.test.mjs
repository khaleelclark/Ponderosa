import assert from 'node:assert/strict';
import test from 'node:test';
import '../shared/web-typescript-loader.mjs';
const {assistantSurfaceVariables,createPonderosaTheme}=await import('../../apps/web/src/theme.ts');
const {composerSurfaceWidth,composerSurfaceSx,assistantComposerSurfaceWidth,assistantComposerSurfaceSx}=await import('../../apps/web/src/components/chat/Composer.styles.ts');

test('ordinary Ponderosa keeps its historical green composer while Assistant and Output keep their own controls',()=>{
 assert.equal(composerSurfaceWidth.md,'min(1180px, calc(100% - 48px))');
 assert.equal(composerSurfaceWidth.xl,'min(1240px, calc(100% - 64px))');
 assert.deepEqual(composerSurfaceSx.borderRadius,{xs:2,sm:2.25});
 assert.equal(composerSurfaceSx['&:focus-within'],undefined);
 assert.equal(assistantComposerSurfaceWidth.md,'min(880px, calc(100% - 48px))');
 assert.ok(assistantComposerSurfaceSx['&:focus-within']);
 for(const mode of ['light','dark']){
  const standard=createPonderosaTheme(mode),assistant=createPonderosaTheme(mode,'assistant');
  assert.equal(standard.palette.primary.main,mode==='light'?'#123126':'#7CBF8A');
  assert.equal(assistant.palette.primary.main,mode==='light'?'#2563EB':'#92B7FF');
  assert.equal(standard.components.MuiDialog,undefined,'iOS-style dialogs are outside ordinary Ponderosa');
  assert.ok(assistant.components.MuiDialog);
  assert.equal(standard.components.MuiButton.styleOverrides.root.borderRadius,8);
  assert.equal(assistant.components.MuiButton.styleOverrides.root.borderRadius,10);
  assert.equal(assistantSurfaceVariables(mode)['--ponderosa-message-bubble'],'#2563EB');
  assert.equal(assistantSurfaceVariables(mode)['--ponderosa-prose-link'],assistant.palette.primary.main);
 }
});
