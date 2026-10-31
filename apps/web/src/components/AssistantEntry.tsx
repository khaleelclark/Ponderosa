import {useQuery} from '@tanstack/react-query';
import {Alert,Button,Stack} from '@mui/material';
import type {AssistantStatusDto} from '@ponderosa/core';
import {requestJson} from '../api/real';

/** Opening Ponderosa initializes the default once; removed speakers stay disabled. */
export function AssistantEntry():JSX.Element{
 const query=useQuery({queryKey:['assistant-initialize'],staleTime:Infinity,retry:false,
  queryFn:()=>requestJson<AssistantStatusDto>('/api/branches/assistant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({initialize:true})})});
 return <Stack direction="row" alignItems="center" sx={{px:1}}><Button href="/assistant">Assistant</Button>
  {query.data?.initialized&&!query.data.enabled&&<Button href="/assistant">Disabled</Button>}
  {query.isError&&<Alert severity="error" action={<Button onClick={()=>void query.refetch()}>Retry</Button>}>{(query.error as Error).message}</Alert>}
 </Stack>;
}
