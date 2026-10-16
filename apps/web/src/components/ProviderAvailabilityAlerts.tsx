import { Box, Button, Popover, Stack, Typography } from "@mui/material";
import { useId, useState } from "react";
import type { EngineDto } from "@ponderosa/core";
import { engineCanTestAccess, engineIsAvailable, engineStatusPresentation } from "../conversationEngine";
import { providerAvailabilityDiagnostic, providerAvailabilityMessage } from "../providerAvailability";

/** Selected-provider diagnostics stay beside runtime controls, on demand. */
export function ProviderAvailabilityStatus({ engine, testPending = false, onTestAccess, showProviderName = false }: {
  engine: EngineDto;
  testPending?: boolean;
  showProviderName?: boolean;
  onTestAccess?(engine: EngineDto): void;
}): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const id = useId();
  const status = engineStatusPresentation(engine);
  const diagnostic = providerAvailabilityDiagnostic(engine.availabilityDetail ?? engine.authDetail, engine.availabilityCategory);
  const detail = engineIsAvailable(engine) ? `${engine.displayName} can accept new work.` : providerAvailabilityMessage(engine);
  return <>
    <Button size="small" color="inherit" aria-haspopup="dialog" aria-expanded={Boolean(anchor)}
      aria-controls={anchor ? id : undefined} aria-label={`${engine.displayName} provider status: ${status.label}`}
      onClick={event => setAnchor(event.currentTarget)}
      sx={{ color: status.color === "warning" ? "warning.main" : "text.secondary", whiteSpace: "nowrap", minHeight: { xs: 44, sm: 32 }, "@media (pointer: coarse)": { minHeight: 44 } }}>
      {showProviderName ? `${engine.displayName} · ${status.label}` : status.label}
    </Button>
    <Popover open={Boolean(anchor)} anchorEl={anchor} onClose={() => setAnchor(null)}
      anchorOrigin={{ vertical: "top", horizontal: "right" }} transformOrigin={{ vertical: "bottom", horizontal: "right" }}>
      <Box id={id} role="dialog" aria-label={`${engine.displayName} provider details`} sx={{ p: 2, width: 340, maxWidth: "calc(100vw - 24px)", overflowWrap: "anywhere" }}>
        <Typography variant="subtitle2">{engine.displayName} · {status.label}</Typography>
        <Typography variant="body2" sx={{ mt: 1 }}>{detail}</Typography>
        {diagnostic ? <Typography variant="caption" component="p" sx={{ mt: 1 }}>{diagnostic}</Typography> : null}
        <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 1 }}>
          <Button size="small" onClick={() => setAnchor(null)}>Close</Button>
          {onTestAccess && engineCanTestAccess(engine) ? <Button size="small" disabled={testPending}
            onClick={() => onTestAccess(engine)}>{testPending ? "Checking…" : "Test Access"}</Button> : null}
        </Stack>
      </Box>
    </Popover>
  </>;
}

export function ProviderAvailabilityAlerts({ engines, testPending, onTestAccess }: {
  engines: EngineDto[];
  testPending: boolean;
  onTestAccess(engine: EngineDto): void;
}): JSX.Element | null {
  const unavailable = engines.filter(engine => engine.enabled !== false && !engineIsAvailable(engine));
  return unavailable.length ? <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" aria-label="Provider availability">
    {unavailable.map(engine => <ProviderAvailabilityStatus key={engine.id} engine={engine} showProviderName testPending={testPending} onTestAccess={onTestAccess} />)}
  </Stack> : null;
}
