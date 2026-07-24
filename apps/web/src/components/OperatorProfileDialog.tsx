import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from "@mui/material";
import type { WorkspacePreferencesDto } from "@ponderosa/core";
import { OperatorProfileEditor, useOperatorProfileForm } from "./OperatorProfileEditor";

export function OperatorProfileDialog({
  open,
  profile,
  onClose,
  onSave,
}: {
  open: boolean;
  profile: WorkspacePreferencesDto["profile"];
  onClose(): void;
  onSave(profile: WorkspacePreferencesDto["profile"]): void;
}): JSX.Element {
  const form = useOperatorProfileForm(profile, open);

  return (
    <Dialog
      open={open}
      onClose={form.busy ? undefined : onClose}
      fullWidth
      maxWidth="xs"
      aria-busy={form.busy || undefined}
    >
      <DialogTitle>Operator Profile</DialogTitle>
      <DialogContent>
        <Box sx={{ pt: 1 }}>
          <OperatorProfileEditor
            form={form}
            avatarSize={56}
            nameLabel="What Agents call you"
            handleHelperText="Used as your stable #handle."
            pictureLabelId="operator-profile-avatar-label"
            nameAutoFocus
            showDescription
            showUploadHelp
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button disabled={form.busy} onClick={onClose}>Cancel</Button>
        <Button
          autoFocus
          variant="contained"
          disabled={form.busy || !form.valid}
          onClick={() => {
            onSave(form.profile);
            onClose();
          }}
        >
          Save Profile
        </Button>
      </DialogActions>
    </Dialog>
  );
}
