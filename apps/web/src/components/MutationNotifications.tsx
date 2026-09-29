import { Alert, Snackbar } from "@mui/material";
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
      if (matching < 0) return [...current, notice];
      const next = current.slice();
      next[matching] = notice;
      return next;
    });
  }, []);
  const value = useMemo(() => notify, [notify]);
  useEffect(() => {
    const announceDownload = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[download]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.dataset.ponderosaDownloadFeedback === "handled") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.protocol !== "blob:" && url.origin !== window.location.origin) return;
      notify({ message: "Download started", key: "first-party-download" });
    };
    document.addEventListener("click", announceDownload, true);
    return () => document.removeEventListener("click", announceDownload, true);
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
          if (reason !== "clickaway") dismiss();
        }}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {active ? (
          <Alert
            severity={active.severity}
            variant="filled"
            onClose={dismiss}
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
