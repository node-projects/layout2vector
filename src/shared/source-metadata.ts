import type { SourceMetadata } from "../types.js";

function getXPathSegment(element: Element): string {
  const tagName = element.tagName.toLowerCase();
  const parent = element.parentElement;
  if (!parent) return tagName;

  let sameTagCount = 0;
  let sameTagIndex = 0;
  for (const sibling of Array.from(parent.children)) {
    if (sibling.tagName !== element.tagName) continue;
    sameTagCount += 1;
    if (sibling === element) {
      sameTagIndex = sameTagCount;
    }
  }

  return sameTagCount > 1 ? `${tagName}[${sameTagIndex}]` : tagName;
}

function getElementXPath(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;

  while (current) {
    segments.push(getXPathSegment(current));

    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }

    const root = current.getRootNode();
    if (root instanceof ShadowRoot) {
      segments.push("shadow-root()");
      current = root.host;
      continue;
    }

    current = null;
  }

  return `/${segments.reverse().join("/")}`;
}

export function buildSourceMetadata(element: Element, originalType?: string): SourceMetadata {
  const id = element.getAttribute("id") || undefined;
  return {
    ...(id ? { id } : {}),
    xpath: getElementXPath(element),
    originalType: originalType ?? element.tagName.toLowerCase(),
  };
}