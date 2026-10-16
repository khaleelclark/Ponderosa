import { messageTagTokens } from "@ponderosa/core";
import type { AgentMentionBindingDto } from "@ponderosa/core";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const markdown = unified().use(remarkParse).use(remarkGfm);
const opaqueTypes = new Set(["link", "linkReference", "image", "imageReference", "code", "inlineCode", "html", "definition"]);

/** JSON embedded in prose is literal data, including strings containing #handles. */
function serializedDataRanges(text: string, opaqueRanges: Array<[number, number]>): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const stack: number[] = [];
  let quoted = false;
  let escaped = false;
  let opaqueIndex = 0;
  for (let index = 0; index < text.length; index++) {
    while (opaqueRanges[opaqueIndex] && opaqueRanges[opaqueIndex]![1] <= index) opaqueIndex++;
    const opaque = opaqueRanges[opaqueIndex];
    // Opaque Markdown cannot open a JSON candidate. A link/code span already
    // inside a JSON string remains part of that candidate's original bytes.
    if (opaque?.[0] === index && !quoted) {
      stack.length = 0;
      escaped = false;
      index = opaque[1] - 1;
      continue;
    }
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"' && stack.length) quoted = true;
    else if (char === "{" || char === "[") stack.push(index);
    else if ((char === "}" || char === "]") && stack.length) {
      const start = stack.pop()!;
      try {
        JSON.parse(text.slice(start, index + 1));
        ranges.push([start, index + 1]);
      } catch { /* Markdown brackets and ordinary prose are not serialized data. */ }
    }
  }
  return ranges;
}

interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

/** Eligible prose spans shared by source-text and rich-message presentation. */
export function messageProseTagTokens(text: string, tree: MarkdownNode = markdown.parse(text)) {
  try { JSON.parse(text); return []; } catch { /* Serialized scalars are literal too. */ }
  const opaqueRanges: Array<[number, number]> = [];
  const collectOpaque = (node: MarkdownNode): void => {
    if (opaqueTypes.has(node.type)) {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) opaqueRanges.push([start, end]);
      return;
    }
    for (const child of node.children ?? []) collectOpaque(child);
  };
  collectOpaque(tree);
  const dataRanges = serializedDataRanges(text, opaqueRanges);
  const tokens: ReturnType<typeof messageTagTokens> = [];
  const visit = (node: MarkdownNode): void => {
    if (opaqueTypes.has(node.type)) return;
    if (node.type === "text" && node.position) {
      const offset = node.position.start.offset!;
      const source = text.slice(offset, node.position.end.offset);
      for (const token of messageTagTokens(source)) {
        const start = offset + token.start;
        if (dataRanges.some(([from, to]) => start >= from && start < to)) continue;
        // The hash in a numeric character reference is syntax, not a mention.
        if (text[start - 1] === "&" && /^#(?:[xX][\da-fA-F]{1,6}|\d{1,7});/u.test(text.slice(start))) continue;
        const escapes = source.slice(0, token.start).match(/\\+$/u)?.[0].length ?? 0;
        if (escapes % 2) continue;
        tokens.push({ ...token, start, end: offset + token.end });
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return tokens;
}

/** Resolve bound prose mentions without rewriting URLs, code, images or data. */
export function resolveMessageMentionText(
  text: string,
  mentions: readonly AgentMentionBindingDto[] | undefined,
): string {
  if (!mentions?.length || !messageTagTokens(text).length) return text;
  for (const token of messageProseTagTokens(text).reverse()) {
    const binding = mentions.find(mention => mention.handle.toLocaleLowerCase() === token.handle.toLocaleLowerCase());
    if (binding) text = text.slice(0, token.start) + `#${binding.currentHandle}` + text.slice(token.end);
  }
  return text;
}
