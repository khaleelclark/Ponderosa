import type {BranchContextDto} from "@ponderosa/core";
import { parseRoute, navigationPreservesSettings, type Route } from './routing.js';
import { routeToPath, type ProjectRoute } from './routeRegistry.js';

export const branchTabs = ['workflow', 'executions', 'settings', 'chats', 'parameters'] as const;
export type BranchTab = typeof branchTabs[number];
export type BranchGlobalView = 'general' | 'providers' | 'notifications' | 'activity' | 'profile' | 'usage' | 'status';
export const branchSettingsSection=(view:BranchGlobalView):NonNullable<Extract<Route,{kind:'settings'}>['section']>=>view==='status'?'providers':view==='usage'?'activity':view;
export interface BranchRoute {
  branchId?: string;
  tab: BranchTab;
  executionId?: string;
  chatId?: string;
  workspace?: ProjectRoute;
  global?: BranchGlobalView;
  executionFilter?: string;
}

/** The model draft stays in BranchesWorkspace; editor-local fields need its panel mounted. */
export function retainedBranchDrafts(current: BranchRoute, next: BranchRoute): { workflow: boolean; editor: boolean; settings: boolean; localKeys: string[] } {
  const workflow = Boolean(current.branchId && current.branchId === next.branchId);
  return { workflow, localKeys:workflow&&!current.global&&!next.global?[`branch-settings:${current.branchId}:parameters`,`branch-settings:${current.branchId}:limits`,`branch-execution-budget:${current.branchId}`,`branch-capabilities:${current.branchId}`,`branch-availability:${current.branchId}`,`branch-deletion:${current.branchId}`]:[], editor: workflow && !next.global, settings:Boolean(current.global&&next.global&&navigationPreservesSettings({kind:'settings',section:branchSettingsSection(current.global)},{kind:'settings',section:branchSettingsSection(next.global)})) };
}

/** Product navigation wraps the existing typed workspace routes, including focus IDs. */
export function parseBranchRoute(search: string): BranchRoute {
  const query = new URLSearchParams(search);
  const tab = query.get('tab');
  const executionId = query.get('execution') || undefined;
  const global = query.get('settings');
  const nested = query.get('workspace');
  const location = nested?.startsWith('/projects/') ? new URL(nested, 'http://ponderosa.invalid') : undefined;
  const workspace: Route | undefined = location ? parseRoute(location.pathname, location.search) : undefined;
  return {
    tab: branchTabs.includes(tab as BranchTab) ? tab as BranchTab : executionId ? 'executions' : 'workflow',
    ...(query.get('branch') ? { branchId: query.get('branch')! } : {}),
    ...(executionId ? { executionId } : {}),
    ...(query.get('chat') ? { chatId: query.get('chat')! } : {}),
    ...(workspace && 'projectId' in workspace && workspace.projectId ? { workspace: workspace as ProjectRoute } : {}),
    ...(['general','providers','notifications','activity','profile','usage','status'].includes(global ?? '') ? { global: global as BranchGlobalView } : {}),
    ...(query.get('state') ? { executionFilter: query.get('state')! } : {}),
  };
}

export function branchRoutePath(route: BranchRoute): string {
  const query = new URLSearchParams();
  if (route.branchId) query.set('branch', route.branchId);
  if (route.tab !== 'workflow') query.set('tab', route.tab);
  if (route.executionId) query.set('execution', route.executionId);
  if (route.chatId) query.set('chat', route.chatId);
  if (route.workspace) query.set('workspace', routeToPath(route.workspace));
  if (route.global) query.set('settings', route.global);
  if (route.executionFilter) query.set('state', route.executionFilter);
  return `/branches${query.size ? `?${query}` : ''}`;
}

/** Wrap a shared destination only after resolving its canonical Chat owner. */
export function branchWorkspaceRoute(context:Pick<BranchContextDto,'id'|'projectId'|'branchId'|'executionId'>,workspace:ProjectRoute):BranchRoute {
  if(!context.branchId||workspace.projectId!==context.projectId||('conversationId'in workspace&&workspace.conversationId&&workspace.conversationId!==context.id))throw new Error('The destination does not belong to this Branch Chat.');
  return {branchId:context.branchId,tab:'chats',...(context.executionId?{executionId:context.executionId}:{}),chatId:context.id,workspace};
}
