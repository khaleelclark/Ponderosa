import {FULL_PACKAGE_EXPORT_WARNING,type WorkingFolderOmissions} from '@ponderosa/core';
import {Alert} from '@mui/material';
import type {ReactNode} from 'react';
import {ConfirmDialog} from './ConfirmationDialogs';

export const fullPackageExportWarning = FULL_PACKAGE_EXPORT_WARNING;

export function workingFolderOmissionNotice(omissions: WorkingFolderOmissions) {
 return {
  key: 'working-folder-export-omissions',
  severity: 'warning' as const,
  persistent: true,
  message: `${omissions.count} working-folder ${omissions.count===1?'path was':'paths were'} excluded from the package.`,
  details: [...omissions.paths, ...(omissions.count > omissions.paths.length ? ['See excludedPaths in the package for the full list.'] : [])].join('\n'),
 };
}

export function FullPackageExportDialog({name,pending,error,onCancel,onConfirm,children,confirmDisabled}:{name?:string;pending:boolean;error?:string;onCancel():void;onConfirm():Promise<void>;children?:ReactNode;confirmDisabled?:boolean}):JSX.Element {
 return <ConfirmDialog open={name!==undefined} title={`Export ${name??'Workflow'}`} confirmLabel="Export Full" confirmDisabled={confirmDisabled} pending={pending} error={error} onCancel={onCancel} onConfirm={onConfirm}>
  <Alert severity="warning">{fullPackageExportWarning}</Alert>
  {children}
 </ConfirmDialog>;
}
