import { useEffect, useRef, useState, type SetStateAction } from "react";
import type { AssetLimitsDto } from "@ponderosa/core";
import { DEFAULT_ASSET_LIMITS } from "@ponderosa/core";
import { collectAttachments, MAX_FOLDER_ENTRIES, safeFolderPath, type FolderImport } from "./folderAttachments";
import { selectComposerFiles } from "./composerUtils";
import { createClientId } from "../../clientId";
import { readBrowserStorage, writeBrowserStorage, removeBrowserStorage } from "../../browserStorage";

export type LocalFolderImport = FolderImport & { id: string; destination?: string; archiveId?: string };

function readReports(key: string | undefined): LocalFolderImport[] {
  if (!key) return [];
  try {
    const data = JSON.parse(readBrowserStorage("localStorage", key) ?? "null");
    if (data?.version !== 1 || !Array.isArray(data.reports) || data.reports.length > DEFAULT_ASSET_LIMITS.maxAssetsPerMessage) return [];
    const ids = new Set<string>();
    return data.reports.map((item: LocalFolderImport) => {
      const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 && value.length <= limit;
      const path = (value: unknown): value is string => typeof value === "string" && safeFolderPath(value) === value && (value === item.name || value.startsWith(`${item.name}/`));
      const paths = (value: unknown): value is string[] => Array.isArray(value) && value.length <= MAX_FOLDER_ENTRIES && value.every(path) && new Set(value).size === value.length;
      if (!text(item.id, 128) || ids.has(item.id) || !text(item.name, 1024) || item.name.includes("/") || safeFolderPath(item.name) !== item.name ||
          (item.destination !== undefined && !text(item.destination, 512)) || (item.archiveId !== undefined && !text(item.archiveId, 256)) ||
          !paths(item.paths) || !Number.isSafeInteger(item.fileCount) || item.fileCount !== item.paths.length ||
          !paths(item.included) || !Array.isArray(item.excluded) || item.excluded.length > MAX_FOLDER_ENTRIES ||
          item.excluded.some(entry => !entry || !path(entry.path) || !["file", "folder"].includes(entry.kind) || !text(entry.reason, 512) || typeof entry.canInclude !== "boolean") ||
          new Set(item.excluded.map(entry => entry.path)).size !== item.excluded.length ||
          item.included.some(path => !item.excluded.some(entry => entry.path === path && entry.canInclude))) throw new Error("Invalid local folder review");
      ids.add(item.id);
      // Only bounded explanatory metadata is restored. Never bytes or source handles.
      return { id: item.id, name: item.name, destination: item.destination, archiveId: item.archiveId,
        paths: item.paths, fileCount: item.fileCount, excluded: item.excluded.map(({ path, kind, reason, canInclude }) => ({ path, kind, reason, canInclude })), included: item.included, input: [] };
    });
  } catch { return []; }
}

function saveReports(key: string | undefined, reports: LocalFolderImport[]): void {
  if (!key) return;
  if (!reports.length) { removeBrowserStorage("localStorage", key); return; }
  writeBrowserStorage("localStorage", key, JSON.stringify({ version: 1, reports: reports.map(({ id, name, destination, archiveId, paths, fileCount, excluded, included }) =>
    ({ id, name, destination, archiveId, paths, fileCount, excluded, included })) }));
}

