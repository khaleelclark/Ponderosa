import { parentPort, workerData } from "node:worker_threads";
import { publishManagedArtifactContentInWorker } from "./managed-artifact-files.js";

interface PublicationWorkerInput {
  dataDir: string;
  projectId: string;
  artifactId: string;
  body: Uint8Array;
}

try {
  const input = workerData as PublicationWorkerInput;
  const result = publishManagedArtifactContentInWorker(
    input.dataDir,
    input.projectId,
    input.artifactId,
    Buffer.from(input.body),
  );
  parentPort?.postMessage({ result });
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : String(error),
  });
}
