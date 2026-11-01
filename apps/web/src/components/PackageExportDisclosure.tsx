import {FULL_PACKAGE_EXPORT_WARNING} from '@ponderosa/core';
import {Alert} from '@mui/material';
import {ConfirmDialog} from './ConfirmationDialogs';

export const fullPackageExportWarning = FULL_PACKAGE_EXPORT_WARNING;

export function FullPackageExportDialog({name,pending,error,onCancel,onConfirm}:{name?:string;pending:boolean;error?:string;onCancel():void;onConfirm():Promise<void>}):JSX.Element {
 return <ConfirmDialog open={name!==undefined} title={`Export ${name??'workflow'}`} confirmLabel="Export full" pending={pending} error={error} onCancel={onCancel} onConfirm={onConfirm}>
  <Alert severity="warning">{fullPackageExportWarning}</Alert>
 </ConfirmDialog>;
}
