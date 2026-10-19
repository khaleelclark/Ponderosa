import { RICH_MESSAGE_MAX_BLOCKS } from "@ponderosa/core";

interface Node {
  type: string;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  children?: Node[];
  position?: { start: { line: number; offset?: number }; end: { line: number; offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, string> };
}

export function closedPonderosaFence(source: string, node: Node): boolean {
  if (node.lang?.toLowerCase() !== "ponderosa" || node.meta) return false;
  const start = node.position?.start.offset, end = node.position?.end.offset;
  if (start === undefined || end === undefined || end <= start) return false;
  const lines = source.slice(start, end).split(/\r\n?|\n/);
  if (lines.length < 2) return false;
  const open = /^(`{3,}|~{3,})[\t ]*ponderosa[\t ]*$/i.exec(lines[0]!);
  const close = /^[\t >]*(`+|~+)[\t ]*$/.exec(lines.at(-1)!);
  return Boolean(open && close && open[1]![0] === close[1]![0] && close[1]!.length >= open[1]!.length);
}

/** Authored prose breaks, never the separator text generated later by remark-rehype. */
export function remarkMessageFormatting() {
  return (tree: Node, file: { value: unknown }): void => {
    const source = String(file.value), lines = source.split(/\r\n?|\n/);
    let richBlocks = 0;
    const visit = (node: Node): void => {
      if (node.type === "code") {
        if (closedPonderosaFence(source, node) && richBlocks++ < RICH_MESSAGE_MAX_BLOCKS) {
          node.data = { ...node.data, hProperties: { ...node.data?.hProperties, "data-ponderosa-closed": "true" } };
        }
        return;
      }
      if (!node.children || node.type === "inlineCode" || node.type === "html") return;
      const children = node.children;
      children.forEach(visit);
      node.children = children.flatMap((child, index) => {
        const result: Node[] = [];
        const previous = children[index - 1];
        if (["root", "blockquote", "listItem"].includes(node.type) && previous?.position && child.position) {
          const end = previous.position.end.line, start = child.position.start.line;
          const extra = start - end - 2;
          if (extra > 0 && lines.slice(end, start - 1).every(line => /^[\t >]*$/.test(line))) {
            result.push({ type: "paragraph", children: [], data: { hName: "div", hProperties: {
              style: `height:${extra}lh`, "aria-hidden": "true", "data-authored-blank-lines": String(extra),
            } } });
          }
        }
        if (child.type === "text" && child.value?.includes("\n")) {
          child.value.split("\n").forEach((value, index) => {
            if (index) result.push({ type: "break" });
            result.push({ type: "text", value });
          });
        } else result.push(child);
        return result;
      });
    };
    visit(tree);
  };
}
