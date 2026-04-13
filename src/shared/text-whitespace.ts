import type { Style } from "../types.js";

export function preservesWhitespace(style: Pick<Style, "whiteSpace">): boolean {
  return style.whiteSpace === "pre" || style.whiteSpace === "pre-wrap" || style.whiteSpace === "break-spaces";
}

export function normalizeWhitespaceAwareText(text: string, style: Pick<Style, "whiteSpace">): string {
  if (preservesWhitespace(style)) return text.replace(/\r\n?/g, "\n");
  return text.replace(/\s+/g, " ").trim();
}