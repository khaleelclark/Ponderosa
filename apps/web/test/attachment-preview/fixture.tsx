import React from 'react';
import { createRoot } from 'react-dom/client';
import { Box, CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { ChatAttachments } from '../../src/components/chat/ChatAttachments';

const image = (id: string) => ({ id, name: id, mediaType: 'image/svg+xml', size: 200,
  url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="400"><rect width="200" height="400" fill="#427a57"/></svg>')}` });
const attachments = [image('First'), image('Second'),
  {id:'slow',name:'Slow.txt',mediaType:'text/plain',size:10,url:'/api/slow.txt'},
  {id:'fast',name:'Fast.txt',mediaType:'text/plain',size:10,url:'/api/fast.txt'},
  {id:'zip',name:'Archive.zip',mediaType:'application/zip',size:10,url:'/archive.zip'},
  {id:'missing',name:'Missing',mediaType:'image/png',size:10,unavailable:true},
  {id:'broken',name:'Broken',mediaType:'image/png',size:10,url:'/broken.png'},
];
createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={createTheme({palette:{mode:'dark'}})}><CssBaseline />
    <Box data-testid="multiple" sx={{p:2}}><ChatAttachments attachments={attachments} /></Box>
    <Box data-testid="single" sx={{p:2}}><ChatAttachments attachments={[image('Only')]} /></Box>
  </ThemeProvider>
);
