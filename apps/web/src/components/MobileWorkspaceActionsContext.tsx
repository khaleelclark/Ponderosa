import {
  createContext,
  useContext,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";

export interface MobileWorkspaceAction {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  onSelect(anchor: HTMLElement): void;
}

export interface MobileWorkspaceActions {
  label: string;
  details?: MobileWorkspaceAction;
  actions: MobileWorkspaceAction[];
  copy?: MobileWorkspaceAction;
  download?: MobileWorkspaceAction;
}

interface MobileWorkspaceActionsRegistration {
  owner: symbol;
  getActions(): MobileWorkspaceActions;
}

export type MobileWorkspaceActionsRegistry =
  MutableRefObject<MobileWorkspaceActionsRegistration | undefined>;

const MobileWorkspaceActionsContext =
  createContext<MobileWorkspaceActionsRegistry | null>(null);

export function MobileWorkspaceActionsProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const registry = useRef<MobileWorkspaceActionsRegistration>();
  return (
    <MobileWorkspaceActionsContext.Provider value={registry}>
      {children}
    </MobileWorkspaceActionsContext.Provider>
  );
}

export function useMobileWorkspaceActionsRegistry():
  | MobileWorkspaceActionsRegistry
  | null {
  return useContext(MobileWorkspaceActionsContext);
}
