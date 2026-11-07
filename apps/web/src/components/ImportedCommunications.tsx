import {Alert,Box,Button,Link,Stack,Typography} from '@mui/material';
import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {requestJson} from '../api/real';
import type {ImportedCommunicationsPageDto} from '@ponderosa/core';

/** Source history stays in the owning Agent's audit view, outside live Chat. */
export function ImportedCommunications({agentId}:{agentId:string}):JSX.Element {
 const [open,setOpen]=useState(false),[offset,setOffset]=useState(0);
 const [version,setVersion]=useState<string>();
 const page=useQuery({queryKey:['imported-communications',agentId,offset,version],enabled:open,retry:false,
  queryFn:()=>requestJson<ImportedCommunicationsPageDto>(`/api/agents/${encodeURIComponent(agentId)}/imported-communications?offset=${offset}&limit=10${version?`&archiveVersion=${encodeURIComponent(version)}`:''}`)});
 const artifacts=new Map(page.data?.artifacts.map(item=>[item.id,item]));
 return <Box sx={{px:2,py:1}}><Button aria-expanded={open} onClick={()=>setOpen(value=>!value)}>Imported history</Button>{open&&<Stack spacing={1} sx={{maxHeight:'50vh',overflow:'auto'}}>
  {page.isPending&&<Typography role="status">Loading imported history…</Typography>}
  {page.isError&&<Alert severity="error" action={<Button onClick={()=>{setOffset(0);setVersion(undefined);void page.refetch();}}>Reload</Button>}>{page.error.message}</Alert>}
  {page.data&&<>
   {page.data.importProvenance?<Stack spacing={0.5} component="section" aria-label="Import record" sx={{overflowWrap:'anywhere'}}>
    <Typography variant="subtitle2">Import record</Typography>
    <Typography variant="body2">Cause: Import request</Typography>
    <Typography variant="body2">Imported by: {page.data.importProvenance.actorScope==='user:local-operator'?'You (local operator)':page.data.importProvenance.actorScope.startsWith('agent:')?'Agent':page.data.importProvenance.actorScope.startsWith('system:')?'Ponderosa (system)':'Not recorded'}</Typography>
    <Typography variant="body2">Source: {page.data.importProvenance.sourceLabel||page.data.source||'Not recorded'}</Typography>
    <Typography variant="body2">Imported into: {page.data.importProvenance.destinationChatTitle}</Typography>
    <Typography variant="body2">Recorded: {new Date(page.data.importProvenance.createdAt).toLocaleString()}</Typography>
    <Box component="details"><Box component="summary">Import identifiers</Box>
     <Typography variant="caption" sx={{display:'block',overflowWrap:'anywhere'}}>Actor: {page.data.importProvenance.actorScope}</Typography>
     <Typography variant="caption" sx={{display:'block',overflowWrap:'anywhere'}}>Request: {page.data.importProvenance.requestId}</Typography>
     <Typography variant="caption" sx={{display:'block',overflowWrap:'anywhere'}}>Creation operation: {page.data.importProvenance.creationOperationId}</Typography>
     {page.data.importProvenance.operationId&&<Typography variant="caption" sx={{display:'block',overflowWrap:'anywhere'}}>Import operation: {page.data.importProvenance.operationId}</Typography>}
     <Typography variant="caption" sx={{display:'block',overflowWrap:'anywhere'}}>Destination Chat: {page.data.importProvenance.destinationChatId}</Typography>
    </Box>
   </Stack>:page.data.source?<Stack spacing={0.5}><Typography variant="body2">Imported from {page.data.source}{page.data.importedAt?` · ${page.data.importedAt}`:''}</Typography><Typography variant="body2">Import actor and operation: Not recorded</Typography></Stack>:<Typography>No import record is available.</Typography>}
   {page.data.messages.length===0&&<Typography>No imported messages.</Typography>}
   {page.data.chatTitleHistory?.map(item=><Box key={`${item.sourceInstanceId}:${item.projectId}:${item.conversationId}:${item.eventId}`} component="section" aria-label="Imported Chat title change" sx={{borderBottom:1,borderColor:'divider',pb:1,overflowWrap:'anywhere'}}>
    <Typography variant="subtitle2">Imported source Chat rename</Typography>
    <Typography variant="caption">Source record · {new Date(item.createdAt).toLocaleString()}</Typography>
    <Typography variant="body2">Previous title: {item.change.previousTitle}</Typography><Typography variant="body2">New title: {item.change.title}</Typography>
    <Typography variant="body2">Recorded source: {item.change.origin==='automatic_title'?'System automatic title':'Operator API request'}</Typography>
    <Box component="details"><Box component="summary">Source identifiers</Box><Typography variant="caption" component="div">Source Chat: {item.conversationId} · Event: {item.eventId}</Typography><Typography variant="caption" component="div">Source instance: {item.sourceInstanceId}</Typography>{item.change.requestId&&<Typography variant="caption" component="div">Source request: {item.change.requestId}</Typography>}</Box>
   </Box>)}
   {page.data.messages.map((message,index)=><Box key={`${offset}:${index}`} sx={{borderBottom:1,borderColor:'divider',pb:1}}>
    <Typography variant="caption">{message.role} · {message.communication?.intent??'Historical message'} · {message.createdAt??''}</Typography>
    <Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{message.text}</Typography>
    {message.communication&&<Box component="details"><Box component="summary">Source and audience</Box><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:'inherit'}}>{JSON.stringify(message.communication,null,2)}</Typography></Box>}
    {Boolean(message.communicationRevisions?.length)&&<Box component="details"><Box component="summary">Source revisions</Box><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:'inherit'}}>{JSON.stringify(message.communicationRevisions,null,2)}</Typography></Box>}
    {[...new Set([...(message.attachmentRefs??[]),...Object.values(message.artifactRefs??{})])].map(id=>{const artifact=artifacts.get(id);return artifact?.downloadUrl?<Link key={id} href={artifact.downloadUrl} sx={{display:'block'}}>{artifact.summary||artifact.path||'Download original'}</Link>:<Typography key={id} variant="body2">Original unavailable</Typography>;})}
   </Box>)}
   <Stack direction="row" spacing={1}><Button disabled={offset===0||page.isFetching} onClick={()=>setOffset(Math.max(0,offset-10))}>Previous</Button><Button disabled={!page.data.hasMore||page.data.nextOffset===undefined||page.isFetching} onClick={()=>{setVersion(page.data!.archiveVersion);setOffset(page.data!.nextOffset!);}}>Next</Button></Stack>
  </>}
 </Stack>}</Box>;
}
