import { Platform } from "obsidian";
import { TaskFile, StatusDef, PriorityDef, TagDef, ChipKind, ResolvedChipStyle, ResolvedChipStyles } from "../types";
import { appendSvg, flagSvg, renderIconish } from "./icons";
import { isOverdue, formatDate } from "../utils/dates";
import { t } from "../i18n";

// Resolve the mobile bottom safe inset (Obsidian navbar + OS gesture/safe-area)
// to pixels. Returns 0 on desktop. We can't read the CSS var directly because
// getComputedStyle returns the unresolved `max(...)` string for custom props, so
// we probe with a throwaway element whose height is that var and measure it.
// Used to keep fixed popovers / context menus clear of the system bottom bar.
export function mobileBottomInset(doc: Document = document): number {
  if (!Platform.isMobile) return 0;
  const probe = doc.createElement("div");
  probe.className = "it-safe-bottom-probe";
  doc.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  const px = Math.round(h);
  return px > 0 ? px : 48;
}

// Render a List / Folder / Space reference (used in view rows / cells where
// the task's owning list/folder/space is shown). Resolves the node config
// from the task's listPath so we get the configured icon and color, then
// renders an `it-list-ref` chip-style span with icon + name. Replaces the
// old plain-text mono labels that ignored icons entirely.
export function renderListReference(
  parent: HTMLElement,
  task: { listPath?: string },
  index: { findList: (p: string) => any; findFolder: (p: string) => any; findSpace: (p: string) => any },
  kind: "list" | "folder" | "space",
): HTMLElement | null {
  if (!task.listPath) return null;
  let cfg: { name?: string; icon?: string; color?: string } | undefined;
  if (kind === "list") {
    cfg = index.findList(task.listPath)?.config;
  } else if (kind === "folder") {
    const l = index.findList(task.listPath);
    if (l?.folderPath) cfg = index.findFolder(l.folderPath)?.config;
  } else {
    const l = index.findList(task.listPath);
    if (l?.spacePath) cfg = index.findSpace(l.spacePath)?.config;
  }
  if (!cfg?.name) return null;
  const wrap = parent.createSpan({ cls: `it-list-ref it-list-ref-${kind}` });
  const fallbackIcon = kind === "list" ? "📋" : kind === "folder" ? "📁" : "🏷️";
  const ico = renderIconish(wrap, cfg.icon || fallbackIcon, { cls: "it-list-ref-icon" });
  if (ico && cfg.color) ico.style.color = cfg.color;
  wrap.createSpan({ cls: "it-list-ref-name", text: cfg.name });
  return wrap;
}

// Toggles the chip's `.it-cs-*` modifier classes (see styles.css) to reflect
// the user's per-element styling preferences. Always strips any previous
// modifier classes first, so the function is safe to call repeatedly (e.g.
// when a picker chip switches between active/inactive).
export function applyChipStyle(el: HTMLElement, style: ResolvedChipStyle | undefined): void {
  // Clean any previous styling-classes so toggling between states works.
  el.classList.remove("it-cs-bd", "it-cs-bd-bold", "it-cs-bd-off", "it-cs-bg");
  if (!style) return;
  // Border: bold > on > off (off explicitly suppresses the default soft border).
  if (style.bold_border) el.classList.add("it-cs-bd-bold");
  else if (style.border) el.classList.add("it-cs-bd");
  else el.classList.add("it-cs-bd-off");
  if (style.background) el.classList.add("it-cs-bg");
}

// Convenience: apply by chip kind given a resolved-styles map. Tolerates
// `undefined` styles (caller doesn't have a resolved map yet) by leaving
// the chip in its default look.
export function applyChipStyleByKind(el: HTMLElement, kind: ChipKind, styles: ResolvedChipStyles | undefined): void {
  if (!styles) return;
  applyChipStyle(el, styles[kind]);
}

// Map a `state.groupBy` value to the ChipKind whose Label-style
// preferences should govern the group header. Returns null for groupBy
// values that don't correspond to a styled chip — those headers stay as
// plain text (e.g. "due_date", "list", custom fields that aren't
// dropdown/labels).
export function chipKindForGroupBy(
  groupBy: string | undefined | null,
  customFieldType?: (id: string) => string | undefined,
): ChipKind | null {
  // A group header renders for every bucket, so this runs on whatever value the
  // view state holds. `groupBy` is typed as a required string and defaults to
  // "status", but a persisted state written by an older version — or edited by
  // hand — can carry null, and the restore path only guards against undefined.
  // Rendering an unadorned header beats making the whole location unopenable.
  if (!groupBy) return null;
  if (groupBy === "status") return "status";
  if (groupBy === "priority") return "priority";
  if (groupBy === "tags") return "tag";
  if (groupBy === "context") return "context";
  if (groupBy === "type") return "task_type";
  if (groupBy.startsWith("custom_field:") && customFieldType) {
    const id = groupBy.slice("custom_field:".length);
    const t = customFieldType(id);
    if (t === "dropdown" || t === "labels") return "custom_field";
  }
  return null;
}

