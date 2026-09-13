import {defineConfig} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
export default defineConfig({plugins:[pluginReact()],html:{template:'./index.html'},source:{entry:{index:'./test/mobile-ios-composition/fixture.tsx'}},server:{host:'127.0.0.1',port:21848}});
