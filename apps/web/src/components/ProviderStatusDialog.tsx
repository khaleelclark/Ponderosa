import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from "@mui/material";
import type { EngineDto, NetworkSecurityPostureDto } from "@ponderosa/core";
import { engineCanTestAccess, engineStatusPresentation } from "../conversationEngine";

export function ProviderStatusDialog({
  open,
  engines,
  networkSecurity,
  networkSecurityLoading = false,
  networkSecurityError,
  recheckingEngineId,
  error,
  onTestAccess,
  onOpenSettings,
  onClose,
}: {
  open: boolean;
  engines: EngineDto[];
  networkSecurity?: NetworkSecurityPostureDto;
  networkSecurityLoading?: boolean;
  networkSecurityError?: string;
  recheckingEngineId?: string;
  error?: string;
  onTestAccess(engine: EngineDto): void;
  onOpenSettings(): void;
  onClose(): void;
}): JSX.Element {
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
    <DialogTitle>AI provider status</DialogTitle>
    <DialogContent>
      <Stack spacing={1.5} sx={{ pt: 1 }}>
        <Box>
          <Typography variant="subtitle1" fontWeight={750}>Network access</Typography>
          {networkSecurity ? <Alert severity={networkSecurity.mode === "trusted_tailnet" ? "warning" : "success"} sx={{ mt: 1 }}>
            <Typography variant="body2" fontWeight={700}>
              {networkSecurity.mode === "trusted_tailnet" ? "Trusted Tailnet" : networkSecurity.mode === "authenticated" ? "Authenticated Listener" : "Loopback Only"}
            </Typography>
            <Typography variant="body2">{networkSecurity.detail} Bound to {networkSecurity.bindHost}.</Typography>
            {networkSecurity.warning ? <Typography variant="body2" fontWeight={700} sx={{ mt: 0.5 }}>{networkSecurity.warning}</Typography> : null}
          </Alert> : networkSecurityLoading
            ? <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Checking network security posture…</Typography>
            : <Alert severity="error" sx={{ mt: 1 }}>{networkSecurityError ?? "Network security posture is unavailable."}</Alert>}
        </Box>
        <Typography variant="body2" color="text.secondary">Ponderosa reports local configuration, sign-in, operator availability, and runtime access. It cannot see subscription quotas or provider-account billing.</Typography>
        {engines.map((engine) => {
          const status = engineStatusPresentation(engine);
          const disabled = engine.enabled === false;
          return <Box key={engine.id} sx={{ p: 1.5, border: 1, borderColor: "divider", borderRadius: 2 }}>
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
              <Typography variant="subtitle1" fontWeight={750} sx={{ flex: 1 }}>{engine.displayName}</Typography>
              <Chip size="small" label={disabled ? "Disabled" : "Enabled"} color={disabled ? "default" : "success"} variant="outlined" />
              <Chip size="small" label={engine.authentication === "authenticated" ? "Signed in" : engine.authentication === "checking" ? "Checking sign-in" : engine.authentication === "error" ? "Sign-in check failed" : "Sign-in needed"} color={engine.authentication === "authenticated" ? "success" : engine.authentication === "checking" ? "default" : "warning"} variant="outlined" />
              <Chip size="small" label={status.label} color={status.color} />
            </Stack>
            <Typography variant="body2" sx={{ mt: 1 }}>{disabled ? "Provider access is inactive while disabled by the operator." : engine.availabilityDetail ?? (engine.intakeReady ? "Provider intake is ready." : "Provider intake is unavailable.")}</Typography>
            {engine.authDetail ? <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>{engine.authDetail}</Typography> : null}
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>Default: {engine.models.find((model) => model.id === engine.defaultModel)?.label ?? engine.defaultModel ?? "provider default"}{engine.defaultEffort ? ` · ${engine.defaultEffort} effort` : ""}</Typography>
            {engineCanTestAccess(engine) ? <Button size="small" sx={{ mt: 1 }} disabled={Boolean(recheckingEngineId)} onClick={() => onTestAccess(engine)}>
              {recheckingEngineId === engine.id ? "Testing…" : "Test Access"}
            </Button> : null}
          </Box>;
        })}
        {error ? <Alert severity="error">{error}</Alert> : null}
      </Stack>
    </DialogContent>
    <DialogActions><Button onClick={onOpenSettings}>Provider Settings</Button><Button onClick={onClose}>Close</Button></DialogActions>
  </Dialog>;
}
