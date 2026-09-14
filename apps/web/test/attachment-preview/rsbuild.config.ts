import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
export default defineConfig({plugins:[pluginReact()],source:{entry:{index:'./test/attachment-preview/fixture.tsx'}},server:{host:'127.0.0.1',port:21844},html:{meta:{viewport:'width=device-width, initial-scale=1'}}});
