// Polymorphic display renderer for custom field values. ONE place that
// knows how each CustomFieldType should look in views (list, board,
// calendar, table). Used by all four views to keep visual consistency.
//
// The editor side lives in src/modals/task-modal.ts → renderCustomField.
// Display is intentionally minimal-chrome (single chip / link / value)
// because views are dense; the modal does the full controls.

import { setIcon } from "obsidian";
import type { CustomFieldDef, CustomFieldOption, LinkedValue, LocationValue, ResolvedChipStyles, TaskAttachment, TaskFile } from "../types";
import type { WorkspaceIndex } from "../data/workspace-index";
import { applyChipStyleByKind } from "./components";
import { renderCfTypeIcon } from "./icons";
import { effectiveCustomFieldValue, isEmptyCustomFieldValue } from "../data/custom-fields";
import { isSecretCustomFieldType } from "../data/custom-fields";
import { formatDate, formatTimeOfDay } from "../utils/dates";

export type CfDisplayMode = "list" | "board" | "calendar" | "table";

export interface CfRenderContext {
  task: TaskFile;
  index: WorkspaceIndex;
  mode: CfDisplayMode;
  // Resolved per-view chip styling (Border / Bold border / Background)
  // pulled from the same chain as status/priority/tag chips. Caller
  // typically passes the view's `context.chipStyles`.
  chipStyles?: ResolvedChipStyles;
  // Pre-built subtask totals/done counts (from index.buildRenderStats),
  // passed by the views so progress_auto doesn't scan allTasks() per cell.
  // Absent in the task modal (single task) — falls back to a live scan.
  subtaskStats?: Map<string, { total: number; done: number }>;
  // When true, the field's colored TYPE icon is rendered before the value.
  // Used by value-only contexts (List/Table cells); name+value contexts
  // (Board/Calendar) render the icon next to the name themselves instead.
  showTypeIcon?: boolean;
}

// Main entry — picks the right renderer by field.type. Renders into the
// given parent. Returns nothing; if the value is empty/missing, nothing
// is appended (caller doesn't need to check).
export function renderCustomFieldValue(
  parent: HTMLElement,
  field: CustomFieldDef,
  value: any,
  ctx: CfRenderContext,
): void {
  if (isSecretCustomFieldType(field.type)) {
    if (isEmptyCustomFieldValue(value)) return;
    if (ctx.showTypeIcon) renderCfTypeIcon(parent, field.type);
    const plaintext = ctx.index.secretFieldPlaintext?.(value) ?? null;
    if (plaintext === null) {
      const masked = parent.createSpan({ cls: "it-cf-display it-cf-secret is-locked", text: "••••••••" });
      setIcon(masked.createSpan({ cls: "it-cf-secret-lock" }), "lock-keyhole");
      return;
    }
    return renderText(parent, plaintext, ctx.mode);
  }
  const resolved = field.type === "progress_auto"
    ? effectiveCustomFieldValue(ctx.task, field, { subtaskStats: ctx.subtaskStats, allTasks: ctx.subtaskStats ? undefined : ctx.index.allTasks() })
    : value;
  if (isEmptyCustomFieldValue(resolved)) return;
  // Colored type icon before the value (value-only contexts opt in).
  if (ctx.showTypeIcon) renderCfTypeIcon(parent, field.type);
  switch (field.type) {
    case "text":
    case "textarea":
    case "markdown":
      return renderText(parent, resolved, ctx.mode);
    case "number":
      return renderNumber(parent, resolved);
    case "money":
      return renderMoney(parent, resolved, field.currency);
    case "date":
      return renderTextLike(parent, formatDate(String(resolved), { withTime: false }));
    case "datetime":
      // Auto: include the time only when the stored value actually has one.
      return renderTextLike(parent, formatDate(String(resolved)));
    case "time":
      return renderTextLike(parent, formatTimeOfDay(String(resolved)));
    case "checkbox":
      return renderCheckbox(parent, !!resolved);
    case "url":
      return renderLinked(parent, resolved, "url");
    case "email":
      return renderLinked(parent, resolved, "email");
    case "phone":
      return renderLinked(parent, resolved, "phone");
    case "location":
      return renderLocation(parent, resolved);
    case "dropdown":
      return renderDropdownDisplay(parent, resolved, field, ctx);
    case "labels":
      return renderLabelsDisplay(parent, resolved, field, ctx);
    case "rating":
      return renderRatingDisplay(parent, resolved, field);
    case "progress_manual":
      return renderProgress(parent, Number(resolved) || 0);
    case "progress_auto":
      return renderProgress(parent, Number(resolved) || 0);
    case "relationship":
      return renderRelationshipDisplay(parent, resolved, ctx.index);
    case "doc_relationship":
      return renderDocRelationshipDisplay(parent, resolved, ctx.index);
    case "attachment":
      return renderAttachmentDisplay(parent, resolved);
    default:
      return renderTextLike(parent, String(resolved));
  }
}

