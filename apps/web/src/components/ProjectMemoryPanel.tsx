import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from "@mui/material";
import type { MemoryDto, MemoryRevisionDto } from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { currentProductScope } from "../api/productScope";
import { api } from "../api";
import { ApiRequestError } from "../api/types";
import { createClientId } from "../clientId";
import { queryKeys } from "../queryKeys";
import { retainIdempotentAttempt, type IdempotentAttempt } from "./idempotentAttempt";

type Prepared = { operation: "save" | "update" | "forget"; text: string; record?: MemoryDto };
type Availability = "closed" | "loading" | "ready" | "unavailable" | "denied" | "error";
const validText = (text: string): boolean => Boolean(text.trim()) && !text.includes("\0") && [...text].length <= 10000;
const textStyle = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 240, overflowY: "auto" } as const;

export function ProjectMemoryPanel(props: { projectId: string; projectLabel: string; pinecone?: boolean }): JSX.Element {
  const product = currentProductScope();
  return <ScopedProjectMemoryPanel key={`${product}:${props.projectId}`} {...props} product={product} />;
}

function ScopedProjectMemoryPanel({ projectId, projectLabel, product, pinecone }: {
  projectId: string; projectLabel: string; pinecone?: boolean; product: "dev" | "branches";
}): JSX.Element {
  const client = useQueryClient();
  const prefix = queryKeys.projectMemories.project(product, projectId);
  const epoch = useRef(0);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const attempt = useRef<IdempotentAttempt<Prepared>>();
  const [availability, setAvailability] = useState<Availability>("closed");
  const [records, setRecords] = useState<MemoryDto[]>([]);
  const [current, setCurrent] = useState<MemoryDto>();
  const [history, setHistory] = useState<MemoryRevisionDto[]>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<"new" | MemoryDto>();
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<Prepared>();
  const [pending, setPending] = useState(false);
  const [ambiguous, setAmbiguous] = useState(false);
  const [message, setMessage] = useState("");
  const [readPending, setReadPending] = useState(false);

  function purge(): void {
    epoch.current++;
    void client.cancelQueries({ queryKey: prefix });
    client.removeQueries({ queryKey: prefix });
    setRecords([]); setCurrent(undefined); setHistory(undefined); setHistoryOpen(false);
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; epoch.current++;
      void client.cancelQueries({ queryKey: queryKeys.projectMemories.project(product, projectId) });
      client.removeQueries({ queryKey: queryKeys.projectMemories.project(product, projectId) });
    };
  }, [client, product, projectId]);

  function failedRead(error: unknown): void {
    purge();
    if (!attempt.current) { setEditor(undefined); setDraft(""); setPreview(undefined); }
    const status = error instanceof ApiRequestError ? error.status : undefined;
    setAvailability(status === 404 ? "unavailable" : status === 401 || status === 403 ? "denied" : "error");
    setMessage(status === 404 ? "Memory management is unavailable in this installation or Project."
      : status === 401 || status === 403 ? "Memory access is unavailable. Sign in or check access, then retry."
      : "Memory could not be read. Retry to check availability.");
  }
  async function read<T>(key: readonly unknown[], load: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void): Promise<void> {
    const generation = ++epoch.current;
    setReadPending(true);
    try {
      const value = await client.fetchQuery({ queryKey: key, queryFn: ({ signal }) => load(signal),
        retry: false, staleTime: 0, gcTime: 0 });
      if (!alive.current || generation !== epoch.current) return;
      setAvailability("ready"); apply(value);
    } catch (error) {
      if (alive.current && generation === epoch.current) failedRead(error);
    } finally {
      if (alive.current && generation === epoch.current) setReadPending(false);
    }
  }
  async function list(search = ""): Promise<void> {
    purge(); setReadPending(false); setAvailability("loading");
    await read(queryKeys.projectMemories.list(product, projectId, search),
      signal => search ? api.searchProjectMemories(projectId, search, signal).then(r => r.memories)
        : api.listProjectMemories(projectId, signal), setRecords);
  }
  useEffect(() => { if (pinecone) void list(); }, [pinecone, projectId]);
  async function detail(id: string): Promise<void> {
    setCurrent(undefined); setHistory(undefined); setHistoryOpen(false);
    await read(queryKeys.projectMemories.detail(product, projectId, id), signal => api.getProjectMemory(projectId, id, signal), setCurrent);
  }
  async function revisions(): Promise<void> {
    if (!current) return;
    setHistory(undefined); setHistoryOpen(true);
    await read(queryKeys.projectMemories.history(product, projectId, current.memoryId),
      signal => api.getProjectMemoryHistory(projectId, current.memoryId, signal), setHistory);
  }
  async function correct(): Promise<void> {
    if (!current) return;
    const id = current.memoryId;
    await read(queryKeys.projectMemories.detail(product, projectId, id), signal => api.getProjectMemory(projectId, id, signal), record => {
      setCurrent(record);
      if (record.sourceBacked !== false || record.sources.length > 0) {
        setMessage("Correction is read-only: this record's source provenance cannot be safely replaced here."); return;
      }
      setEditor(record); setDraft(record.text); setMessage("");
    });
  }
  function review(prepared: Prepared): void {
    if (inFlight.current || ambiguous || availability !== "ready") return;
    attempt.current = retainIdempotentAttempt(undefined, JSON.stringify(prepared), createClientId, () => prepared);
    setPreview(attempt.current.prepared); setMessage("");
  }
  function cancelPreview(): void {
    if (inFlight.current || ambiguous) return;
    attempt.current = undefined; setPreview(undefined);
  }
  async function submit(): Promise<void> {
    const selected = attempt.current;
    if (!selected || inFlight.current || availability !== "ready") return;
    inFlight.current = true; setPending(true);
    const p = selected.prepared, record = p.record;
    // Invalidate any history response before Forget can commit.
    if (p.operation === "forget") { purge(); setReadPending(false); }
    try {
      const receipt = p.operation === "save" ? await api.saveProjectMemory(projectId, p.text, selected.idempotencyKey)
        : p.operation === "update" && record ? await api.updateProjectMemory(projectId, record.memoryId, record.revision,
          { text: p.text, classification: record.classification, ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}) }, selected.idempotencyKey)
        : await api.forgetProjectMemory(projectId, record!.memoryId, record!.revision, selected.idempotencyKey);
      if (!alive.current) return;
      attempt.current = undefined; setAmbiguous(false); setPreview(undefined); setEditor(undefined); setDraft("");
      purge();
      setMessage(p.operation === "forget" ? pinecone ? "Pinecone won’t use this memory anymore. Past messages are unchanged." : "Forgotten from normal reads. Permanent erasure is not promised."
        : pinecone ? "Remembered for Pinecone." : `Saved revision ${receipt.revision}. Available for keyword search.`);
      await list();
    } catch (error) {
      if (!alive.current) return;
      const status = error instanceof ApiRequestError ? error.status : undefined;
      if (status === undefined || status >= 500 || status === 408 || status === 429) {
        setAmbiguous(true);
        setMessage("Outcome unknown. Retry this exact attempt to check its result; it may already have committed. Reloading loses this retry state.");
      } else {
        attempt.current = undefined; setAmbiguous(false); setPreview(undefined);
        if (status === 401 || status === 403 || status === 404) failedRead(error);
        else if (status === 409) {
          setMessage("Revision or command changed. Your draft is kept. Reload the current record and review again before confirming.");
          if (record) await read(queryKeys.projectMemories.detail(product, projectId, record.memoryId),
            signal => api.getProjectMemory(projectId, record.memoryId, signal), value => {
              setCurrent(value);
              if (p.operation === "update") setEditor(value);
            });
        } else setMessage(`Memory was not accepted: ${error instanceof Error ? error.message : "request failed"}`);
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setPending(false);
    }
  }
  const ready = availability === "ready";
  const blocked = !ready || pending || ambiguous || readPending;
  const editable = current && current.sourceBacked === false && !current.sources.length;
  return <Box component="section" aria-label="Project memory" sx={{ borderTop: 1, borderColor: "divider", pt: 2, minWidth: 0 }}>
    <Stack spacing={1.5}>
      <Typography variant="h6" component="h3">{pinecone ? "Saved facts and preferences" : "Project memory"}</Typography>
      <Typography variant="body2">{pinecone ? "Write, search, correct or forget useful context for Pinecone." : `${projectLabel} · Keyword search only. Semantic recall, message Remember and global management are unavailable here.`}</Typography>
      {availability === "closed" ? <Button variant="outlined" onClick={() => void list()}>Open Project memory</Button> : <>
        {message && <Alert severity={ambiguous || !ready ? "warning" : "info"}>{message}</Alert>}
        {availability === "loading" && <Typography role="status">Reading memory…</Typography>}
        {!ready && availability !== "loading" && <Button onClick={() => void list()}>Retry memory access</Button>}
        {ready && <>
          <Stack component="form" direction={{ xs: "column", sm: "row" }} spacing={1} onSubmit={event => { event.preventDefault(); if (!blocked && (!query.trim() || validText(query))) void list(query.trim()); }}>
            <TextField label={pinecone ? "Search memories" : "Search Project memory"} value={query} onChange={e => setQuery([...e.target.value].slice(0, 10001).join(""))} fullWidth disabled={pending || ambiguous} />
            <Button type="submit" disabled={blocked || (!!query.trim() && !validText(query))}>Search</Button>
            <Button onClick={() => { setQuery(""); void list(); }} disabled={blocked}>Refresh</Button>
          </Stack>
          <Button variant="outlined" disabled={blocked} onClick={() => { setEditor("new"); setDraft(""); setMessage(""); }}>Write a memory</Button>
          <Box aria-label="Memory results" sx={{ maxHeight: 360, overflowY: "auto", minWidth: 0 }}>
            {!records.length && !readPending && <Typography>No memories found.</Typography>}
            {records.map(record => <Button key={record.memoryId} fullWidth disabled={pending || ambiguous || readPending}
              sx={{ justifyContent: "flex-start", textAlign: "left", overflowWrap: "anywhere", textTransform: "none" }} onClick={() => void detail(record.memoryId)}>
              {record.text.slice(0, 180)}{!pinecone && ` · revision ${record.revision}`}
            </Button>)}
            {records.length === 20 && <Typography variant="caption">Showing at most 20 results. Narrow your search for others.</Typography>}
          </Box>
          {current && <Box component="section" aria-label="Current memory" sx={{ minWidth: 0 }}>
            <Typography variant="caption">Revision {current.revision} · {current.classification === "user_statement" ? "User statement" : "Agent inference"} · {current.createdAt}{current.expiresAt ? ` · Expires ${current.expiresAt}` : ""}</Typography>
            <Typography tabIndex={0} sx={textStyle}>{current.text}</Typography>
            {!editable && <Typography variant="body2">Correction is read-only because source provenance cannot be safely replaced here.</Typography>}
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
              <Button disabled={blocked || !editable} onClick={() => void correct()}>Correct memory</Button>
              <Button disabled={blocked} onClick={() => void revisions()}>Revision history</Button>
              <Button color="error" disabled={pending || ambiguous || !ready} onClick={() => review({ operation: "forget", text: "", record: current })}>Forget memory</Button>
            </Stack>
          </Box>}
        </>}
      </>}
    </Stack>
    <Dialog open={ready && editor !== undefined && !preview} onClose={() => { if (!pending && !ambiguous) { setEditor(undefined); setDraft(""); } }} fullWidth maxWidth="sm" aria-labelledby="memory-editor-title">
      <DialogTitle id="memory-editor-title">{pinecone ? editor === "new" ? "Remember something" : "Correct memory" : editor === "new" ? "Write a Project memory" : "Correct Project memory"}</DialogTitle>
      <DialogContent>
        <Typography variant="body2">Author your own self-contained text. Shared with authorized Agents in {projectLabel}. This does not capture a message or its sources.</Typography>
        {message && <Alert severity="info">{message}</Alert>}
        <TextField label="Memory text" value={draft} onChange={e => setDraft([...e.target.value].slice(0, 10001).join(""))} autoFocus multiline minRows={4} maxRows={12} fullWidth margin="normal"
          helperText={`${[...draft].length} / 10000 code points`} />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { setEditor(undefined); setDraft(""); }}>Cancel</Button>
        <Button disabled={blocked || !validText(draft) || (editor !== "new" && (!editor || editor.sourceBacked !== false || editor.sources.length > 0))}
          onClick={() => review({ operation: editor === "new" ? "save" : "update", text: draft, ...(editor && editor !== "new" ? { record: editor } : {}) })}>Review memory</Button>
      </DialogActions>
    </Dialog>
    <Dialog open={ready && preview !== undefined} onClose={cancelPreview} fullWidth maxWidth="sm" aria-labelledby="memory-preview-title">
      <DialogTitle id="memory-preview-title">{preview?.operation === "forget" ? "Forget this memory?" : pinecone ? "Remember this?" : "Confirm Project memory"}</DialogTitle>
      <DialogContent>
        <Typography>Destination: {projectLabel}{!pinecone && " (Project)"}</Typography>
        {preview?.record && <Typography variant="body2">Expected revision {preview.record.revision} · {preview.record.classification}{preview.record.expiresAt ? ` · Expires ${preview.record.expiresAt}` : ""}</Typography>}
        {preview?.operation === "forget" ? <Typography>All revisions disappear from normal reads. Audits and backups may retain text; permanent erasure is not promised.</Typography>
          : <><Typography>Shared with authorized Agents in this Project. Exact text:</Typography><Typography tabIndex={0} sx={textStyle}>{preview?.text}</Typography></>}
        {message && <Alert severity={ambiguous ? "warning" : "info"}>{message}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button disabled={pending || ambiguous} onClick={cancelPreview}>Back</Button>
        <Button variant="contained" color={preview?.operation === "forget" ? "error" : "primary"} disabled={pending} onClick={() => void submit()}>
          {pending ? "Submitting…" : ambiguous ? "Retry exact attempt" : preview?.operation === "forget" ? "Confirm forget" : pinecone ? "Remember for Pinecone" : "Remember for this Project"}
        </Button>
      </DialogActions>
    </Dialog>
    <Dialog open={ready && historyOpen} onClose={() => { epoch.current++; setReadPending(false); setHistoryOpen(false); setHistory(undefined); void client.cancelQueries({ queryKey: prefix }); client.removeQueries({ queryKey: prefix }); }} fullWidth maxWidth="sm" aria-labelledby="memory-history-title">
      <DialogTitle id="memory-history-title">Revision history</DialogTitle>
      <DialogContent>
        {history ? history.map(revision => <Box key={revision.revision} sx={{ mb: 2 }}><Typography>Revision {revision.revision} · {revision.classification} · {revision.createdAt}</Typography><Typography tabIndex={0} sx={textStyle}>{revision.text}</Typography></Box>) : <Typography role="status">Reading history…</Typography>}
        {history?.length === 20 && <Typography>Showing at most 20 revisions.</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { epoch.current++; setReadPending(false); setHistoryOpen(false); setHistory(undefined); void client.cancelQueries({ queryKey: prefix }); client.removeQueries({ queryKey: prefix }); }}>Close history</Button>
        <Button color="error" disabled={pending || ambiguous || !current} onClick={() => { setHistoryOpen(false); setHistory(undefined); if (current) review({ operation: "forget", text: "", record: current }); }}>Forget memory</Button>
      </DialogActions>
    </Dialog>
  </Box>;
}
