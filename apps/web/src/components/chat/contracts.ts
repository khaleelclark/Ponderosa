import type { OperatorProfileDto } from "@ponderosa/core";
import type { ReactNode } from "react";

export type ChatAuthor =
  | { kind: "operator"; profile?: OperatorProfileDto }
  | { kind: "agent"; name: string; onOpen?(): void }
  | { kind: "notice"; name?: string };

export interface ChatReplyReference {
  text: string;
  onOpen(): void;
}

export interface ChatHistoryPage {
  kind: "cursor";
  hasEarlier: boolean;
  loading: boolean;
  label?: string;
  onLoadEarlier(): void;
}

export interface ChatFollowLatest {
  kind: "latest";
  storageKey?: string;
  onPositionChange?(element: HTMLElement, atLatest: boolean): void;
}

export interface ChatMessagePresentation {
  id: string;
  author: ChatAuthor;
  createdAt: string;
  body: ReactNode;
  reply?: ChatReplyReference;
  afterBody?: ReactNode;
  belowBody?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  ariaLabel?: string;
  onSelect?(): void;
}
