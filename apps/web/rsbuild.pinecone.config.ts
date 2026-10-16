import {defineConfig} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';

/** Standalone product build. It uses the existing daemon and canonical V4 Chat. */
export default defineConfig({
  plugins:[pluginReact()],
  source:{entry:{index:'./candidate-entry.tsx'}},
  output:{distPath:{root:'dist/pinecone'}},
  html:{
    title:'Pinecone',
    template:'./pinecone.html',
    meta:{viewport:'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content',description:'Your personal assistant, in one conversation.'},
  },
});
