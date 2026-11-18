import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const {pluginReact}=require('@rsbuild/plugin-react');
const output=process.env.PONDEROSA_MOUNTED_BUILD;
if(!output||!path.isAbsolute(output))throw Error('Set PONDEROSA_MOUNTED_BUILD to a fresh owned absolute directory');
export default {
 plugins:[pluginReact()],
 source:{entry:{index:fileURLToPath(new URL('./mounted-regressions.tsx',import.meta.url))}},
 html:{templateContent:'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>'},
 output:{distPath:{root:output},cleanDistPath:false},
 tools:{rspack:{resolve:{modules:[fileURLToPath(new URL('../../apps/web/node_modules',import.meta.url)),'node_modules'],extensionAlias:{'.js':['.ts','.tsx','.js']}}}},
 performance:{chunkSplit:{strategy:'all-in-one'}},
};
