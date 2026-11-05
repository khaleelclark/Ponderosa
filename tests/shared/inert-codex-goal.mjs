// Disposable Codex 0.159.2 protocol process; no network, credentials or provider account.
import {chmod,readFile,rename,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {CodexAdapter} from '../../packages/engines/dist/index.js';
import {until} from './fixture.mjs';

function nativeProcess(config){
 const fs=require('node:fs'),readline=require('node:readline');
 if(process.argv.includes('mcp')&&process.argv.includes('list')){console.log('[]');return;}
 if(process.argv.includes('--version')){console.log('codex-cli 0.159.2');return;}
 if(process.argv.includes('--help')){console.log('app-server');return;}
 const record=value=>fs.appendFileSync(config.log,JSON.stringify({pid:process.pid,...value})+'\n');
 const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
 let saved=JSON.parse(fs.readFileSync(config.state,'utf8')),turn,sequence=0;
 const persist=()=>fs.writeFileSync(config.state,JSON.stringify(saved));
 const notify=(method,params)=>{record({notification:method,params});emit({method,params});};
 const updateGoal=status=>{saved.goal={...saved.goal,status,updatedAt:saved.goal.updatedAt+1};persist();notify('thread/goal/updated',{threadId:saved.threadId,...(turn?{turnId:turn}:{}),goal:saved.goal});};
 const start=kind=>{turn=kind+'-'+(++sequence);notify('turn/started',{threadId:saved.threadId,turn:{id:turn,status:'inProgress',items:[]}});return turn;};
 const text=value=>{
  if(!turn)throw Error('No current native turn');
  const base={threadId:saved.threadId,turnId:turn},itemId='answer-'+sequence;
  notify('item/started',{...base,item:{id:itemId,type:'agentMessage',phase:'final_answer',text:''}});
  notify('item/agentMessage/delta',{...base,itemId,delta:value});
  notify('item/completed',{...base,item:{id:itemId,type:'agentMessage',phase:'final_answer',text:value}});
 };
 const complete=(status='completed')=>{
  if(!turn)throw Error('No current native turn');
  const id=turn;
  saved.goal.tokensUsed+=10;persist();
  notify('thread/tokenUsage/updated',{threadId:saved.threadId,turnId:id,tokenUsage:{total:{totalTokens:saved.goal.tokensUsed},last:{totalTokens:10},modelContextWindow:200000}});
  notify('turn/completed',{threadId:saved.threadId,turn:{id,status,items:[]}});turn=undefined;
 };
 record({processStarted:true});
 process.on('exit',code=>record({processExited:true,code}));
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{record({signal});process.exit(0);});
 readline.createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.id===910001&&!request.method){record({toolResponse:request});if(request.result?.success!==true)throw Error('Canonical fixture reply failed');complete();return;}
  if(!request.method||request.id===undefined)return;
  record(request);let result={},after;
  if(request.method==='initialize')result={userAgent:'codex/0.159.2 (inert fixture)'};
  else if(request.method==='account/read')result={account:{type:'chatgpt'}};
  else if(request.method==='model/list')result={data:[{id:'fixture',model:'fixture',displayName:'Fixture',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}],nextCursor:null};
  else if(request.method==='mcpServerStatus/list'||request.method==='thread/backgroundTerminals/list')result={data:[],nextCursor:null};
  else if(request.method==='thread/start'||request.method==='thread/resume'){
   saved.ownerPid=process.pid;persist();result={thread:{id:saved.threadId},model:'fixture'};
   // A real persisted active goal may resume autonomous work: the host must
   // inspect it before issuing thread/resume after an uncertain interruption.
   if(request.method==='thread/resume'&&saved.goal?.status==='active')after=()=>start('unowned-resumed-goal');
  }else if(request.method==='turn/start'){result={turn:{id:'ordinary-'+(sequence+1)}};after=()=>start('ordinary');}
  else if(request.method==='thread/goal/get')result={goal:saved.goal};
  else if(request.method==='thread/goal/set'){
   if(request.params.threadId!==saved.threadId)throw Error('Wrong goal thread');
   const previous=saved.goal?.status;
   saved.goal={threadId:saved.threadId,tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1700000000,...saved.goal,...Object.fromEntries(Object.entries(request.params).filter(([key])=>['objective','status','tokenBudget'].includes(key))),updatedAt:(saved.goal?.updatedAt??1700000000)+1};
   if(config.normalizeObjective&&typeof saved.goal.objective==='string')saved.goal.objective=saved.goal.objective.trim();
   persist();
   record({goalMutation:saved.goal.status});
   if(saved.goal?.status==='active'&&config.dropResumeAcknowledgement){record({lostGoalAcknowledgement:true});process.exit(19);}
   result={goal:saved.goal};
   after=()=>{notify('thread/goal/updated',{threadId:saved.threadId,...(turn?{turnId:turn}:{}),goal:saved.goal});if(previous!=='active'&&saved.goal?.status==='active')start('goal');};
  }else if(request.method==='turn/interrupt'){after=()=>{if(turn)complete('interrupted');};}
  emit({id:request.id,result});after?.();
 });
 setInterval(()=>{
  if(!fs.existsSync(config.command))return;
  let input;try{input=JSON.parse(fs.readFileSync(config.command,'utf8'));if(input.targetPid!==process.pid)return;fs.unlinkSync(config.command);}catch{return;}
  try{
   if(input.op==='reply'){if(!turn)throw Error('No current native turn');emit({id:910001,method:'item/tool/call',params:{threadId:saved.threadId,turnId:turn,callId:'canonical-reply-'+sequence,tool:'ponderosa_message',arguments:{text:input.text}}});}
   else if(input.op==='text')text(input.text);
   else if(input.op==='complete'){if(input.text)text(input.text);complete();}
   else if(input.op==='next'){if(saved.goal.status!=='active'||turn)throw Error('Native campaign is not between active cycles');start('goal');}
   else if(input.op==='goal')updateGoal(input.status);
   else throw Error('Unknown inert control');
   record({controlCompleted:input.id,op:input.op});
  }catch(error){record({controlCompleted:input.id,error:error.message});}
 },10);
}

