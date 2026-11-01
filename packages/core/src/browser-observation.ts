/** Browser observations belong to the already-authorized owned session. */
export interface BrowserConsoleQuery {
  after?: number;
  limit?: number;
  pageId?: string;
  level?: 'log' | 'info' | 'warning' | 'error';
}
export interface BrowserConsoleEntry {
  sequence: number;
  at: string;
  pageId: string;
  level: 'log' | 'info' | 'warning' | 'error';
  text: string;
}
export interface BrowserConsoleResult {
  entries: BrowserConsoleEntry[];
  next: number;
  /** An eviction occurred since the requested cursor; query does not clear the ring. */
  truncated: boolean;
}
export interface BrowserRecordingStatus {
  id: string;
  pageId: string;
  startedAt: string;
}
/** Timestamped CDP JPEG frames, not an encoded video or audio recording. */
export interface BrowserRecordingData extends BrowserRecordingStatus {
  format: 'ponderosa.browser-recording.v1';
  endedAt: string;
  reason: 'explicit_stop' | 'duration_limit' | 'frame_limit' | 'byte_limit' | 'page_closed';
  frames: { atMs: number; jpeg: string }[];
}
export interface BrowserRecordingArtifact {
  artifactId: string;
  artifactRef: string;
  path: string;
  mediaType: 'application/json';
  frames: number;
  reason: BrowserRecordingData['reason'];
}

/** Agent SDK: uses the existing server-issued Run capability, including saved-browser grants. */
export class BrowserObservationClient {
  constructor(private readonly call: <T>(operation: string, input: object) => Promise<T>) {}
  console(query: BrowserConsoleQuery = {}) { return this.call<BrowserConsoleResult>('console', {query}); }
  startRecording(pageId: string) { return this.call<BrowserRecordingStatus>('recording_start', {page_id: pageId}); }
  stopRecording(recordingId: string) { return this.call<BrowserRecordingArtifact>('recording_stop', {recording_id: recordingId}); }
}
