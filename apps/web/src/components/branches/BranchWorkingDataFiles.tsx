import {useEffect,useState} from 'react';
import {Alert,Checkbox,FormControlLabel,Stack,TextField,Typography} from '@mui/material';
import type {BranchImportFileSelections,InstalledBranchPackage} from '@ponderosa/core';
import {NativePortableImportChoices} from '../NativePortableDataChoices';
import {nativeDataPreview,type NativeDataPreview} from '../nativeDataPreview';
import {branchWorkingDataRoots,branchWorkingDataDestinations,branchWorkingDataDerivedChat,workingOwnerKey} from './branchWorkingDataFiles';
export function BranchWorkingDataFiles({pkg,value,onChange,disabled}:{pkg:InstalledBranchPackage;value:BranchImportFileSelections;onChange(value:BranchImportFileSelections):void;disabled:boolean}):JSX.Element {
 const roots=branchWorkingDataRoots(pkg),destinations=branchWorkingDataDestinations(pkg,value),data=pkg.workingData!;
 const [loaded,setLoaded]=useState<{source:object;summary:NativeDataPreview}>();
 useEffect(()=>{let active=true;setLoaded(undefined);void nativeDataPreview(data.package.agents).then(summary=>{if(active)setLoaded({source:data,summary})});return()=>{active=false};},[data]);
 const summary=loaded?.source===data?loaded.summary:undefined,primary=roots[0]?.key;
 const live=Object.values(value).some(choice=>choice.workingFilesActivation);
 const recovery=(ref:string,name:string)=>{
  const mapped={...destinations,[ref]:name};
  for(let depth=0;depth<roots.length;depth++)for(const root of roots)if(root.boundary&&mapped[root.boundary.parentRootRef])mapped[root.ref]=mapped[root.boundary.parentRootRef]!.replace(/\/$/,'')+'/'+root.boundary.path;
  const next={...value};for(const root of roots)next[root.key]={...next[root.key],workingRootDestinations:{...next[root.key]?.workingRootDestinations,[root.ref]:mapped[root.ref]??''}};onChange(next);
 };
 const setLive=(enabled:boolean)=>{
  const next={...value};
  for(const chat of pkg.chats){if(!Object.values(data.owners).some(owner=>owner.chatRef===chat.ref))continue;const root=chat.agents.find(agent=>!agent.managerRef)??chat.agents[0];if(!root)continue;const key=workingOwnerKey(chat.ref,root.ref),{workingFilesActivation,newManagedChatFolderName,...prior}=next[key]??{};next[key]={...prior,...(enabled?{workingFilesActivation:{},...(!branchWorkingDataDerivedChat(pkg,chat.ref)?{newManagedChatFolderName:newManagedChatFolderName??''}:{})}:{})};}
  onChange(next);
 };
 return <Stack spacing={1}>
  <Typography variant="h6">Included Working Folders</Typography>
  <Typography variant="caption">Each captured folder is restored once; Chat histories stay separate.</Typography>
  {roots.map(root=><TextField key={root.ref} disabled={disabled||Boolean(root.boundary)} label={'Recovery folder · '+(pkg.chats.find(chat=>chat.ref===root.owner.chatRef)?.title??root.owner.chatRef)+' · '+root.node.title} value={destinations[root.ref]??''} onChange={event=>recovery(root.ref,event.target.value)} helperText={root.boundary?'Inside the selected parent folder: '+root.boundary.path:'New absolute host folder; existing files are never overwritten.'}/>)}
  <FormControlLabel control={<Checkbox disabled={disabled} checked={live} onChange={event=>setLive(event.target.checked)}/>} label="Use Restored Folders For The Imported Chats"/>
  {live&&pkg.chats.filter(chat=>Object.values(data.owners).some(owner=>owner.chatRef===chat.ref)).map(chat=>{const root=chat.agents.find(agent=>!agent.managerRef)??chat.agents[0]!,key=workingOwnerKey(chat.ref,root.ref),derived=branchWorkingDataDerivedChat(pkg,chat.ref);if(derived)return <Typography key={chat.ref} variant="caption">{chat.title}: {derived.kind==='shared'?'shares the restored folder with ':'inside the restored folder for '}{pkg.chats.find(source=>source.ref===derived.sourceChatRef)?.title??derived.sourceChatRef}{derived.path?' / '+derived.path:''}</Typography>;return <TextField key={chat.ref} disabled={disabled} label={'New working-folder name · '+chat.title} value={value[key]?.newManagedChatFolderName??''} onChange={event=>onChange({...value,[key]:{...value[key],newManagedChatFolderName:event.target.value}})}/>;})}
  {live&&<Alert severity="info">Confirm actual managed folder paths after creation.</Alert>}
  {primary&&<NativePortableImportChoices summary={summary} value={value[primary]??{}} disabled={disabled||!summary} destinations={destinations} onChange={choices=>onChange({...value,[primary]:{...value[primary],...choices}})}/>}
 </Stack>;
}
