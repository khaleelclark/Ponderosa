import type {BranchBindings,BranchDefinition} from '@ponderosa/core';

export type WorkflowDraftSnapshot={definition:BranchDefinition;bindings:BranchBindings;chatId:string};
export type WorkflowDraftEdit={definition?:BranchDefinition;bindings?:BranchBindings};
export type WorkflowDraftHistory={past:WorkflowDraftSnapshot[];future:WorkflowDraftSnapshot[]};
export const emptyWorkflowHistory=():WorkflowDraftHistory=>({past:[],future:[]});
const content=({definition,bindings,chatId}:WorkflowDraftSnapshot):WorkflowDraftSnapshot=>({definition,bindings,chatId});
const snapshot=(draft:WorkflowDraftSnapshot):WorkflowDraftSnapshot=>structuredClone(content(draft));

/** Local draft history only; real resources and publication identities are never reversed. */
export function recordWorkflowEdit(history:WorkflowDraftHistory,before:WorkflowDraftSnapshot,after:WorkflowDraftSnapshot):WorkflowDraftHistory{
 if(JSON.stringify(content(before))===JSON.stringify(content(after)))return history;
 // ponytail: retain the latest 100 explicit draft edits; add field coalescing only if measured use needs it.
 return {past:[...history.past,snapshot(before)].slice(-100),future:[]};
}
export function moveWorkflowHistory(history:WorkflowDraftHistory,current:WorkflowDraftSnapshot,direction:'undo'|'redo'):{history:WorkflowDraftHistory;draft:WorkflowDraftSnapshot}|undefined{
 const source=direction==='undo'?history.past:history.future,previous=source.at(-1);
 if(!previous)return;
 return {draft:snapshot(previous),history:direction==='undo'?{past:history.past.slice(0,-1),future:[...history.future,snapshot(current)]}:{past:[...history.past,snapshot(current)],future:history.future.slice(0,-1)}};
}
