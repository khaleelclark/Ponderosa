#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { restoreContent } from "../dist/offline-content-restore.js";
import { AssetStore } from "../../../apps/server/dist/assets.js";
import { AssetAuthority } from "../../../apps/server/dist/asset-authority.js";

const { values } = parseArgs({ options: {
  prod: { type: "string" }, "prod-index-sha256": { type: "string" },
  dev: { type: "string" }, "dev-index-sha256": { type: "string" },
  output: { type: "string" }, "document-supplement": { type: "string" },
  "document-supplement-sha256": { type: "string" },
  "upload-supplement": { type: "string" }, "upload-supplement-sha256": { type: "string" },
} });
if (!values.output) throw new Error("--output must name a nonexistent directory beneath an existing parent");
const sources = ["prod", "dev"].filter(channel => values[channel]).map(channel => ({
  channel, directory: values[channel], indexSha256: values[`${channel}-index-sha256`],
}));
const receipt = restoreContent({ sources, output: values.output,
  validateRecoveredUploads(dataDirectory, uploads) {
    const assets = new AssetStore(dataDirectory);
    try {
      for (const upload of uploads) {
        if (!assets.authoritativeRuntimeAttachment(upload.projectId, upload.agentId, upload.id)) {
          throw new Error(`recovered upload fails current metadata or image validation: ${upload.id}`);
        }
      }
    } finally { assets.close(); }
  },
  encodePngPreview(original) {
    const assets = new URL("../../../apps/server/dist/assets.js", import.meta.url).href;
    const script = `import { prepareAssetUpload } from ${JSON.stringify(assets)};
      const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
      const prepared = await prepareAssetUpload({ body: Buffer.concat(chunks), name: "restored.jpg", declaredType: "image/jpeg" });
      process.stdout.write(prepared.preview);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      input: original, timeout: 30000, maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`PNG preview encoding failed: ${result.stderr}`);
    return result.stdout;
  },
  registerDocumentArtifacts(dataDirectory, artifacts) {
    const authority = new AssetAuthority(dataDirectory);
    try {
      for (const artifact of artifacts) authority.registerRuntimeArtifact(artifact);
    } finally { authority.close(); }
  },
  registerGeneratedArtifacts(dataDirectory, artifacts) {
    const authority = new AssetAuthority(dataDirectory);
    try {
      for (const artifact of artifacts) authority.registerGeneratedArtifact(artifact);
    } finally {
      authority.close();
    }
  },
  ...(values["document-supplement"] ? { documentSupplement: {
    directory: values["document-supplement"], manifestSha256: values["document-supplement-sha256"],
  } } : {}),
  ...(values["upload-supplement"] ? { uploadSupplement: { directory: values["upload-supplement"], manifestSha256: values["upload-supplement-sha256"] } } : {}),
});
console.log(JSON.stringify(receipt, null, 2));
