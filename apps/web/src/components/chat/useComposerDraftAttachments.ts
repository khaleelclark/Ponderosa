import type { AssetLimitsDto, DraftAttachmentDto } from "@ponderosa/core";
import {
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
} from "react";
import { api } from "../../api";
import type { DraftUploadStatus } from "./ComposerAttachment";
import {
  selectComposerFiles,
  type ComposerAttachmentAction,
} from "./composerUtils";

interface RestoredDraftAttachment {
  attachment: DraftAttachmentDto;
  file: File;
}

interface ComposerDraftAttachments {
  addFiles(candidates: File[]): void;
  attachmentIds: MutableRefObject<Map<File, string>>;
  attachmentVersion: number;
  clear(): void;
  removeFile(index: number): void;
  replaceRestored(restored: RestoredDraftAttachment[]): void;
  retryUpload(file: File): void;
  uploadStates: Map<
    File,
    { status: DraftUploadStatus; error?: string }
  >;
}

/**
 * Owns the attachment upload queue and its File-to-durable-ID mapping. Composer
 * owns message text; this hook owns the independent draft attachment lifecycle.
 */
export function useComposerDraftAttachments({
  assetLimits,
  conversationDraftId,
  dispatch,
  draftOwnerId,
  files,
}: {
  assetLimits?: AssetLimitsDto;
  conversationDraftId?: string;
  dispatch: Dispatch<ComposerAttachmentAction>;
  draftOwnerId: string;
  files: File[];
}): ComposerDraftAttachments {
  const attachmentIds = useRef(new Map<File, string>());
  const [uploadStates, setUploadStates] = useState<
    Map<File, { status: DraftUploadStatus; error?: string }>
  >(() => new Map());
  const pendingUploads = useRef<File[]>([]);
  const activeUploads = useRef(0);
  const generation = useRef(0);
  const pumpUploads = useRef<() => void>(() => undefined);
  const [attachmentVersion, setAttachmentVersion] = useState(0);

  pumpUploads.current = () => {
    if (!conversationDraftId) return;
    while (activeUploads.current < 4 && pendingUploads.current.length > 0) {
      const file = pendingUploads.current.shift()!;
      const state = uploadStates.get(file);
      if (state?.status === "complete" || attachmentIds.current.has(file)) {
        continue;
      }
      activeUploads.current += 1;
      const uploadGeneration = generation.current;
      setUploadStates(current =>
        new Map(current).set(file, { status: "uploading" }),
      );
      void api
        .uploadDraftAttachment(conversationDraftId, draftOwnerId, file)
        .then(attachment => {
          if (uploadGeneration !== generation.current) return;
          attachmentIds.current.set(file, attachment.id);
          setUploadStates(current =>
            new Map(current).set(file, { status: "complete" }),
          );
          setAttachmentVersion(value => value + 1);
        })
        .catch((error: unknown) => {
          if (uploadGeneration !== generation.current) return;
          setUploadStates(current =>
            new Map(current).set(file, {
              status: "failed",
              error: error instanceof Error ? error.message : "Upload failed.",
            }),
          );
        })
        .finally(() => {
          if (uploadGeneration !== generation.current) return;
          activeUploads.current -= 1;
          pumpUploads.current();
        });
    }
  };

  const queueUploads = (candidates: File[]) => {
    if (!conversationDraftId || candidates.length === 0) return;
    setUploadStates(current => {
      const next = new Map(current);
      for (const file of candidates) next.set(file, { status: "queued" });
      return next;
    });
    pendingUploads.current.push(...candidates);
    window.queueMicrotask(() => pumpUploads.current());
  };

  const addFiles = (candidates: File[]) => {
    const selection = selectComposerFiles(files, candidates, assetLimits);
    dispatch({ type: "add", candidates, limits: assetLimits });
    queueUploads(selection.accepted);
  };

  const retryUpload = (file: File) => {
    if (!conversationDraftId || attachmentIds.current.has(file)) return;
    setUploadStates(current =>
      new Map(current).set(file, { status: "queued" }),
    );
    pendingUploads.current.push(file);
    pumpUploads.current();
  };

  const removeFile = (index: number) => {
    const file = files[index];
    if (!file) return;
    const id = attachmentIds.current.get(file);
    attachmentIds.current.delete(file);
    pendingUploads.current = pendingUploads.current.filter(
      candidate => candidate !== file,
    );
    setUploadStates(current => {
      const next = new Map(current);
      next.delete(file);
      return next;
    });
    dispatch({ type: "remove", index });
    setAttachmentVersion(value => value + 1);
    if (conversationDraftId && id) {
      void api
        .deleteDraftAttachment(conversationDraftId, draftOwnerId, id)
        .catch(() => undefined);
    }
  };

  const clear = () => {
    generation.current += 1;
    attachmentIds.current.clear();
    pendingUploads.current = [];
    activeUploads.current = 0;
    setUploadStates(new Map());
    dispatch({ type: "clear" });
    setAttachmentVersion(value => value + 1);
  };

  const replaceRestored = (restored: RestoredDraftAttachment[]) => {
    generation.current += 1;
    pendingUploads.current = [];
    activeUploads.current = 0;
    attachmentIds.current = new Map(
      restored.map(({ attachment, file }) => [file, attachment.id]),
    );
    setUploadStates(
      new Map(
        restored.map(({ file }) => [
          file,
          { status: "complete" as const },
        ]),
      ),
    );
    dispatch({
      type: "replace",
      files: restored.map(({ file }) => file),
    });
    setAttachmentVersion(value => value + 1);
  };

  return {
    addFiles,
    attachmentIds,
    attachmentVersion,
    clear,
    removeFile,
    replaceRestored,
    retryUpload,
    uploadStates,
  };
}
