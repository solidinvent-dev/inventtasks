import { setIcon } from "obsidian";
import { customFieldTypeMeta, fieldIconMeta } from "../constants";

// Renders the colored icon for ANY field key — built-in (status, priority, …)
// or "custom_field:<id>". Mirrors renderCfTypeIcon but resolves built-ins too.
export function renderFieldIcon(
  parent: HTMLElement,
  key: string,
  customFields?: { id: string; type: string }[],
  opts: { cls?: string } = {},
): HTMLElement {
  const meta = fieldIconMeta(key, customFields);
  const span = parent.createSpan({ cls: "it-cf-type-ic" + (opts.cls ? " " + opts.cls : "") });
  setIcon(span, meta.icon);
  span.style.color = meta.color;
  return span;
}

// Renders the colored type-icon for a custom-field type. Shared everywhere a
// field's type / label / value is shown so the icon is consistent. The color
// is the type's fixed accent; a title tooltip names the type.
export function renderCfTypeIcon(
  parent: HTMLElement,
  type: string | undefined,
  opts: { cls?: string; title?: boolean } = {},
): HTMLElement {
  const meta = customFieldTypeMeta(type);
  const span = parent.createSpan({ cls: "it-cf-type-ic" + (opts.cls ? " " + opts.cls : "") });
  setIcon(span, meta.icon);
  span.style.color = meta.color;
  if (opts.title !== false) span.setAttribute("title", meta.label);
  return span;
}

/**
 * Insert one of the plugin's own SVG strings. Parsed as SVG rather than
 * assigned through innerHTML, so nothing in the string is treated as markup or
 * script; every string passed here declares the SVG namespace.
 */
export function appendSvg(el: HTMLElement, svg: string): void {
  const node = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  if (node.namespaceURI !== "http://www.w3.org/2000/svg" || node.localName !== "svg") return;
  el.appendChild(el.ownerDocument.importNode(node, true));
}

export function flagSvg(color: string): string {
  // The color comes from user-editable config frontmatter and is interpolated
  // into markup — restrict it to safe CSS color forms (hex / var() / rgb/hsl /
  // bare keyword) so a crafted value can't break out of the attribute.
  const safe = /^(#[0-9a-fA-F]{3,8}|var\(--[\w-]+\)|(rgb|rgba|hsl|hsla)\([\d\s.,%/]*\)|[a-zA-Z]+)$/.test(color.trim())
    ? color.trim()
    : "var(--text-faint)";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="${safe}" aria-hidden="true"><path d="M3 1.5a.5.5 0 0 0-1 0v13a.5.5 0 0 0 1 0V9.55l1.4-.35 4.2 1.4a.5.5 0 0 0 .15.02l5-.5a.5.5 0 0 0 .25-.92l-3-2 3-3a.5.5 0 0 0-.35-.84l-5 .5L4.5 1.55 3 1.95V1.5z"/></svg>`;
}

export function emoji(value: string | undefined, fallback: string = "📋"): string {
  return value || fallback;
}

// Renders an icon string that may be either a single emoji/glyph or a Lucide icon name.
// Heuristic: if it's all ASCII letters/digits/hyphens it's treated as a Lucide name.
// If setIcon doesn't produce an SVG, the string is rendered as plain text as a fallback.
export function renderIconish(
  parent: HTMLElement,
  iconStr: string | undefined | null,
  opts: { cls?: string; fallback?: string } = {}
): HTMLElement | null {
  const v = (iconStr || "").trim();
  if (!v && !opts.fallback) return null;
  const final = v || opts.fallback || "";
  if (!final) return null;
  const cls = opts.cls || "it-iconish";

  const isLikelyLucide = /^[a-z][a-z0-9-]*$/i.test(final) && final.length > 1 && !/^(?:[A-Z]{1,4})$/.test(final);
  if (isLikelyLucide) {
    const span = parent.createSpan({ cls: `${cls} ${cls}-svg` });
    setIcon(span, final);
    if (!span.firstElementChild) {
      // Lucide didn't render anything — fall back to text/emoji
      span.empty();
      span.textContent = final;
    }
    return span;
  }
  return parent.createSpan({ text: final, cls });
}
