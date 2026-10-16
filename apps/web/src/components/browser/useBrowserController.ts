import type { BrowserSession } from "./browserAdapters";
import type { BrowserControlTarget, BrowserEndpointAdapter, UnfencedBrowserInput } from "./browserAdapters";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError } from "../../api/types";
import { createBrowserInputQueue } from "../../browserInputQueue";
import { coalesceBrowserScrollInputs } from "../../browserInteraction";

export function useBrowserController<Session extends BrowserSession>({
  adapter,
  enabled,
  pollingEnabled = true,
  onSession,
}: {
  adapter: BrowserEndpointAdapter<Session>;
  enabled: boolean;
  pollingEnabled?: boolean;
  onSession?(session: Session): void;
}) {
  const queryClient = useQueryClient();
  const sessionRef = useRef<Session>();
  const [inputError, setInputError] = useState<Error>();
  const [inputPending, setInputPending] = useState(false);
  const [followAgent, setFollowAgent] = useState(true);
  const [selectedPageId, setSelectedPageId] = useState<string>();
  const inputBusy = useRef(false);
  const refreshFrame = useRef<() => void>(() => undefined);

  const query = useQuery({
    queryKey: adapter.queryKey,
    queryFn: adapter.get,
    enabled,
    retry: false,
    refetchInterval: (current) => (pollingEnabled || (enabled && followAgent && current.state.data?.controlOwner === "agent" && document.visibilityState === "visible"))
      ? current.state.data?.status === "opening" ? 750 : 2_500
      : false,
  });
  const missing = query.error instanceof ApiRequestError && query.error.status === 404;
  const queryError = missing ? undefined : query.error;
  const candidate = missing || queryError ? undefined : query.data;
  const session = candidate && sessionRef.current?.id === candidate.id && sessionRef.current.controlEpoch > candidate.controlEpoch
    ? sessionRef.current : candidate;
  sessionRef.current = session;
  const viewedPageId = session?.controlOwner === "operator" || followAgent || !session?.pages.some(page => page.id === selectedPageId)
    ? session?.activePageId : selectedPageId;
  const update = useCallback((next: Session) => {
    if (sessionRef.current?.id === next.id && sessionRef.current.controlEpoch > next.controlEpoch) return;
    sessionRef.current = next;
    queryClient.setQueryData(adapter.queryKey, next);
    onSession?.(next);
  }, [adapter.queryKey, onSession, queryClient]);

  const open = useMutation({ mutationFn: (url?: string) => adapter.open!(url), onSuccess: update });
  const navigate = useMutation({ mutationFn: (url: string) => {
    if (inputBusy.current) throw new Error("Wait for pending browser input before navigating.");
    return adapter.navigate!(url);
  }, onSuccess: update });
  const reconnect = useMutation({ mutationFn: adapter.reconnect, onSuccess: update });
  const close = useMutation({ mutationFn: adapter.close, onSuccess: update });
  const activatePage = useMutation({
    mutationFn: (pageId: string) => {
      if (inputBusy.current) throw new Error("Wait for pending browser input before switching tabs.");
      const session = sessionRef.current;
      if (!session) throw new Error("The browser session changed. Refresh and try again.");
      return adapter.activatePage(pageId, session.controlEpoch);
    },
    onSuccess: (next) => { update(next); refreshFrame.current(); },
    onError: () => { void queryClient.invalidateQueries({ queryKey: adapter.queryKey }); },
  });
  const closePage = useMutation({
    mutationFn: (pageId: string) => {
      if (inputBusy.current) throw new Error("Wait for pending browser input before closing a tab.");
      const session = sessionRef.current;
      if (!session) throw new Error("The browser session changed. Refresh and try again.");
      return adapter.closePage(pageId, session.controlEpoch);
    },
    onSuccess: (next) => { update(next); refreshFrame.current(); },
    onError: () => { void queryClient.invalidateQueries({ queryKey: adapter.queryKey }); },
  });
  const newPage = useMutation({ mutationFn: () => {
    if (inputBusy.current || !sessionRef.current || !adapter.newPage) throw new Error("Wait for browser input to finish before opening a tab.");
    return adapter.newPage(sessionRef.current.controlEpoch);
  }, onSuccess: next => { update(next); refreshFrame.current(); } });
  const upload = useMutation({
    mutationFn: ({ artifactId, selector }: { artifactId: string; selector?: string }) => {
      const session = sessionRef.current;
      if (!session || session.controlOwner !== "operator") {
        throw new Error("Browser control changed before the upload was sent.");
      }
      return adapter.upload(artifactId, selector, session.controlEpoch);
    },
    onSuccess: (response) => {
      update(response.session);
      refreshFrame.current();
    },
    onError: () => { void queryClient.invalidateQueries({ queryKey: adapter.queryKey }); },
  });
  const cancelFileChooser = useMutation({
    mutationFn: () => {
      const session = sessionRef.current;
      if (!session || session.controlOwner !== "operator") {
        throw new Error("Browser control changed before the file chooser was cancelled.");
      }
      return adapter.cancelFileChooser(session.controlEpoch);
    },
    onSuccess: update,
    onError: () => { void queryClient.invalidateQueries({ queryKey: adapter.queryKey }); },
  });
  const control = useMutation({
    mutationFn: (target: BrowserControlTarget) => {
      const session = sessionRef.current;
      if (!session) throw new Error("The browser session changed. Refresh and try again.");
      return adapter.setControl(target, session.controlEpoch);
    },
    onSuccess: update,
    onError: () => { void queryClient.invalidateQueries({ queryKey: adapter.queryKey }); },
  });

  const updateRef = useRef(update);
  updateRef.current = update;
  const inputQueue = useMemo(() => createBrowserInputQueue<UnfencedBrowserInput>({
    context: () => {
      const current = sessionRef.current;
      return current?.status === "ready" && current.controlOwner === "operator"
        ? JSON.stringify([current.id, current.controlEpoch, current.activePageId]) : undefined;
    },
    dispatch: async (value, context) => {
      const [, epoch, pageId] = JSON.parse(context) as [string, number, string];
      const next = await adapter.sendInput({ ...value, expectedPageId: value.expectedPageId ?? pageId }, epoch);
      updateRef.current(next);
      refreshFrame.current();
    },
    onError: setInputError,
    onBusy: busy => { inputBusy.current = busy; setInputPending(busy); },
    coalesce: (pending, next) => {
      if (pending.kind !== "scroll" || next.kind !== "scroll") return undefined;
      return coalesceBrowserScrollInputs(pending, next);
    },
  }), [adapter]);
  const sendInput = useCallback((value: UnfencedBrowserInput) => inputQueue.enqueue(value), [inputQueue]);

  useEffect(() => {
    inputQueue.activate();
    return () => {
      inputQueue.dispose();
      refreshFrame.current = () => undefined;
    };
  }, [inputQueue]);

  return {
    query,
    session,
    missing,
    queryError,
    open,
    navigate,
    reconnect,
    close,
    activatePage,
    closePage,
    newPage,
    viewedPageId,
    followAgent,
    setFollowAgent,
    viewPage(pageId: string) {
      if (session?.controlOwner === "operator") activatePage.mutate(pageId);
      else { setSelectedPageId(pageId); setFollowAgent(false); }
    },
    upload,
    cancelFileChooser,
    control,
    sendInput,
    refreshFrame,
    inputError,
    inputPending,
    resumeInput() { inputQueue.reset(); setInputError(undefined); },
    error: open.error ?? navigate.error ?? reconnect.error ?? close.error ?? activatePage.error ?? closePage.error ?? newPage.error ?? upload.error ?? cancelFileChooser.error ?? control.error,
    resetMutations() {
      open.reset();
      navigate.reset();
      reconnect.reset();
      close.reset();
      activatePage.reset();
      closePage.reset();
      upload.reset();
      cancelFileChooser.reset();
      control.reset();
    },
  };
}
