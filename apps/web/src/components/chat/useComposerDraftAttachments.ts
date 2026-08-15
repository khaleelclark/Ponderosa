import type { AssetLimitsDto, DraftAttachmentDto } from "@ponderosa/core";
import {
  useCallback,
  useEffect,
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
  locallyRemovedIds: MutableRefObject<Set<string>>;
  mergeRestored(restored: RestoredDraftAttachment[]): void;
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
  onEdit,
  onBeforeClear,
}: {
  assetLimits?: AssetLimitsDto;
  conversationDraftId?: string;
  dispatch: Dispatch<ComposerAttachmentAction>;
  draftOwnerId: string;
  files: File[];
  onEdit(removedAttachmentId?: string): void;
  onBeforeClear(): void;
}): ComposerDraftAttachments {
  const attachmentIds = useRef(new Map<File, string>());
  const locallyRemovedIds = useRef(new Set<string>());
  const locallyRemovedFiles = useRef(new WeakSet<File>());
  const [uploadStates, setUploadStates] = useState<
    Map<File, { status: DraftUploadStatus; error?: string }>
  >(() => new Map());
  const pendingUploads = useRef<File[]>([]);
  const activeUploads = useRef(0);
  const generation = useRef(0);
  const pumpUploads = useRef<() => void>(() => undefined);
  const mounted = useRef(true);
  const [attachmentVersion, setAttachmentVersion] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      pendingUploads.current = [];
      activeUploads.current = 0;
    };
  }, []);

  pumpUploads.current = () => {
    if (!mounted.current || !conversationDraftId) return;
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
          if (
            !mounted.current ||
            uploadGeneration !== generation.current ||
            locallyRemovedFiles.current.has(file)
          ) {
            void api
              .deleteDraftAttachment(
                conversationDraftId,
                draftOwnerId,
                attachment.id,
              )
              .catch(() => undefined);
            return;
          }
          attachmentIds.current.set(file, attachment.id);
          setUploadStates(current =>
            new Map(current).set(file, { status: "complete" }),
          );
          setAttachmentVersion(value => value + 1);
        })
        .catch((error: unknown) => {
          if (!mounted.current || uploadGeneration !== generation.current)
            return;
          setUploadStates(current =>
            new Map(current).set(file, {
              status: "failed",
              error: error instanceof Error ? error.message : "Upload failed.",
            }),
          );
        })
        .finally(() => {
          if (!mounted.current || uploadGeneration !== generation.current)
            return;
          activeUploads.current -= 1;
          pumpUploads.current();
        });
    }
  };

  const queueUploads = useCallback((candidates: File[]) => {
    if (!conversationDraftId || candidates.length === 0) return;
    setUploadStates(current => {
      const next = new Map(current);
      for (const file of candidates) next.set(file, { status: "queued" });
      return next;
    });
    pendingUploads.current.push(...candidates);
    window.queueMicrotask(() => pumpUploads.current());
  }, [conversationDraftId]);

  const addFiles = useCallback((candidates: File[]) => {
    const selection = selectComposerFiles(files, candidates, assetLimits);
    dispatch({ type: "add", candidates, limits: assetLimits });
    for (const file of selection.accepted) {
      locallyRemovedFiles.current.delete(file);
    }
    if (selection.accepted.length > 0) onEdit();
    queueUploads(selection.accepted);
  }, [assetLimits, dispatch, files, onEdit, queueUploads]);

  const retryUpload = useCallback((file: File) => {
    if (!conversationDraftId || attachmentIds.current.has(file)) return;
    locallyRemovedFiles.current.delete(file);
    setUploadStates(current =>
      new Map(current).set(file, { status: "queued" }),
    );
    pendingUploads.current.push(file);
    pumpUploads.current();
  }, [conversationDraftId]);

  const removeFile = useCallback((index: number) => {
    const file = files[index];
    if (!file) return;
    const id = attachmentIds.current.get(file);
    attachmentIds.current.delete(file);
    if (id) locallyRemovedIds.current.add(id);
    else locallyRemovedFiles.current.add(file);
    pendingUploads.current = pendingUploads.current.filter(
      candidate => candidate !== file,
    );
    setUploadStates(current => {
      const next = new Map(current);
      next.delete(file);
      return next;
    });
    dispatch({ type: "remove", index });
    onEdit(id);
    setAttachmentVersion(value => value + 1);
    if (conversationDraftId && id) {
      void api
        .deleteDraftAttachment(conversationDraftId, draftOwnerId, id)
        .catch(() => undefined);
    }
  }, [conversationDraftId, dispatch, draftOwnerId, files, onEdit]);

  const mergeRestored = useCallback((restored: RestoredDraftAttachment[]) => {
    const existingIds = new Set(attachmentIds.current.values());
    const additions = restored.filter(
      ({ attachment }) =>
        !existingIds.has(attachment.id) &&
        !locallyRemovedIds.current.has(attachment.id),
    );
    if (additions.length === 0) return;
    for (const { attachment, file } of additions) {
      attachmentIds.current.set(file, attachment.id);
    }
    setUploadStates(current => {
      const next = new Map(current);
      for (const { file } of additions) {
        next.set(file, { status: "complete" });
      }
      return next;
    });
    dispatch({
      type: "prepend",
      files: additions.map(({ file }) => file),
    });
    setAttachmentVersion(value => value + 1);
  }, [dispatch]);

  const clear = useCallback(() => {
    // Invalidate Composer hydration before clearing deletion tombstones.
    onBeforeClear();
    generation.current += 1;
    attachmentIds.current.clear();
    locallyRemovedIds.current.clear();
    locallyRemovedFiles.current = new WeakSet<File>();
    pendingUploads.current = [];
    activeUploads.current = 0;
    setUploadStates(new Map());
    dispatch({ type: "clear" });
    setAttachmentVersion(value => value + 1);
  }, [dispatch, onBeforeClear]);

  const replaceRestored = useCallback((restored: RestoredDraftAttachment[]) => {
    generation.current += 1;
    pendingUploads.current = [];
    activeUploads.current = 0;
    const retained = restored.filter(
      ({ attachment }) => !locallyRemovedIds.current.has(attachment.id),
    );
    attachmentIds.current = new Map(
      retained.map(({ attachment, file }) => [file, attachment.id]),
    );
    setUploadStates(
      new Map(
        retained.map(({ file }) => [
          file,
          { status: "complete" as const },
        ]),
      ),
    );
    dispatch({
      type: "replace",
      files: retained.map(({ file }) => file),
    });
    setAttachmentVersion(value => value + 1);
  }, [dispatch]);

  return {
    addFiles,
    attachmentIds,
    attachmentVersion,
    clear,
    locallyRemovedIds,
    mergeRestored,
    removeFile,
    replaceRestored,
    retryUpload,
    uploadStates,
  };
}
