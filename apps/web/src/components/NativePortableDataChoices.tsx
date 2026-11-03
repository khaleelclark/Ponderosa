import {useQuery} from '@tanstack/react-query';
import {Alert,Button,Checkbox,FormControlLabel,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {ReviewedUserDataActivation,ReviewedUserDataSelection} from '@ponderosa/core';
import {requestJson} from '../api/real';
import {portablePathChoice,sourcePathInput} from './portablePathChoices';
import {nativeImportChoiceError,type NativeDataPreview} from './nativeDataPreview';
import type {NativeImportChoices} from './nativeDataPreview';
export {nativeImportChoiceError,type NativeImportChoices} from './nativeDataPreview';
export function NativePortableExportChoices({available,disabled,value,onChange}:{available:boolean;disabled?:boolean;value:ReviewedUserDataSelection;onChange(value:ReviewedUserDataSelection):void}):JSX.Element {
 const update=(patch:Partial<ReviewedUserDataSelection>)=>onChange({...value,...patch});
 return <Stack spacing={0.5}>
  <TextField select label="Settings data source" disabled={!available||disabled} value={value.source??'live'} onChange={event=>update({source:event.target.value as 'live'|'retained_originals'})}><MenuItem value="live">Current folders</MenuItem><MenuItem value="retained_originals">Imported originals</MenuItem></TextField>
  <FormControlLabel control={<Checkbox disabled={!available||disabled} checked={available&&value.git} onChange={event=>update({git:event.target.checked,...(!event.target.checked?{externalGitDependencies:undefined}:{})})}/>} label="Git history, branches and staged files"/>
  <FormControlLabel control={<Checkbox disabled={!available||disabled||!value.git} checked={available&&value.git&&Boolean(value.externalGitDependencies)} onChange={event=>update({externalGitDependencies:event.target.checked?true:undefined})}/>} label="Include configured Git files and hooks"/>
  <FormControlLabel control={<Checkbox disabled={!available||disabled} checked={available&&value.harness} onChange={event=>update({harness:event.target.checked})}/>} label="Claude and Codex project settings"/>
  <FormControlLabel control={<Checkbox disabled={!available||disabled} checked={available&&Boolean(value.extendedMetadata)} onChange={event=>update({extendedMetadata:event.target.checked?{userXattrs:true,posixAcl:true}:undefined})}/>} label="File permissions and extended metadata"/>
  <FormControlLabel control={<Checkbox disabled={!available||disabled} checked={available&&Boolean(value.persistentNodes?.fifo)} onChange={event=>update({persistentNodes:{fifo:event.target.checked,evidenceOnly:value.persistentNodes?.evidenceOnly??false}})}/>} label="Named pipes"/>
  <FormControlLabel control={<Checkbox disabled={!available||disabled} checked={available&&Boolean(value.persistentNodes?.evidenceOnly)} onChange={event=>update({persistentNodes:{fifo:value.persistentNodes?.fifo??false,evidenceOnly:event.target.checked}})}/>} label="Device and socket evidence"/>
  <Typography variant="caption" color="text.secondary">Whole folders required. Import activation is a separate choice; device and socket services are not recreated.</Typography>
 </Stack>;
}
export function NativePortableImportChoices({summary,value,onChange,disabled,destinations={}}:{summary?:NativeDataPreview;value:NativeImportChoices;onChange(value:NativeImportChoices):void;disabled?:boolean;destinations?:Record<string,string>}):JSX.Element|null {
 const metadata=summary?.metadata,activation=value.reviewedMetadataActivation;
 const provenance=useQuery({queryKey:['portable-metadata-provenance'],enabled:Boolean(metadata),queryFn:()=>requestJson<{qualifier:string;ownerId:string;groupId:string}>('/api/portable-metadata/provenance'),retry:false});
 const native=value.reviewedUserDataActivation;
 if(!summary)return null;
 const updateNative=(patch:Partial<ReviewedUserDataActivation>)=>{const next={git:native?.git??false,harness:native?.harness??false,...native,...patch};onChange({...value,reviewedUserDataActivation:next.git||next.harness?next:undefined});};
 const mappings=(native as ReviewedUserDataActivation&{gitPathMappings?:Array<{source:string;destination:string}>}|undefined)?.gitPathMappings??[];
 const suggested=summary.sourceRoots.flatMap(root=>destinations[root.rootRef]?.trim()?[{source:root.sourcePath,destination:destinations[root.rootRef]!.trim()}]:[]);
 return <Stack spacing={1}>
  {nativeImportChoiceError(value,summary)&&<Alert severity="warning">{nativeImportChoiceError(value,summary)}</Alert>}
  {summary.warning&&<Alert severity="warning">Native data review: {summary.warning}</Alert>}
  {(summary.git||summary.harness||metadata)&&<Typography variant="subtitle1">Restore native settings</Typography>}
  {summary.git&&<FormControlLabel control={<Checkbox disabled={disabled} checked={native?.git??false} onChange={event=>updateNative({git:event.target.checked})}/>} label="Activate imported Git repository and hooks"/>}
  {summary.harness&&<FormControlLabel control={<Checkbox disabled={disabled} checked={native?.harness??false} onChange={event=>updateNative({harness:event.target.checked})}/>} label="Activate imported Claude and Codex settings"/>}
  {native?.git&&<Stack spacing={1}>
   <Typography variant="caption">Map referenced settings paths to included destination folders or files.</Typography>
   {mappings.map((mapping,index)=><Stack key={index} direction={{xs:'column',sm:'row'}} spacing={1}><TextField disabled={disabled} label="Old folder or file" value={mapping.source} onChange={event=>{const next=mappings.map((item,i)=>i===index?{...item,source:sourcePathInput(event.target.value)}:item);updateNative({gitPathMappings:next} as Partial<ReviewedUserDataActivation>);}} onBlur={event=>{const name=sourcePathInput(event.target.value),source=(portablePathChoice(name)??portablePathChoice(name.replace(/\/+$/,'')))?.path;if(source){const next=mappings.map((item,i)=>i===index?{...item,source}:item);updateNative({gitPathMappings:next} as Partial<ReviewedUserDataActivation>);}}/><TextField disabled={disabled} label="Included destination folder or file" value={mapping.destination} onChange={event=>{const next=mappings.map((item,i)=>i===index?{...item,destination:event.target.value}:item);updateNative({gitPathMappings:next} as Partial<ReviewedUserDataActivation>);}}/><Button disabled={disabled} onClick={()=>{const next=mappings.filter((_,i)=>i!==index);const {gitPathMappings:_,...base}=native as ReviewedUserDataActivation&{gitPathMappings?:unknown};onChange({...value,reviewedUserDataActivation:{...base,...(next.length?{gitPathMappings:next}:{})}});}}>Remove mapping</Button></Stack>)}
   <Stack direction="row" spacing={1}><Button disabled={disabled} onClick={()=>updateNative({gitPathMappings:[...mappings,{source:'',destination:''}]} as Partial<ReviewedUserDataActivation>)}>Add path mapping</Button>{suggested.length>0&&<Button disabled={disabled} onClick={()=>updateNative({gitPathMappings:suggested} as Partial<ReviewedUserDataActivation>)}>Use selected folder mappings</Button>}</Stack>
  </Stack>}
  {metadata&&<>
   {provenance.error&&<Alert severity="warning" action={<Button onClick={()=>void provenance.refetch()}>Retry</Button>}>{provenance.error.message}</Alert>}
   {metadata.unsupportedNodes>0&&<Alert severity="warning">Device and socket evidence stays inactive; restore their owning services separately.</Alert>}
   <FormControlLabel control={<Checkbox disabled={disabled||!provenance.data||metadata.unsupportedNodes>0||!metadata.rootRefs.length} checked={Boolean(activation)} onChange={event=>onChange({...value,reviewedMetadataActivation:event.target.checked?{sourceQualifier:metadata.sourceQualifier,destinationQualifier:provenance.data!.qualifier,replaceInheritedUserAndPosixAcl:true,rootRefs:metadata.rootRefs,fifo:false,principalMappings:metadata.principals.map(principal=>({...principal,sourceQualifier:metadata.sourceQualifier,destinationId:''}))}:undefined})}/>} label="Restore included permissions and metadata"/>
   {activation&&<>
    {provenance.data&&activation.destinationQualifier!==provenance.data.qualifier&&<Alert severity="warning" action={<Button onClick={()=>onChange({...value,reviewedMetadataActivation:{...activation,destinationQualifier:provenance.data!.qualifier,principalMappings:activation.principalMappings.map(mapping=>({...mapping,destinationId:''}))}})}>Review this host again</Button>}>Destination host changed; review owner mappings again.</Alert>}
    <Typography variant="caption">Replaces inherited user attributes and permissions only in the new imported folders.</Typography>
    {metadata.principals.map(principal=>{const index=activation.principalMappings.findIndex(mapping=>mapping.kind===principal.kind&&mapping.sourceId===principal.sourceId),mapping=activation.principalMappings[index],currentId=(principal.kind==='user'?provenance.data?.ownerId:provenance.data?.groupId)??'';const choose=(destinationId:string)=>onChange({...value,reviewedMetadataActivation:{...activation,principalMappings:activation.principalMappings.map((item,i)=>i===index?{...item,destinationId}:item)}});return <Stack key={principal.kind+principal.sourceId} direction={{xs:'column',sm:'row'}} spacing={1}><TextField disabled={disabled} label={(principal.kind==='user'?'Destination user for source owner ':'Destination group for source group ')+principal.sourceId} value={mapping?.destinationId??''} onChange={event=>choose(event.target.value)} inputProps={{inputMode:'numeric',pattern:'[0-9]*'}}/><Button disabled={disabled||!currentId} onClick={()=>choose(currentId)}>{principal.kind==='user'?'Use current user':'Use current group'}</Button></Stack>;})}
    {metadata.fifoCount>0&&<FormControlLabel control={<Checkbox disabled={disabled} checked={activation.fifo} onChange={event=>onChange({...value,reviewedMetadataActivation:{...activation,fifo:event.target.checked}})}/>} label="Recreate the included named pipes"/>}
   </>}
  </>}
  {(native?.git||native?.harness)&&<Alert severity="warning">These choices activate imported settings and executable hooks in the new folders.</Alert>}
 </Stack>;
}
