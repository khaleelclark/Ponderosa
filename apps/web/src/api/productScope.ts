let standaloneScope: 'branches' | undefined;
let standaloneApiPrefix = '';
let standaloneWorkspaceOwner: { branchId: string; chatId: string } | undefined;
export function setStandaloneWorkspaceOwner(owner: typeof standaloneWorkspaceOwner): void { standaloneWorkspaceOwner = owner; }
export function setStandaloneProductScope(scope: 'branches' | undefined, apiPrefix = ''): void { standaloneScope = scope; standaloneApiPrefix = apiPrefix; }
export function currentProductScope(): 'branches' | 'dev' { return standaloneScope ?? (typeof window !== 'undefined' && isBranchesPath(window.location.pathname) ? 'branches' : 'dev'); }

export const isBranchesPath=(pathname:string):boolean=>/^\/branches(?:\/|$)/.test(pathname);

export function productApiPath(path:string):string {
  const routed = currentProductScope()==='branches' && path.startsWith('/api/') && !/^\/api\/branch(?:es|\-executions|\-gates)(?:\/|$)/.test(path) ? '/api/branches/engine/'+path.slice(5) : path;
  return routed.startsWith('/api/') ? standaloneApiPrefix + routed : routed;
}

/** Native file links keep their exact path/fragment within the current product. */
export function productWorkspacePath(path:string):string {
  if(typeof window==='undefined'||currentProductScope()!=='branches'||!path.startsWith('/projects/'))return path;
  const query=new URLSearchParams(isBranchesPath(window.location.pathname)?window.location.search:undefined);
  if(!isBranchesPath(window.location.pathname)&&standaloneWorkspaceOwner){
    query.set('branch',standaloneWorkspaceOwner.branchId);query.set('chat',standaloneWorkspaceOwner.chatId);
  }
  query.set('tab','chats');query.set('workspace',path);query.delete('settings');
  return `/branches?${query}`;
}

export const isOutputAppPath=(path:string):boolean=>path==='/assistant'||/^\/apps\/[^/]+\/?$/.test(path);
