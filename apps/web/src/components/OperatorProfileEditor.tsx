import PhotoCameraOutlinedIcon from "@mui/icons-material/PhotoCameraOutlined";
import {
  Alert,
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { WorkspacePreferencesDto } from "@ponderosa/core";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useUnsavedForm } from "../reloadSafety";
import { OperatorAvatar } from "./OperatorAvatar";

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif";
const AVATARS = [
  ["default-user", "Pine"],
  ["sunset", "Sunset"],
  ["river", "River"],
  ["mountain", "Mountain"],
  ["fox", "Fox"],
  ["owl", "Owl"],
] as const;

export interface OperatorProfileForm {
  name: string;
  handle: string;
  avatarId: string;
  busy: boolean;
  error?: string;
  valid: boolean;
  dirty: boolean;
  saving: boolean;
  profile: WorkspacePreferencesDto["profile"];
  setName(value: string): void;
  setHandle(value: string): void;
  setAvatarId(value: string): void;
  beginSave(): void;
  finishSave(submitted: WorkspacePreferencesDto["profile"], succeeded: boolean): void;
  upload(file: File): void;
}

export function useOperatorProfileForm(
  profile: WorkspacePreferencesDto["profile"],
  resetWhen?: boolean,
): OperatorProfileForm {
  const [name, setNameState] = useState(profile.displayName);
  const [handle, setHandleState] = useState(profile.handle);
  const [avatarId, setAvatarIdState] = useState(profile.avatarId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const canonicalProfile = useRef(profile);
  canonicalProfile.current = profile;
  const currentDraft = useRef(profile);
  const saveBase = useRef(profile);
  const [savePending, setSavePending] = useState(false);
  const editedSinceSync = useRef(false);
  const normalizedHandle = handle.replace(/^#/, "").toLowerCase();
  const draft = { displayName: name.trim(), handle: normalizedHandle, avatarId };
  currentDraft.current = draft;
  const sameProfile = (left: WorkspacePreferencesDto["profile"], right: WorkspacePreferencesDto["profile"]) =>
    left.displayName === right.displayName && left.handle === right.handle && left.avatarId === right.avatarId;
  const dirty = !sameProfile(draft, profile);
  useUnsavedForm("operator-profile", dirty || busy || savePending);

  useEffect(() => {
    if (!resetWhen && (savePending || (editedSinceSync.current && !sameProfile(currentDraft.current, profile)))) return;
    if (sameProfile(currentDraft.current, profile)) editedSinceSync.current = false;
    else if (resetWhen) editedSinceSync.current = false;
    setNameState(profile.displayName);
    setHandleState(profile.handle);
    setAvatarIdState(profile.avatarId);
    setError(undefined);
  }, [profile, resetWhen, savePending]);

  const valid = Boolean(name.trim())
    && /^[a-z][a-z0-9_-]{1,31}$/.test(normalizedHandle)
    && !["broadcast", "everyone", "user"].includes(normalizedHandle);
  const updateDraft = (next: WorkspacePreferencesDto["profile"], update: () => void) => {
    currentDraft.current = next;
    editedSinceSync.current = savePending || !sameProfile(next, canonicalProfile.current);
    update();
  };
  const setName = (value: string) => updateDraft({ ...currentDraft.current, displayName: value.trim() }, () => setNameState(value));
  const setHandle = (value: string) => updateDraft({ ...currentDraft.current, handle: value.replace(/^#/, "").toLowerCase() }, () => setHandleState(value));
  const setAvatarId = (value: string) => updateDraft({ ...currentDraft.current, avatarId: value }, () => setAvatarIdState(value));

  return {
    name,
    handle: normalizedHandle,
    avatarId,
    busy,
    error,
    valid,
    dirty,
    saving: savePending,
    profile: draft,
    setName,
    setHandle,
    setAvatarId,
    beginSave: () => {
      saveBase.current = canonicalProfile.current;
      setSavePending(true);
      editedSinceSync.current = true;
    },
    finishSave: (submitted, succeeded) => {
      setSavePending(false);
      editedSinceSync.current = succeeded
        ? !sameProfile(currentDraft.current, submitted)
        : !sameProfile(currentDraft.current, saveBase.current);
    },
    upload: file => {
      if (file.size > IMAGE_MAX_BYTES) {
        setError("Picture must be 10 MiB or smaller.");
        return;
      }
      setBusy(true);
      setError(undefined);
      void api.uploadOperatorAvatar(file)
        .then(uploaded => setAvatarId(uploaded.avatarId))
        .catch(reason => setError(reason instanceof Error ? reason.message : "Picture upload failed."))
        .finally(() => setBusy(false));
    },
  };
}

export function OperatorProfileEditor({
  form,
  avatarSize,
  nameLabel,
  handleHelperText,
  pictureLabelId,
  avatarFirst = false,
  nameAutoFocus = false,
  showDescription = false,
  showUploadHelp = false,
}: {
  form: OperatorProfileForm;
  avatarSize: number;
  nameLabel: string;
  handleHelperText: string;
  pictureLabelId: string;
  avatarFirst?: boolean;
  nameAutoFocus?: boolean;
  showDescription?: boolean;
  showUploadHelp?: boolean;
}): JSX.Element {
  const avatar = <Stack direction="row" spacing={avatarSize > 60 ? 2 : 1.5} sx={{ alignItems: "center" }}>
    <OperatorAvatar profile={{ displayName: form.name || "User", handle: form.handle || "operator", avatarId: form.avatarId }} size={avatarSize} />
    <Button component="label" variant="outlined" startIcon={<PhotoCameraOutlinedIcon />} disabled={form.busy}>
      {form.busy ? "Uploading…" : "Upload Picture"}
      <input hidden type="file" accept={IMAGE_ACCEPT} onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) form.upload(file);
      }} />
    </Button>
  </Stack>;
  const fields = <>
    <TextField autoFocus={nameAutoFocus} label={nameLabel} value={form.name} onChange={(event) => form.setName(event.target.value)} error={!form.name.trim()} helperText={!form.name.trim() ? "Enter a display name." : undefined} inputProps={{ maxLength: 80 }} />
    <TextField label="Handle" value={form.handle} onChange={(event) => form.setHandle(event.target.value)}
      error={!/^[a-z][a-z0-9_-]{1,31}$/u.test(form.handle) || ["broadcast", "everyone", "user"].includes(form.handle)}
      helperText={["broadcast", "everyone", "user"].includes(form.handle) ? "This handle is reserved. Choose another."
        : !/^[a-z][a-z0-9_-]{1,31}$/u.test(form.handle) ? "Use 2–32 characters, starting with a letter: lowercase letters, numbers, underscores, or hyphens."
        : handleHelperText} inputProps={{ maxLength: 32 }} />
  </>;
  return <Stack spacing={avatarSize > 60 ? 2.25 : 2}>
    {showDescription ? <Typography variant="body2" color="text.secondary">Your name and picture across Ponderosa.</Typography> : null}
    {avatarFirst ? avatar : fields}
    {avatarFirst ? fields : avatar}
    <FormControl fullWidth>
      <InputLabel id={pictureLabelId}>Generated Picture</InputLabel>
      <Select labelId={pictureLabelId} label="Generated Picture" value={form.avatarId} onChange={(event) => form.setAvatarId(event.target.value)}>
        {form.avatarId.startsWith("uploaded:") ? <MenuItem value={form.avatarId}>Uploaded Picture</MenuItem> : null}
        {AVATARS.map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
      </Select>
    </FormControl>
    {showUploadHelp ? <Typography variant="caption" color="text.secondary">PNG, JPEG, WebP, GIF or AVIF · up to 10 MiB</Typography> : null}
    {form.error ? <Alert severity="error">{form.error}</Alert> : null}
  </Stack>;
}
