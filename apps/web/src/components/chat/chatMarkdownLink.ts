import { defaultUrlTransform } from "react-markdown";

export const chatMarkdownUrlTransform = (url: string): string =>
  url.startsWith("ponderosa://project-file/") ? url : defaultUrlTransform(url);

export const renderableChatLinkHref = (
  href: string | undefined,
): string | undefined => href || undefined;
