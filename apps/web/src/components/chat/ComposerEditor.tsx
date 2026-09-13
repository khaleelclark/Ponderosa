import CloseIcon from "@mui/icons-material/Close";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import { Box, Typography } from "@mui/material";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COPY_COMMAND,
  COMMAND_PRIORITY_HIGH,
  INSERT_PARAGRAPH_COMMAND,
  CUT_COMMAND,
  PASTE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  DecoratorNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import type { AgentMentionBindingDto } from "@ponderosa/core";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
  forwardRef,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ForwardedRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  LONG_TEXT_MAX_UTF8_BYTES,
  messageTagTokens,
  utf8ByteLength,
} from "@ponderosa/core";
import {
  composerSubmissionText,
  engineCommandDisabledReason,
  filesFromClipboard,
  removeComposerPasteSelection,
  shouldExtractLongPaste,
  shouldIgnoreComposerKey,
  shouldConsumeComposerKey,
  shouldSendComposerKey,
} from "./composerUtils";
import type { ComposerMenuSuggestion } from "./Composer.controls";
import { isIOSDevice } from "../../browserPlatform";

// iPadOS can identify as a Mac. Do not change Android or desktop Return policy.
const isIOSComposer = isIOSDevice();

export type ComposerMentionDescriptor = {
  start: number;
  end: number;
  handle: string;
  title: string;
  valid: boolean;
  kind: "agent" | "special";
  agentId?: string;
  structural?: boolean;
};

export type ComposerSelectionOffsets = { start: number; end: number };

export type ComposerProjectFileDescriptor = {
  projectId: string;
  artifactId: string;
  historicalFilename: string;
  currentFilename: string;
};

const PROJECT_FILE_REFERENCE_PATTERN = /\[Project file\]\(ponderosa:\/\/project-file\/([^/()\s]+)\/([^?()\s]+)\?historical=([^&()\s]*)&current=([^()\s]*)\)/gu;
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

function adjacentFocusableElement(
  current: HTMLElement,
  backwards: boolean,
): HTMLElement | undefined {
  const focusable = [...document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter(element =>
      element.tabIndex >= 0 &&
      !element.closest('[aria-hidden="true"]') &&
      !element.closest("[inert]") &&
      element.getClientRects().length > 0
    );
  const currentIndex = focusable.indexOf(current);
  if (currentIndex < 0 || focusable.length < 2) return undefined;
  const nextIndex = (currentIndex + (backwards ? -1 : 1) + focusable.length) % focusable.length;
  return focusable[nextIndex];
}

export function projectFileCanonicalText(
  descriptor: ComposerProjectFileDescriptor,
): string {
  return `[Project file](ponderosa://project-file/${encodeURIComponent(descriptor.projectId)}/${encodeURIComponent(descriptor.artifactId)}?historical=${encodeURIComponent(descriptor.historicalFilename)}&current=${encodeURIComponent(descriptor.currentFilename)})`;
}

function projectFileReferences(text: string): Array<ComposerProjectFileDescriptor & {
  start: number;
  end: number;
}> {
  return [...text.matchAll(PROJECT_FILE_REFERENCE_PATTERN)].flatMap(match => {
    try {
      return [{
        projectId: decodeURIComponent(match[1]!),
        artifactId: decodeURIComponent(match[2]!),
        historicalFilename: decodeURIComponent(match[3]!),
        currentFilename: decodeURIComponent(match[4]!),
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      }];
    } catch {
      return [];
    }
  });
}

function readableProjectFileReferences(text: string): string {
  const references = projectFileReferences(text);
  if (!references.length) return text;
  let cursor = 0;
  let readable = "";
  for (const reference of references) {
    readable += text.slice(cursor, reference.start);
    readable += `@${reference.currentFilename || reference.historicalFilename}`;
    cursor = reference.end;
  }
  return readable + text.slice(cursor);
}

export interface ComposerEditorHandle {
  focus(): void;
  isFocused(): boolean;
  getCanonicalText(): string;
  getSelectionOffsets(): ComposerSelectionOffsets;
  setSelectionOffsets(start: number, end: number): void;
  replaceCanonicalRange(start: number, end: number, content: string, options?: { focus?: boolean }): void;
  insertMention(descriptor: Omit<ComposerMentionDescriptor, "start" | "end">): void;
  insertProjectFile(
    descriptor: ComposerProjectFileDescriptor,
    replace?: ComposerSelectionOffsets,
    trailingText?: string,
  ): void;
  insertText(text: string): void;
  removeMention(nodeKey: string): void;
  resetDocument(canonicalText: string): void;
  clear(): void;
}

type SerializedMentionNode = Spread<
  {
    type: "composer-mention";
    version: 1;
    kind: "agent" | "special";
    agentId?: string;
    handle: string;
    title: string;
    valid: boolean;
    structural?: boolean;
  },
  SerializedLexicalNode
>;

type SerializedProjectFileNode = Spread<
  ComposerProjectFileDescriptor & {
    type: "composer-project-file";
    version: 1;
  },
  SerializedLexicalNode
>;

const StructuralDestinationRemovalContext = createContext<
  (() => void) | undefined
>(undefined);
const ComposerMutationLockedContext = createContext(false);

class ComposerMentionNode extends DecoratorNode<ReactNode> {
  __kind: "agent" | "special";
  __agentId?: string;
  __handle: string;
  __title: string;
  __valid: boolean;
  __structural: boolean;

  static override getType(): string {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(
      node.__kind,
      node.__handle,
      node.__title,
      node.__valid,
      node.__agentId,
      node.__structural,
      node.__key,
    );
  }

  static override importJSON(serialized: SerializedMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(
      serialized.kind,
      serialized.handle,
      serialized.title,
      serialized.valid,
      serialized.agentId,
      serialized.structural,
    );
  }

  constructor(
    kind: "agent" | "special",
    handle: string,
    title: string,
    valid: boolean,
    agentId?: string,
    structural = false,
    key?: NodeKey,
  ) {
    super(key);
    this.__kind = kind;
    this.__agentId = agentId;
    this.__handle = handle;
    this.__title = title;
    this.__valid = valid;
    this.__structural = structural;
  }

  override exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      type: "composer-mention",
      version: 1,
      kind: this.__kind,
      agentId: this.__agentId,
      handle: this.__handle,
      title: this.__title,
      valid: this.__valid,
      structural: this.__structural,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement("span");
    element.style.display = "inline";
    return element;
  }

  override updateDOM(): false {
    return false;
  }

  override isInline(): true {
    return true;
  }

  override isIsolated(): true {
    return true;
  }

  override isKeyboardSelectable(): true {
    return true;
  }

  override getTextContent(): string {
    return `#${this.__handle}`;
  }

  getDescriptor(): Omit<ComposerMentionDescriptor, "start" | "end"> {
    return {
      kind: this.__kind,
      agentId: this.__agentId,
      handle: this.__handle,
      title: this.__title,
      valid: this.__valid,
      structural: this.__structural,
    };
  }

  reconcile(descriptor: Omit<ComposerMentionDescriptor, "start" | "end">): void {
    const writable = this.getWritable();
    writable.__kind = descriptor.kind;
    writable.__agentId = descriptor.agentId;
    writable.__handle = descriptor.handle;
    writable.__title = descriptor.title;
    writable.__valid = descriptor.valid;
    writable.__structural = descriptor.structural ?? false;
  }

  isStructural(): boolean {
    return this.__structural;
  }

  override decorate(): ReactNode {
    return (
      <ComposerMentionToken
        nodeKey={this.__key}
        handle={this.__handle}
        title={this.__title}
        valid={this.__valid}
        kind={this.__kind}
        structural={this.__structural}
      />
    );
  }
}

