import { useEffect, useId, useRef, useState } from "react";
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Stack, Typography } from "@mui/material";
import { folderExclusion, FOLDER_PICKER_NOTE } from "./folderAttachments";
import type { useFolderImports, LocalFolderImport } from "./useFolderImports";

export function FolderImportReview({ imports, files, disabled }: {
  imports: ReturnType<typeof useFolderImports>; files: File[]; disabled: boolean;
}): JSX.Element {
  const titleId = useId();
  const report = imports.reports.find(item => item.id === imports.reviewId);
  const [selected, setSelected] = useState<string[]>([]);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const reselect = useRef<{ report: LocalFolderImport; selected: string[] }>();
  const loadingArchive = Boolean(report?.archiveId && !report.file);
  const sourceMissing = Boolean(report && !report.input.length);
  useEffect(() => setSelected([]), [report?.id, report?.included]);
  const directAdvisory = files.some(file => !imports.reports.some(item => item.file === file) && folderExclusion(file.name));
  return <Box sx={{ minWidth: 0 }}>
    {imports.reports.map(item => <Stack key={item.id} direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center" sx={{ px: 1.5, py: 0.5 }}>
      <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>{item.name}: {item.excluded.some(entry => !item.included.includes(entry.path)) ? "Items Excluded" : item.file || item.archiveId || item.fileCount ? item.excluded.length ? "Import Details" : "Folder Imported" : "Empty Folder"}</Typography>
      <Button size="small" onClick={() => imports.review(item.id)}>{item.excluded.some(entry => !item.included.includes(entry.path)) ? "Review Excluded Items" : "Review Folder"}</Button>
    </Stack>)}
    {directAdvisory ? <Typography variant="caption" component="p" sx={{ px: 1.5 }}>Individual files are attached as selected. Folder imports exclude likely credentials and metadata by default; file contents are not inspected.</Typography> : null}
    {imports.error && !report ? <Alert severity="error">{imports.error}</Alert> : null}
    <Dialog data-folder-import-review open={Boolean(report)} onClose={() => imports.review(undefined)} fullWidth maxWidth="sm" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>{report?.excluded.length ? "Review Excluded Items" : "Review Folder"}</DialogTitle>
      <DialogContent>
        {report ? <Stack spacing={1}>
          {imports.error ? <Alert severity="error">{imports.error}</Alert> : null}
          <Typography sx={{ overflowWrap: "anywhere" }}>{report.name}</Typography>
          <Typography variant="body2">{report.fileCount} included files · {report.excluded.filter(item => item.kind === "file" && !report.included.includes(item.path)).length} excluded files · {report.excluded.filter(item => item.kind === "folder" && !report.included.includes(item.path)).length} excluded folders</Typography>
          <Typography variant="caption">Counts cover files supplied by your browser. {FOLDER_PICKER_NOTE}</Typography>
          <Typography variant="caption">Excluded folder contents were not counted. These decisions use names, not a content scan. Include only items you intend to share.</Typography>
          {loadingArchive ? <Typography role="status">This attachment must finish restoring before it can be changed.</Typography> : sourceMissing ? <Typography>Select the original folder again to include files.</Typography> : null}
          {!report.file && !report.archiveId && <Typography>{report.excluded.length ? "No files are attached yet. Include selected items below or remove this folder." : "This folder contains no files. Choose a different folder."}</Typography>}
          {report.excluded.map(item => <Box key={item.path} sx={{ overflowWrap: "anywhere" }}>
            <FormControlLabel disableTypography sx={{ m: 0, width: "100%", alignItems: "flex-start" }} control={<Checkbox disabled={!item.canInclude || report.included.includes(item.path) || disabled || imports.preparing || loadingArchive} checked={selected.includes(item.path) || report.included.includes(item.path)} onChange={(_event, checked) => setSelected(current => checked ? [...current, item.path] : current.filter(path => path !== item.path))} />} label={<Box component="span" sx={{ minWidth: 0, flex: 1, pt: 0.75 }}><Typography component="span" variant="body2" sx={{ display: "block" }}>{item.path}</Typography><Typography variant="caption" component="span" sx={{ display: "block" }}>{item.kind === "folder" ? "Folder" : "File"} · {item.reason}{report.included.includes(item.path) ? " · Included" : !item.canInclude ? " · Excluded automatically" : ""}</Typography></Box>} />
          </Box>)}
        </Stack> : null}
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap" }}>
        <Button disabled={disabled || imports.preparing || loadingArchive} onClick={() => report && imports.remove(report)}>Remove Folder</Button>
        <Button onClick={() => imports.review(undefined)}>Close</Button>
        <input hidden multiple type="file" aria-label="Reselect Folder" ref={element => { folderInput.current = element; if (element) element.webkitdirectory = true; }} onChange={event => {
          const request = reselect.current; reselect.current = undefined;
          const files = Array.from(event.target.files ?? []); event.target.value = "";
          if (request && files.length) void imports.include(request.report, request.selected, files);
        }} />
        <Button disabled={disabled || imports.preparing || loadingArchive || (!selected.length && !sourceMissing)} onClick={() => {
          if (!report) return;
          if (sourceMissing) { reselect.current = { report, selected: [...selected] }; folderInput.current?.click(); }
          else void imports.include(report, selected);
        }}>{imports.preparing ? "Preparing…" : sourceMissing ? "Select Folder Again" : "Include Selected Items"}</Button>
      </DialogActions>
    </Dialog>
  </Box>;
}
