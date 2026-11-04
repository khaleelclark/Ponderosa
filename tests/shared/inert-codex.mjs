// Disposable local protocol fixture. No provider account or network is used.
import {chmod,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CodexAdapter} from '../../packages/engines/dist/index.js';
export async function inertCodex(root) {
 const bin=path.join(root,'inert-codex'),log=path.join(root,'inert-codex-requests.jsonl'),command=path.join(root,'inert-codex-command.json');
 const script="const fs=require('node:fs'),readline=require('node:readline');\nconst log=process.env.INERT_CODEX_LOG, command=process.env.INERT_CODEX_COMMAND;\nconst emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');\nconst record=value=>fs.appendFileSync(log,JSON.stringify(value)+'\\n');\nreadline.createInterface({input:process.stdin}).on('line',line=>{\n const m=JSON.parse(line);\n if(m.method && m.id!==undefined){\n  record(m); let result={};\n  if(m.method==='initialize')result={userAgent:'ponderosa/0.143.0 (fixture)'};\n  else if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'inert-reviewed-thread'},model:'fixture'};\n  else if(m.method==='turn/start')result={turn:{id:'inert-reviewed-turn'}};\n  else if(m.method==='model/list'||m.method==='mcpServerStatus/list')result={data:[],nextCursor:null};\n  else if(m.method==='account/read')result={account:{type:'chatgpt'}};\n  emit({id:m.id,result});\n } else if(m.id===910001){\n  record({toolResponse:m});\n  emit({method:'turn/completed',params:{threadId:'inert-reviewed-thread',turn:{id:'inert-reviewed-turn',status:'completed'}}});\n }\n});\nsetInterval(()=>{\n if(!fs.existsSync(command))return;\n let instruction;\n try{instruction=JSON.parse(fs.readFileSync(command,'utf8'));fs.unlinkSync(command);}catch{return;}\n if(instruction.tool)emit({id:910001,method:'item/tool/call',params:{threadId:'inert-reviewed-thread',turnId:'inert-reviewed-turn',callId:'inert-reviewed-call',tool:instruction.tool,arguments:instruction.arguments}});\n},10);\n";
 await writeFile(bin,'#!'+process.execPath+'\n'+'process.env.INERT_CODEX_LOG='+JSON.stringify(log)+';process.env.INERT_CODEX_COMMAND='+JSON.stringify(command)+';\n'+script);
 await chmod(bin,0o700);
 return {
  adapter:new CodexAdapter({bin,killGraceMs:100}),
  async requests(){try{return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}},
  async sendTool(tool,args){const temporary=command+'.new';await writeFile(temporary,JSON.stringify({tool,arguments:args}));await rename(temporary,command);},
 };
}
