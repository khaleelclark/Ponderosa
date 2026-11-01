import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {validWorkingRootDestinations} from '../../apps/web/src/components/workingRootDestinations.ts';
test('each root requires a distinct absolute nonnested destination',()=>{
 const refs=['shared','separate'];
 assert.equal(validWorkingRootDestinations(refs,{shared:'/tmp/shared',separate:'/tmp/separate'}),true);
 for(const destinations of [{shared:'/tmp/shared'},{shared:'relative',separate:'/tmp/other'},{shared:'/tmp/shared',separate:'/tmp/shared/child'},{shared:'/tmp/shared/',separate:'/tmp//shared'},{shared:'/',separate:'/tmp/other'},{shared:'////',separate:'/tmp/other'},{shared:'/tmp/../shared',separate:'/tmp/other'}])assert.equal(validWorkingRootDestinations(refs,destinations),false);
 assert.equal(validWorkingRootDestinations([],{}),true);
});
