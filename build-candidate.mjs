import {createRsbuild} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
const build=await createRsbuild({cwd:new URL('./apps/web',import.meta.url).pathname,rsbuildConfig:{plugins:[pluginReact()],source:{entry:{index:'./candidate-entry.tsx'}},html:{title:'Pinecone · Candidate preview',meta:{viewport:'width=device-width, initial-scale=1, viewport-fit=cover'}},output:{distPath:{root:'../../candidate-web-dist'}}}});
await build.build();
