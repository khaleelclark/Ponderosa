import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import type { EngineDto } from "@ponderosa/core";
import { engineCanTestAccess, engineIsAvailable } from "../conversationEngine";
import {
  providerAvailabilityDiagnostic,
  providerAvailabilityMessage,
} from "../providerAvailability";

export function ProviderAvailabilityAlerts({
  engines,
  testPending,
  onTestAccess,
}: {
  engines: EngineDto[];
  testPending: boolean;
  onTestAccess(engine: EngineDto): void;
}): JSX.Element | null {
  const unavailable = engines.filter((engine) => engine.enabled !== false && !engineIsAvailable(engine));
  if (!unavailable.length) return null;

  return <Stack spacing={1} aria-label="Provider availability">
    {unavailable.map((engine) => {
      const diagnostic = providerAvailabilityDiagnostic(
        engine.availabilityDetail ?? engine.authDetail,
        engine.availabilityCategory,
      );
      const canTest = engineCanTestAccess(engine);
      return <Alert
        key={engine.id}
        severity="warning"
        data-provider-id={engine.id}
        action={canTest ? <Button
          color="inherit"
          size="small"
          disabled={testPending}
          aria-label={`Test ${engine.displayName} access`}
          onClick={() => onTestAccess(engine)}
        >Test Access</Button> : undefined}
        sx={{
          minWidth: 0,
          alignItems: "flex-start",
          "& .MuiAlert-message": { minWidth: 0, width: "100%" },
          "& .MuiAlert-action": { flexShrink: 0, ml: 1, mr: 0, pl: 0 },
        }}
      >
        <Typography variant="body2">{providerAvailabilityMessage(engine)}</Typography>
        {diagnostic ? <Box component="details" sx={{ mt: 0.5, maxWidth: "100%" }}>
          <Typography
            component="summary"
            variant="caption"
            sx={{ cursor: "pointer", width: "fit-content" }}
          >Diagnostic detail</Typography>
          <Typography
            data-testid={`provider-diagnostic-${engine.id}`}
            component="p"
            variant="caption"
            color="text.secondary"
            sx={{
              mb: 0,
              mt: 0.5,
              maxHeight: "4.5em",
              overflow: "auto",
              overflowWrap: "anywhere",
            }}
          >{diagnostic}</Typography>
        </Box> : null}
      </Alert>;
    })}
  </Stack>;
}
