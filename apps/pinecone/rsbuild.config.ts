import {defineConfig} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
export default defineConfig({
  plugins:[pluginReact()],
  source:{entry:{index:'./src/main.tsx'}},
  output:{distPath:{root:'dist'},assetPrefix:'/pinecone/'},
  html:{title:'Pinecone',meta:{viewport:'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content',description:'Your personal assistant, in one conversation.'}},
});
