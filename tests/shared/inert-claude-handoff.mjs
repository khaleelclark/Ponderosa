// Disposable native Claude stream: no provider account or external network.
import {chmod,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ClaudeAdapter} from '../../packages/engines/dist/index.js';

export async function inertClaudeHandoff(root,{resumeInit='match',holdEcho=false,stallInput=false,startup='success',expectedOrigin}={}){
 const bin=path.join(root,'inert-handoff-claude'),log=path.join(root,'inert-handoff-claude.jsonl'),command=path.join(root,'inert-handoff-claude-command.json');
 const script=`
const fs=require('node:fs'),readline=require('node:readline'),crypto=require('node:crypto');
const idx=name=>process.argv.indexOf(name);
if(idx('--resume')<0&&idx('--session-id')<0){if(idx('--version')>=0)process.stdout.write('2.1.0\\n');process.exit(0);}
const resume=idx('--resume')>=0, session=process.argv[idx(resume?'--resume':'--session-id')+1], model=idx('--model')>=0?process.argv[idx('--model')+1]:'sonnet';
const record=x=>fs.appendFileSync(process.env.TEST_CLAUDE_LOG,JSON.stringify(x)+'\\n'),emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let current,heldEcho,heldInitialize;record({kind:'open',session,resume,model,pid:process.pid});
if(resume){try{record({kind:'restored-native-context',session,...JSON.parse(fs.readFileSync(process.env.TEST_CLAUDE_COMMAND+'.session-'+session,'utf8'))});}catch{}}
readline.createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);record({kind:'input',frame,session});
 if(frame.type==='control_request'&&frame.request?.subtype==='initialize'){
  let startup=process.env.TEST_CLAUDE_STARTUP;try{startup=fs.readFileSync(process.env.TEST_CLAUDE_COMMAND+'.startup','utf8');}catch{}
  if(startup==='exit'){process.exit(23);return;}
  if(startup==='result'){emit({type:'result',subtype:'error_during_execution',is_error:true,session_id:session,errors:['Synthetic saved session missing']});return;}
  if(startup==='silent')return;
  if(startup==='hold'){heldInitialize=frame.request_id;return;}
  emit({type:'control_response',response:{subtype:startup==='error'?'error':'success',request_id:frame.request_id,...(startup==='error'?{error:'Synthetic saved session load failed'}:{}),response:{commands:[]}}});
  if(process.env.TEST_CLAUDE_STALL_INPUT==='1')process.stdin.pause();
 }else if(frame.type==='control_request'&&frame.request?.subtype==='set_model'){
  emit({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{}}});
 }else if(frame.type==='user'){
  const mode=resume?process.env.TEST_CLAUDE_RESUME_INIT:'match';
  if(mode!=='missing')emit({type:'system',subtype:'init',session_id:mode==='wrong'?'wrong-session':session,model});
  current=frame;const echo={...frame,isReplay:true,parent_tool_use_id:null};
  if(resume&&process.env.TEST_CLAUDE_HOLD_ECHO==='1')heldEcho=echo;else emit(echo);
 }
});
setInterval(async()=>{
 if(!fs.existsSync(process.env.TEST_CLAUDE_COMMAND))return;
 let instruction;try{instruction=JSON.parse(fs.readFileSync(process.env.TEST_CLAUDE_COMMAND,'utf8'));fs.unlinkSync(process.env.TEST_CLAUDE_COMMAND);}catch{return;}
 if(instruction.releaseStartup&&heldInitialize){emit({type:'control_response',response:{subtype:'success',request_id:heldInitialize,response:{commands:[]}}});heldInitialize=undefined;}
 if(instruction.exitIdle){record({kind:'idle-exit',session});process.exit(19);}
 if(instruction.workResult){fs.writeFileSync(process.env.TEST_CLAUDE_COMMAND+'.session-'+session,JSON.stringify({finding:instruction.workResult,originalInput:current?.message}));emit({type:'assistant',session_id:session,message:{id:crypto.randomUUID(),role:'assistant',model,content:[{type:'tool_use',id:'native-only-tool',name:'Bash',input:{command:'synthetic-inspection'}}]}});emit({type:'user',session_id:session,message:{role:'user',content:[{type:'tool_result',tool_use_id:'native-only-tool',content:instruction.workResult}]}});record({kind:'native-only-result',session,text:instruction.workResult});}
 if(instruction.corruptEcho&&heldEcho){heldEcho.message.content[0].text+=' altered';emit(heldEcho);heldEcho=undefined;}
 if((instruction.releaseEcho||instruction.echoAndTool)&&heldEcho){emit(heldEcho);heldEcho=undefined;}
 if(instruction.preEchoTool||instruction.echoAndTool)emit({type:'control_request',request_id:'premature-tool',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'echo synthetic'}}});
 if(instruction.preEchoStop)emit({type:'control_request',request_id:'premature-stop',request:{subtype:'hook_callback',callback_id:'ponderosa-lifetime-'+session,input:{session_id:session,hook_event_name:'Stop',background_tasks:[{id:'old-task',type:'agent',status:'running'}]}}});
 if(instruction.probe&&current){
  const messageUrl=process.env.PONDEROSA_AGENT_MESSAGE_URL,token=process.env.PONDEROSA_AGENT_MESSAGE_TOKEN;
  const paths=instruction.probe==='before'?
   [['message','/api/agent-messages','POST',{intent:'direct_to_user',text:'SYNTHETIC_UNCONFIRMED_TOOL_EFFECT'}],
    ['update','/api/agent-request-updates','POST',{}],['directory','/api/agent-directory','GET']]:
   [['directory','/api/agent-directory','GET']];
  const results=[];
  for(const [name,route,method,body] of paths){
   const url=messageUrl.replace(/\\/api\\/agent-messages$/,route);
   const response=await fetch(url,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
   results.push({name,status:response.status});await response.text();
  }
  record({kind:'probe',phase:instruction.probe,results});
 }
 if(instruction.answer&&current){
  if(instruction.publish){const target=process.env.PONDEROSA_AGENT_MESSAGE_URL;if(!process.env.TEST_CLAUDE_EXPECTED_ORIGIN||new URL(target).origin!==process.env.TEST_CLAUDE_EXPECTED_ORIGIN)throw new Error('Synthetic publication target is not the owned fixture origin');const response=await fetch(target,{method:'POST',headers:{authorization:'Bearer '+process.env.PONDEROSA_AGENT_MESSAGE_TOKEN,'content-type':'application/json'},body:JSON.stringify({intent:'direct_to_user',text:instruction.answer})});record({kind:'publication',status:response.status});await response.text();}
  const msg={id:crypto.randomUUID(),role:'assistant',model,content:[{type:'text',text:instruction.answer}],usage:{input_tokens:15,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}};
  emit({type:'assistant',session_id:session,parent_tool_use_id:null,message:msg});
  emit({type:'result',subtype:'success',session_id:session,is_error:false,result:instruction.answer});current=undefined;
 }
 if(instruction.voice&&current){
  const id='fixture-voice-call';
  emit({type:'assistant',session_id:session,parent_tool_use_id:null,message:{id:crypto.randomUUID(),role:'assistant',model,content:[{type:'tool_use',id,name:'mcp__ponderosa__voice_reply',input:{}}]}});
  await new Promise(resolve=>setTimeout(resolve,30));
  const url=process.env.PONDEROSA_AGENT_MESSAGE_URL.replace(/\\/api\\/agent-messages$/,'/api/agent-voice-reply');
  const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+process.env.PONDEROSA_AGENT_MESSAGE_TOKEN,'content-type':'application/json','x-ponderosa-voice-operation-id':'fixture-voice'},body:'{}'});
  const receipt=await response.json();record({kind:'voice',status:response.status,receipt});
  emit({type:'user',session_id:session,parent_tool_use_id:null,message:{role:'user',content:[{type:'tool_result',tool_use_id:id,content:[{type:'text',text:JSON.stringify(receipt)}]}]}});
  const msg={id:crypto.randomUUID(),role:'assistant',model,content:[{type:'text',text:instruction.voice}],usage:{input_tokens:15,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}};
  emit({type:'assistant',session_id:session,parent_tool_use_id:null,message:msg});
  emit({type:'result',subtype:'success',session_id:session,is_error:false,result:instruction.voice});current=undefined;
 }
},10);
`;
 await writeFile(bin,'#!'+process.execPath+'\n'+
  'process.env.TEST_CLAUDE_LOG='+JSON.stringify(log)+';process.env.TEST_CLAUDE_COMMAND='+JSON.stringify(command)+';'+
  'process.env.TEST_CLAUDE_EXPECTED_ORIGIN='+JSON.stringify(expectedOrigin??'')+';process.env.TEST_CLAUDE_STARTUP='+JSON.stringify(startup)+';process.env.TEST_CLAUDE_RESUME_INIT='+JSON.stringify(resumeInit)+';process.env.TEST_CLAUDE_HOLD_ECHO='+JSON.stringify(holdEcho?'1':'0')+';process.env.TEST_CLAUDE_STALL_INPUT='+JSON.stringify(stallInput?'1':'0')+';\n'+script);
 await chmod(bin,0o700);
 async function send(value){const temporary=command+'.new';await writeFile(temporary,JSON.stringify(value));await rename(temporary,command);}
 return {adapter:new ClaudeAdapter({bin,killGraceMs:100}),
  async frames(){try{return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}},
  setStartup:mode=>writeFile(command+'.startup',mode),
  releaseStartup:()=>send({releaseStartup:true}),exitIdle:()=>send({exitIdle:true}),workResult:text=>send({workResult:text}),
  answer:text=>send({answer:text}),publishAnswer:text=>send({answer:text,publish:true}),voice:text=>send({voice:text}),releaseEcho:()=>send({releaseEcho:true}),preEchoTool:()=>send({preEchoTool:true}),echoAndTool:()=>send({echoAndTool:true}),preEchoStop:()=>send({preEchoStop:true}),corruptEcho:()=>send({corruptEcho:true}),probe:phase=>send({probe:phase})};
}