class ComposerProjectFileNode extends DecoratorNode<ReactNode> {
  __projectId: string;
  __artifactId: string;
  __historicalFilename: string;
  __currentFilename: string;

  static override getType(): string {
    return "composer-project-file";
  }

  static override clone(node: ComposerProjectFileNode): ComposerProjectFileNode {
    return new ComposerProjectFileNode(node.getDescriptor(), node.__key);
  }

  static override importJSON(
    serialized: SerializedProjectFileNode,
  ): ComposerProjectFileNode {
    return new ComposerProjectFileNode(serialized);
  }

  constructor(descriptor: ComposerProjectFileDescriptor, key?: NodeKey) {
    super(key);
    this.__projectId = descriptor.projectId;
    this.__artifactId = descriptor.artifactId;
    this.__historicalFilename = descriptor.historicalFilename;
    this.__currentFilename = descriptor.currentFilename;
  }

  override exportJSON(): SerializedProjectFileNode {
    return {
      ...super.exportJSON(),
      type: "composer-project-file",
      version: 1,
      ...this.getDescriptor(),
    };
  }

  override createDOM(): HTMLElement {
    const element = document.createElement("span");
    element.style.display = "inline";
    return element;
  }

  override updateDOM(): false {
    return false;
  }

  override isInline(): true {
    return true;
  }

  override isIsolated(): true {
    return true;
  }

  override isKeyboardSelectable(): true {
    return true;
  }

  override getTextContent(): string {
    return projectFileCanonicalText(this.getDescriptor());
  }

  getDescriptor(): ComposerProjectFileDescriptor {
    return {
      projectId: this.__projectId,
      artifactId: this.__artifactId,
      historicalFilename: this.__historicalFilename,
      currentFilename: this.__currentFilename,
    };
  }

  override decorate(): ReactNode {
    return (
      <ComposerProjectFileToken
        nodeKey={this.__key}
        filename={this.__currentFilename || this.__historicalFilename}
      />
    );
  }
}

function $createComposerProjectFileNode(
  descriptor: ComposerProjectFileDescriptor,
): ComposerProjectFileNode {
  return new ComposerProjectFileNode(descriptor);
}

function $isComposerProjectFileNode(
  node: LexicalNode | null | undefined,
): node is ComposerProjectFileNode {
  return node instanceof ComposerProjectFileNode;
}

