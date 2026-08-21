import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { Alert, Box, Button, LinearProgress, Stack, Typography } from "@mui/material";
import {
  Component,
  createElement,
  lazy,
  Suspense,
  useMemo,
  useState,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";

export type LazyRouteLoad<Props extends object> = () => Promise<{
  default: ComponentType<Props>;
}>;

type RenderableLazyRoute = ComponentType<Record<string, unknown>>;

/*
 * Route loaders are module-level functions. Cache the React.lazy wrapper by
 * loader so returning to an already downloaded route family does not create a
 * new payload and briefly reveal the Suspense fallback.
 */
const lazyRouteCache = new WeakMap<
  LazyRouteLoad<object>,
  RenderableLazyRoute
>();

function loadWithTimeout<Props extends object>(
  load: LazyRouteLoad<Props>,
  timeoutMs: number,
): ReturnType<LazyRouteLoad<Props>> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Workspace route loader timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
    load().then(
      module => {
        window.clearTimeout(timeout);
        resolve(module);
      },
      error => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function createLazyRoute<Props extends object>(
  load: LazyRouteLoad<Props>,
  timeoutMs: number,
): RenderableLazyRoute {
  return lazy(() => loadWithTimeout(load, timeoutMs)) as unknown as RenderableLazyRoute;
}

function getLazyRoute<Props extends object>(
  load: LazyRouteLoad<Props>,
  timeoutMs: number,
): RenderableLazyRoute {
  const cacheKey = load as unknown as LazyRouteLoad<object>;
  const cached = lazyRouteCache.get(cacheKey);
  if (cached) return cached;

  const route = createLazyRoute(load, timeoutMs);
  lazyRouteCache.set(cacheKey, route);
  return route;
}

function replaceLazyRoute<Props extends object>(
  load: LazyRouteLoad<Props>,
  timeoutMs: number,
): RenderableLazyRoute {
  const route = createLazyRoute(load, timeoutMs);
  lazyRouteCache.set(load as unknown as LazyRouteLoad<object>, route);
  return route;
}

class LazyRouteErrorBoundary extends Component<{
  attempt: number;
  maxRetries: number;
  children: ReactNode;
  onRetry(): void;
  onReload(): void;
  diagnostic: string;
}, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Workspace route chunk failed", {
      route: this.props.diagnostic,
      error,
      componentStack: info.componentStack,
    });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const canRetry = this.props.attempt < this.props.maxRetries;
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="error" icon={<ErrorOutlineIcon />}>
          <Stack spacing={1}>
            <Typography fontWeight={800}>This view could not be loaded.</Typography>
            <Typography variant="body2">
              {canRetry
                ? "The downloaded view may be stale or temporarily unavailable."
                : "The view still could not load. Reload Ponderosa to request a fresh application shell."}
            </Typography>
            <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
              {this.props.diagnostic}
            </Typography>
            <Button
              color="inherit"
              variant="outlined"
              size="small"
              onClick={canRetry ? this.props.onRetry : this.props.onReload}
              sx={{ alignSelf: "flex-start" }}
            >
              {canRetry ? "Try Again" : "Reload Ponderosa"}
            </Button>
          </Stack>
        </Alert>
      </Box>
    );
  }
}

function RouteLoading(): JSX.Element {
  return (
    <Stack role="status" aria-live="polite" spacing={1} sx={{ p: 3 }}>
      <LinearProgress />
      <Typography color="text.secondary">Loading view…</Typography>
    </Stack>
  );
}

/**
 * React.lazy retains a rejected thenable. One explicit in-app retry creates a
 * fresh lazy payload; a second rejection offers a user-triggered page reload.
 * Nothing reloads automatically, so a stale deployment cannot form a loop.
 */
export function RecoverableLazyRoute<Props extends object>({
  load,
  componentProps,
  maxRetries = 1,
  reload = () => window.location.reload(),
  timeoutMs = 15_000,
}: {
  load: LazyRouteLoad<Props>;
  componentProps: Props;
  maxRetries?: number;
  reload?(): void;
  timeoutMs?: number;
}): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const diagnostic = [
    window.location.pathname,
    window.location.search,
    " / ",
    load.name || "anonymous route loader",
  ].join("");
  const RenderableComponent = useMemo(
    () => attempt === 0
      ? getLazyRoute(load, timeoutMs)
      : replaceLazyRoute(load, timeoutMs),
    [attempt, load, timeoutMs],
  );
  return (
    <LazyRouteErrorBoundary
      key={attempt}
      attempt={attempt}
      maxRetries={maxRetries}
      onRetry={() => setAttempt(current => Math.min(current + 1, maxRetries))}
      onReload={reload}
      diagnostic={diagnostic}
    >
      <Suspense fallback={<RouteLoading />}>
        <Box
          sx={{ display: "contents" }}
        >
          {createElement(RenderableComponent, componentProps as Record<string, unknown>)}
        </Box>
      </Suspense>
    </LazyRouteErrorBoundary>
  );
}
