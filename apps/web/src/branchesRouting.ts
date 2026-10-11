import { parseRoute, type Route } from './routing.js';
import { routeToPath, type ProjectRoute } from './routeRegistry.js';

export const branchTabs = ['workflow', 'executions', 'settings', 'chats', 'parameters', 'pinecone'] as const;
export type BranchTab = typeof branchTabs[number];
export type BranchGlobalView = 'general' | 'providers' | 'notifications' | 'activity' | 'profile' | 'usage' | 'status';
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
export function retainedBranchDrafts(current: BranchRoute, next: BranchRoute): { workflow: boolean; editor: boolean } {
  const workflow = Boolean(current.branchId && current.branchId === next.branchId);
  return { workflow, editor: workflow && !next.global };
}

/** Product navigation wraps the existing typed workspace routes, including focus IDs. */
export function parseBranchRoute(search: string): BranchRoute {
  const query = new URLSearchParams(search);
  const tab = query.get('tab');
  const executionId = query.get('execution') || undefined;
  const global = query.get('settings');
  const nested = query.get('workspace');
  const workspace: Route | undefined = nested?.startsWith('/projects/') ? parseRoute(nested) : undefined;
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
