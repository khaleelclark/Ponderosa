import {ApiRequestError,ApiTransportError} from './api/types';

/** HTTP/transport evidence only; error prose is never availability authority. */
export function availabilityFailure(error: unknown): boolean {
  return error instanceof ApiTransportError || error instanceof ApiRequestError && error.status>=500&&error.status<=504;
}
export const errorDetail = (error: unknown): string => error instanceof Error ? error.message : String(error ?? '');
/** Authored UI summary; exact diagnostic text remains available through errorDetail. */
export function errorSummary(error:unknown, resource:string):string {
  if(error instanceof ApiRequestError){
    switch(error.status){
      case 401:return 'Sign-In Required';
      case 403:return 'Access Denied';
      case 404:return 'Resource Not Found';
      case 409:return 'Review Required';
      case 429:return 'Request Rate Limit Exceeded';
    }
    if(error.status>=500&&error.status<=504)return 'Service Unavailable';
  }
  return error instanceof ApiTransportError?'Connection Interrupted':`${resource} Unavailable`;
}
export const distinctDiagnostics = (values: readonly (string | undefined)[]): string[] => [...new Set(values.filter((value): value is string => Boolean(value)))];

export interface WorkspaceReadIssue {
  owner: string;
  resource: string;
  error?: unknown;
  hasData: boolean;
  active?: boolean;
  /** A successful, settled read, rather than an in-flight retry or unmount. */
  success: boolean;
  retrying?: boolean;
  retry(): unknown;
}
export const readIssueKey = (issue: Pick<WorkspaceReadIssue, 'owner' | 'resource'>): string => JSON.stringify([issue.owner, issue.resource]);
export function workspaceRead(owner:string,resource:string,query:{error:unknown;data:unknown;isSuccess:boolean;fetchStatus:string;isEnabled?:boolean;refetch(options?:{cancelRefetch?:boolean}):unknown},hasData=query.data!==undefined):WorkspaceReadIssue {
  return {owner,resource,error:query.error??undefined,hasData,active:query.isEnabled!==false,success:query.isSuccess&&query.fetchStatus==='idle',retrying:query.fetchStatus==='fetching',retry:()=>query.refetch({cancelRefetch:false})};
}

export const readDismissalKey = (read:WorkspaceReadIssue):string => JSON.stringify([readIssueKey(read),availabilityFailure(read.error)?"availability":read.error instanceof ApiRequestError?read.error.status:"other"]);
