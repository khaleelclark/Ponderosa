import { Alert, Box, Button, LinearProgress, Snackbar } from "@mui/material";
import { prepareDownload, type DownloadProgress } from "../downloads";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type MutationNoticeSeverity = "success" | "error" | "warning" | "info";

export interface MutationNoticeInput {
  message: string;
  severity?: MutationNoticeSeverity;
  /** Stable operation key used to replace/coalesce repeated feedback. */
  key?: string;
  /** Errors and durable background outcomes stay visible until dismissed. */
  persistent?: boolean;
  progress?: DownloadProgress;
  onCancel?(): void;
}

interface MutationNotice extends MutationNoticeInput {
  id: number;
  severity: MutationNoticeSeverity;
}

type MutationNotifier = (notice: MutationNoticeInput | string) => void;

const MutationNotificationContext = createContext<MutationNotifier | undefined>(undefined);

export function MutationNotificationProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const nextId = useRef(1);
  const [notices, setNotices] = useState<MutationNotice[]>([]);
  const active = notices[0];
  const notify = useCallback<MutationNotifier>((input) => {
    const normalized = typeof input === "string" ? { message: input } : input;
    const severity = normalized.severity ?? "success";
    const key = normalized.key ?? `${severity}:${normalized.message}`;
    setNotices((current) => {
      const notice: MutationNotice = {
        ...normalized,
        key,
        severity,
        id: nextId.current++,
      };
      const matching = current.findIndex((candidate) => candidate.key === key);
      if (matching < 0) return normalized.progress ? [notice, ...current] : [...current, notice];
      const next = current.slice();
      next[matching] = normalized.progress ? { ...notice, id: current[matching]!.id } : notice;
      if (normalized.progress && matching > 0) return [next[matching]!, ...next.filter((_, index) => index !== matching)];
      return next;
    });
  }, []);
  const value = useMemo(() => notify, [notify]);
  useEffect(() => {
    const pending = new Map<string, { controller: AbortController; report(message?: string): void }>();
    let mounted = true;
    const announceDownload = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[download]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.dataset.ponderosaDownloadFeedback === "handled") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.protocol !== "blob:" && url.origin !== window.location.origin) return;
      if (url.protocol !== "blob:" && url.pathname.startsWith("/api/")) {
        event.preventDefault();
        const existing = pending.values().next().value;
        if (existing) { existing.report(pending.has(url.href) ? "This download is already being prepared." : "Finish or cancel the current download before starting another."); return; }
        const controller = new AbortController();
        let progress: DownloadProgress = { receivedBytes: 0 };
        let lastReportedAt = 0;
        let progressTimer: ReturnType<typeof setTimeout> | undefined;
        const report = (message = "Preparing download…") => {
          if (!mounted) return;
          const received = (progress.receivedBytes / 1024 / 1024).toFixed(1);
          const total = progress.totalBytes ? ` of ${(progress.totalBytes / 1024 / 1024).toFixed(1)}` : "";
          notify({ message: `${message} ${received}${total} MiB received.`, severity: "info", persistent: true,
            key: "first-party-download", progress, onCancel: () => controller.abort(new DOMException("Download cancelled.", "AbortError")) });
          lastReportedAt = Date.now();
        };
        let idleTimer: ReturnType<typeof setTimeout>;
        const resetIdle = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => controller.abort(new Error("No download data arrived for 60 seconds. Check your connection and try again.")), 60_000);
        };
        // Slow but progressing transfers keep their slot; stalled transfers
        // stop after one minute, with a finite 15-minute overall ceiling.
        const deadline = setTimeout(() => controller.abort(new Error("The download took longer than 15 minutes. Check your connection and try again.")), 15 * 60_000);
        pending.set(url.href, { controller, report });
        resetIdle();
        report();
        void prepareDownload(url.href, anchor.download, controller.signal, next => {
          const changedTotal = progress.totalBytes !== next.totalBytes;
          progress = next;
          resetIdle();
          if (changedTotal || Date.now() - lastReportedAt >= 250 || next.receivedBytes === next.totalBytes) {
            clearTimeout(progressTimer); progressTimer = undefined; report();
          } else progressTimer ??= setTimeout(() => { progressTimer = undefined; report(); }, 250);
        })
          .then(() => { if (mounted) notify({ message: "Download started", key: "first-party-download" }); })
          .catch((error: unknown) => {
            if (!mounted) return;
            // Some browsers reject body reads with a generic AbortError even
            // when the controller's reason was a timeout rather than Cancel.
            const failure = controller.signal.aborted ? controller.signal.reason : error;
            const cancelled = failure instanceof DOMException && failure.name === "AbortError";
            notify({ message: cancelled ? "Download cancelled" : failure instanceof TypeError ? "The download connection was interrupted. Check your connection and try again." : failure instanceof Error ? failure.message : "Download could not start. Try again.", severity: cancelled ? "info" : "error", key: "first-party-download" });
          })
          .finally(() => { clearTimeout(idleTimer); clearTimeout(deadline); clearTimeout(progressTimer); pending.delete(url.href); });
        return;
      }
      notify({ message: "Download started", key: "first-party-download" });
    };
    document.addEventListener("click", announceDownload, true);
    return () => { mounted = false; document.removeEventListener("click", announceDownload, true); for (const download of pending.values()) download.controller.abort(); };
  }, [notify]);
  const dismiss = () => setNotices((current) => current.slice(1));

  return (
    <MutationNotificationContext.Provider value={value}>
      {children}
      <Snackbar
        key={active?.id}
        open={Boolean(active)}
        autoHideDuration={active?.persistent || active?.severity === "error" ? null : 3_000}
        onClose={(_event, reason) => {
          if (reason !== "clickaway" && !active?.progress) dismiss();
        }}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {active ? (
          <Alert
            severity={active.severity}
            variant="filled"
            onClose={active.progress ? undefined : dismiss}
            action={active.onCancel ? <Button color="inherit" size="small" onClick={active.onCancel}>Cancel download</Button> : undefined}
            sx={{
              width: "auto",
              minWidth: "min(88vw, 260px)",
              maxWidth: "min(92vw, 480px)",
              px: 1.25,
              py: 0.25,
              display: "grid",
              gridTemplateColumns: "auto minmax(0, 1fr) auto",
              alignItems: "center",
              "& .MuiAlert-icon": { m: 0, mr: 1, p: 0, alignItems: "center" },
              "& .MuiAlert-message": {
                minWidth: 0,
                py: 0.5,
                textAlign: "center",
              },
              "& .MuiAlert-action": { m: 0, ml: 1, p: 0, alignItems: "center" },
            }}
          >
            {active.message}
            {active.progress ? <Box sx={{ mt: 0.75 }}><LinearProgress aria-label="Download preparation progress"
              variant={active.progress.totalBytes ? "determinate" : "indeterminate"}
              value={active.progress.totalBytes ? Math.min(100, 100 * active.progress.receivedBytes / active.progress.totalBytes) : undefined}
              color="inherit" /></Box> : null}
          </Alert>
        ) : undefined}
      </Snackbar>
    </MutationNotificationContext.Provider>
  );
}

export function useMutationNotification(): MutationNotifier {
  const context = useContext(MutationNotificationContext);
  if (!context) {
    throw new Error("useMutationNotification must be used within MutationNotificationProvider");
  }
  return context;
}
