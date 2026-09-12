import {defineConfig} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
export default defineConfig({plugins:[pluginReact()],source:{entry:{index:'./test/reply-destination/fixture.tsx'}},server:{host:'127.0.0.1',port:21845}});
