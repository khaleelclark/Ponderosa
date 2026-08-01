import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import { Box, Tooltip, Typography } from "@mui/material";

const DIRECT_SCOPE_EXPLANATION =
  "Visible in your Project timeline, but excluded from future organizational context.";

export function DirectMessageScope({
  agents,
}: {
  agents: Array<{ id: string; title: string }>;
}): JSX.Element | null {
  if (!agents.length) return null;
  const names = agents.map((agent) => agent.title);
  const audience = names.length > 2
    ? `${names.slice(0, 2).join(", ")} +${names.length - 2}`
    : names.join(", ");
  const label = `Direct · You ↔ ${audience}`;

  return (
    <Tooltip title={DIRECT_SCOPE_EXPLANATION} describeChild>
      <Box
        component="span"
        tabIndex={0}
        aria-label={`${label}. ${DIRECT_SCOPE_EXPLANATION}`}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.4,
          minWidth: 0,
          maxWidth: { xs: 150, sm: 260 },
          color: "text.secondary",
          borderRadius: 0.75,
          outlineOffset: 2,
        }}
      >
        <GroupsOutlinedIcon
          aria-hidden
          sx={{ flex: "0 0 auto", fontSize: 14 }}
        />
        <Typography
          component="span"
          variant="caption"
          sx={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 11.5,
            fontWeight: 600,
            lineHeight: 1.35,
          }}
        >
          {label}
        </Typography>
      </Box>
    </Tooltip>
  );
}

export { DIRECT_SCOPE_EXPLANATION };
