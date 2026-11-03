import {Button,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {GitStorageSelection} from '@ponderosa/core';
import {createClientId} from '../clientId';
export function GitStorageBindingsEditor({agents,value,onChange,available,disabled}:{agents:Array<{id:string;title:string}>;value:GitStorageSelection[];onChange(value:GitStorageSelection[]):void;available:boolean;disabled?:boolean}):JSX.Element {
 const titleCounts=new Map<string,number>();for(const agent of agents)titleCounts.set(agent.title,(titleCounts.get(agent.title)??0)+1);
 const label=(agent:{id:string;title:string})=>agent.title+(titleCounts.get(agent.title)!>1?' · '+agent.id:'');
 const update=(index:number,patch:Partial<GitStorageSelection>)=>onChange(value.map((binding,i)=>i===index?{...binding,...patch}:binding));
 return <Stack component="details" spacing={1}><Typography component="summary" sx={{cursor:'pointer'}}>Mapped Git folders</Typography>
  {!available&&<Typography variant="caption">Include all organization folders and current Git data to map separate Git storage.</Typography>}
  {value.map((binding,index)=><Stack key={binding.id} spacing={1}>
   <TextField select disabled={disabled||!available} label="Working-folder Agent" value={binding.worktreeAgentId} onChange={event=>update(index,{worktreeAgentId:event.target.value})}><MenuItem value="">Choose Agent</MenuItem>{agents.map(agent=><MenuItem key={agent.id} value={agent.id}>{label(agent)}</MenuItem>)}</TextField>
   <TextField select disabled={disabled||!available} label="Storage-folder Agent" value={binding.storageAgentId} onChange={event=>update(index,{storageAgentId:event.target.value})}><MenuItem value="">Choose Agent</MenuItem>{agents.map(agent=><MenuItem key={agent.id} value={agent.id}>{label(agent)}</MenuItem>)}</TextField>
   <TextField select disabled={disabled||!available} label="Git folder type" value={binding.role} onChange={event=>update(index,{role:event.target.value as GitStorageSelection['role']})}><MenuItem value="common">Shared repository files</MenuItem><MenuItem value="private">Private worktree files</MenuItem><MenuItem value="module">Module repository files</MenuItem></TextField>
   <TextField disabled={disabled||!available} label="Git folder inside the storage Agent’s folder" value={binding.relativePath} onChange={event=>update(index,{relativePath:event.target.value})} helperText="Relative path, such as .git; use . for the folder itself."/>
   <Button disabled={disabled} onClick={()=>onChange(value.filter((_,i)=>i!==index))}>Remove Git mapping</Button>
  </Stack>)}
  <Button disabled={disabled||!available||value.length>=1000} onClick={()=>onChange([...value,{id:createClientId(),worktreeAgentId:agents[0]?.id??'',storageAgentId:agents[0]?.id??'',relativePath:'.git',role:'common'}])}>Add Git folder mapping</Button>
 </Stack>;
}
