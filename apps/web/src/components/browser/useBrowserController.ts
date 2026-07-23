import type { BrowserSession } from "./browserAdapters";
import type { BrowserControlTarget, BrowserEndpointAdapter, UnfencedBrowserInput } from "./browserAdapters";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { ApiRequestError } from "../../api/types";
import { mergeBrowserScrollInputs, type BrowserScrollInput } from "../../browserInteraction";

export function useBrowserController<Session extends BrowserSession>({
  adapter,
  enabled,
  onSession,
}: {
  adapter: BrowserEndpointAdapter<Session>;
  enabled: boolean;
  onSession?(session: Session): void;
}) {
  const queryClient = useQueryClient();
  const sessionRef = useRef<Session>();
  const inputBusy = useRef(false);
  const queuedScroll = useRef<BrowserScrollInput>();
  const refreshFrame = useRef<() => void>(() => undefined);

  const query = useQuery({
    queryKey: adapter.queryKey,
    queryFn: adapter.get,
    enabled,
    retry: false,
    refetchInterval: (current) => current.state.data?.status === "opening" ? 750 : 2_500,
  });
  const missing = query.error instanceof ApiRequestError && query.error.status === 404;
  const queryError = missing ? undefined : query.error;
  const session = missing || queryError ? undefined : query.data;
  sessionRef.current = session;
  const update = useCallback((next: Session) => {
    sessionRef.current = next;
    queryClient.setQueryData(adapter.queryKey, next);
    onSession?.(next);
  }, [adapter.queryKey, onSession, queryClient]);

  const open = useMutation({ mutationFn: (url?: string) => adapter.open!(url), onSuccess: update });
  const navigate = useMutation({ mutationFn: (url: string) => adapter.navigate!(url), onSuccess: update });
  const reconnect = useMutation({ mutationFn: adapter.reconnect, onSuccess: update });
  const close = useMutation({ mutationFn: adapter.close, onSuccess: update });
  const control = useMutation({
    mutationFn: (target: BrowserControlTarget) => {
      const session = sessionRef.current;
      if (!session) throw new Error("The browser session changed. Refresh and try again.");
      return adapter.setControl(target, session.controlEpoch);
    },
    onSuccess: update,
    onError: () => { void queryClient.invalidateQueries({ queryKey: adapter.queryKey }); },
  });
  const input = useMutation({
    mutationFn: (value: UnfencedBrowserInput) => {
      const session = sessionRef.current;
      if (!session || session.controlOwner !== "operator") {
        throw new Error("Browser control changed before the input was sent.");
      }
      return adapter.sendInput(value, session.controlEpoch);
    },
    onSuccess: (next) => {
      update(next);
      refreshFrame.current();
    },
    onError: () => { void queryClient.invalidateQueries({ queryKey: adapter.queryKey }); },
  });

  const sendInput = useCallback((value: UnfencedBrowserInput): void => {
    if (sessionRef.current?.controlOwner !== "operator") return;
    if (inputBusy.current) {
      if (value.kind === "scroll") queuedScroll.current = mergeBrowserScrollInputs(queuedScroll.current, value);
      return;
    }
    inputBusy.current = true;
    input.mutate(value, {
      onSettled: (_data, error) => {
        inputBusy.current = false;
        const next = queuedScroll.current;
        queuedScroll.current = undefined;
        if (!error && next) sendInput(next);
      },
    });
  }, [input]);

  useEffect(() => () => {
    queuedScroll.current = undefined;
    refreshFrame.current = () => undefined;
  }, [adapter]);

  return {
    query,
    session,
    missing,
    queryError,
    open,
    navigate,
    reconnect,
    close,
    control,
    input,
    sendInput,
    refreshFrame,
    error: open.error ?? navigate.error ?? reconnect.error ?? close.error ?? control.error ?? input.error,
    resetMutations() {
      open.reset();
      navigate.reset();
      reconnect.reset();
      close.reset();
      control.reset();
      input.reset();
    },
  };
}
