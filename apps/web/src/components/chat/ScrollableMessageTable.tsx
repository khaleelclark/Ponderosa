import type { ComponentPropsWithoutRef } from "react";

export function ScrollableMessageTable({node: _node, ...props}: ComponentPropsWithoutRef<"table"> & {node?: unknown}): JSX.Element {
  return <div style={{minWidth: 0, maxWidth: "100%"}}>
    <div role="region" tabIndex={0} aria-label="Scrollable message table" style={{maxWidth: "100%", overflowX: "auto", overscrollBehaviorX: "contain"}}>
      <table {...props} />
    </div>
  </div>;
}
