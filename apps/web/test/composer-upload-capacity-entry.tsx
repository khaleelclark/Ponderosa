import { createRoot } from "react-dom/client";
import { useReducer } from "react";
import { api } from "../src/api";
import { composerAttachmentReducer } from "../src/components/chat/composerUtils";
import { useComposerDraftAttachments } from "../src/components/chat/useComposerDraftAttachments";
import { ChatAttachments } from "../src/components/chat/ChatAttachments";
import { DEFAULT_ASSET_LIMITS } from "@ponderosa/core";

const docx = new URLSearchParams(window.location.search).get("case") === "docx";
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let started = 0;
let active = 0;
let peak = 0;
let released = false;
const held: Array<() => void> = [];
const stats = () => ({ started, active, peak });
(window as typeof window & { uploadStats: typeof stats }).uploadStats = stats;

api.uploadDraftAttachment = ((_chatId: string, _ownerId: string, file: File) =>
  new Promise(resolve => {
    started += 1;
    active += 1;
    peak = Math.max(peak, active);
    const finish = () => {
      active -= 1;
      resolve({ id: `asset-${file.name}` });
    };
    if (!released && started <= 2) held.push(finish);
    else queueMicrotask(finish);
  })) as typeof api.uploadDraftAttachment;
api.deleteDraftAttachment = async () => undefined;

function Fixture() {
  const [attachments, dispatch] = useReducer(composerAttachmentReducer, { files: [] });
  const { addFiles, uploadStates } = useComposerDraftAttachments({
    conversationDraftId: "chat", draftOwnerId: "operator", files: attachments.files,
    assetLimits: DEFAULT_ASSET_LIMITS,
    dispatch, onEdit: () => undefined, onBeforeClear: () => undefined,
  });
  return <>
    <button onClick={() => addFiles([0, 1, 2, 3].map(index =>
      new File([String(index)], `file-${index}.${docx ? "docx" : "txt"}`, {
        type: docx ? [docxMime, "application/zip", "", "application/octet-stream"][index] : "text/plain",
      })))}>Select four files</button>
    <button onClick={() => { released = true; for (const finish of held.splice(0)) finish(); }}>Release slots</button>
    {attachments.files.map(file => <div key={file.name} data-file-status={file.name}>
      {uploadStates.get(file)?.status ?? "pending"}
    </div>)}
    {docx ? <ChatAttachments attachments={attachments.files
      .filter(file => uploadStates.get(file)?.status === "complete")
      .map(file => ({ id: `asset-${file.name}`, agentId: "chat", name: file.name,
        mediaType: docxMime, size: file.size, downloadUrl: `/download/${file.name}` }))} /> : null}
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
