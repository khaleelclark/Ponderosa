import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  type DialogProps,
} from "@mui/material";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

interface FormDialogShellProps {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  pending?: boolean;
  error?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  confirmColor?: "primary" | "error";
  confirmDisabled?: boolean;
  cancelLabel?: string;
  maxWidth?: DialogProps["maxWidth"];
  onCancel(): void;
  onConfirm(): void;
}

function FormDialogShell({
  open,
  title,
  children,
  pending = false,
  error,
  confirmLabel,
  pendingLabel,
  confirmColor = "primary",
  confirmDisabled = false,
  cancelLabel = "Cancel",
  maxWidth = "xs",
  onCancel,
  onConfirm,
}: FormDialogShellProps): JSX.Element {
  const close = (): void => {
    if (!pending) onCancel();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      fullWidth
      maxWidth={maxWidth}
      aria-busy={pending || undefined}
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {children}
        {error ? <Alert severity="error" role="alert" sx={{ mt: 2 }}>{error}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={pending}>{cancelLabel}</Button>
        <Button
          autoFocus
          color={confirmColor}
          variant="contained"
          disabled={pending || confirmDisabled}
          onClick={onConfirm}
        >
          {pending ? pendingLabel ?? `${confirmLabel.replace(/\s+$/, "")}…` : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  confirmLabel?: string;
  pendingLabel?: string;
  pending?: boolean;
  error?: ReactNode;
  confirmDisabled?: boolean;
  onCancel(): void;
  onConfirm(): void;
}

export function ConfirmDialog({
  confirmLabel = "Continue",
  ...props
}: ConfirmDialogProps): JSX.Element {
  return <FormDialogShell {...props} confirmLabel={confirmLabel} />;
}

export function DestructiveConfirmDialog({
  confirmLabel = "Delete",
  ...props
}: ConfirmDialogProps): JSX.Element {
  return (
    <FormDialogShell
      {...props}
      confirmLabel={confirmLabel}
      confirmColor="error"
    />
  );
}

export interface ResourceDeletionDialogProps
  extends Omit<ConfirmDialogProps, "title"> {
  resourceType: string;
  resourceName?: string;
  title?: ReactNode;
}

/**
 * Shared destructive-action language for workspace resources. Callers provide
 * the resource-specific consequences while the title, confirmation action,
 * pending state, and error treatment remain consistent.
 */
export function ResourceDeletionDialog({
  resourceType,
  resourceName,
  title,
  confirmLabel,
  ...props
}: ResourceDeletionDialogProps): JSX.Element {
  return (
    <DestructiveConfirmDialog
      {...props}
      title={
        title ??
        `Delete ${resourceType}${resourceName ? ` “${resourceName}”` : ""}?`
      }
      confirmLabel={confirmLabel ?? `Delete ${resourceType}`}
    />
  );
}

export interface TextInputDialogProps extends Omit<ConfirmDialogProps, "children" | "onConfirm"> {
  label: string;
  initialValue?: string;
  helperText?: ReactNode;
  validate?(value: string): string | undefined;
  onConfirm(value: string): void;
}

export function TextInputDialog({
  open,
  label,
  initialValue = "",
  helperText,
  validate,
  onConfirm,
  ...props
}: TextInputDialogProps): JSX.Element {
  const [value, setValue] = useState(initialValue);
  const wasOpen = useRef(open);
  const validationError = validate?.(value);

  useEffect(() => {
    if (open && !wasOpen.current) setValue(initialValue);
    wasOpen.current = open;
  }, [initialValue, open]);

  return (
    <ConfirmDialog
      {...props}
      open={open}
      confirmDisabled={Boolean(validationError)}
      onConfirm={() => onConfirm(value)}
    >
      <TextField
        autoFocus
        fullWidth
        label={label}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        error={Boolean(validationError)}
        helperText={validationError ?? helperText}
        sx={{ mt: 1 }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !props.pending && !validationError) {
            event.preventDefault();
            onConfirm(value);
          }
        }}
      />
    </ConfirmDialog>
  );
}
