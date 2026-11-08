import {createContext} from 'react';
/** Canonical direct conversations share compact contact chrome and calm empty states. */
export const ConversationChromeContext=createContext<{statusHost:HTMLElement|null;callActionsHost:HTMLElement|null}|undefined>(undefined);
