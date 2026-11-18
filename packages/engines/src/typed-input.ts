import { requireRuntimeInputFileBudget, type RuntimeInputFile, type RuntimeInputMaterial, type RuntimeTurnInput } from "@ponderosa/core";
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readFileSync } from "@ponderosa/native-host/fs";
import path from "node:path";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Revalidate the admitted bytes immediately before constructing native input. */
function bytes(material: RuntimeInputMaterial): Buffer {
  if (!path.isAbsolute(material.localPath) || !Number.isSafeInteger(material.byteLength) ||
      material.byteLength < 0 || !/^[a-f0-9]{64}$/u.test(material.sha256))
    throw new Error("Typed input has an invalid immutable-file binding");
  const fd = openSync(material.localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size !== material.byteLength)
      throw new Error("Typed input file changed after admission");
    const body = readFileSync(fd);
    if (body.length !== material.byteLength || createHash("sha256").update(body).digest("hex") !== material.sha256)
      throw new Error("Typed input file digest changed after admission");
    return body;
  } finally { closeSync(fd); }
}

function files(input: RuntimeTurnInput): RuntimeInputFile[] {
  const selected = input.inputFiles ?? [];
  requireRuntimeInputFileBudget(selected);
  for (const file of selected) bytes(file.original);
  return selected;
}

export type CodexTypedInput = { type: "text"; text: string; text_elements: [] } | { type: "localImage"; path: string };
export function codexTurnContent(input: RuntimeTurnInput, prompt = input.prompt): CodexTypedInput[] {
  const content: CodexTypedInput[] = [{ type: "text", text: prompt, text_elements: [] }];
  for (const file of files(input)) {
    const image = file.image ?? file.original;
    if (IMAGE_TYPES.has(image.mediaType)) {
      if (file.image) bytes(image);
      content.push({ type: "localImage", path: image.localPath });
    }
  }
  return content;
}

export type ClaudeTypedInput = { type: "text"; text: string } | {
  type: "image" | "document";
  source: { type: "base64"; media_type: string; data: string };
};
export function claudeTurnContent(input: RuntimeTurnInput, prompt = input.prompt): ClaudeTypedInput[] {
  const content: ClaudeTypedInput[] = [{ type: "text", text: prompt }];
  for (const file of files(input)) {
    const image = file.image ?? file.original;
    if (IMAGE_TYPES.has(image.mediaType)) content.push({ type: "image", source: {
      type: "base64", media_type: image.mediaType, data: bytes(image).toString("base64"),
    } });
    else if (file.original.mediaType === "application/pdf") content.push({ type: "document", source: {
      type: "base64", media_type: "application/pdf", data: bytes(file.original).toString("base64"),
    } });
    // Other files retain the exact original-file descriptor in the host prompt.
  }
  return content;
}