// Render a group-header label as either a fully-styled chip (when the
// groupBy resolves to a ChipKind) or as plain text. The dot + plain label
// fallback used to be the only mode; this helper unifies both shapes so
// list/board/table views render identically.
//
// Caller responsibilities:
//   - bucket: { label, color }
//   - kind: result of chipKindForGroupBy; null → plain text
//   - styles: resolved chip styles from the view context
export function renderGroupHeaderChip(
  parent: HTMLElement,
  bucket: { label: string; color?: string; icon?: string },
  kind: ChipKind | null,
  styles: ResolvedChipStyles | undefined,
): HTMLElement {
  // Priority: flag glyph inside the chip, mirroring the task-modal priority chip.
  if (kind === "priority") {
    const chip = parent.createSpan({ cls: "it-chip it-chip-priority it-group-chip" });
    chip.style.setProperty("--chip-color", bucket.color || "var(--text-faint)");
    applyChipStyleByKind(chip, "priority", styles);
    const flag = chip.createSpan({ cls: "it-priority-flag" });
    appendSvg(flag, flagSvg(bucket.color || "var(--text-faint)"));
    chip.createSpan({ text: bucket.label, cls: "it-chip-label" });
    return chip;
  }
  if (kind) {
    // Styled chip; show the icon (e.g. Task type) before the label when present.
    const chip = parent.createSpan({ cls: "it-chip it-chip-tag it-group-chip" });
    if (bucket.color) chip.style.setProperty("--chip-color", bucket.color);
    if (bucket.icon) {
      const ic = renderIconish(chip, bucket.icon, { cls: "it-group-chip-icon" });
      if (ic && bucket.color) ic.style.color = bucket.color;
    }
    chip.createSpan({ text: bucket.label });
    applyChipStyleByKind(chip, kind, styles);
    return chip;
  }
  // Plain fallback. Show an icon when available (e.g. List groups), otherwise a
  // colored dot — both followed by the label.
  if (bucket.icon) {
    const wrap = parent.createSpan({ cls: "it-group-label-wrap" });
    const ic = renderIconish(wrap, bucket.icon, { cls: "it-group-chip-icon" });
    if (ic && bucket.color) ic.style.color = bucket.color;
    wrap.createSpan({ text: bucket.label, cls: "it-group-label" });
    return wrap;
  }
  if (bucket.color) {
    const dot = parent.createSpan({ cls: "it-group-dot" });
    dot.style.background = bucket.color;
  }
  return parent.createSpan({ text: bucket.label, cls: "it-group-label" });
}

export function statusChip(parent: HTMLElement, status: StatusDef | undefined, onClick?: (e: MouseEvent) => void, styles?: ResolvedChipStyles): HTMLElement {
  const chip = parent.createEl("button", {
    cls: "it-chip it-chip-status",
    text: status?.name ?? t("action.noStatus"),
  });
  if (status) {
    chip.style.setProperty("--chip-color", status.color);
    chip.setAttribute("data-group", status.group);
  } else {
    chip.addClass("it-chip-muted");
  }
  applyChipStyleByKind(chip, "status", styles);
  if (onClick) chip.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
  return chip;
}

export function priorityChip(parent: HTMLElement, priority: 1 | 2 | 3 | 4 | null | undefined, defs: PriorityDef[], onClick?: (e: MouseEvent) => void, styles?: ResolvedChipStyles): HTMLElement {
  const def = priority ? defs.find((p) => p.id === priority) : undefined;
  const wrap = parent.createEl("button", { cls: "it-chip it-chip-priority" });
  wrap.style.setProperty("--chip-color", def?.color || "var(--text-faint)");
  applyChipStyleByKind(wrap, "priority", styles);
  const ico = wrap.createSpan({ cls: "it-priority-flag" });
  appendSvg(ico, flagSvg(def?.color || "var(--text-faint)"));
  wrap.createSpan({ text: def?.label || "—", cls: "it-chip-label" });
  if (onClick) wrap.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
  return wrap;
}

export function dueDateChip(parent: HTMLElement, task: TaskFile, onClick?: (e: MouseEvent) => void): HTMLElement | null {
  if (!task.data.due_date) {
    if (!onClick) return null;
    const empty = parent.createEl("button", { cls: "it-chip it-chip-date it-chip-empty", text: t("action.addDate") });
    empty.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
    return empty;
  }
  const overdue = isOverdue(task.data.due_date, task.data.status_group);
  const chip = parent.createEl("button", {
    cls: "it-chip it-chip-date" + (overdue ? " it-chip-overdue" : ""),
    text: formatDate(task.data.due_date),
  });
  if (onClick) chip.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
  return chip;
}

export function tagChip(parent: HTMLElement, tag: string, color?: string, onClick?: (e: MouseEvent) => void, styles?: ResolvedChipStyles): HTMLElement {
  const chip = parent.createEl("button", { cls: "it-chip it-chip-tag", text: "#" + tag });
  if (color) chip.style.setProperty("--chip-color", color);
  applyChipStyleByKind(chip, "tag", styles);
  if (onClick) chip.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
  return chip;
}

