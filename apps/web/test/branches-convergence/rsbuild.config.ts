import {defineConfig} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
export default defineConfig({output:{distPath:{root:'node_modules/.cache/branches-fixture'}},plugins:[pluginReact()],html:{template:'./index.html'},source:{entry:{index:'./test/branches-convergence/fixture.tsx'}},server:{host:'127.0.0.1',port:21859}});
