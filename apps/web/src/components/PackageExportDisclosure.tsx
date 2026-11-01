import {FULL_PACKAGE_EXPORT_WARNING} from '@ponderosa/core';
import {Alert} from '@mui/material';
import type {ReactNode} from 'react';
import {ConfirmDialog} from './ConfirmationDialogs';

export const fullPackageExportWarning = FULL_PACKAGE_EXPORT_WARNING;

export function FullPackageExportDialog({name,pending,error,onCancel,onConfirm,children,confirmDisabled}:{name?:string;pending:boolean;error?:string;onCancel():void;onConfirm():Promise<void>;children?:ReactNode;confirmDisabled?:boolean}):JSX.Element {
 return <ConfirmDialog open={name!==undefined} title={`Export ${name??'workflow'}`} confirmLabel="Export full" confirmDisabled={confirmDisabled} pending={pending} error={error} onCancel={onCancel} onConfirm={onConfirm}>
  <Alert severity="warning">{fullPackageExportWarning}</Alert>
  {children}
 </ConfirmDialog>;
}
