import {useState} from 'react';
import {Alert,Button,FormControlLabel,MenuItem,Paper,Stack,Switch,TextField,Typography} from '@mui/material';
import type {BranchDefinition,BranchParameter} from '@ponderosa/core';

export function ParameterDefinitions({definition,onChange}:{definition:BranchDefinition;onChange(definition:BranchDefinition):void}):JSX.Element {
 const [name,setName]=useState('');
 const parameters=definition.parameters??{};
 const valid=/^[a-zA-Z0-9_.:-]{1,160}$/.test(name)&&!Object.hasOwn(parameters,name);
 const update=(key:string,value:BranchParameter)=>onChange({...definition,parameters:{...parameters,[key]:value}});
 return <Stack spacing={2}>
  <Typography variant="h6">Parameter Definitions</Typography>
  <Typography variant="body2" color="text.secondary">Installation values · paths do not load file contents</Typography>
  {Object.entries(parameters).map(([key,p])=><Paper variant="outlined" key={key} sx={{p:2}}><Stack spacing={1.5}>
   <Stack direction="row" alignItems="center" gap={1}><Typography sx={{flex:1,overflowWrap:'anywhere'}}>{key}</Typography><Button aria-label={`Remove Parameter ${key}`} onClick={()=>{const next={...parameters};delete next[key];onChange({...definition,parameters:next})}}>Remove</Button></Stack>
   <Stack direction={{xs:'column',sm:'row'}} gap={1}><TextField fullWidth label={`Label For ${key}`} value={p.label??''} onChange={e=>update(key,{...p,label:e.target.value})}/><TextField fullWidth select label={`Type For ${key}`} value={p.type} onChange={e=>{const {default:discarded,...rest}=p;void discarded;update(key,{...rest,type:e.target.value as BranchParameter['type']})}}>{(['text','number','boolean','path','secret'] as const).map(type=><MenuItem key={type} value={type}>{type==='path'?'File / folder path':type}</MenuItem>)}</TextField></Stack>
   <TextField label={`Help For ${key}`} value={p.help??''} onChange={e=>update(key,{...p,help:e.target.value})}/>
   <FormControlLabel label="Required" control={<Switch checked={p.required??false} onChange={(_,required)=>update(key,{...p,required})}/>}/>
   {p.type==='secret'?<Alert severity="info">Engine-owned secrets: no entry, export or prompt interpolation.</Alert>:<>
    <FormControlLabel label="Use A Default" control={<Switch checked={p.default!==undefined} onChange={(_,enabled)=>{const next={...p};if(enabled)next.default=p.type==='number'?0:p.type==='boolean'?false:'';else delete next.default;update(key,next)}}/>}/>
    {p.default!==undefined&&(p.type==='boolean'?<FormControlLabel label="Default Value" control={<Switch checked={Boolean(p.default)} onChange={(_,value)=>update(key,{...p,default:value})}/>}/>:<TextField label={`Default For ${key}`} type={p.type==='number'?'number':'text'} value={p.default} onChange={e=>{const value=p.type==='number'?Number(e.target.value):e.target.value;if(typeof value!=='number'||Number.isFinite(value))update(key,{...p,default:value})}}/>)}
   </>}
  </Stack></Paper>)}
  <Stack direction={{xs:'column',sm:'row'}} gap={1}><TextField size="small" label="New Parameter Name" value={name} error={Boolean(name)&&!valid} helperText="Unique letters, numbers, dots, colons, underscores, or hyphens." onChange={e=>setName(e.target.value)}/><Button disabled={!valid} onClick={()=>{update(name,{type:'text'});setName('')}}>Add Parameter</Button></Stack>
 </Stack>;
}