function ComposerProjectFileToken({
  nodeKey,
  filename,
}: {
  nodeKey: NodeKey;
  filename: string;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const mutationLocked = useContext(ComposerMutationLockedContext);
  const remove = useCallback(() => {
    if (mutationLocked) return;
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isComposerProjectFileNode(node)) return;
      const parent = node.getParent();
      const index = node.getIndexWithinParent();
      node.remove();
      if (parent) {
        const selection = $createRangeSelection();
        selection.anchor.set(parent.getKey(), index, "element");
        selection.focus.set(parent.getKey(), index, "element");
        $setSelection(selection);
      }
    });
    requestAnimationFrame(() => editor.focus());
  }, [editor, mutationLocked, nodeKey]);

  return (
    <Box
      component="span"
      data-composer-project-file="true"
      data-node-key={nodeKey}
      contentEditable={false}
      role="group"
      aria-label={`Project File ${filename}`}
      sx={{
        display: "inline-flex",
        alignItems: "baseline",
        maxWidth: "min(70vw, 360px)",
        mx: "1px",
        px: 0.75,
        py: "1px",
        borderRadius: 1.25,
        bgcolor: "action.selected",
        color: "primary.main",
        boxShadow: "inset 0 0 0 1px rgba(127, 196, 142, .18)",
        fontSize: "1em",
        fontWeight: 700,
        lineHeight: "1.35em",
        verticalAlign: "baseline",
        whiteSpace: "nowrap",
      }}
    >
      <InsertDriveFileOutlinedIcon sx={{ mr: 0.4, fontSize: "1em", alignSelf: "center" }} />
      <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        @{filename}
      </Box>
      <Box
        component="button"
        type="button"
        disabled={mutationLocked}
        tabIndex={-1}
        aria-label={`Remove @${filename}`}
        onMouseDown={event => event.preventDefault()}
        onClick={event => {
          event.preventDefault();
          event.stopPropagation();
          remove();
        }}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          alignSelf: "center",
          ml: 0.5,
          p: 0,
          border: 0,
          bgcolor: "transparent",
          color: "inherit",
          cursor: "pointer",
          lineHeight: 0,
        }}
      >
        <CloseIcon sx={{ fontSize: "1.05em" }} />
      </Box>
    </Box>
  );
}

function $createComposerMentionNode(
  descriptor: Omit<ComposerMentionDescriptor, "start" | "end">,
): ComposerMentionNode {
  return new ComposerMentionNode(
    descriptor.kind,
    descriptor.handle,
    descriptor.title,
    descriptor.valid,
    descriptor.agentId,
    descriptor.structural,
  );
}

function $isComposerMentionNode(
  node: LexicalNode | null | undefined,
): node is ComposerMentionNode {
  return node instanceof ComposerMentionNode;
}

function ComposerMentionToken({
  nodeKey,
  handle,
  title,
  valid,
  kind,
  structural,
}: {
  nodeKey: NodeKey;
  handle: string;
  title: string;
  valid: boolean;
  kind: "agent" | "special";
  structural: boolean;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const mutationLocked = useContext(ComposerMutationLockedContext);
  const removeStructuralDestination = useContext(
    StructuralDestinationRemovalContext,
  );
  const remove = useCallback(() => {
    if (mutationLocked) return;
    if (structural) {
      removeStructuralDestination?.();
      return;
    }
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isComposerMentionNode(node)) return;
      const parent = node.getParent();
      const index = node.getIndexWithinParent();
      node.remove();
      if (parent) {
        const selection = $createRangeSelection();
        selection.anchor.set(parent.getKey(), index, "element");
        selection.focus.set(parent.getKey(), index, "element");
        $setSelection(selection);
      }
    });
    requestAnimationFrame(() => editor.focus());
  }, [editor, mutationLocked, nodeKey, removeStructuralDestination, structural]);

  return (
    <Box
      component="span"
      data-composer-mention="true"
      data-node-key={nodeKey}
      contentEditable={false}
      role="group"
      aria-label={kind === "special"
        ? `${title} tag`
        : valid
          ? `Agent mention ${title}`
          : `Unavailable Agent mention ${title}`}
      sx={{
        display: "inline-flex",
        alignItems: "baseline",
        maxWidth: "min(70vw, 320px)",
        mx: "1px",
        px: 0.75,
        py: "1px",
        borderRadius: 1.25,
        bgcolor: valid ? "action.selected" : "error.dark",
        color: valid ? "primary.main" : "error.contrastText",
        boxShadow: valid
          ? "inset 0 0 0 1px rgba(127, 196, 142, .18)"
          : undefined,
        fontSize: "1em",
        fontWeight: 700,
        lineHeight: "1.35em",
        verticalAlign: "baseline",
        whiteSpace: "nowrap",
      }}
    >
      <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        #{handle}
      </Box>
      <Box
        component="button"
        type="button"
        disabled={mutationLocked}
        tabIndex={-1}
        aria-label={`Remove #${handle}`}
        onMouseDown={event => event.preventDefault()}
        onClick={event => {
          event.preventDefault();
          event.stopPropagation();
          remove();
        }}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          alignSelf: "center",
          ml: 0.5,
          p: 0,
          border: 0,
          bgcolor: "transparent",
          color: "inherit",
          cursor: "pointer",
          lineHeight: 0,
        }}
      >
        <CloseIcon sx={{ fontSize: "1.05em" }} />
      </Box>
    </Box>
  );
}

