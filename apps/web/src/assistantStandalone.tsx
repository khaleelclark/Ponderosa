import {ThemeProvider} from '@mui/material/styles';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {setStandaloneProductScope,currentProductScope} from './api/productScope';
import {createPonderosaTheme} from './theme';
import {MobileNavigationProvider} from './components/MobileNavigationContext';
import {MutationNotificationProvider} from './components/MutationNotifications';
import {PrimaryHeaderActionsProvider} from './components/PrimaryHeaderActions';
import {WorkspaceErrorBoundary} from './components/WorkspaceErrorBoundary';
import {OutputAgentApp} from './components/OutputAgentApp';
import {confirmUnsavedNavigation,reloadBlockers} from './reloadSafety';
import type {AssistantMountApi,AssistantMountProps,AssistantMountWindow} from './assistantMount';

setStandaloneProductScope('branches');
let root:Root|undefined;
let queryClient:QueryClient|undefined;
function render(props:AssistantMountProps){
 if(!root||!queryClient)return;
 root.render(<StrictMode><QueryClientProvider client={queryClient}><ThemeProvider theme={createPonderosaTheme(props.colorMode,'assistant')}><MutationNotificationProvider notifier={props.notify}><MobileNavigationProvider onOpen={props.onOpenNavigation}><PrimaryHeaderActionsProvider onOpenProviderSettings={props.onOpenProviderSettings}><WorkspaceErrorBoundary title="Assistant could not display its conversation."><OutputAgentApp embedded colorMode={props.colorMode} onToggleColorMode={props.onToggleColorMode} returnTo={props.returnTo} onIdentityChanged={props.onIdentityChanged}/></WorkspaceErrorBoundary></PrimaryHeaderActionsProvider></MobileNavigationProvider></MutationNotificationProvider></ThemeProvider></QueryClientProvider></StrictMode>);
}
const api:AssistantMountApi={
 mount(host,props){if(root)throw Error('Assistant already mounted');queryClient=new QueryClient({defaultOptions:{queries:{staleTime:15_000,refetchOnWindowFocus:true}}});root=createRoot(host);render(props);},
 update(props){render(props);},
 unmount(){root?.unmount();queryClient?.clear();root=undefined;queryClient=undefined;},
 canLeave:confirmUnsavedNavigation,
 blockers:reloadBlockers,
 productScope:currentProductScope,
};
(window as AssistantMountWindow).__ponderosaAssistantMount=api;
