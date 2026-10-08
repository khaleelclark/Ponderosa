import {defineConfig} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
export default defineConfig({output:{distPath:{root:'node_modules/.cache/branch-budget-ui'}},plugins:[pluginReact()],html:{template:'./index.html'},source:{entry:{index:'./test/branch-budget-ui/fixture.tsx'}},server:{host:'127.0.0.1',port:21861}});