function nodeTextLength(node: LexicalNode): number {
  if ($isComposerMentionNode(node) && node.isStructural()) return 0;
  return node.getTextContent().length;
}

function $canonicalText(): string {
  const root = $getRoot();
  const paragraph = root.getFirstChild();
  if (!paragraph || !$isElementNode(paragraph)) return "";
  return paragraph.getChildren().map(node =>
    $isComposerMentionNode(node) && node.isStructural()
      ? ""
      : node.getTextContent(),
  ).join("");
}

function $canonicalOffsetForPoint(point: {
  key: NodeKey;
  offset: number;
  type: "text" | "element";
}): number {
  const root = $getRoot();
  const paragraph = root.getFirstChild();
  if (!paragraph || !$isElementNode(paragraph)) return 0;
  const children = paragraph.getChildren();
  if (point.key === root.getKey()) {
    return point.offset <= 0 ? 0 : $canonicalText().length;
  }
  if (point.key === paragraph.getKey() && point.type === "element") {
    return children
      .slice(0, Math.max(0, Math.min(point.offset, children.length)))
      .reduce((total, node) => total + nodeTextLength(node), 0);
  }
  let offset = 0;
  for (const child of children) {
    if (child.getKey() === point.key) {
      if ($isTextNode(child)) {
        return offset + Math.max(0, Math.min(point.offset, child.getTextContentSize()));
      }
      return offset + (point.offset > 0 ? nodeTextLength(child) : 0);
    }
    offset += nodeTextLength(child);
  }
  return offset;
}

function $selectionOffsets(): ComposerSelectionOffsets {
  const selection = $getSelection();
  const end = $canonicalText().length;
  if (!$isRangeSelection(selection)) return { start: end, end };
  return {
    start: $canonicalOffsetForPoint(selection.anchor),
    end: $canonicalOffsetForPoint(selection.focus),
  };
}

function $pointForCanonicalOffset(offset: number): {
  key: NodeKey;
  offset: number;
  type: "text" | "element";
} {
  const root = $getRoot();
  const paragraph = root.getFirstChild();
  if (!paragraph || !$isElementNode(paragraph)) {
    return { key: root.getKey(), offset: 0, type: "element" };
  }
  const children = paragraph.getChildren();
  const bounded = Math.max(0, Math.min(offset, $canonicalText().length));
  let cursor = 0;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const length = nodeTextLength(child);
    if ($isTextNode(child) && bounded >= cursor && bounded <= cursor + length) {
      return { key: child.getKey(), offset: bounded - cursor, type: "text" };
    }
    if (bounded <= cursor + length) {
      return {
        key: paragraph.getKey(),
        offset: bounded - cursor < length / 2 ? index : index + 1,
        type: "element",
      };
    }
    cursor += length;
  }
  return { key: paragraph.getKey(), offset: children.length, type: "element" };
}

function $setSelectionOffsets(start: number, end: number): void {
  const anchor = $pointForCanonicalOffset(start);
  const focus = $pointForCanonicalOffset(end);
  const selection = $createRangeSelection();
  selection.anchor.set(anchor.key, anchor.offset, anchor.type);
  selection.focus.set(focus.key, focus.offset, focus.type);
  $setSelection(selection);
}

function descriptorsForCanonicalText(
  text: string,
  descriptors: readonly ComposerMentionDescriptor[],
): ComposerMentionDescriptor[] {
  if (!text) return [];
  const sourceTokens = messageTagTokens(text);
  const exact = descriptors.filter(descriptor =>
    sourceTokens.some(
      token =>
        token.start === descriptor.start &&
        token.end === descriptor.end &&
        token.handle.toLocaleLowerCase() ===
          descriptor.handle.toLocaleLowerCase(),
    ),
  );
  if (exact.length > 0 || descriptors.length === 0) return exact;
  const byHandle = new Map(
    descriptors.map(descriptor => [descriptor.handle.toLocaleLowerCase(), descriptor]),
  );
  return messageTagTokens(text).flatMap(token => {
    const descriptor = byHandle.get(token.handle.toLocaleLowerCase());
    return descriptor
      ? [{ ...descriptor, start: token.start, end: token.end }]
      : [];
  });
}

function $appendCanonicalContent(
  text: string,
  descriptors: readonly ComposerMentionDescriptor[],
): LexicalNode[] {
  const nodes: LexicalNode[] = [];
  const references = [
    ...descriptorsForCanonicalText(text, descriptors).map(descriptor => ({
      kind: "mention" as const,
      start: descriptor.start,
      end: descriptor.end,
      descriptor,
    })),
    ...projectFileReferences(text).map(descriptor => ({
      kind: "project-file" as const,
      start: descriptor.start,
      end: descriptor.end,
      descriptor,
    })),
  ].sort((a, b) => a.start - b.start);
  let cursor = 0;
  const appendText = (value: string) => {
    const parts = value.split("\n");
    parts.forEach((part, index) => {
      if (part) nodes.push($createTextNode(part));
      if (index < parts.length - 1) nodes.push($createLineBreakNode());
    });
  };
  for (const reference of references) {
    if (reference.start < cursor) continue;
    appendText(text.slice(cursor, reference.start));
    nodes.push(reference.kind === "mention"
      ? $createComposerMentionNode(reference.descriptor)
      : $createComposerProjectFileNode(reference.descriptor));
    cursor = reference.end;
  }
  appendText(text.slice(cursor));
  return nodes;
}

