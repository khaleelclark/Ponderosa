import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// Exact LICENSE/CREDITS wording approved for the first public release.
export const firstPartyNotices = {
  LICENSE: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  "CREDITS.md": "3f17313264955afa83dd29fb83392a09cfee0b9517473c152970e9e73cdae556",
};

export function verifyFirstPartyNotices(root) {
  for (const [filename, expected] of Object.entries(firstPartyNotices)) {
    const content = readFileSync(path.join(root, filename));
    if (createHash("sha256").update(content).digest("hex") !== expected) {
      throw new Error(`First-party ${filename} differs from the approved release wording.`);
    }
  }
}
