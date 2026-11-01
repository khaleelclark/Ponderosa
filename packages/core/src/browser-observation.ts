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
export interface BrowserRecordingDestination {projectId: string; conversationId: string}
export interface BrowserRecordingArtifact {
  /** Only shared operator recordings have a Chat destination, without an originating Agent/Run. */
  destination?: BrowserRecordingDestination;
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

/** Operator observations use existing browser-route ownership, never a Run capability. */
export interface BrowserOperatorObservationContext {
  /** Required for saved-browser recording start/stop/status; Chat browsers reject a different Chat. */
  destination?: {conversationId: string};
  sessionId: string;
  expectedControlEpoch: number;
}
export interface BrowserOperatorConsoleRequest extends BrowserOperatorObservationContext {
  query: BrowserConsoleQuery & {pageId: string};
}
export interface BrowserOperatorRecordingStartRequest extends BrowserOperatorObservationContext {
  pageId: string;
}
export interface BrowserOperatorRecordingStopRequest extends BrowserOperatorObservationContext {
  recordingId: string;
}
/** Managed receipt is also recoverable through recording/status after a lost response. */
export interface BrowserOperatorRecordingResult extends BrowserRecordingArtifact {
  downloadUrl: string;
}
export interface BrowserOperatorRecordingState {
  destination?: BrowserRecordingDestination;
  recording?: BrowserRecordingStatus;
  artifact?: BrowserRecordingArtifact;
}
export interface BrowserOperatorRecordingResponse extends Omit<BrowserOperatorRecordingState, 'artifact'> {
  artifact?: BrowserOperatorRecordingResult;
}
/** Supply an existing owned-browser REST base; this client does not acquire ownership or retry requests. */
export class BrowserOperatorObservationClient {
  constructor(private readonly post: <T>(suffix: string, input: object) => Promise<T>) {}
  console(input: BrowserOperatorConsoleRequest) { return this.post<BrowserConsoleResult>('observations/console', input); }
  startRecording(input: BrowserOperatorRecordingStartRequest) { return this.post<BrowserRecordingStatus>('observations/recording/start', input); }
  stopRecording(input: BrowserOperatorRecordingStopRequest) { return this.post<BrowserOperatorRecordingResult>('observations/recording/stop', input); }
  recordingStatus(input: BrowserOperatorObservationContext) { return this.post<BrowserOperatorRecordingResponse>('observations/recording/status', input); }
}
