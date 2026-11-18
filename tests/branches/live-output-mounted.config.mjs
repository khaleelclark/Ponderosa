import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const {pluginReact}=require('@rsbuild/plugin-react');
export default {plugins:[pluginReact()],source:{entry:{index:fileURLToPath(new URL('./live-output-mounted.tsx',import.meta.url))}},html:{templateContent:'<html><body><div id="root"></div></body></html>'},output:{distPath:{root:process.env.PONDEROSA_LIVE_MOUNT_BUILD},cleanDistPath:false},tools:{rspack:{resolve:{modules:[fileURLToPath(new URL('../../apps/web/node_modules',import.meta.url)),'node_modules'],extensionAlias:{'.js':['.ts','.tsx','.js']}}}},performance:{chunkSplit:{strategy:'all-in-one'}}};
