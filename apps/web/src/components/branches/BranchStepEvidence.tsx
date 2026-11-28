import {useState} from 'react';
import {Alert,Box,Button,Stack,Typography} from '@mui/material';
import {branchScriptFailureSummary, type BranchAttemptDto, type BranchStepEvidenceDto} from '@ponderosa/core';
import {branchRoutePath} from '../../branchesRouting';
import {ChatMessageBody,CopyableCodeBlock} from '../chat/ChatMessages';

export function EvidenceText({text,markdownFallback=false}:{text:string;markdownFallback?:boolean}):JSX.Element {
 let formatted=text,format='text';
 if (/^[{\[]/u.test(text.trimStart())) {
  try {
   JSON.parse(text);
   format='json';
   // Preserve the saved tokens, including large numbers, duplicate keys and string escapes.
   const tokens=text.match(/"(?:\\[\s\S]|[^"\\])*"|[^\s{}\[\],:]+|[{}\[\],:]/gu)??[];
   let depth=0;
   const indent=()=> '\n'+'  '.repeat(Math.min(depth,20));
   formatted=tokens.map((token,index)=>{
    if(token==='{'||token==='['){
     depth++;
     return token+(tokens[index+1]===(token==='{'?'}':']')?'':indent());
    }
    if(token==='}'||token===']'){
     depth--;
     return (tokens[index-1]===(token==='}'?'{':'[')?'':indent())+token;
    }
    if(token===',')return ','+indent();
    return token===':'?': ':token;
   }).join('');
  } catch {
   // Invalid or partial JSON remains readable as recorded text.
  }
 }
 if(markdownFallback&&format==='text')return <ChatMessageBody text={text} collapseLongMessage={false}/>;
 return <CopyableCodeBlock text={formatted} copyValue={text} format={format}/>;
}

function EvidenceDisclosure({label,text}:{label:string;text:string}):JSX.Element {
 const [open,setOpen]=useState(false);
 return <Box component="details" sx={{mt:0.5}} onToggle={event=>setOpen(event.currentTarget.open)}>
  <Typography component="summary" sx={{cursor:'pointer'}}>{label}</Typography>
  {open&&<EvidenceText text={text}/>}
 </Box>;
}

export function attemptReason(attempt?:BranchAttemptDto):string|undefined {
 return attempt?.error || (attempt?.scriptEvidence
  ? branchScriptFailureSummary(attempt.scriptEvidence.code,attempt.scriptEvidence.error)
  : attempt?.result?.output);
}

export function BranchStepEvidence({evidence,hasReadableResult}:{evidence:BranchStepEvidenceDto;hasReadableResult:boolean}):JSX.Element {
 const output=evidence.result?.output??evidence.sealedResult?.result.output;
 const attempts=evidence.attempts;
 const terminalId=evidence.sealedResult?.terminalAttemptId??attempts.at(-1)?.id;
 const terminal=attempts.find(attempt=>attempt.id===terminalId);
 const separateOutput=output&&output!==terminal?.result?.output;
 return <Stack spacing={1.5} sx={{minWidth:0}}>
  {evidence.input&&<EvidenceDisclosure label="Step Input" text={evidence.input}/>}
  {output&&hasReadableResult&&<EvidenceDisclosure label="Raw Step Output" text={output}/>}
  {separateOutput&&!hasReadableResult&&<Box><Typography fontWeight={600}>Step Output</Typography><EvidenceText text={output}/></Box>}
  {attempts.map(attempt=>{
   const script=attempt.scriptEvidence;
   const attemptOutput=attempt.result?.output;
   const sameAsResult=hasReadableResult&&attempt.id===terminalId&&Boolean(output)&&attemptOutput===output;
   const savedOutput=attempt.id===terminalId?output:undefined;
   const logs=[['Stdout',script?.stdout],['Stderr',script?.stderr]] as const;
   const distinctLogs=logs.filter(([,text],index)=>text&&text!==attemptOutput&&text!==savedOutput&&(!index||text!==logs[0][1]));
   return <Box key={attempt.id} component="section" aria-label={`Attempt ${attempt.number}`} sx={{minWidth:0,borderTop:1,borderColor:'divider',pt:1}}>
    <Typography fontWeight={600}>Attempt {attempt.number} · {attempt.state.replaceAll('_',' ')}{attempt.purpose==='recovery'?' · Recovery Agent':''}</Typography>
    {script&&<Typography variant="body2">{script.runtime??'Node.js'} · Exit code: {script.code??'Not recorded'}</Typography>}
    {attempt.outcome&&<Alert severity="warning">{attempt.outcome.kind}{attempt.outcome.limit?` · ${attempt.outcome.limit}: limit ${attempt.outcome.configured}, attempted ${attempt.outcome.observed}`:''}</Alert>}
    {attempt.error&&<Alert severity="warning" sx={{overflowWrap:'anywhere'}}>{attempt.error}</Alert>}
    {script?.error&&script.error!==attempt.error&&<Alert severity="error">{script.error}</Alert>}
    {attempt.availableAt&&attempt.state==='prepared'&&<Typography variant="caption">Eligible after {new Date(attempt.availableAt).toLocaleString()}</Typography>}
    {attempt.calledBranch&&<Button size="small" href={branchRoutePath({branchId:attempt.calledBranch.id,tab:'workflow'})}>{attempt.calledBranch.name}</Button>}
    {attempt.childExecutionId&&<Button size="small" href={branchRoutePath({tab:'executions',executionId:attempt.childExecutionId})}>Open Child Run</Button>}
    {Boolean(attemptOutput)&&!sameAsResult&&<Box>
     <Typography variant="body2" fontWeight={600}>Attempt Output</Typography>
     <EvidenceText text={attemptOutput!}/>
    </Box>}
    {distinctLogs.map(([name,text])=><EvidenceDisclosure key={name} label={name} text={text!}/>)}
    {script?.cwd&&<Typography variant="caption" display="block" sx={{overflowWrap:'anywhere'}}>{script.cwd}</Typography>}
   </Box>;
  })}
 </Stack>;
}
