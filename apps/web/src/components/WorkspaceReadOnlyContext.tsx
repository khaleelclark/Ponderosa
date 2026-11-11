import {createContext,useContext} from 'react';

/** Execution inspection uses the normal workspace without offering mutations. */
export const WorkspaceReadOnlyContext=createContext(false);
export const useWorkspaceReadOnly=()=>useContext(WorkspaceReadOnlyContext);
