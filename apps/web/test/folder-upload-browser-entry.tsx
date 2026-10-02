import { useReducer } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_ASSET_LIMITS } from "@ponderosa/core";
import { collectAttachments } from "../src/components/chat/folderAttachments";
import { composerAttachmentReducer } from "../src/components/chat/composerUtils";
import { useComposerDraftAttachments } from "../src/components/chat/useComposerDraftAttachments";

function Fixture(): JSX.Element {
  const [attachments, dispatch] = useReducer(composerAttachmentReducer, { files: [] });
  const { addFiles, uploadStates, attachmentIds } = useComposerDraftAttachments({
    conversationDraftId: "folder-chat", draftOwnerId: "folder-owner", files: attachments.files,
    assetLimits: DEFAULT_ASSET_LIMITS, dispatch, onEdit: () => {}, onBeforeClear: () => {},
  });
  const prepare = async (input: Array<FileSystemEntry | File>) => {
    try { addFiles((await collectAttachments(input, DEFAULT_ASSET_LIMITS.maxMessageBytes)).files); }
    catch (error) { document.body.dataset.error = String(error); }
  };
  const folderProps = { webkitdirectory: "" };
  return <>
    <input {...folderProps} aria-label="Choose folder" type="file" multiple onChange={event => { void prepare(Array.from(event.target.files ?? [])); }} />
    <button onClick={() => {
      const name = new URLSearchParams(location.search).get("root") ?? "Fonts";
      let read = false;
      const entry = { name, isDirectory: true, isFile: false, createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => {
        resolve(read ? [] : [{ name: "字形.ttf", isFile: true, isDirectory: false,
          file: (yes: (file: File) => void) => yes(new File(["exact font bytes"], "字形.ttf")) }]); read = true;
      } }) } as unknown as FileSystemEntry;
      void prepare([entry]);
    }}>Prepare dropped folder</button>
    {attachments.files.map(file => <div key={file.name} data-file-name={file.name} data-attachment-id={attachmentIds.current.get(file)}>
      {uploadStates.get(file)?.status ?? "pending"}: {uploadStates.get(file)?.error}
    </div>)}
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