export async function inertCodexGoal(root,{dropResumeAcknowledgement=false,freshGoal=false,normalizeObjective=false}={}){
 const bin=path.join(root,'inert-codex-goal'),log=bin+'.jsonl',state=bin+'.state.json',command=bin+'.command.json';
 const threadId='inert-goal-thread';
 await writeFile(state,JSON.stringify({threadId,goal:freshGoal?null:{threadId,objective:'Preserve the entire original goal objective.',status:'paused',tokenBudget:1000,tokensUsed:0,timeUsedSeconds:0,createdAt:1700000000,updatedAt:1700000000}}));
 await writeFile(bin,'#!'+process.execPath+'\n('+nativeProcess.toString()+')('+JSON.stringify({log,state,command,dropResumeAcknowledgement,normalizeObjective})+');\n');await chmod(bin,0o700);
 const requests=async()=>{try{return (await readFile(log,'utf8')).split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
 return {adapter:new CodexAdapter({bin,killGraceMs:100}),threadId,requests,state:async()=>JSON.parse(await readFile(state,'utf8')),
  async control(op,fields={}){
   const id=randomUUID(),temporary=command+'.'+id;
   const targetPid=JSON.parse(await readFile(state,'utf8')).ownerPid;if(!Number.isInteger(targetPid))throw Error('No owned inert native thread');
   await writeFile(temporary,JSON.stringify({id,op,targetPid,...fields}));await rename(temporary,command);
   const result=await until(async()=>(await requests()).find(row=>row.controlCompleted===id),'inert goal control '+op,10000);
   if(result.error)throw Error(result.error);
  },
 };
}
