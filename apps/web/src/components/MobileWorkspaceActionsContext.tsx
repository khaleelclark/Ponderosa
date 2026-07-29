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

const EMPTY_SUBSCRIBE = () => () => undefined;
const EMPTY_SNAPSHOT = () => undefined;

function createMobileWorkspaceActionsRegistry(): MobileWorkspaceActionsRegistry {
  let current: MobileWorkspaceActionsRegistration | undefined;
  let snapshot: MobileWorkspaceActions | undefined;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  const updateSnapshot = (next: MobileWorkspaceActions | undefined) => {
    if (Object.is(snapshot, next)) return;
    snapshot = next;
    emit();
  };
  return {
    register(registration) {
      current = registration;
      updateSnapshot(registration.getActions());
      return () => {
        if (current !== registration) return;
        current = undefined;
        updateSnapshot(undefined);
      };
    },
    notify(registration) {
      if (current === registration) {
        updateSnapshot(registration.getActions());
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
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
    registry?.subscribe ?? EMPTY_SUBSCRIBE,
    registry?.getSnapshot ?? EMPTY_SNAPSHOT,
    registry?.getSnapshot ?? EMPTY_SNAPSHOT,
  );
}
