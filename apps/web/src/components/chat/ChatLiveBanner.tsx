import { Alert } from "@mui/material";
import type { ReactNode } from "react";

export function ChatLiveBanner({ children }: { children?: ReactNode }): JSX.Element | null {
  if (!children) return null;
  return (
    <Alert
      severity="info"
      role="status"
      aria-live="polite"
      sx={{
        py: 0.25,
        mb: 1,
        width: "fit-content",
        maxWidth: "min(1180px, calc(100% - 24px))",
        mx: "auto",
        bgcolor: "transparent",
        boxShadow: "none",
        "& .MuiAlert-message": { py: 0.5, textAlign: "center" },
      }}
    >
      {children}
    </Alert>
  );
}
