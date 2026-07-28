import type { ImageAttachmentDto, OperatorProfileDto } from "@ponderosa/core";
import type { ReactNode } from "react";

type ChatAuthor =
  | { kind: "operator"; profile?: OperatorProfileDto }
  | { kind: "inbound_agent"; name: string; onOpen?(): void }
  | { kind: "agent"; name: string; onOpen?(): void }
  | { kind: "notice"; name?: string };

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
  /** Distance from the bottom that still counts as actively following.
   * Chat tolerates a small reading offset; dense audit surfaces can require a
   * nearly exact bottom position to avoid pulling the operator's viewport. */
  bottomThreshold?: number;
  /** Disable automatic repositioning for surfaces whose rows change height
   * while settling. Explicit layout-key updates still follow the latest item. */
  followResizes?: boolean;
  onPositionChange?(element: HTMLElement, atLatest: boolean): void;
}

export interface ChatMessagePresentation {
  id: string;
  author: ChatAuthor;
  createdAt: string;
  body: ReactNode;
  /** Quiet cross-surface context rendered beside the author and timestamp. */
  source?: ReactNode;
  attachments?: ImageAttachmentDto[];
  attachmentDensity?: "comfortable" | "compact";
  afterBody?: ReactNode;
  belowBody?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  ariaLabel?: string;
  onSelect?(): void;
  /** Called only while this exact message row intersects the visible page. */
  onVisible?(): void;
}
