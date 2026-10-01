import {createRoot} from 'react-dom/client';
import {CssBaseline,ThemeProvider} from '@mui/material';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {api} from '../src/api';
import {createPonderosaTheme} from '../src/theme';
import {useWorkspaceStream} from '../src/hooks/useWorkspaceStream';
import {WorkspaceConnectionNotice} from '../src/components/WorkspaceConnectionNotice';
import {WorkspaceRefreshProvider} from '../src/components/WorkspaceRefreshContext';
import {MutationNotificationProvider} from '../src/components/MutationNotifications';

let handlers:Parameters<typeof api.subscribeWorkspace>[1];
let attempts=0;
api.subscribeWorkspace=(_cursor,next)=>{handlers=next;document.body.dataset.attempts=String(++attempts);return{close(){}};};
function Probe(){
  const connection=useWorkspaceStream();
  return <><WorkspaceConnectionNotice connection={connection} hasSavedData/>
    <div id="connection">{connection.status}</div>
    <button onClick={()=>handlers.onError?.(new Event('error'))}>Fail connection</button>
    <button onClick={()=>handlers.onStatus?.({instanceId:'fixture',cursor:0,reset:false})}>Restore connection</button>
    <p><a download="app.apk" href="/api/probe/download">Download APK</a></p>
    <p><a download="other.apk" href="/api/probe/other">Download another file</a></p>
    <p><a download="missing.apk" href="/api/probe/missing">Download missing file</a></p>
    <p><a download="unknown.apk" href="/api/probe/unknown">Download unknown size</a></p>
  </>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider theme={createPonderosaTheme('dark')}><CssBaseline/><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><WorkspaceRefreshProvider><MutationNotificationProvider><Probe/></MutationNotificationProvider></WorkspaceRefreshProvider></QueryClientProvider></ThemeProvider>);
