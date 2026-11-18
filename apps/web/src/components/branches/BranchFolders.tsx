import type { ReactNode } from "react";
import type { BranchDto, BranchFolderDto, WorkspacePreferencesDto, UpdateWorkspacePreferencesRequest } from "@ponderosa/core";
import { ResourceFolders } from "../ResourceFolders";
import { customOrderSeed, reorderStableIds, sortWorkspaceResources, starredWorkspaceResources, type ResourceFolder } from "../../resourcePreferences";

export function BranchFolders({branches, preferences, filtering, renderRow, onPreferences, onRename, children}: {
  branches: BranchDto[]; preferences: WorkspacePreferencesDto; filtering: boolean;
  renderRow(branch: BranchDto): ReactNode;
  onRename(branch: BranchDto): void;
  onPreferences(patch: UpdateWorkspacePreferencesRequest): void;
  children(rows: {starredRows: ReactNode; allRows: ReactNode; openRows: ReactNode}): ReactNode;
}) {
  const sort=preferences.branchSort??"last_used";
  const items=sortWorkspaceResources(branches.map(branch=>({...branch,title:branch.name,updatedAt:branch.lastUsedAt??branch.createdAt,runningAgentCount:branch.activeExecutions})),sort,preferences.branchOrder,item=>item.id,item=>item.title,item=>item.updatedAt);
  const toFolders=(folders:ResourceFolder[]):BranchFolderDto[]=>folders.map(({memberIds,...folder})=>({...folder,branchIds:memberIds}));
  return <ResourceFolders<(typeof items)[number]> items={items} starredItems={sortWorkspaceResources(items.map(item=>({...item,updatedAt:item.createdAt})),sort,preferences.branchOrder,item=>item.id,item=>item.title,item=>item.updatedAt)} folders={(preferences.branchFolders??[]).map(({branchIds,...folder})=>({...folder,memberIds:branchIds}))}
    onRename={onRename} renameLabel="Rename…" resourceKind="branch" resourceLabel="Workflows" sort={sort} starredIds={starredWorkspaceResources(preferences)} filtering={filtering} renderRow={renderRow}
    onChange={(folders,custom)=>onPreferences({branchFolders:toFolders(folders),...(custom?{branchSort:"custom",branchOrder:sort==="custom"?preferences.branchOrder:customOrderSeed(preferences.branchOrder,items.map(item=>item.id))}:{})})}
    onReorder={(source,target,position,folders)=>{const visible=items.map(item=>item.id);onPreferences({branchSort:"custom",branchOrder:reorderStableIds(sort==="custom"?preferences.branchOrder:customOrderSeed(preferences.branchOrder,visible),visible,source,target,position),...(folders?{branchFolders:toFolders(folders)}:{})});}}>
    {children}
  </ResourceFolders>;
}