/** Exclusion paths and source handles stay in this local draft scope, never in upload metadata. */
export function useFolderImports(options: {
  scope: string;
  storageKey?: string;
  attachmentIds?: ReadonlyMap<File, string>;
  attachmentVersion?: number;
  ready?: boolean;
  retainedAttachmentIds?: readonly string[];
  destination?: string;
  cancellationKey?: string;
  enabled: boolean;
  files: File[];
  limits?: AssetLimitsDto;
  addFiles(files: File[]): void;
  replaceFile(previous: File, replacement: File): void;
  removeFile(index: number): void;
}) {
  const latest = useRef(options); latest.current = options;
  const generation = useRef(0), busy = useRef(false);
  const [preparing, setPreparing] = useState(false), [error, setError] = useState<string>();
  const [state, setState] = useState(() => ({ scope: options.scope, reports: readReports(options.storageKey) }));
  const reports = state.scope === options.scope ? state.reports : [];
  const setReports = (update: SetStateAction<LocalFolderImport[]>) => setState(current => {
    if (current.scope !== options.scope) return current;
    const reports = typeof update === "function" ? update(current.reports) : update;
    return reports === current.reports ? current : { scope: current.scope, reports };
  });
  const [reviewId, setReviewId] = useState<string>();
  const reportsRef = useRef(reports); reportsRef.current = reports;
  useEffect(() => {
    setState({ scope: options.scope, reports: readReports(options.storageKey) }); setReviewId(undefined); setError(undefined); setPreparing(false); busy.current = false;
    return () => { generation.current++; busy.current = false; };
  }, [options.scope, options.storageKey]);
  useEffect(() => {
    generation.current++; busy.current = false; setPreparing(false);
  }, [options.enabled, options.destination, options.cancellationKey]);
  useEffect(() => {
    if (state.scope !== options.scope) return;
    setReports(current => {
      let changed = false;
      const retained = current.flatMap(report => {
        if (report.file && options.files.includes(report.file)) {
          const archiveId = options.attachmentIds?.get(report.file) ?? report.archiveId;
          if (archiveId !== report.archiveId) { changed = true; return [{ ...report, archiveId }]; }
          return [report];
        }
        const file = report.archiveId ? options.files.find(file => options.attachmentIds?.get(file) === report.archiveId) : undefined;
        if (file) { changed = true; return [{ ...report, file }]; }
        if (report.archiveId && (options.retainedAttachmentIds?.includes(report.archiveId) || options.ready === false)) {
          if (report.file) { changed = true; return [{ ...report, file: undefined }]; }
          return [report];
        }
        if ((report.file || report.archiveId) && options.ready !== false) { changed = true; return []; }
        return [report];
      });
      return changed ? retained : current;
    });
  }, [options.files, options.attachmentVersion, options.ready, options.retainedAttachmentIds, state.scope]);
  useEffect(() => {
    if (state.scope === options.scope) saveReports(options.storageKey, state.reports);
  }, [state, options.scope, options.storageKey]);
  const prepare = async (entries: Array<FileSystemEntry | File>, previous?: LocalFolderImport, selected: string[] = []) => {
    if (busy.current || !latest.current.enabled) return;
    busy.current = true;
    const token = ++generation.current, scope = options.scope, destination = options.destination, cancellationKey = options.cancellationKey;
    const active = () => {
      const current = latest.current;
      return token === generation.current && current.scope === scope && current.destination === destination && current.cancellationKey === cancellationKey && current.enabled &&
        (!previous || previous.destination === destination && reportsRef.current.some(report => report.id === previous.id)) &&
        (!previous?.archiveId || Boolean(previous.file)) && (!previous?.file || current.files.includes(previous.file));
    };
    const check = () => { if (!active()) throw new Error("Folder preparation was cancelled because the destination or attachment changed."); };
    setPreparing(true); setError(undefined);
    try {
      const limits = latest.current.limits ?? DEFAULT_ASSET_LIMITS;
      const others = latest.current.files.filter(file => file !== previous?.file);
      const maxBytes = Math.min(limits.maxFileBytes, limits.maxMessageBytes - others.reduce((sum, file) => sum + file.size, 0));
      const result = await collectAttachments(entries, maxBytes, check, new Set([...(previous?.included ?? []), ...selected]),
        new Map(previous?.excluded.map(item => [item.path, item.kind])));
      check();
      if (previous && (result.folders.length !== 1 || result.folders[0]?.name !== previous.name))
        throw new Error(`${previous.name}: Select the original folder to rebuild this attachment; the attachment was not changed.`);
      const missing = previous?.paths.find(path => !result.folders[0]?.paths.includes(path));
      if (missing) throw new Error(`${missing}: A previously included file is no longer available. Select the folder again; the attachment was not changed.`);
      const currentLimits = latest.current.limits ?? DEFAULT_ASSET_LIMITS;
      const selection = selectComposerFiles(latest.current.files.filter(file => file !== previous?.file), result.files, currentLimits);
      if (selection.error) throw new Error(selection.error);
      const pendingRoots = reportsRef.current.filter(report => report.id !== previous?.id && !report.file).length;
      if (latest.current.files.filter(file => file !== previous?.file).length + result.files.length + pendingRoots + result.folders.filter(report => !report.file).length > currentLimits.maxAssetsPerMessage)
        throw new Error(`The draft can hold at most ${currentLimits.maxAssetsPerMessage} files or pending folder imports. Remove a folder or file and retry; nothing was attached.`);
      const next = result.folders.map(report => ({
        ...report,
        excluded: [...report.excluded, ...(previous?.excluded.filter(item => !report.excluded.some(current => current.path === item.path)) ?? [])],
        id: previous?.id ?? createClientId(), destination,
      }));
      if (next.some(report => report.excluded.length > MAX_FOLDER_ENTRIES))
        throw new Error("The folder review exceeds 2,048 items. Remove this folder and select it again; the attachment was not changed.");
      if (previous?.file && result.files[0]) latest.current.replaceFile(previous.file, result.files[0]);
      else latest.current.addFiles(result.files);
      setReports(current => [...current.filter(report => report.id !== previous?.id), ...next]);
      const allExcluded = next.find(report => !report.file && report.excluded.length);
      if (allExcluded) setReviewId(allExcluded.id);
    } catch (failure) {
      if (active())
        setError(failure instanceof Error ? failure.message : "The folder could not be prepared. Select it again.");
    } finally {
      if (token === generation.current && latest.current.scope === scope) { busy.current = false; setPreparing(false); }
    }
  };
  return {
    reports: reports.filter(report => report.destination === options.destination), preparing, error, reviewId,
    review: setReviewId,
    importFiles: (entries: Array<FileSystemEntry | File>) => prepare(entries),
    include: (report: LocalFolderImport, selected: string[], reselected?: File[]) => prepare(reselected ?? report.input, report, selected),
    remove: (report: LocalFolderImport) => {
      if (!latest.current.enabled || report.destination !== latest.current.destination || !reportsRef.current.some(item => item.id === report.id) || (report.archiveId && !report.file)) return;
      if (report.file) { const index = latest.current.files.indexOf(report.file); if (index >= 0) latest.current.removeFile(index); }
      setReports(current => current.filter(item => item.id !== report.id));
      setReviewId(undefined);
    },
  };
}
