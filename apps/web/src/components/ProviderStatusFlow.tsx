import { Typography } from "@mui/material";
import type { EngineDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { ConfirmDialog } from "./ConfirmationDialogs";
import { ProviderStatusDialog } from "./ProviderStatusDialog";

export function ProviderStatusFlow({
  open,
  engines,
  networkSecurity,
  networkSecurityLoading,
  networkSecurityError,
  onOpenSettings,
  onClose,
}: {
  open: boolean;
  engines: EngineDto[];
  networkSecurity?: Parameters<typeof ProviderStatusDialog>[0]["networkSecurity"];
  networkSecurityLoading: boolean;
  networkSecurityError?: string;
  onOpenSettings(): void;
  onClose(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [engineToTest, setEngineToTest] = useState<EngineDto>();
  const recheck = useMutation({
    mutationFn: (engineId: string) => api.recheckEngine(engineId),
    onSuccess: (updated) => {
      queryClient.setQueryData<EngineDto[]>(queryKeys.engines.all, (current) =>
        current?.map((candidate) => candidate.id === updated.id ? updated : candidate));
      void queryClient.invalidateQueries({ queryKey: queryKeys.engines.all });
      setEngineToTest(undefined);
    },
  });

  return (
    <>
      <ProviderStatusDialog
        open={open}
        engines={engines}
        networkSecurity={networkSecurity}
        networkSecurityLoading={networkSecurityLoading}
        networkSecurityError={networkSecurityError}
        recheckingEngineId={recheck.isPending ? recheck.variables : undefined}
        error={recheck.isError ? String(recheck.error) : undefined}
        onTestAccess={setEngineToTest}
        onOpenSettings={onOpenSettings}
        onClose={onClose}
      />
      <ConfirmDialog
        open={Boolean(engineToTest)}
        title={`Test ${engineToTest?.displayName ?? "provider"} access?`}
        confirmLabel="Test Access"
        pendingLabel="Testing…"
        pending={recheck.isPending}
        error={recheck.isError ? String(recheck.error) : undefined}
        onCancel={() => {
          recheck.reset();
          setEngineToTest(undefined);
        }}
        onConfirm={() => {
          if (engineToTest) recheck.mutate(engineToTest.id);
        }}
      >
        <Typography sx={{ pt: 1 }}>This sends one minimal subscription-backed request.</Typography>
      </ConfirmDialog>
    </>
  );
}
