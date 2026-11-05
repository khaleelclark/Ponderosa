import {StepInputField} from '../../apps/web/src/components/branches/NodeEditor';
import {createRoot} from 'react-dom/client';
import {AgentJobHandlingField} from '../../apps/web/src/components/branches/AgentStepFields';
import {changeAgentJobHandling,newDefinition,addNode,type AgentJobHandling} from '../../apps/web/src/components/branches/model';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));};
export async function expertJobHandlingRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 let definition=addNode(newDefinition(),'agent').definition;
 const node=definition.steps[0] as Extract<typeof definition.steps[number],{kind:'agent'}>&{jobHandling?:AgentJobHandling};
 delete node.jobHandling;const originalTarget=JSON.stringify(node.target);let writes=0;
 const render=()=>{const current=definition.steps[0] as typeof node;root.render(<AgentJobHandlingField value={current.jobHandling} onChange={mode=>{writes++;definition=changeAgentJobHandling(definition,current,mode);render();}}/>);};
 try{
  render();await settle();assert(writes===0,'opening legacy step never rewrites saved behavior');
  assert(host.textContent?.includes('Existing behavior · steer or run'),'legacy behavior remains visible');
  for(const [value,label,meaning] of [
   ['queue','Queue independent jobs','receives its own outcome'],
   ['steer','Steer shared Agent','delivery or uncertainty is not a separate job result'],
   ['copy','Temporary copy per job','temporary copy of the selected Agent'],
  ] as const){
   const select=host.querySelector('[role="combobox"]');assert(select,'job handling picker');
   select!.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));await settle();
   const option=Array.from(document.querySelectorAll('[role="option"]')).find(item=>item.textContent===label);
   assert(option,label);(option as HTMLElement).click();await settle();
   assert((definition.steps[0] as typeof node).jobHandling===value,'exact selected value reaches workflow draft');
   assert(JSON.stringify((definition.steps[0] as typeof node).target)===originalTarget,'selected expert identity preserved');
   assert(host.textContent?.includes(meaning),'mode consequence remains visible');
  }
  assert(writes===3,'each explicit choice writes once');render();await settle();assert(writes===3,'rerender does not rewrite draft');
 }finally{root.unmount();host.remove();}
}

export async function steeringNoResultRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 let input:import('@ponderosa/core').BranchDefinition['edges'][number]['input'],writes=0;
 const render=(noResult=true)=>root.render(<StepInputField input={input} noResult={noResult} onChange={next=>{input=next;writes++;render(noResult);}}/>);
 const open=async()=>{host.querySelector('[role="combobox"]')!.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));await settle();};
 try{
  render();await settle();assert(writes===0&&input===undefined,'saved output dependency is not silently rewritten');
  assert(host.querySelector('[aria-invalid="true"]'),'incompatible output dependency is visibly invalid');
  await open();const unavailable=Array.from(document.querySelectorAll('[role="option"]')).find(item=>item.textContent?.includes('steering has no output'))!;
  assert(unavailable?.getAttribute('aria-disabled')==='true','steering output is unavailable');
  (Array.from(document.querySelectorAll('[role="option"]')).find(item=>item.textContent==='Explicit Text') as HTMLElement).click();await settle();
  assert(writes===1&&input?.kind==='literal','only explicit correction changes edge input');
  assert(!host.querySelector('[aria-invalid="true"]'),'literal independent input resolves no-result validation');
  input=undefined;render(false);await settle();await open();
  const available=Array.from(document.querySelectorAll('[role="option"]')).find(item=>item.textContent==='This Step’s Output')!;
  assert(available?.getAttribute('aria-disabled')!=='true','result-bearing modes retain output selection');(available as HTMLElement).click();await settle();
 }finally{root.unmount();host.remove();}
}
