import PhotoCameraOutlinedIcon from "@mui/icons-material/PhotoCameraOutlined";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { WorkspacePreferencesDto } from "@ponderosa/core";
import { useEffect, useState } from "react";
import { api } from "../api";
import { OperatorAvatar } from "./OperatorAvatar";

export const OPERATOR_PROFILE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const OPERATOR_PROFILE_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif";

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
  const [name, setName] = useState(profile.displayName);
  const [handle, setHandle] = useState(profile.handle);
  const [avatarId, setAvatarId] = useState(profile.avatarId);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setName(profile.displayName);
    setHandle(profile.handle);
    setAvatarId(profile.avatarId);
    setUploadError(undefined);
  }, [open, profile]);

  const valid = Boolean(name.trim())
    && /^[a-z][a-z0-9_-]{1,31}$/.test(handle)
    && !["broadcast", "everyone", "user"].includes(handle);

  return (
    <Dialog
      open={open}
      onClose={uploadBusy ? undefined : onClose}
      fullWidth
      maxWidth="xs"
      aria-busy={uploadBusy || undefined}
    >
      <DialogTitle>Operator Profile</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">This synced identity controls how Agents address you and how your profile appears throughout Ponderosa.</Typography>
          <TextField autoFocus label="What Agents call you" value={name} onChange={(event) => setName(event.target.value)} inputProps={{ maxLength: 80 }} />
          <TextField label="Handle" value={handle} onChange={(event) => setHandle(event.target.value.replace(/^#/, "").toLowerCase())} helperText="Used as your stable #handle." inputProps={{ maxLength: 32 }} />
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
            <OperatorAvatar profile={{ displayName: name || "User", handle: handle || "operator", avatarId }} size={56} />
            <Button component="label" variant="outlined" startIcon={<PhotoCameraOutlinedIcon />} disabled={uploadBusy}>
              {uploadBusy ? "Uploading…" : "Upload Picture"}
              <input hidden type="file" accept={OPERATOR_PROFILE_IMAGE_ACCEPT} onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                if (file.size > OPERATOR_PROFILE_IMAGE_MAX_BYTES) {
                  setUploadError("Picture must be 10 MiB or smaller.");
                  return;
                }
                setUploadBusy(true);
                setUploadError(undefined);
                void api.uploadOperatorAvatar(file)
                  .then((uploaded) => setAvatarId(uploaded.avatarId))
                  .catch((reason) => setUploadError(reason instanceof Error ? reason.message : "Picture upload failed."))
                  .finally(() => setUploadBusy(false));
              }} />
            </Button>
          </Stack>
          <FormControl fullWidth>
            <InputLabel id="operator-profile-avatar-label">Generated Picture</InputLabel>
            <Select labelId="operator-profile-avatar-label" label="Generated Picture" value={avatarId} onChange={(event) => setAvatarId(event.target.value)}>
              {avatarId.startsWith("uploaded:") ? <MenuItem value={avatarId}>Uploaded Picture</MenuItem> : null}
              <MenuItem value="default-user">Pine</MenuItem>
              <MenuItem value="sunset">Sunset</MenuItem>
              <MenuItem value="river">River</MenuItem>
              <MenuItem value="mountain">Mountain</MenuItem>
              <MenuItem value="fox">Fox</MenuItem>
              <MenuItem value="owl">Owl</MenuItem>
            </Select>
          </FormControl>
          <Typography variant="caption" color="text.secondary">PNG, JPEG, WebP, GIF, or AVIF up to 10 MiB. HEIC is not accepted because current browsers cannot render it reliably. Uploaded pictures are stored in Ponderosa-managed workspace data.</Typography>
          {uploadError ? <Alert severity="error">{uploadError}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={uploadBusy} onClick={onClose}>Cancel</Button>
        <Button
          autoFocus
          variant="contained"
          disabled={uploadBusy || !valid}
          onClick={() => {
            onSave({ displayName: name.trim(), handle, avatarId });
            onClose();
          }}
        >
          Save Profile
        </Button>
      </DialogActions>
    </Dialog>
  );
}
