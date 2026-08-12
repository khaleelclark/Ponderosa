import { useTheme } from "@mui/material";
import type { CSSProperties, HTMLProps } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light";
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";

export interface SyntaxHighlightedCodeProps {
  children: string;
  language: string;
  themeMode?: "auto" | "light";
  customStyle?: CSSProperties;
  codeTagProps?: HTMLProps<HTMLElement>;
  wrapLongLines?: boolean;
}

export default function SyntaxHighlightedCode({
  children,
  language,
  themeMode = "auto",
  customStyle,
  codeTagProps,
  wrapLongLines = false,
}: SyntaxHighlightedCodeProps): JSX.Element {
  const theme = useTheme();
  return (
    <SyntaxHighlighter
      language={language}
      style={
        themeMode === "auto" && theme.palette.mode === "dark"
          ? vscDarkPlus
          : oneLight
      }
      PreTag="div"
      wrapLongLines={wrapLongLines}
      customStyle={customStyle}
      codeTagProps={codeTagProps}
    >
      {children}
    </SyntaxHighlighter>
  );
}