function $resetCanonicalDocument(
  text: string,
  descriptors: readonly ComposerMentionDescriptor[],
  selection?: ComposerSelectionOffsets,
  structuralDestination?: Omit<ComposerMentionDescriptor, "start" | "end">,
): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);
  if (structuralDestination) {
    paragraph.append($createComposerMentionNode({
      ...structuralDestination,
      structural: true,
    }));
  }
  paragraph.append(...$appendCanonicalContent(text, descriptors));
  const next = selection ?? { start: text.length, end: text.length };
  $setSelectionOffsets(
    Math.min(next.start, text.length),
    Math.min(next.end, text.length),
  );
}

function $insertCanonicalContent(
  text: string,
  descriptors: readonly ComposerMentionDescriptor[],
): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  selection.insertNodes($appendCanonicalContent(text, descriptors));
}

function $removeSelectedContent(): void {
  const selection = $getSelection();
  removeComposerPasteSelection(
    $isRangeSelection(selection)
      ? { kind: "range", removeText: () => selection.removeText() }
      : $isNodeSelection(selection)
        ? {
            kind: "node",
            removeNodes: () => selection.getNodes().forEach(node => node.remove()),
          }
        : { kind: "other" },
  );
}

function EditorBridge({
  editorRef,
  text,
  mentionDescriptors,
  mentionBindings,
  structuralDestination,
  onClearStructuralDestination,
  disabled,
  attachmentsEnabled,
  pastedText,
  onFiles,
  onPastedText,
  onPasteError,
  onTextChange,
}: {
  editorRef: ForwardedRef<ComposerEditorHandle>;
  text: string;
  mentionDescriptors: readonly ComposerMentionDescriptor[];
  mentionBindings: readonly AgentMentionBindingDto[];
  structuralDestination?: Omit<ComposerMentionDescriptor, "start" | "end">;
  onClearStructuralDestination?(): void;
  disabled: boolean;
  attachmentsEnabled: boolean;
  pastedText?: string;
  onFiles(files: File[]): void;
  onPastedText(value: string): void;
  onPasteError(message: string): void;
  onTextChange(value: string, caret: number): void;
}): null {
  const [editor] = useLexicalComposerContext();
  const canonicalRef = useRef(text);
  useEffect(() => {
    if (!isIOSComposer) return;
    // Own newline insertion inside Lexical, including soft-keyboard beforeinput.
    // A React keydown insertion would race Lexical's native event handling.
    return editor.registerCommand(INSERT_PARAGRAPH_COMMAND, () => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      selection.insertLineBreak();
      return true;
    }, COMMAND_PRIORITY_HIGH);
  }, [editor]);
  const descriptorsRef = useRef(mentionDescriptors);
  const structuralDestinationRef = useRef(structuralDestination);
  descriptorsRef.current = mentionDescriptors;
  structuralDestinationRef.current = structuralDestination;

  useImperativeHandle(editorRef, () => ({
    focus: () => editor.focus(),
    isFocused: () => editor.getRootElement()?.contains(document.activeElement) ?? false,
    getCanonicalText: () => canonicalRef.current,
    getSelectionOffsets: () =>
      editor.getEditorState().read(() => $selectionOffsets()),
    setSelectionOffsets: (start, end) => {
      editor.update(() => $setSelectionOffsets(start, end));
    },
    replaceCanonicalRange: (start, end, content, options) => {
      editor.update(() => {
        $setSelectionOffsets(start, end);
        const parsed = descriptorsForCanonicalText(content, descriptorsRef.current);
        $insertCanonicalContent(content, parsed);
      }, { tag: options?.focus === false ? SKIP_DOM_SELECTION_TAG : undefined });
      if (options?.focus !== false) requestAnimationFrame(() => editor.focus());
    },
    insertMention: descriptor => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        selection.insertNodes([$createComposerMentionNode(descriptor)]);
      });
      requestAnimationFrame(() => editor.focus());
    },
    insertProjectFile: (descriptor, replace, trailingText = "") => {
      editor.update(() => {
        if (replace) $setSelectionOffsets(replace.start, replace.end);
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        selection.insertNodes([
          $createComposerProjectFileNode(descriptor),
          ...(trailingText ? [$createTextNode(trailingText)] : []),
        ]);
      });
      requestAnimationFrame(() => editor.focus());
    },
    insertText: value => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        selection.insertNodes($appendCanonicalContent(value, descriptorsRef.current));
      });
      requestAnimationFrame(() => editor.focus());
    },
    removeMention: nodeKey => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isComposerMentionNode(node)) node.remove();
      });
    },
    resetDocument: value => {
      editor.update(() => $resetCanonicalDocument(
        value,
        descriptorsRef.current,
        undefined,
        structuralDestinationRef.current,
      ));
    },
    clear: () => {
      editor.update(() => $resetCanonicalDocument(
        "",
        [],
        undefined,
        structuralDestinationRef.current,
      ));
    },
  }), [editor]);

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
      editorState.read(() => {
        const canonical = $canonicalText();
        const offsets = $selectionOffsets();
        canonicalRef.current = canonical;
        const structuralNodes = $getRoot().getChildren().flatMap(rootChild =>
          $isElementNode(rootChild)
            ? rootChild.getChildren().filter(
                child =>
                  $isComposerMentionNode(child) && child.isStructural(),
              )
            : [],
        );
        if (structuralDestination) {
          if (structuralNodes.length === 0) {
            queueMicrotask(() => onClearStructuralDestination?.());
          }
        } else if (structuralNodes.length > 0) {
          const structuralNodeKeys = structuralNodes.map(node => node.getKey());
          queueMicrotask(() => editor.update(() => {
            for (const structuralNodeKey of structuralNodeKeys) {
              const current = $getNodeByKey(structuralNodeKey);
              if ($isComposerMentionNode(current) && current.isStructural()) {
                current.remove();
              }
            }
          }));
        }
        if (dirtyElements.size > 0 || dirtyLeaves.size > 0) {
          onTextChange(canonical, offsets.end);
        } else {
          onTextChange(canonical, offsets.end);
        }
      });
    });
  }, [editor, onClearStructuralDestination, onTextChange, structuralDestination]);

  useLayoutEffect(() => {
    if (text === canonicalRef.current) return;
    editor.update(() => {
      const selection = $selectionOffsets();
      $resetCanonicalDocument(
        text,
        mentionDescriptors,
        selection,
        structuralDestination,
      );
      canonicalRef.current = text;
    });
  }, [editor, mentionDescriptors, structuralDestination, text]);

  useEffect(() => {
    editor.update(() => {
      const desired = descriptorsForCanonicalText(canonicalRef.current, mentionDescriptors);
      const mentionNodes: ComposerMentionNode[] = [];
      const visit = (node: LexicalNode) => {
        if ($isComposerMentionNode(node)) mentionNodes.push(node);
        if ($isElementNode(node)) node.getChildren().forEach(visit);
      };
      $getRoot().getChildren().forEach(visit);
      const structuralNodes = mentionNodes.filter(node => node.isStructural());
      const selectionBeforeStructuralSync = $selectionOffsets();
      let structuralChanged = false;
      if (structuralDestination) {
        const existing = structuralNodes[0];
        if (existing) {
          const current = existing.getDescriptor();
          if (
            current.handle !== structuralDestination.handle ||
            current.title !== structuralDestination.title ||
            current.valid !== structuralDestination.valid ||
            current.agentId !== structuralDestination.agentId
          ) {
            existing.reconcile({
              ...structuralDestination,
              structural: true,
            });
            structuralChanged = true;
          }
        } else {
          const paragraph = $getRoot().getFirstChild();
          if ($isElementNode(paragraph)) {
            const node = $createComposerMentionNode({
              ...structuralDestination,
              structural: true,
            });
            const first = paragraph.getFirstChild();
            if (first) first.insertBefore(node);
            else paragraph.append(node);
            structuralChanged = true;
          }
        }
        for (const duplicate of structuralNodes.slice(1)) {
          duplicate.remove();
          structuralChanged = true;
        }
      } else {
        for (const node of structuralNodes) {
          node.remove();
          structuralChanged = true;
        }
      }
      if (structuralChanged) {
        $setSelectionOffsets(
          selectionBeforeStructuralSync.start,
          selectionBeforeStructuralSync.end,
        );
        return;
      }
      const authoredMentionNodes = mentionNodes.filter(
        node => !node.isStructural(),
      );
      const currentById = new Map(
        mentionBindings.map(binding => [binding.agentId, binding]),
      );
      let lifecycleChanged = false;
      for (const node of authoredMentionNodes) {
        const current = node.getDescriptor();
        if (current.kind !== "agent" || !current.agentId) continue;
        const binding = currentById.get(current.agentId);
        const reconciled = binding
          ? {
              ...current,
              title: binding.currentTitle,
              valid: true,
            }
          : { ...current, valid: false };
        if (
          current.handle !== reconciled.handle ||
          current.title !== reconciled.title ||
          current.valid !== reconciled.valid
        ) {
          node.reconcile(reconciled);
          lifecycleChanged = true;
        }
      }
      if (lifecycleChanged) return;
      if (authoredMentionNodes.length !== desired.length) {
        const selection = $selectionOffsets();
        $resetCanonicalDocument(
          canonicalRef.current,
          desired,
          selection,
          structuralDestination,
        );
        return;
      }
      for (let index = 0; index < authoredMentionNodes.length; index += 1) {
        const node = authoredMentionNodes[index]!;
        const descriptor = desired[index]!;
        const current = node.getDescriptor();
        if (
          current.handle !== descriptor.handle ||
          current.title !== descriptor.title ||
          current.valid !== descriptor.valid ||
          current.agentId !== descriptor.agentId ||
          current.kind !== descriptor.kind
        ) {
          node.reconcile(descriptor);
        }
      }
    });
  }, [editor, mentionBindings, mentionDescriptors, structuralDestination]);

  useEffect(() => {
    const copy = (event: ClipboardEvent | KeyboardEvent | null): boolean => {
      if (!event || !("clipboardData" in event) || !event.clipboardData) return false;
      const selection = $getSelection();
      if (!selection) return false;
      const offsets = $selectionOffsets();
      const start = Math.min(offsets.start, offsets.end);
      const end = Math.max(offsets.start, offsets.end);
      const selectedText = $isNodeSelection(selection)
        ? selection.getTextContent()
        : $canonicalText().slice(start, end);
      event.clipboardData.setData(
        "text/plain",
        readableProjectFileReferences(selectedText),
      );
      event.preventDefault();
      return true;
    };
    const unregisterCopy = editor.registerCommand(
      COPY_COMMAND,
      copy,
      4,
    );
    const unregisterCut = editor.registerCommand(
      CUT_COMMAND,
      event => {
        if (!copy(event)) return false;
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.removeText();
        else if ($isNodeSelection(selection)) selection.getNodes().forEach(node => node.remove());
        return true;
      },
      4,
    );
    return () => {
      unregisterCopy();
      unregisterCut();
    };
  }, [editor]);

  useEffect(() => editor.registerCommand(
    PASTE_COMMAND,
    event => {
      if (
        disabled ||
        !event ||
        !("clipboardData" in event) ||
        !event.clipboardData
      ) return false;
      if (attachmentsEnabled) {
        const files = filesFromClipboard(
          event.clipboardData.items,
          event.clipboardData.files,
        );
        if (files.length > 0) {
          event.preventDefault();
          onFiles(files);
          return true;
        }
      }
      const pasted = event.clipboardData.getData("text/plain");
      event.preventDefault();
      if (shouldExtractLongPaste(pasted)) {
        const combined = composerSubmissionText(pastedText ?? "", pasted);
        if (utf8ByteLength(combined) > LONG_TEXT_MAX_UTF8_BYTES) {
          onPasteError("Pasted text exceeds the 8 MiB limit.");
        } else {
          $removeSelectedContent();
          onPastedText(combined);
        }
        return true;
      }
      $insertCanonicalContent(
        pasted,
        descriptorsForCanonicalText(pasted, descriptorsRef.current),
      );
      return true;
    },
    4,
  ), [
    attachmentsEnabled,
    disabled,
    editor,
    onFiles,
    onPasteError,
    onPastedText,
    pastedText,
  ]);

  return null;
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, {
  text: string;
  disabled: boolean;
  locked: boolean;
  placeholder?: string;
  comboboxEnabled: boolean;
  menuOpen: boolean;
  listId: string;
  highlighted: number;
  attachmentsEnabled: boolean;
  pastedText?: string;
  menuSuggestions: ComposerMenuSuggestion[];
  destinationMode?: "project-chat" | "fixed" | "target-required";
  requiredRecipient?: { handle: string; title: string; onClear(): void };
  inlineDestination?: {
    handle: string;
    title: string;
    agentId?: string;
    onClear(): void;
  };
  mentionDescriptors: ComposerMentionDescriptor[];
  mentionBindings: AgentMentionBindingDto[];
  canSend: boolean;
  onTextChange(value: string, caret: number): void;
  onFiles(files: File[]): void;
  onPastedText(value: string): void;
  onPasteError(message: string): void;
  onHighlightChange(index: number): void;
  onSuppressMenu(): void;
  onApplySuggestion(suggestion: ComposerMenuSuggestion): void;
  onClearRequiredRecipient(): void;
  onSend(): void;
}>(function ComposerEditor({
  text,
  disabled,
  locked,
  placeholder,
  comboboxEnabled,
  menuOpen,
  listId,
  highlighted,
  attachmentsEnabled,
  pastedText,
  menuSuggestions,
  destinationMode,
  requiredRecipient,
  inlineDestination,
  mentionDescriptors,
  mentionBindings,
  canSend,
  onTextChange,
  onFiles,
  onPastedText,
  onPasteError,
  onHighlightChange,
  onSuppressMenu,
  onApplySuggestion,
  onClearRequiredRecipient,
  onSend,
}, ref): JSX.Element {
  const bridgeRef = useRef<ComposerEditorHandle | null>(null);
  const assignBridgeRef = useCallback((handle: ComposerEditorHandle | null) => {
    bridgeRef.current = handle;
    if (typeof ref === "function") ref(handle);
    else if (ref) ref.current = handle;
  }, [ref]);
  const initialTextRef = useRef(text);
  const initialDescriptorsRef = useRef(mentionDescriptors);
  const structuralDestination = inlineDestination
    ? {
        kind: "agent" as const,
        agentId: inlineDestination.agentId,
        handle: inlineDestination.handle,
        title: inlineDestination.title,
        valid: true,
        structural: true,
      }
    : undefined;
  const initialStructuralDestinationRef = useRef(structuralDestination);
  const initialConfig = useRef({
    namespace: "PonderosaComposer",
    nodes: [ComposerMentionNode, ComposerProjectFileNode],
    onError(error: Error) {
      throw error;
    },
    editorState: () => {
      $resetCanonicalDocument(
        initialTextRef.current,
        initialDescriptorsRef.current,
        undefined,
        initialStructuralDestinationRef.current,
      );
    },
  }).current;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      shouldIgnoreComposerKey({
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
      })
    ) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Enter" && (isIOSComposer || (
      event.shiftKey && window.matchMedia("(max-width: 899.95px)").matches
    ))) {
      if (menuOpen) onSuppressMenu();
      // Lexical owns mobile Shift+Return. iOS also uses plain Return for a newline.
      return;
    }
    if (
      event.key === "Enter" &&
      event.shiftKey
    ) {
      event.preventDefault();
      bridgeRef.current?.insertText("\n");
      return;
    }
    if (menuOpen && event.key === "ArrowDown") {
      event.preventDefault();
      onHighlightChange((highlighted + 1) % menuSuggestions.length);
      return;
    }
    if (menuOpen && event.key === "ArrowUp") {
      event.preventDefault();
      onHighlightChange(
        (highlighted - 1 + menuSuggestions.length) % menuSuggestions.length,
      );
      return;
    }
    const selectedSuggestion = menuSuggestions[highlighted];
    const selectedSuggestionDisabled = selectedSuggestion?.kind === "command" &&
      Boolean(engineCommandDisabledReason(selectedSuggestion.command));
    if (
      menuOpen &&
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault();
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        selectedSuggestion &&
        !selectedSuggestionDisabled
      ) {
        onApplySuggestion(selectedSuggestion);
      }
      return;
    }
    if (
      menuOpen &&
      event.key === "Tab" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      selectedSuggestion &&
      !selectedSuggestionDisabled
    ) {
      event.preventDefault();
      onApplySuggestion(selectedSuggestion);
      return;
    }
    if (menuOpen && event.key === "Escape") {
      event.preventDefault();
      onSuppressMenu();
      return;
    }
    if (event.key === "Tab") {
      if (menuOpen) onSuppressMenu();
      const next = adjacentFocusableElement(event.currentTarget, event.shiftKey);
      if (next) {
        event.preventDefault();
        next.focus();
      }
      return;
    }
    if (
      event.key === "Escape" &&
      destinationMode === "target-required" &&
      requiredRecipient
    ) {
      event.preventDefault();
      onClearRequiredRecipient();
      return;
    }
    const sendKey = {
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      repeat: event.repeat,
    };
    if (shouldConsumeComposerKey(sendKey)) {
      event.preventDefault();
      if (canSend && shouldSendComposerKey(sendKey)) onSend();
    }
  };

  return (
    <ComposerMutationLockedContext.Provider value={disabled || locked}>
    <StructuralDestinationRemovalContext.Provider
      value={inlineDestination?.onClear}
    >
    <LexicalComposer initialConfig={initialConfig}>
      <Box
        sx={{
          position: "relative",
          minWidth: 0,
          "& .composer-editor-input": {
            minHeight: 22,
            maxHeight: 110,
            overflowY: "auto",
            px: 0.25,
            pt: 0.75,
            pb: 0.5,
            outline: 0,
            color: "text.primary",
            fontFamily: "inherit",
            // Avoid iOS focus zoom without disabling user-controlled pinch zoom.
            fontSize: isIOSComposer ? 16 : 15,
            lineHeight: "22px",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            WebkitUserSelect: "text",
            userSelect: "text",
          },
          "& .composer-editor-input p": {
            m: 0,
          },
          "& .composer-editor-input[contenteditable='false']": {
            color: "text.disabled",
            cursor: "default",
          },
        }}
      >
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="composer-editor-input"
              tabIndex={disabled || locked ? -1 : 0}
              aria-label="Message"
              role="textbox"
              aria-multiline="true"
              aria-autocomplete={comboboxEnabled ? "list" : undefined}
              aria-controls={menuOpen ? listId : undefined}
              aria-activedescendant={menuOpen
                ? `${listId}-option-${highlighted}`
                : undefined}
              onKeyDown={handleKeyDown}
            />
          }
          placeholder={
            <Typography
              component="span"
              sx={{
                position: "absolute",
                top: 6,
                left: 2,
                color: { xs: "text.secondary", md: "text.disabled" },
                fontSize: isIOSComposer ? 16 : 15,
                lineHeight: "22px",
                pointerEvents: "none",
              }}
            >
              {locked ? "Agent is working" : (placeholder ?? "Send a message")}
            </Typography>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <EditorBridge
          editorRef={assignBridgeRef}
          text={text}
          mentionDescriptors={mentionDescriptors}
          mentionBindings={mentionBindings}
          structuralDestination={structuralDestination}
          onClearStructuralDestination={inlineDestination?.onClear}
          disabled={disabled || locked}
          attachmentsEnabled={attachmentsEnabled}
          pastedText={pastedText}
          onFiles={onFiles}
          onPastedText={onPastedText}
          onPasteError={onPasteError}
          onTextChange={onTextChange}
        />
      </Box>
    </LexicalComposer>
    </StructuralDestinationRemovalContext.Provider>
    </ComposerMutationLockedContext.Provider>
  );
});
