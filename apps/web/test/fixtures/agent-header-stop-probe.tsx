import { AgentDetailHeader as Header } from "@qualification-real-agent-header";
// Test-only wrapper around the actual header, keeping the existing fixture
// unchanged. Inspecting status must never invoke the work-changing callback.
(window as any).stopRequests = 0;
export function AgentDetailHeader(props: any): JSX.Element {
  return <Header {...props} onStop={() => { (window as any).stopRequests++; props.onStop(); }} />;
}
