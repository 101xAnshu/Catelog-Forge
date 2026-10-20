import sanitizeHtml from "sanitize-html";

const ALLOWED = {
  allowedTags: ["p", "br", "ul", "ol", "li", "strong", "em", "b", "i"],
  allowedAttributes: {},
  disallowedTagsMode: "discard" as const,
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed"],
};

export const MAX_DESCRIPTION_CHARS = 5000;

/** Strips scripts, event handlers, styles and anything outside a tiny formatting allowlist. */
export function sanitizeDescription(html: string): string {
  return sanitizeHtml(html, ALLOWED).replace(/\s+/g, " ").replace(/<p>\s*<\/p>/g, "").trim();
}

/** Plain text used for claim verification and language detection. */
export function htmlToText(html: string): string {
  return sanitizeHtml(html.replace(/<(br|\/p|\/li)\s*\/?>/gi, " $&"), { allowedTags: [], allowedAttributes: {} })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(s);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