// ----- Per-type renderers -----

function renderText(parent: HTMLElement, value: any, mode: CfDisplayMode): void {
  // For long text in dense views, truncate with ellipsis; modal shows full.
  const s = String(value);
  const trimmed = mode === "list" || mode === "table"
    ? (s.length > 80 ? s.slice(0, 79) + "…" : s)
    : s;
  const span = parent.createSpan({ cls: "it-cf-display it-cf-text" });
  span.setText(trimmed);
  if (trimmed !== s) span.setAttribute("title", s);
}

function renderTextLike(parent: HTMLElement, s: string): void {
  parent.createSpan({ cls: "it-cf-display", text: s });
}

function renderNumber(parent: HTMLElement, value: any): void {
  const n = Number(value);
  if (!Number.isFinite(n)) return renderTextLike(parent, String(value));
  parent.createSpan({ cls: "it-cf-display it-cf-number", text: String(n) });
}

function renderMoney(parent: HTMLElement, value: any, currency?: string): void {
  const n = Number(value);
  if (!Number.isFinite(n)) return renderTextLike(parent, String(value));
  const cur = (currency || "PLN").toUpperCase();
  let s: string;
  try {
    s = new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(n);
  } catch {
    s = `${n.toFixed(2)} ${cur}`;
  }
  parent.createSpan({ cls: "it-cf-display it-cf-money", text: s });
}

function renderCheckbox(parent: HTMLElement, checked: boolean): void {
  // Just the icon — the field name is already shown elsewhere in views
  // (list column header, board/calendar chip label) so repeating it here
  // is noise.
  const span = parent.createSpan({ cls: "it-cf-display it-cf-checkbox" + (checked ? " is-checked" : "") });
  setIcon(span, checked ? "check-square" : "square");
}

// ----- Linked values (url / email / phone) -----

function normalizeLinked(value: any): LinkedValue | null {
  if (typeof value === "string" && value) return { value };
  if (value && typeof value === "object" && typeof value.value === "string" && value.value) {
    return { label: value.label, value: value.value };
  }
  return null;
}

// The ONLY schemes allowed to reach an href. These links render inside
// Obsidian's Electron renderer, where a `javascript:` URL executes with the
// app's privileges — and custom field values arrive from synced or shared
// vaults, so they are untrusted input.
//
// Testing for "://" is not enough and was the hole here: `javascript://x%0A…`
// contains "://" yet still runs, because `//` opens a comment and the encoded
// newline ends it. Match on the scheme itself instead, and treat anything not
// on this list as a bare address to be prefixed rather than a URL to trust.
const SAFE_LINK_SCHEME = /^(https?|mailto|tel|obsidian):/i;

export function isSafeLinkHref(value: string): boolean {
  return SAFE_LINK_SCHEME.test(value.trim());
}

/** Coerce any stored value into an href that can never be an executable URL. */
export function safeExternalHref(value: string): string {
  // Strip leading whitespace and C0/C1 control characters first: a browser
  // ignores them when parsing the scheme, so a padded "javascript:" payload
  // would otherwise slip past a naive prefix check.
  const v = value.replace(/^[\s\u0000-\u001F\u007F-\u009F]+/, "");
  if (!v) return "";
  if (isSafeLinkHref(v)) return v;
  if (v.startsWith("//")) return `https:${v}`;
  return `https://${v.replace(/^\/+/, "")}`;
}

