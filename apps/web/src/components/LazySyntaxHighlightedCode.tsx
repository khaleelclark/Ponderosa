import {
  Component,
  lazy,
  Suspense,
  useMemo,
  useState,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { SyntaxHighlightedCodeProps } from "./SyntaxHighlightedCode";

type SyntaxHighlighterModule = {
  default: ComponentType<SyntaxHighlightedCodeProps>;
};

export type SyntaxHighlighterLoad = () => Promise<SyntaxHighlighterModule>;

export interface SyntaxHighlightFallbackState {
  status: "pending" | "failed";
  retry(): void;
}

export interface LazySyntaxHighlightedCodeProps
  extends SyntaxHighlightedCodeProps {
  load?: SyntaxHighlighterLoad;
  renderFallback(state: SyntaxHighlightFallbackState): ReactNode;
}

const loadSyntaxHighlighter: SyntaxHighlighterLoad = () =>
  import("./SyntaxHighlightedCode");
const DefaultHighlighter = lazy(loadSyntaxHighlighter);

class SyntaxHighlightErrorBoundary extends Component<{
  children: ReactNode;
  fallback: ReactNode;
}, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The code-block fallback is the recovery surface. Chunk failures are
    // expected during offline or stale-deploy transitions and stay local.
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Keep the large syntax renderer out of the entry bundle while containing a
 * rejected chunk at one code block. Each retry constructs a fresh React.lazy
 * payload, so React does not replay its cached rejected promise.
 */
export function LazySyntaxHighlightedCode({
  load = loadSyntaxHighlighter,
  renderFallback,
  ...props
}: LazySyntaxHighlightedCodeProps): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const Highlighter = useMemo(
    () => attempt === 0 && load === loadSyntaxHighlighter ? DefaultHighlighter : lazy(load),
    [attempt, load],
  );
  const retry = (): void => setAttempt((current) => current + 1);

  return (
    <SyntaxHighlightErrorBoundary
      key={attempt}
      fallback={renderFallback({ status: "failed", retry })}
    >
      <Suspense fallback={renderFallback({ status: "pending", retry })}>
        <Highlighter {...props} />
      </Suspense>
    </SyntaxHighlightErrorBoundary>
  );
}
