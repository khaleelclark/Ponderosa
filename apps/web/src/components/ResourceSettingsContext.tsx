import {createContext,type ReactNode} from 'react';

/** Product-owned settings extend the shared screens without copying them. */
export const ResourceSettingsContext=createContext<{
 render?(kind:'chat'|'agent',id:string):ReactNode;
 confirmClose?():boolean;
}>({});