export function buildLinkedHref(kind: "url" | "email" | "phone" | "location", value: string): string {
  if (kind === "email") return `mailto:${value}`;
  if (kind === "phone") return `tel:${value.replace(/[^\d+]/g, "")}`;
  // location: use a genuine URL as-is; anything else becomes a Maps search.
  if (kind === "location") {
    if (isSafeLinkHref(value)) return value;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`;
  }
  return safeExternalHref(value);
}

function renderLinked(parent: HTMLElement, value: any, kind: "url" | "email" | "phone" | "location"): void {
  const lv = normalizeLinked(value);
  if (!lv) return;
  const href = buildLinkedHref(kind, lv.value);
  const a = parent.createEl("a", { cls: "it-cf-display it-cf-link" + (kind === "location" ? " it-cf-link-location" : ""), text: lv.label || lv.value, href });
  if (kind === "url" || kind === "location") {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener");
  }
  a.setAttribute("title", lv.label ? `${lv.label} — ${lv.value}` : lv.value);
  // Click on the link must not propagate to the row (would open the task modal).
  a.addEventListener("click", (e) => e.stopPropagation());
}

// ----- Location -----

// Normalises the stored value for the `location` field. Handles:
//   • new LocationValue { label?, url?, lat?, lng? }
//   • legacy LinkedValue { label?, value } (value = URL or plain address)
//   • plain string (treated as address label)
function normalizeLocation(value: any): { displayText: string; href: string; coords?: string } | null {
  if (!value) return null;
  let label: string | undefined;
  let url: string | undefined;
  let lat: number | undefined;
  let lng: number | undefined;

  if (typeof value === "string" && value) {
    label = value;
  } else if (value && typeof value === "object") {
    if ("url" in value || "lat" in value || "lng" in value) {
      // New LocationValue
      label = value.label;
      url = value.url;
      lat = value.lat != null ? Number(value.lat) : undefined;
      lng = value.lng != null ? Number(value.lng) : undefined;
    } else if (typeof value.value === "string" && value.value) {
      // Legacy LinkedValue
      const v: string = value.value;
      label = value.label;
      if (isSafeLinkHref(v)) url = v;
      else label = label || v;
    }
  }

  if (!label && !url && lat == null) return null;

  // Build the clickable href
  let href: string;
  if (url) {
    // A stored map URL is untrusted too — never hand it to an href unchecked.
    href = safeExternalHref(url);
  } else if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
    href = `https://www.google.com/maps?q=${lat},${lng}`;
  } else {
    href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label || "")}`;
  }

  const displayText = label || (lat != null && lng != null ? `${lat}, ${lng}` : url || "");
  const coords = lat != null && lng != null && !isNaN(lat) && !isNaN(lng) ? `${lat}, ${lng}` : undefined;

  return { displayText, href, coords };
}

function renderLocation(parent: HTMLElement, value: any): void {
  const loc = normalizeLocation(value);
  if (!loc) return;
  // In all views show only the text label as a clickable link — compact single
  // line that won't overflow tight bars (gantt/timeline) or board chips.
  // Coordinates are stored in the data and visible in the edit modal.
  const a = parent.createEl("a", {
    cls: "it-cf-display it-cf-link it-cf-location-link",
    text: loc.displayText,
    href: loc.href,
  });
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener");
  // Tooltip: show address + coords if present so the info is still accessible.
  const tip = loc.coords ? `${loc.displayText}\n${loc.coords}` : loc.displayText;
  a.setAttribute("title", tip);
  a.addEventListener("click", (e) => e.stopPropagation());
}

// ----- Choice types (dropdown / labels) -----

function findOption(options: CustomFieldOption[] | undefined, v: string): CustomFieldOption | undefined {
  if (!options) return undefined;
  return options.find((o) => (o.value ?? o.label) === v || o.label === v);
}

function renderDropdownDisplay(parent: HTMLElement, value: any, field: CustomFieldDef, ctx: CfRenderContext): void {
  const opt = findOption(field.options, String(value));
  const chip = parent.createSpan({ cls: "it-chip it-chip-tag it-cf-display", text: opt?.label ?? String(value) });
  if (opt?.color) chip.style.setProperty("--chip-color", opt.color);
  // Apply the user's "custom_field" Label-style preferences (Border /
  // Bold border / Background) so dropdown chips match status/priority/tag
  // styling instead of always showing the default soft border.
  applyChipStyleByKind(chip, "custom_field", ctx.chipStyles);
}

function renderLabelsDisplay(parent: HTMLElement, value: any, field: CustomFieldDef, ctx: CfRenderContext): void {
  const arr: any[] = Array.isArray(value) ? value : [value];
  for (const v of arr) {
    const opt = findOption(field.options, String(v));
    const chip = parent.createSpan({ cls: "it-chip it-chip-tag it-cf-display", text: opt?.label ?? String(v) });
    if (opt?.color) chip.style.setProperty("--chip-color", opt.color);
    applyChipStyleByKind(chip, "custom_field", ctx.chipStyles);
  }
}

// ----- Rating -----

function renderRatingDisplay(parent: HTMLElement, value: any, field: CustomFieldDef): void {
  const n = Math.max(0, Math.min(field.scale || 5, Number(value) || 0));
  const icon = field.icon || "★";
  parent.createSpan({ cls: "it-cf-display it-cf-rating", text: icon.repeat(n) + ` (${n}/${field.scale || 5})` });
}

// ----- Progress (manual + auto) -----

function renderProgress(parent: HTMLElement, percent: number): void {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const wrap = parent.createSpan({ cls: "it-cf-display it-cf-progress" });
  const track = wrap.createSpan({ cls: "it-cf-progress-track" });
  const fill = track.createSpan({ cls: "it-cf-progress-fill" });
  fill.style.width = `${p}%`;
  wrap.createSpan({ cls: "it-cf-progress-label", text: `${p}%` });
}

// ----- Relationship -----

function renderRelationshipDisplay(parent: HTMLElement, value: any, idx: WorkspaceIndex): void {
  const ids: string[] = Array.isArray(value) ? value.filter((x) => typeof x === "string") : [];
  if (ids.length === 0) return;
  // Render up to 3 inline; show "+N more" for the rest.
  const shown = ids.slice(0, 3);
  for (const id of shown) {
    const linked = idx.tasksById.get(id);
    const label = linked ? (linked.data.title || id) : id;
    const chip = parent.createSpan({ cls: "it-chip it-chip-link it-cf-display", text: label });
    chip.setAttribute("title", linked ? `${label} (${id})` : id);
  }
  if (ids.length > shown.length) {
    parent.createSpan({ cls: "it-chip it-chip-meta it-cf-display", text: `+${ids.length - shown.length}` });
  }
}

function renderDocRelationshipDisplay(parent: HTMLElement, value: any, idx: WorkspaceIndex): void {
  const ids: string[] = Array.isArray(value) ? value.filter((x) => typeof x === "string") : [];
  if (ids.length === 0) return;
  const shown = ids.slice(0, 3);
  for (const id of shown) {
    const doc = idx.docById(id);
    const label = doc ? doc.name : id;
    const chip = parent.createSpan({ cls: "it-chip it-chip-link it-cf-display", text: label });
    chip.setAttribute("title", label);
  }
  if (ids.length > shown.length) {
    parent.createSpan({ cls: "it-chip it-chip-meta it-cf-display", text: `+${ids.length - shown.length}` });
  }
}

// ----- Attachment -----

function renderAttachmentDisplay(parent: HTMLElement, value: any): void {
  const list: TaskAttachment[] = Array.isArray(value) ? value : [];
  if (list.length === 0) return;
  // Compact: paperclip icon + count. Filenames in the modal.
  const span = parent.createSpan({ cls: "it-cf-display it-cf-attachment" });
  const ico = span.createSpan({ cls: "it-cf-attachment-icon" });
  setIcon(ico, "paperclip");
  span.createSpan({ text: ` ${list.length}` });
  span.setAttribute("title", list.map((a) => a.name).join(", "));
}
