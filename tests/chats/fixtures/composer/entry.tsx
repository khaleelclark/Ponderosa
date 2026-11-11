import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { ComposerEditor, type ComposerEditorHandle } from "../../../../apps/web/src/components/chat/ComposerEditor";
import { createPonderosaTheme } from "../../../../apps/web/src/theme";

// Native-input regression: type t, then hanks. Metadata must overlap the first
// input without moving its caret; output must end in thanks. Also check a native
// mid-text selection, undo, refocus and token removal. No application transport.
const params = new URLSearchParams(location.search), mode = params.get("mode") ?? "authored";
const structural = mode !== "authored", handle = "Bryce-Canyon", agentId = "fixture-agent";
const handles = params.has("multiple") ? [handle, "Long-Agent-Name-For-Narrow-Composer-Ellipsis"] : [handle];
const initial = params.get("text") ?? (structural ? "" : handles.map(handle => `#${handle} `).join(""));
function App() {
  const [text, setText] = useState(initial), [metadata, setMetadata] = useState(0), [removed, setRemoved] = useState(false);
  const [output, setOutput] = useState(""), editor = useRef<ComposerEditorHandle>(null), sends = useRef(0);
  const nativeTrace = useRef<unknown[]>([]);
  const title = metadata ? "Bryce Canyon Updated" : "Bryce Canyon", valid = !(metadata && params.get("change") === "validity");
  const bindings = handles.map((handle, index) => ({ projectId: "fixture-project", agentId: index ? "second-fixture-agent" : agentId, handle, currentHandle: handle, currentTitle: index ? "Second Agent" : title }));
  useEffect(() => {
    const refresh = (event: Event) => {
      if (!(event.target as Element).closest('[contenteditable="true"]')) return;
      document.removeEventListener("input", refresh, true);
      if (params.has("caretRepair")) {
        const snapshot = () => ({ text: (event.target as Element).textContent, offset: getSelection()?.anchorOffset });
        nativeTrace.current.push(snapshot());
        editor.current?.placeCaretAfterLoneMention();
        nativeTrace.current.push(snapshot());
        return;
      }
      queueMicrotask(() => setMetadata(1));
    };
    document.addEventListener("input", refresh, true);
    return () => document.removeEventListener("input", refresh, true);
  }, []);
  return <ThemeProvider theme={createPonderosaTheme(params.get("theme") === "light" ? "light" : "dark")}>
    <CssBaseline /><div style={{ width: params.has("narrow") ? 320 : undefined }}>
    <p>Type t, then hanks. {params.has("caretRepair") ? "Lone-mention focus repair runs during the first native input." : "The recipient metadata changes during the first native input."}</p>
    <input aria-label="Other focus target" />
    <ComposerEditor ref={editor} text={text} onTextChange={setText} disabled={false} locked={false}
      comboboxEnabled={false} menuOpen={false} listId="fixture-list" highlighted={0} attachmentsEnabled={false}
      menuSuggestions={[]} destinationMode={mode === "required" ? "target-required" : "project-chat"}
      inlineDestination={structural && !removed ? { agentId, handle, title, onClear: () => setRemoved(true) } : undefined}
      requiredRecipient={mode === "required" && !removed ? { handle, title, onClear: () => setRemoved(true) } : undefined}
      mentionDescriptors={structural ? [] : bindings.flatMap(binding => {
        const start = text.indexOf(`#${binding.handle}`);
        return start < 0 ? [] : [{ start, end: start + binding.handle.length + 1, handle: binding.handle, title: binding.currentTitle, valid, kind: "agent" as const, agentId: binding.agentId }];
      })}
      mentionBindings={valid ? bindings : []} canSend={valid} onFiles={() => {}} onPastedText={() => {}}
      onPasteError={() => {}} onHighlightChange={() => {}} onSuppressMenu={() => {}} onApplySuggestion={() => {}}
      onClearRequiredRecipient={() => setRemoved(true)} onSend={() => { sends.current++; }} />
    <button onMouseDown={event => event.preventDefault()} onClick={() => setMetadata(value => value + 1)}>Refresh metadata</button>
    <button onMouseDown={event => event.preventDefault()} onClick={() => setOutput(JSON.stringify({
      text: editor.current?.getCanonicalText(), sends: sends.current, selection: editor.current?.getSelectionOffsets(), metadata, nativeTrace: nativeTrace.current,
      dom: document.querySelector('[contenteditable="true"]')?.textContent,
      nativeSelection: { text: getSelection()?.toString(), anchor: getSelection()?.anchorOffset, focus: getSelection()?.focusOffset },
      geometry: [document.querySelector('[contenteditable="true"]'), document.querySelector('[contenteditable="true"] p'),
        ...document.querySelectorAll('[data-composer-mention="true"]')].map(element => element?.getBoundingClientRect().toJSON()),
      activeElement: document.activeElement?.getAttribute("aria-label"),
    }))}>Inspect</button>
    <output aria-label="Regression result">{output}</output>
  </div></ThemeProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
