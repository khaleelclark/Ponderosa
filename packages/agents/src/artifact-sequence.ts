import { existsSync, readFileSync } from "@ponderosa/native-host/fs";
import { join } from "node:path";
import { agentDir } from "./paths.js";

/** Reserved by offline restore/repair; canonical event sequences never change. */
export interface ArtifactSequenceReservation { fromSeq: number; offset: number }
export function artifactSequencePath(dataDir: string, projectId: string, agentId: string): string {
  return join(agentDir(dataDir, projectId, agentId), "artifact-sequence.json");
}
export function readArtifactSequenceReservation(dataDir: string, projectId: string, agentId: string): ArtifactSequenceReservation | undefined {
  const file = artifactSequencePath(dataDir, projectId, agentId);
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8")) as ArtifactSequenceReservation;
  if (Object.keys(value).sort().join(",") !== "fromSeq,offset" ||
      !Number.isSafeInteger(value.fromSeq) || value.fromSeq < 1 ||
      !Number.isSafeInteger(value.offset) || value.offset < 1) {
    throw new Error("invalid artifact sequence reservation");
  }
  return value;
}
export function reservedArtifactSeq(seq: number, reservation?: ArtifactSequenceReservation): number {
  const result = reservation && seq >= reservation.fromSeq ? seq + reservation.offset : seq;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error("artifact sequence exhausted");
  return result;
}
export function retainedArtifactHighWater(agentId: string, ids: Iterable<string>): number {
  const prefix = `${agentId}:a:`;
  let highest = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const suffix = id.slice(prefix.length);
    if (!/^[1-9][0-9]*:[0-9]+$/u.test(suffix)) throw new Error("invalid retained projection artifact identity");
    const seq = Number(suffix.split(":")[0]);
    if (!Number.isSafeInteger(seq)) throw new Error("retained artifact sequence exhausted");
    highest = Math.max(highest, seq);
  }
  return highest;
}
