import type { CommunicationDocumentReference, ImageAttachmentDto } from "@ponderosa/core";

export interface TranscriptMessage {
  author: string;
  text: string;
  createdAt?: string;
  attachments?: ImageAttachmentDto[];
  document?: CommunicationDocumentReference;
}

function headingText(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "Unknown author";
  return normalized.replace(/([\\`*_[\]<>#])/g, "\\$1");
}

function linkLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1");
}

function attachmentReference(attachment: ImageAttachmentDto): string {
  const url = attachment.downloadUrl ?? attachment.url;
  const label = `Attachment: ${linkLabel(attachment.name)}`;
  return url ? `- [${label}](<${url.replace(/>/g, "%3E")}>)` : `- ${label}`;
}

/**
 * Formats only the human-facing message projection supplied by a chat view.
 * Execution events are deliberately not accepted by this boundary.
 */
export function buildMarkdownTranscript(title: string, messages: TranscriptMessage[]): string {
  const sections = messages.map((message) => {
    const timestamp = message.createdAt ? ` · ${message.createdAt}` : "";
    const body = message.text.trim();
    const references = [
      ...(message.attachments ?? []).map(attachmentReference),
      ...(message.document
        ? [`- [Document: ${linkLabel(message.document.title)}](<${message.document.downloadUrl.replace(/>/g, "%3E")}>)`]
        : []),
    ];
    return [
      `## ${headingText(message.author)}${timestamp}`,
      body,
      references.length ? `**Attachments**\n\n${references.join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  });
  return [`# ${headingText(title)}`, ...sections].join("\n\n").trimEnd() + "\n";
}

export function transcriptFileName(title: string): string {
  const safe = title
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLocaleLowerCase()
    .slice(0, 80);
  return `${safe || "chat"}-transcript.md`;
}

export function downloadMarkdownTranscript(markdown: string, fileName: string): void {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
