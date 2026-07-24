import { Avatar } from "@mui/material";
import type { OperatorProfileDto } from "@ponderosa/core";

const GENERATED_AVATAR_GLYPHS: Record<string, string> = {
  "default-user": "🌲",
  sunset: "🌅",
  river: "🌊",
  mountain: "⛰️",
  fox: "🦊",
  owl: "🦉",
};

export function operatorAvatarUrl(avatarId: string | undefined): string | undefined {
  return avatarId?.startsWith("uploaded:")
    ? `/api/workspace/profile-images/${encodeURIComponent(avatarId)}`
    : undefined;
}

export function operatorInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "U";
  const initials = words.length === 1
    ? words[0]!.slice(0, 2)
    : `${words[0]![0] ?? ""}${words.at(-1)?.[0] ?? ""}`;
  return initials.toLocaleUpperCase();
}

export function OperatorAvatar({ profile, size = 36, compactOnMobile = false, fallback }: {
  profile?: OperatorProfileDto;
  size?: number;
  compactOnMobile?: boolean;
  fallback?: string;
}): JSX.Element {
  const name = profile?.displayName ?? "User";
  return <Avatar
    aria-label={`${name} avatar`}
    src={operatorAvatarUrl(profile?.avatarId)}
    imgProps={{ referrerPolicy: "no-referrer" }}
    sx={{
      width: compactOnMobile ? { xs: 32, sm: size } : size,
      height: compactOnMobile ? { xs: 32, sm: size } : size,
      flex: "0 0 auto",
      bgcolor: (theme) => theme.palette.mode === "dark" ? "#25302F" : "#F0F1EC",
      color: "text.primary",
      fontSize: compactOnMobile ? { xs: 13, sm: size <= 36 ? 15 : 16 } : size <= 36 ? 15 : 16,
      fontWeight: 750,
    }}
  >{GENERATED_AVATAR_GLYPHS[profile?.avatarId ?? "default-user"] ?? fallback ?? "●"}</Avatar>;
}