export function renderTagsCell(parent: HTMLElement, tags: string[], palette: TagDef[] = [], maxVisible: number = 2, styles?: ResolvedChipStyles) {
  const colorMap = new Map(palette.map((td) => [td.name, td.color]));
  const visible = tags.slice(0, maxVisible);
  const remaining = tags.length - visible.length;
  for (const tg of visible) tagChip(parent, tg, colorMap.get(tg), undefined, styles);
  if (remaining > 0) {
    const more = parent.createEl("button", { cls: "it-tags-more", text: "…" });
    more.setAttribute("aria-label", t("chip.showMoreTags", { count: remaining }));
    more.title = t("chip.showMoreTags", { count: remaining });
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      showPopover(more, (root) => {
        const wrap = root.createDiv({ cls: "it-tags-popover" });
        for (const tg of tags) tagChip(wrap, tg, colorMap.get(tg), undefined, styles);
      });
    });
  }
}

export function buildDropdown<T>(opts: {
  parent: HTMLElement;
  current: T | undefined | null;
  items: Array<{ value: T; label: string; color?: string; icon?: string }>;
  onSelect: (v: T, popover: HTMLElement | null) => void;
  footer?: Array<{ label: string; icon?: string; onClick: () => void }>;
}): HTMLElement {
  const root = opts.parent.createDiv({ cls: "it-popover-menu" });
  for (const item of opts.items) {
    const row = root.createEl("button", { cls: "it-popover-item" });
    if (item.icon) {
      const iconEl = renderIconish(row, item.icon, { cls: "it-popover-icon" });
      if (iconEl && item.color) iconEl.style.color = item.color;
    } else if (item.color) {
      const dot = row.createSpan({ cls: "it-dot" });
      dot.style.background = item.color;
    }
    row.createSpan({ text: item.label });
    if (opts.current === item.value) row.addClass("is-active");
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      // Capture the owner while the click target is still attached. Callers
      // often await a write before dismissing the menu; Event.currentTarget is
      // already null by then in Chromium and must not be used for that cleanup.
      const popover = row.closest(".it-popover") as HTMLElement | null;
      opts.onSelect(item.value, popover);
    });
  }
  if (opts.footer && opts.footer.length) {
    root.createDiv({ cls: "it-popover-sep" });
    for (const f of opts.footer) {
      const row = root.createEl("button", { cls: "it-popover-item it-popover-footer-item" });
      row.createSpan({ text: f.label });
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        row.ownerDocument.querySelectorAll(".it-popover").forEach((el) => el.remove());
        f.onClick();
      });
    }
  }
  return root;
}

export function showPopover(target: HTMLElement, build: (root: HTMLElement) => void) {
  // Open in the target's own window (settings live in a separate window since
  // Obsidian 1.14; views can be popped out).
  const doc = target.ownerDocument;
  const win = doc.defaultView ?? window;
  // Remove existing popovers
  doc.querySelectorAll(".it-popover").forEach((el) => el.remove());
  const rect = target.getBoundingClientRect();
  const popover = doc.createElement("div");
  popover.className = "it-popover it-popover-floating";
  doc.body.appendChild(popover);
  build(popover);

  // Cap the height to whichever side (below / above the target) has more room,
  // and let the popover scroll — otherwise long menus (e.g. Group by with many
  // custom fields) run off-screen and their items become unclickable.
  const margin = 8;
  const gap = 6;
  const natural = popover.offsetHeight;
  // On mobile, treat the area behind Obsidian's bottom navbar as unavailable so
  // the popover (and its lowest, often most-used items) stays tappable.
  const usableBottom = win.innerHeight - mobileBottomInset(doc);
  const spaceBelow = usableBottom - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;
  const placeBelow = natural <= spaceBelow || spaceBelow >= spaceAbove;
  popover.style.maxHeight = `${Math.max(140, placeBelow ? spaceBelow : spaceAbove)}px`;

  const ph = popover.offsetHeight; // re-measure after the cap
  const pw = popover.offsetWidth;
  const top = placeBelow ? rect.bottom + gap : Math.max(margin, rect.top - ph - gap);
  let left = rect.left;
  if (left + pw > win.innerWidth - margin) left = Math.max(margin, win.innerWidth - pw - margin);
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
  const closer = (ev: MouseEvent) => {
    if (!popover.contains(ev.target as Node)) {
      popover.remove();
      doc.removeEventListener("mousedown", closer, true);
      doc.removeEventListener("keydown", esc, true);
    }
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      popover.remove();
      doc.removeEventListener("mousedown", closer, true);
      doc.removeEventListener("keydown", esc, true);
    }
  };
  setTimeout(() => {
    doc.addEventListener("mousedown", closer, true);
    doc.addEventListener("keydown", esc, true);
  }, 0);
}
