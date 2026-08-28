import { Alert, Snackbar } from "@mui/material";
import {
  createContext,
  useCallback,
  useContext,
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
            sx={{ width: "100%", maxWidth: "min(92vw, 640px)" }}
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
