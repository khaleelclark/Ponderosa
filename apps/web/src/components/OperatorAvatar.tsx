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

function operatorAvatarUrl(avatarId: string | undefined): string | undefined {
  return avatarId?.startsWith("uploaded:")
    ? `/api/workspace/profile-images/${encodeURIComponent(avatarId)}`
    : undefined;
}

export function OperatorAvatar({ profile, size = 36, compactOnMobile = false, fallback }: {
  profile?: OperatorProfileDto;
  size?: number;
  compactOnMobile?: boolean;
  fallback?: string;
}): JSX.Element {
  const name = profile?.displayName ?? "Operator";
  return <Avatar
    aria-label={`${name} avatar`}
    src={operatorAvatarUrl(profile?.avatarId)}
    imgProps={{ alt: "", referrerPolicy: "no-referrer" }}
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
