import test from 'node:test';
import assert from 'node:assert/strict';
import {budgetPresentation,validBudgetNumber} from '../src/components/branches/budgetPresentation.js';
test('budget presentation never fabricates zero or unlimited during loading/failure',()=>{
 assert.match(budgetPresentation({}).message,/Loading/);
 assert.equal(budgetPresentation({error:new Error('offline'),data:{policy:null}}).message,'Budget unavailable');
 assert.match(budgetPresentation({data:{policy:null},isFetching:true}).message,/Refreshing.*Last observed/);
 assert.equal(budgetPresentation({data:{policy:{limit:4},used:3,allowance:2}}).message,'3 used · 4 base + 2 extra executions');
 for(const value of ['', ' ', '0','-1','1.5','Infinity','1000000001'])assert.equal(validBudgetNumber(value),false,value);
 for(const value of ['1','1000000000'])assert.equal(validBudgetNumber(value),true,value);
});
