import type { ImageAttachmentDto, OperatorProfileDto } from "@ponderosa/core";
import type { ReactNode } from "react";

type ChatAuthor =
  | { kind: "operator"; profile?: OperatorProfileDto }
  | { kind: "agent"; name: string; onOpen?(): void }
  | { kind: "notice"; name?: string };

interface ChatReplyReference {
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
  attachments?: ImageAttachmentDto[];
  attachmentDensity?: "comfortable" | "compact";
  afterBody?: ReactNode;
  belowBody?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  ariaLabel?: string;
  onSelect?(): void;
}
