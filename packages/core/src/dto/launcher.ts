export interface LauncherShutdownReceiptDto {
  schemaVersion: 1;
  generation: string;
  pid: number;
  processBirthMarker?: string;
  state: "pending" | "clean" | "incomplete";
  requestedAt: string;
  updatedAt: string;
  error?: string;
}
