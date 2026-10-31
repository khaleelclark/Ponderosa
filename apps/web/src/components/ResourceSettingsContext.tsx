import {createContext,type ReactNode} from 'react';
import {CapabilityPolicyEditor} from './CapabilityPolicyEditor';
import {confirmUnsavedNavigation} from '../reloadSafety';

/** Product-owned settings extend the shared screens without copying them. */
export const ResourceSettingsContext=createContext<{
 render?(kind:'chat'|'agent',id:string):ReactNode;
 confirmClose?():boolean;
}>({render:(kind,id)=><CapabilityPolicyEditor scopeKind={kind} endpoint={`/api/${kind==='chat'?'conversations':'agents'}/${id}/capabilities`} title="Tool permissions" immediateSave/>,confirmClose:confirmUnsavedNavigation});
