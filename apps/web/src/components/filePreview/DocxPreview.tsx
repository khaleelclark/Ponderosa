import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { docxParagraphs, readDocxPreview } from "./readDocxPreview";

export default function DocxPreview({ url, title }: { url: string; title: string }): JSX.Element {
  const [result, setResult] = useState<ReturnType<typeof docxParagraphs>>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let disposed = false;
    setResult(undefined); setError(undefined);
    const deadline = setTimeout(() => {
      abort.abort();
      if (!disposed) setError("Word document preview took too long. Try again or download the file.");
    }, 30_000);
    void readDocxPreview(url, abort.signal).then(xml => {
      const preview = docxParagraphs(xml, abort.signal);
      if (!disposed && !abort.signal.aborted) setResult(preview);
    }).catch(error => {
      if (!disposed && !abort.signal.aborted) setError(error instanceof Error && /^(This Word|Word document|The Word|This browser|Invalid Word)/u.test(error.message)
        ? error.message : "Word document could not be previewed. Try again or download it to open it in Word.");
    }).finally(() => clearTimeout(deadline));
    return () => { disposed = true; clearTimeout(deadline); abort.abort(); };
  }, [url, attempt]);
  return <Box aria-label={`Word document preview: ${title}`} sx={{ minWidth: 0 }}>
    {error ? <Alert severity="error" action={<Button color="inherit" onClick={() => setAttempt(value => value + 1)}>Try again</Button>}>{error}</Alert>
      : !result ? <Stack direction="row" spacing={1} role="status" sx={{ p: 2, alignItems: "center" }}><CircularProgress size={20}/><Typography>Loading Word document…</Typography></Stack>
      : <>
        <Typography variant="caption" color="text.secondary">Text preview. Images and exact page layout are not shown; download the file for the original document.</Typography>
        {result.truncated ? <Alert severity="info" sx={{ my: 1 }}>This preview shows only part of the document. Download it for the complete contents.</Alert> : null}
        {result.paragraphs.length ? result.paragraphs.map((paragraph, index) => <Typography
          key={index} component={paragraph.heading ? `h${paragraph.heading}` as "h1" : "p"}
          sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", minHeight: "1em", lineHeight: 1.65,
            fontWeight: paragraph.heading ? 700 : 400, fontSize: paragraph.heading ? "1.15rem" : "inherit", my: 1 }}
        >{paragraph.text}</Typography>) : <Alert severity="info">This document has no text to preview. Download it to view any images or other content.</Alert>}
      </>}
  </Box>;
}
