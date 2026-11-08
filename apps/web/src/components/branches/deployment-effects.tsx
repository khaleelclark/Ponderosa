import {Accordion,AccordionDetails,AccordionSummary,Box,Typography} from '@mui/material';

/** Present publication consequences as labeled facts without changing server notes. */
export function deploymentEffectFacts(notes:readonly string[]):Array<{label:string;value:string}>{
 return notes.flatMap(note=>{
  if(note==='Accepted executions keep their version and binding revision.')return [{label:'Accepted executions',value:'Version and binding revision retained'}];
  if(note==='Persistent Agents belong to this Branch through their Chat. Their living history is preserved.')return [{label:'Persistent Agents',value:'Owned by this workflow via their Chat'},{label:'Agent history',value:'Preserved'}];
  if(note==='Detached bindings preserve Agents and user folders. Template Agents are created per invocation and deleted after cleanup.')return [{label:'Removed bindings',value:'Agents and user folders preserved'},{label:'Template Agents',value:'Created per invocation · deleted after cleanup'}];
  if(note==='Agents and Scripts use the host account’s authority. A human gate controls workflow order, not other host activity.')return [{label:'Agents and Scripts',value:'Host account authority'},{label:'Human gates',value:'Workflow order only · other host activity unaffected'}];
  let match=note.match(/^Traversal preflight: a successful run needs at least (\d+) visits of the configured (\d+) traversal limit\.$/);
  if(match)return [{label:'Successful run',value:'At least '+match[1]+' visits'},{label:'Traversal limit',value:match[2]!}];
  match=note.match(/^Traversal preflight: a successful run needs at least (\d+) visits, above the configured (\d+) traversal limit\. Increase the Branch limit before running\.$/);
  if(match)return [{label:'Successful run',value:'At least '+match[1]+' visits'},{label:'Traversal limit',value:match[2]+' · increase before running'}];
  match=note.match(/^Traversal preflight: estimated baseline (\d+) visits\. Conditions or loops make the full count uncertain; check the configured (\d+) traversal limit before running\.$/);
  if(match)return [{label:'Traversal baseline',value:match[1]+' visits · full count uncertain (conditions or loops)'},{label:'Traversal limit',value:match[2]+' · check before running'}];
  match=note.match(/^(\d+) already queued Runs? remain\. Schedule changes affect future checks; they do not clear, merge or cancel this backlog\.$/);
  if(match)return [{label:'Queued Runs',value:match[1]+' retained · no clearing, merging or cancellation'},{label:'Schedule changes',value:'Future checks only'}];
  // A new server consequence must remain visible until it has a concise label.
  return [{label:'Additional effect',value:note}];
 });
}


export function PublishingEffects({notes}:{notes:readonly string[]}):JSX.Element{
 return <Accordion><AccordionSummary>Publishing effects</AccordionSummary><AccordionDetails><Box component="dl" sx={{m:0,display:'grid',gridTemplateColumns:{xs:'1fr',sm:'minmax(140px, 1fr) 2fr'},gap:1}}>{deploymentEffectFacts(notes).map((fact,index)=><Box key={index} sx={{display:'contents'}}><Typography component="dt" variant="body2" fontWeight={600}>{fact.label}</Typography><Typography component="dd" variant="body2" color="text.secondary" sx={{m:0,mb:{xs:1,sm:0}}}>{fact.value}</Typography></Box>)}</Box></AccordionDetails></Accordion>;
}
