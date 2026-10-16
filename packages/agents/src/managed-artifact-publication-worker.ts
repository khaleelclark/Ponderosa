import { parentPort, workerData } from "node:worker_threads";
import { publishManagedArtifactContentInWorker } from "./managed-artifact-files.js";

interface PublicationWorkerInput {
  dataDir: string;
  projectId: string;
  artifactId?: string;
  body?: Uint8Array;
  entries?: Array<{ artifactId: string; body: Uint8Array }>;
}

try {
  const input = workerData as PublicationWorkerInput;
  if (input.entries) {
    const results = input.entries.map(({ artifactId, body }) =>
      publishManagedArtifactContentInWorker(
        input.dataDir,
        input.projectId,
        artifactId,
        Buffer.from(body),
      ));
    parentPort?.postMessage({ results });
  } else if (input.artifactId && input.body) {
    const result = publishManagedArtifactContentInWorker(
      input.dataDir,
      input.projectId,
      input.artifactId,
      Buffer.from(input.body),
    );
    parentPort?.postMessage({ result });
  } else {
    throw new Error("managed artifact worker input is invalid");
  }
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : String(error),
  });
}
