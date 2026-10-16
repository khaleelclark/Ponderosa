import {createRequire} from 'node:module';
const require=createRequire(new URL('./apps/web/package.json',import.meta.url));
const {createRsbuild,loadConfig}=require('@rsbuild/core');
const cwd=new URL('./apps/web',import.meta.url).pathname;
const {content}=await loadConfig({cwd,path:new URL('./apps/web/rsbuild.pinecone.config.ts',import.meta.url).pathname});
const build=await createRsbuild({cwd,rsbuildConfig:{...content,output:{...content.output,distPath:{root:process.env.PINECONE_UI_DIST??'../../candidate-web-dist'}}}});
await build.build();
