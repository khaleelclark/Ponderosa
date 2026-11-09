import {createContext} from 'react';
/** Canonical direct conversations share compact contact chrome and calm empty states. */
export const ConversationChromeContext=createContext<{assistantAgentId?:string;statusHost:HTMLElement|null;callActionsHost:HTMLElement|null}|undefined>(undefined);
