import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const {branchRunStatus}=await import('../../apps/web/src/components/branches/branchRunStatus.ts');
const {BranchWorkspaceHeader}=await import('../../apps/web/src/components/branches/BranchWorkspaceHeader.tsx');
const {BranchDirectoryStatus}=await import('../../apps/web/src/components/branches/BranchDirectoryStatus.tsx');
const {SemanticStatusCircle}=await import('../../apps/web/src/components/SemanticStatus.tsx');
const {MutationNotificationProvider}=await import('../../apps/web/src/components/MutationNotifications.tsx');
const base={name:'Workflow',tab:'executions',published:true,dirty:false,onTab(){},onExport(){},onUpdate(){},onRename(){}};

test('Run count presentation separates Running, Waiting and Queued without guessing unknown as zero',()=>{
 assert.deepEqual(branchRunStatus({running:2,waiting:3,queued:4}),{status:'running',label:'2 Running · 7 Pending',compact:'2 / 7',lines:['Workflow Runs','Running: 2','Waiting: 3','Queued: 4']});
 assert.equal(branchRunStatus({running:0,waiting:1,queued:2}).status,'waiting');assert.equal(branchRunStatus({running:0,waiting:0,queued:0}).status,'idle');assert.equal(branchRunStatus({running:0,waiting:0,queued:0}).label,'0 Running');assert.equal(branchRunStatus({running:4,waiting:0,queued:0}).label,'4 Running');assert.equal(branchRunStatus({running:0,waiting:1,queued:39}).label,'0 Running · 40 Pending');
 for(const counts of [undefined,{running:-1,waiting:0,queued:0},{running:0.5,waiting:0,queued:0}])assert.match(branchRunStatus(counts).label,/loading/);
 assert.equal(branchRunStatus(undefined,true).label,'Run status unavailable');assert.deepEqual(branchRunStatus({running:1,waiting:0,queued:0},true).lines,['Workflow Runs','Running: 1','Waiting: 0','Queued: 0','Updates delayed']);
});

test('expanded and compact header counts reuse shared status presentation and one accessible breakdown',()=>{
 const props={...base,runCounts:{running:2,waiting:3,queued:4}},header=BranchWorkspaceHeader(props).props.children,status=header.props.status,full=status.props.children[0],compact=status.props.children[1];
 const tooltip=renderToStaticMarkup(full.props.title);for(const text of ['Running: 2','Waiting: 3','Queued: 4'])assert.ok(tooltip.includes(text));
 assert.equal(full.props.children.props.tabIndex,0,'Desktop count tooltip is keyboard reachable');
 assert.equal(compact.props.children.props['aria-label'],'2 Running · 7 Pending');assert.equal(compact.props.children.props.tabIndex,0);
 assert.equal(compact.props.children.props.children[0].props.children.type,SemanticStatusCircle);
 const html=renderToStaticMarkup(React.createElement(MutationNotificationProvider,null,React.createElement(BranchWorkspaceHeader,props)));assert.match(html,/2 Running · 7 Pending/);assert.doesNotMatch(html,/active executions/);
 const unknown=renderToStaticMarkup(React.createElement(MutationNotificationProvider,null,React.createElement(BranchWorkspaceHeader,{...base,executionsUnavailable:true})));assert.match(unknown,/Run status unavailable/);assert.doesNotMatch(unknown,/0 Running/);
});

test('sidebar tooltip reuses the same count breakdown while retaining independent availability and intake',()=>{
 const props={branch:{id:'b',name:'Workflow',enabled:true,versionId:'v',triggerId:'t',triggerEnabled:false,activeExecutions:9,runCounts:{running:2,waiting:3,queued:4}}};
 const status=BranchDirectoryStatus(props),tooltip=renderToStaticMarkup(status.props.title);
 for(const text of ['Enabled','Automatic intake paused','Running: 2','Waiting: 3','Queued: 4'])assert.ok(tooltip.includes(text));
 assert.equal(status.props.children.props.children[0].type,SemanticStatusCircle);assert.match(status.props.children.props['aria-label'],/Running: 2.*Waiting: 3.*Queued: 4/);
 const delayed=BranchDirectoryStatus({...props,delayed:true});assert.match(renderToStaticMarkup(delayed.props.title),/Updates delayed/);
});
