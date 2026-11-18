import {Box} from '@mui/material';
import type {WorkspaceFileOwnerDto} from '@ponderosa/core';
import {ChatMessageBody,messageProseTypography} from './ChatMessages';

/** Keep incomplete Markdown literal; promote once the canonical segment closes. */
export function AgentResponseText({text,completed,projectId,fileScope,compact=false}:{
 text:string;completed:boolean;projectId?:string;fileScope?:WorkspaceFileOwnerDto;compact?:boolean;
}):JSX.Element {
 return <Box aria-busy={!completed} sx={{minWidth:0,overflowWrap:'anywhere'}}>
  {completed?<ChatMessageBody text={text} collapseLongMessage={false} projectId={projectId} fileScope={fileScope} compactMarkdown={compact} smallText={compact}/>:
   <Box sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',...messageProseTypography[compact?'small':'normal']}}>{text}</Box>}
 </Box>;
}
