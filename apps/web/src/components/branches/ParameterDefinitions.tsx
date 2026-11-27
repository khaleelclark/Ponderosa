import {useState} from 'react';
import {Alert,Button,FormControlLabel,Link,MenuItem,Paper,Stack,Switch,TextField,Typography} from '@mui/material';
import type {BranchDefinition,BranchParameter} from '@ponderosa/core';
import {isUnmodifiedPrimaryClick} from '../../nativeNavigation';

const typeLabels:Record<BranchParameter['type'],string>={text:'Text',number:'Number',boolean:'Yes/No',path:'File or folder path',secret:'Engine-managed secret'};

export function ParameterDefinitions({definition,onChange,settingsHref,onSettings}:{definition:BranchDefinition;onChange(definition:BranchDefinition):void;settingsHref:string;onSettings():void}):JSX.Element {
 const [name,setName]=useState('');
 const parameters=definition.parameters??{};
 const valid=/^[a-zA-Z0-9_.:-]{1,160}$/.test(name)&&!Object.hasOwn(parameters,name);
 const update=(key:string,value:BranchParameter)=>onChange({...definition,parameters:{...parameters,[key]:value}});
 return <Stack spacing={2}>
  <Typography variant="subtitle1">Set a value once and reuse it in this workflow.</Typography>
  <Typography variant="body2">For example, add <code>report_title</code> with the default <strong>Weekly team update</strong>. In Agent Instructions, use <code>{'Draft a report titled “{{parameter:report_title}}”.'}</code></Typography>
  <Typography variant="body2">Define the name, type, and optional default here, then publish. Edit saved values for the published workflow in <Link href={settingsHref} onClick={event=>{
   if(isUnmodifiedPrimaryClick(event)){event.preventDefault();onSettings();}
  }}>Settings → Workflow Variables</Link>.</Typography>
  <Typography variant="body2">A run uses the saved values it started with. Run once input supplies the starting input for that run.</Typography>
  <Stack spacing={1}>
   <TextField fullWidth size="small" label="Variable name" value={name} error={Boolean(name)&&!valid}
    helperText={Object.hasOwn(parameters,name)?'This name is already in use.':'Use 1–160 letters, numbers, dots, colons, underscores, or hyphens.'} onChange={e=>setName(e.target.value)}/>
   <Button sx={{alignSelf:'start',minHeight:44}} disabled={!valid} onClick={()=>{update(name,{type:'text'});setName('')}}>Add variable</Button>
  </Stack>
  {Object.entries(parameters).map(([key,p])=><Paper variant="outlined" key={key} sx={{p:2}}><Stack spacing={1.5}>
   <Stack direction="row" alignItems="center" gap={1}><Typography sx={{flex:1,overflowWrap:'anywhere'}}>{key}</Typography><Button aria-label={`Remove variable ${key}`} onClick={()=>{const next={...parameters};delete next[key];onChange({...definition,parameters:next})}}>Remove</Button></Stack>
   <Stack direction={{xs:'column',sm:'row'}} gap={1}><TextField fullWidth label={`Label for ${key}`} value={p.label??''} onChange={e=>update(key,{...p,label:e.target.value})}/><TextField fullWidth select label={`Type for ${key}`} value={p.type} onChange={e=>{const {default:discarded,...rest}=p;void discarded;update(key,{...rest,type:e.target.value as BranchParameter['type']})}}>{Object.entries(typeLabels).map(([type,label])=><MenuItem key={type} value={type}>{label}</MenuItem>)}</TextField></Stack>
   <TextField label={`Help for ${key}`} value={p.help??''} onChange={e=>update(key,{...p,help:e.target.value})}/>
   {p.type==='path'&&<Typography variant="body2" color="text.secondary">A path names a location. A step must open it to read its contents.</Typography>}
   <FormControlLabel label="Required" control={<Switch checked={p.required??false} onChange={(_,required)=>update(key,{...p,required})}/>}/>
   {p.type==='secret'?<Alert severity="info">Engine-managed secrets are available only to supported integrations.</Alert>:<>
    <FormControlLabel label={`Use a default for ${key}`} control={<Switch checked={p.default!==undefined} onChange={(_,enabled)=>{const next={...p};if(enabled)next.default=p.type==='number'?0:p.type==='boolean'?false:'';else delete next.default;update(key,next)}}/>}/>
    {p.default!==undefined&&(p.type==='boolean'?<FormControlLabel label={`Default for ${key}`} control={<Switch checked={Boolean(p.default)} onChange={(_,value)=>update(key,{...p,default:value})}/>}/>:<TextField label={`Default for ${key}`} type={p.type==='number'?'number':'text'} value={p.default} onChange={e=>{const value=p.type==='number'?Number(e.target.value):e.target.value;if(typeof value!=='number'||Number.isFinite(value))update(key,{...p,default:value})}}/>)}
   </>}
  </Stack></Paper>)}
 </Stack>;
}
