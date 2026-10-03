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
      <ProviderStatusDetails
        engines={engines}
        networkSecurity={networkSecurity}
        networkSecurityLoading={networkSecurityLoading}
        networkSecurityError={networkSecurityError}
        recheckingEngineId={recheckingEngineId}
        error={error}
        onTestAccess={onTestAccess}
      />
    </DialogContent>
    <DialogActions><Button onClick={onOpenSettings}>Provider Settings</Button><Button onClick={onClose}>Close</Button></DialogActions>
  </Dialog>;
}

export function ProviderStatusDetails({
  engines,
  networkSecurity,
  networkSecurityLoading = false,
  networkSecurityError,
  recheckingEngineId,
  error,
  onTestAccess,
}: {
  engines: EngineDto[];
  networkSecurity?: NetworkSecurityPostureDto;
  networkSecurityLoading?: boolean;
  networkSecurityError?: string;
  recheckingEngineId?: string;
  error?: string;
  onTestAccess(engine: EngineDto): void;
}): JSX.Element {
  return (
      <Stack spacing={1.5} sx={{ pt: 1 }}>
        <Box>
          <Typography variant="subtitle1" fontWeight={750}>Network access</Typography>
          {networkSecurity ? <Alert severity={networkSecurity.warning ? "warning" : "success"} sx={{ mt: 1 }}>
            <Typography variant="body2" fontWeight={700}>
              {networkSecurity.mode === "trusted_tailnet" ? "Trusted Tailnet" : networkSecurity.mode === "reverse_proxy" ? "Reverse Proxy" : networkSecurity.mode === "authenticated" ? "Authenticated Listener" : "Loopback Only"}
            </Typography>
            <Typography variant="body2">{networkSecurity.detail} Bound to {networkSecurity.bindHost}.</Typography>
            {networkSecurity.warning ? <Typography variant="body2" fontWeight={700} sx={{ mt: 0.5 }}>{networkSecurity.warning}</Typography> : null}
          </Alert> : networkSecurityLoading
            ? <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Checking network security posture…</Typography>
            : <Alert severity="error" sx={{ mt: 1 }}>{networkSecurityError ?? "Network security posture is unavailable."}</Alert>}
        </Box>
        <Typography variant="body2" color="text.secondary">Ponderosa reports local configuration, sign-in, and runtime access. Supported providers expose account limits in Provider usage; Provider Activity shows individual Run telemetry, not billing.</Typography>
        {engines.map((engine) => {
          const status = engineStatusPresentation(engine);
          const disabled = engine.enabled === false;
          const accessRejected = engine.authentication === "authenticated" && engine.reachability === "degraded" && engine.availabilityCategory === "authentication";
          return <Box key={engine.id} sx={{ p: 1.5, border: 1, borderColor: "divider", borderRadius: 2 }}>
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
              <Typography variant="subtitle1" fontWeight={750} sx={{ flex: 1 }}>{engine.displayName}</Typography>
              <Chip size="small" label={disabled ? "Disabled" : "Enabled"} color={disabled ? "default" : "success"} variant="outlined" />
              <Chip size="small" label={accessRejected ? "Access rejected" : engine.authentication === "authenticated" ? "Sign-in information found" : engine.authentication === "checking" ? "Checking sign-in" : engine.authentication === "error" ? "Sign-in check failed" : "Sign-in needed"} color={accessRejected ? "warning" : engine.authentication === "authenticated" ? "success" : engine.authentication === "checking" ? "default" : "warning"} variant="outlined" />
              <Chip size="small" label={status.label} color={status.color} />
            </Stack>
            <Typography variant="body2" sx={{ mt: 1 }}>{disabled ? "Provider access is inactive while disabled by the operator." : engine.availabilityDetail ?? (engine.intakeReady ? "Provider intake is ready." : "Provider intake is unavailable.")}</Typography>
            {accessRejected ? <Alert severity="warning" sx={{ mt: 1 }}>Sign-in information was found, but the provider rejected the access check. Sign in again or test access before sending new work.</Alert> : engine.authDetail ? <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>{engine.authDetail}</Typography> : null}
            {engine.authObservedAt ? <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Sign-in observed: {engine.authObservedAt}{engine.authSource ? ` · ${engine.authSource}` : ""}{engine.authReason ? ` · ${engine.authReason}` : ""}</Typography> : null}
            {engine.resourceAdmission ? <Box component="details" sx={{ mt: 1 }}>
              <Box component="summary" sx={{ cursor: "pointer" }}>{engine.resourceAdmission.state === "held" ? "Waiting for host resources" : engine.resourceAdmission.state === "disabled" ? "Host-resource protection disabled" : engine.resourceAdmission.protected ? "Host-resource protection active" : "Host-resource protection unavailable"}</Box>
              <Typography variant="caption">Accepted work stays queued; existing Runs are not cancelled. {engine.resourceAdmission.observedAt ? `Observed ${engine.resourceAdmission.observedAt}. ` : ""}{engine.resourceAdmission.availableBytes !== undefined ? `${Math.floor(engine.resourceAdmission.availableBytes / 1024 / 1024)} MiB available; ${Math.floor(engine.resourceAdmission.reserveBytes! / 1024 / 1024)} MiB reserved. ` : ""}{engine.resourceAdmission.reason}</Typography>
            </Box> : null}
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>Provider/host default: {engine.models.find((model) => model.id === engine.defaultModel)?.label ?? engine.defaultModel ?? "provider default"}{engine.defaultEffort ? ` · ${engine.defaultEffort} effort` : ""}</Typography>
            {engineCanTestAccess(engine) ? <Button size="small" sx={{ mt: 1 }} disabled={Boolean(recheckingEngineId)} onClick={() => onTestAccess(engine)}>
              {recheckingEngineId === engine.id ? "Testing…" : "Test Access"}
            </Button> : null}
          </Box>;
        })}
        {error ? <Alert severity="error">{error}</Alert> : null}
      </Stack>
  );
}
