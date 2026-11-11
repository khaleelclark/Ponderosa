// Disposable Claude stream fixture: no account, provider, or network.
import {chmod,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ClaudeAdapter} from '../../packages/engines/dist/index.js';
export async function inertClaude(root,{holdModel=false}={}) {
 const bin=path.join(root,'inert-claude'),log=path.join(root,'inert-claude-frames.jsonl'),command=path.join(root,'inert-claude-command.json');
 const script="const fs=require('node:fs'), readline=require('node:readline');\nconst session=process.argv[process.argv.indexOf('--session-id')+1];\nconst log=process.env.INERT_CLAUDE_LOG, command=process.env.INERT_CLAUDE_COMMAND;\nconst emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');\nconst record=value=>fs.appendFileSync(log,JSON.stringify(value)+'\\n');\nlet heldModel;\nreadline.createInterface({input:process.stdin}).on('line',line=>{\n const frame=JSON.parse(line);record(frame);\n if(frame.type==='control_request'&&frame.request?.subtype==='initialize'){\n  emit({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{commands:[]}}});\n  emit({type:'system',subtype:'init',session_id:session,model:'fixture'});\n } else if(frame.type==='control_request'&&frame.request?.subtype==='set_model'){\n  const response={type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{}}};\n  if(process.env.INERT_CLAUDE_HOLD_MODEL==='1')heldModel=response;else emit(response);\n }\n});\nsetInterval(()=>{\n if(!fs.existsSync(command))return;\n let instruction;try{instruction=JSON.parse(fs.readFileSync(command,'utf8'));fs.unlinkSync(command);}catch{return;}\n if(instruction.releaseModel && heldModel){emit(heldModel);heldModel=undefined;}\n if(instruction.finish)emit({type:'result',subtype:'success',session_id:session,is_error:false,result:''});\n},10);\n";
 await writeFile(bin,'#!'+process.execPath+'\n'+'process.env.INERT_CLAUDE_LOG='+JSON.stringify(log)+';process.env.INERT_CLAUDE_COMMAND='+JSON.stringify(command)+';process.env.INERT_CLAUDE_HOLD_MODEL='+JSON.stringify(holdModel?'1':'0')+';\n'+script);
 await chmod(bin,0o700);
 async function send(value){const temporary=command+'.new';await writeFile(temporary,JSON.stringify(value));await rename(temporary,command);}
 return {
  adapter:new ClaudeAdapter({bin,killGraceMs:100}),
  async frames(){try{return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}},
  async finish(){await send({finish:true});},
  async releaseModel(){await send({releaseModel:true});},
 };
}
