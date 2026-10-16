export const replaceDestination = (value: string, nextHandle?: string) =>
  value.replace(
    /(?:^|\s)#([\p{L}\p{N}_-]+)(?=$|\s|[.,!?;:])/gu,
    (match, handle: string) => {
      if (["broadcast", "everyone"].includes(handle.toLocaleLowerCase()))
        return match;
      return nextHandle ? ` #${nextHandle}` : " ";
    },
  );

export const removeHandle = (value: string, handle: string) =>
  value
    .replace(
      new RegExp(
        `(?:^|\\s)#${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|\\s|[.,!?;:])`,
        "iu",
      ),
      " ",
    )
    .replace(/^\s+/u, "");

export function compactPreviewText(text: string, maxLength = 240): string {
  const compact = text.trim().replace(/\s+/g, " ") || "Draft unavailable";
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}
