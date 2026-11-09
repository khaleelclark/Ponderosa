import {defineConfig} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';

// A separate compilation keeps Branch API module state inside Assistant's
// in-document React root while the surrounding Ponderosa shell stays in Core.
export default defineConfig({
  plugins:[pluginReact()],
  source:{entry:{assistant:'./src/assistantStandalone.tsx'},define:{'typeof process':JSON.stringify('undefined')}},
  output:{distPath:{root:'dist/assistant-assets'},assetPrefix:'/assistant-assets/',manifest:true,injectStyles:true},
  tools:{rspack:config=>{config.output??={};config.output.uniqueName='ponderosa-assistant';}},
});
