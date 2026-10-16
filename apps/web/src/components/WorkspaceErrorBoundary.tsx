import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface WorkspaceErrorBoundaryProps {
  children: ReactNode;
  title?: string;
  resetKey?: string;
  onReset?(): void;
}

interface WorkspaceErrorBoundaryState {
  error?: Error;
}

/** Contains a failed workspace surface without taking down global navigation. */
export class WorkspaceErrorBoundary extends Component<WorkspaceErrorBoundaryProps, WorkspaceErrorBoundaryState> {
  override state: WorkspaceErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): WorkspaceErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Workspace surface failed", error, info.componentStack);
  }

  override componentDidUpdate(previous: Readonly<WorkspaceErrorBoundaryProps>): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: undefined });
    }
  }

  private reset = (): void => {
    this.setState({ error: undefined });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <Box role="alert" sx={{ minHeight: 0, overflow: "auto", p: { xs: 2, md: 3 } }}>
      <Alert severity="error" icon={<ErrorOutlineIcon />}>
        <Stack spacing={1}>
          <Typography fontWeight={800}>{this.props.title ?? "This workspace view could not be displayed."}</Typography>
          <Typography variant="body2">Ponderosa navigation remains available while you retry this workspace view.</Typography>
          <Button color="inherit" variant="outlined" size="small" onClick={this.reset} sx={{ alignSelf: "flex-start" }}>Try Again</Button>
        </Stack>
      </Alert>
    </Box>;
  }
}
