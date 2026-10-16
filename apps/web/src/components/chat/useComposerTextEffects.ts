import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import { findMentionedHandles } from "../../mentions";
import { readChatState, writeChatState } from "../../chatState";
import { replaceDestination } from "./Composer.helpers";
import type { ComposerEditorHandle } from "./ComposerEditor";
import type { ComposerProps } from "./Composer.types";

interface UseComposerInsertTextRequestOptions {
  appliedInsertRequest: MutableRefObject<string | undefined>;
  conversationDraftId: string | undefined;
  destinationMode: ComposerProps["destinationMode"];
  draftQuery: { isError: boolean };
  draftReady: MutableRefObject<boolean>;
  draftReadyVersion: number;
  mutationLocked: boolean;
  inputRef: RefObject<ComposerEditorHandle>;
  insertTextRequest: ComposerProps["insertTextRequest"];
  setCaret: Dispatch<SetStateAction<number>>;
  selectionIntent: MutableRefObject<number>;
}

export function useComposerInsertTextRequest({
  appliedInsertRequest,
  conversationDraftId,
  destinationMode,
  draftQuery,
  draftReady,
  draftReadyVersion,
  mutationLocked,
  inputRef,
  insertTextRequest,
  setCaret,
  selectionIntent,
}: UseComposerInsertTextRequestOptions): void {
  useEffect(() => {
    if (
      mutationLocked || !insertTextRequest ||
      appliedInsertRequest.current === insertTextRequest.id
    )
      return;
    if (conversationDraftId && !draftReady.current && !draftQuery.isError)
      return;
    const editor = inputRef.current;
    if (!editor) return;
    appliedInsertRequest.current = insertTextRequest.id;
    const current = editor.getCanonicalText();
    const next = (() => {
      const requested = insertTextRequest.text.trim();
      if (
        requested &&
        (/^#[\p{L}\p{N}_-]+$/u.test(requested)
          ? findMentionedHandles(current, [requested.slice(1)]).length > 0
          : current.toLocaleLowerCase().includes(requested.toLocaleLowerCase()))
      )
        return current;
      if (
        destinationMode === "target-required" &&
        /^#[\p{L}\p{N}_-]+$/u.test(requested)
      ) {
        return `${requested} ${replaceDestination(current, undefined).trimStart()}`.trimEnd();
      }
      const prefix = current && !/\s$/u.test(current) ? " " : "";
      return `${current}${prefix}${insertTextRequest.text} `;
    })();
    // Edit through the same Lexical transaction path as typing/paste. Updating
    // React text first lets a pending editor selection update echo the old
    // document back over this explicit insertion.
    if (next !== current) editor.replaceCanonicalRange(0, current.length, next);
    const capturedIntent = selectionIntent.current;
    const frame = window.requestAnimationFrame(() => {
      if (selectionIntent.current !== capturedIntent || inputRef.current !== editor ||
          editor.getCanonicalText() !== next) return;
      inputRef.current?.focus();
      const end = inputRef.current?.getCanonicalText().length ?? 0;
      inputRef.current?.setSelectionOffsets(end, end);
      setCaret(end);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    conversationDraftId,
    destinationMode,
    draftQuery?.isError,
    draftReadyVersion,
    mutationLocked,
    insertTextRequest,
  ]);
}

interface UseComposerMentionedHandlesChangeOptions {
  mentionedHandles: string[];
  onMentionedHandlesChange: ComposerProps["onMentionedHandlesChange"];
}

export function useComposerMentionedHandlesChange({
  mentionedHandles,
  onMentionedHandlesChange,
}: UseComposerMentionedHandlesChangeOptions): void {
  useEffect(() => {
    onMentionedHandlesChange?.(mentionedHandles);
  }, [mentionedHandles, onMentionedHandlesChange]);
}

interface UseComposerDraftStorageResetOptions {
  carryText?: string;
  draftStorageKey: string | undefined;
  previousDraftStorageKey: MutableRefObject<string | undefined>;
  setPastedText: Dispatch<SetStateAction<string | undefined>>;
  setText: Dispatch<SetStateAction<string>>;
}

export function useComposerDraftStorageReset({
  draftStorageKey,
  previousDraftStorageKey,
  setPastedText,
  setText,
  carryText,
}: UseComposerDraftStorageResetOptions): void {
  useEffect(() => {
    if (previousDraftStorageKey.current !== draftStorageKey) {
      previousDraftStorageKey.current = draftStorageKey;
      setText(carryText ?? (draftStorageKey ? (readChatState(draftStorageKey) ?? "") : ""));
      setPastedText(undefined);
    }
  }, [draftStorageKey]);
}

interface UseComposerDraftStorageWriteOptions {
  draftStorageKey: string | undefined;
  text: string;
  textRef: MutableRefObject<string>;
}

export function useComposerDraftStorageWrite({
  draftStorageKey,
  text,
  textRef,
}: UseComposerDraftStorageWriteOptions): void {
  useEffect(() => {
    if (draftStorageKey) writeChatState(draftStorageKey, textRef.current);
  }, [draftStorageKey, text, textRef]);
}
