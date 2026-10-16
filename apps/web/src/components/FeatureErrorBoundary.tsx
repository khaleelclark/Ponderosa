import { Alert, Box, Button } from "@mui/material";
import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps an optional workspace feature from taking down navigation or chat when
 * a browser frame, document renderer, or third-party embed throws while
 * rendering.
 */
export class FeatureErrorBoundary extends Component<{
  children: ReactNode;
  feature: string;
}, { error?: Error }> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.feature} failed`, error, info);
  }

  override componentDidUpdate(previous: Readonly<{ children: ReactNode; feature: string }>): void {
    if (previous.feature !== this.props.feature && this.state.error) this.setState({ error: undefined });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <Box sx={{ p: 1.5 }}>
      <Alert
        severity="error"
        action={<Button color="inherit" onClick={() => this.setState({ error: undefined })}>Try Again</Button>}
      >
        {this.props.feature} could not be displayed. The rest of the workspace is still available.
      </Alert>
    </Box>;
  }
}
