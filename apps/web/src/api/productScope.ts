let standaloneScope: 'branches' | undefined;

/** A standalone product entry chooses its API namespace before mounting React.
 * The server still owns authorization and resource isolation. */
export function setStandaloneProductScope(scope: 'branches' | undefined): void {
  standaloneScope = scope;
}

export function productApiPath(path:string):string {
  if((standaloneScope === 'branches' || typeof window !== 'undefined' && window.location.pathname.startsWith('/branches')) && path.startsWith('/api/') && !/^\/api\/branch(?:es|\-executions|\-gates)(?:\/|$)/.test(path)) return '/api/branches/engine/'+path.slice(5);
  return path;
}
