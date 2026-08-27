import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import { readChatState, writeChatState } from "../../chatState";
import { replaceDestination } from "./Composer.helpers";
import type { ComposerProps } from "./Composer.types";

interface UseComposerInsertTextRequestOptions {
  appliedInsertRequest: MutableRefObject<string | undefined>;
  conversationDraftId: string | undefined;
  destinationMode: ComposerProps["destinationMode"];
  draftQuery: { isError: boolean };
  draftReady: MutableRefObject<boolean>;
  draftReadyVersion: number;
  inputRef: RefObject<HTMLTextAreaElement>;
  insertTextRequest: ComposerProps["insertTextRequest"];
  setCaret: Dispatch<SetStateAction<number>>;
  updateText: Dispatch<SetStateAction<string>>;
}

export function useComposerInsertTextRequest({
  appliedInsertRequest,
  conversationDraftId,
  destinationMode,
  draftQuery,
  draftReady,
  draftReadyVersion,
  inputRef,
  insertTextRequest,
  setCaret,
  updateText,
}: UseComposerInsertTextRequestOptions): void {
  useEffect(() => {
    if (
      !insertTextRequest ||
      appliedInsertRequest.current === insertTextRequest.id
    )
      return;
    if (conversationDraftId && !draftReady.current && !draftQuery.isError)
      return;
    appliedInsertRequest.current = insertTextRequest.id;
    updateText(current => {
      const requested = insertTextRequest.text.trim();
      if (
        requested &&
        current.toLocaleLowerCase().includes(requested.toLocaleLowerCase())
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
    });
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const end = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(end, end);
      setCaret(end);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    conversationDraftId,
    destinationMode,
    draftQuery?.isError,
    draftReadyVersion,
    insertTextRequest,
    updateText,
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
}: UseComposerDraftStorageResetOptions): void {
  useEffect(() => {
    if (previousDraftStorageKey.current !== draftStorageKey) {
      previousDraftStorageKey.current = draftStorageKey;
      setText(draftStorageKey ? (readChatState(draftStorageKey) ?? "") : "");
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
