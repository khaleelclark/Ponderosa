import {defineConfig} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
export default defineConfig({plugins:[pluginReact()],source:{entry:{index:'./test/confirmed-send/fixture.tsx'}},server:{host:'127.0.0.1',port:21846}});
