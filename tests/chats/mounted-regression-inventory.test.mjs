import test from 'node:test';
import assert from 'node:assert/strict';
import {mountedRegressionInventory,mountedRegressionEntryImports} from '../shared/mounted-regression-inventory.mjs';
test('every exported mounted regression module is included in the browser entry exactly once',()=>{
 const inventory=mountedRegressionInventory(),imports=mountedRegressionEntryImports(),names=inventory.flatMap(row=>row.names);
 assert.ok(inventory.length>0,'Mounted fixtures must be discovered');
 assert.deepEqual(imports,inventory.map(row=>row.file),'A newly added mounted fixture must be wired before verification can pass');
 assert.equal(new Set(imports).size,imports.length,'A module cannot be duplicated in the entry');
 assert.equal(new Set(names).size,names.length,'Browser-addressable regression names must be unique');
});
