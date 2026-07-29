import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
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

export interface MobileWorkspaceActionsRegistration {
  getActions(): MobileWorkspaceActions;
}

export interface MobileWorkspaceActionsRegistry {
  register(registration: MobileWorkspaceActionsRegistration): () => void;
  notify(registration: MobileWorkspaceActionsRegistration): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): MobileWorkspaceActions | undefined;
}

const MobileWorkspaceActionsContext =
  createContext<MobileWorkspaceActionsRegistry | null>(null);

function createMobileWorkspaceActionsRegistry(): MobileWorkspaceActionsRegistry {
  let current: MobileWorkspaceActionsRegistration | undefined;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  return {
    register(registration) {
      current = registration;
      emit();
      return () => {
        if (current !== registration) return;
        current = undefined;
        emit();
      };
    },
    notify(registration) {
      if (current === registration) emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return current?.getActions();
    },
  };
}

export function MobileWorkspaceActionsProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [registry] = useState(createMobileWorkspaceActionsRegistry);
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

export function useMobileWorkspaceActions():
  | MobileWorkspaceActions
  | undefined {
  const registry = useMobileWorkspaceActionsRegistry();
  return useSyncExternalStore(
    registry?.subscribe ?? (() => () => undefined),
    registry?.getSnapshot ?? (() => undefined),
    registry?.getSnapshot ?? (() => undefined),
  );
}
