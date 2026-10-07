export function productApiPath(path:string):string {
  if(typeof window !== 'undefined' && window.location.pathname.startsWith('/branches') && path.startsWith('/api/') && !/^\/api\/branch(?:es|\-executions|\-gates)(?:\/|$)/.test(path)) return '/api/branches/engine/'+path.slice(5);
  return path;
}
