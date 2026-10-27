// Shared horizontal time-axis engine for the Gantt and Timeline views.
//
// Both views render the same scaffold: an optional left rail, a sticky two-tier
// date header, and a scrollable canvas where task bars are positioned by their
// start/due dates. This module owns all the geometry (date ↔ pixel), the axis
// header + grid painting, color/progress resolution, and the desktop
// drag/resize interaction. The views themselves only decide WHICH rows exist
// (Gantt: one per task in a tree; Timeline: packed bars per swimlane) and fill
// the rail + canvas accordingly.
//
// Timezone-safety: every date here is a "YYYY-MM-DD" key. We never route a
// date-only string through `new Date()` for day math — we read the day off the
// string and step with UTC arithmetic (see addDaysKey). Mirrors utils/dates.ts.

import { setIcon, Platform } from "obsidian";
import { TaskFile, TimeZoom, StatusDef, PriorityDef, CustomFieldDef, ResolvedChipStyles } from "../types";
import { dayKey, todayKey, dayDiff } from "../utils/dates";
import { effectiveCustomFieldValue } from "../data/custom-fields";
import { taskDateValue } from "../data/date-source";
import { DATE_SOURCE_DUE, DATE_SOURCE_START } from "../constants";
import { t, zoomLabel, monthName } from "../i18n";

// ---------- Layout constants ----------

export const ROW_H = 38;          // Gantt task row (rail + canvas band)
export const LANE_SUBROW_H = 30;  // Timeline packed sub-row
export const LANE_PAD = 6;        // vertical padding inside a swimlane band
export const AXIS_H = 52;         // two-tier header height
export const GANTT_RAIL_DEFAULT_W = 280;
export const TIMELINE_RAIL_DEFAULT_W = 200;
export const TIME_RAIL_MIN_W = 120;
export const TIME_RAIL_MAX_W = 720;
export const BAR_MIN_W = 8;       // minimum bar width so 1-day items stay grabbable
export const HANDLE_W = 8;        // edge hit-zone for resize

export interface ZoomDef { id: TimeZoom; label: string; pxPerDay: number; }

// pxPerDay tuned so a "typical" window of that unit fills a comfortable width.
export function zoomDef(id: TimeZoom): ZoomDef {
  const px: Record<TimeZoom, number> = { day: 46, week: 24, month: 9, quarter: 3.6, year: 1.7 };
  return { id, label: zoomLabel(id), pxPerDay: px[id] };
}
export const ZOOMS: Record<TimeZoom, ZoomDef> = {
  day: zoomDef("day"),
  week: zoomDef("week"),
  month: zoomDef("month"),
  quarter: zoomDef("quarter"),
  year: zoomDef("year"),
};
export const ZOOM_ORDER: TimeZoom[] = ["day", "week", "month", "quarter", "year"];

// How far prev/next nudges the scroll anchor, in days, per zoom.
const SHIFT_DAYS: Record<TimeZoom, number> = {
  day: 7, week: 21, month: 60, quarter: 120, year: 365,
};

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad2 = (n: number) => n.toString().padStart(2, "0");

// ---------- Key arithmetic (UTC, timezone-safe) ----------

export function addDaysKey(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
function minKey(a: string, b: string): string { return a <= b ? a : b; }
function maxKey(a: string, b: string): string { return a >= b ? a : b; }
// Monday=0 … Sunday=6, for a "YYYY-MM-DD" key.
export function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// ---------- Axis ----------

export interface TimeAxis {
  zoom: TimeZoom;
  pxPerDay: number;
  startKey: string;   // domain start → x = 0
  endKey: string;     // domain end (inclusive)
  totalDays: number;
  width: number;      // px
  today: string;
  xForKey(key: string): number;
  /** Left px of the day a stored date value falls on, or null when unset. */
  xForDate(v: string | null | undefined): number | null;
  /** Snap a px offset back to the day key it lands in. */
  keyForX(px: number): string;
}

// Build the visible domain: spans every task's dates, always includes today
// and the scroll anchor, padded by the zoom so bars never hug the edge.
export function buildAxis(tasks: TaskFile[], zoom: TimeZoom, anchorKey: string, fields?: DateFields): TimeAxis {
  const today = todayKey();
  let lo = minKey(anchorKey, today);
  let hi = maxKey(anchorKey, today);
  for (const t of tasks) {
    for (const v of [taskDateValue(t, fields?.start, DATE_SOURCE_START), taskDateValue(t, fields?.due, DATE_SOURCE_DUE)]) {
      const k = dayKey(v);
      if (!k) continue;
      lo = minKey(lo, k);
      hi = maxKey(hi, k);
    }
  }
  const pad = SHIFT_DAYS[zoom];
  const startKey = addDaysKey(lo, -pad);
  const endKey = addDaysKey(hi, pad);
  return buildRangeAxis(zoom, startKey, endKey);
}

// Fixed-domain variant used by graphical exports. Unlike buildAxis it does not
// add padding or force today into the domain: the requested date range is the
// exact printable window.
export function buildRangeAxis(zoom: TimeZoom, startKey: string, endKey: string): TimeAxis {
  const pxPerDay = ZOOMS[zoom].pxPerDay;
  const today = todayKey();
  const totalDays = dayDiff(startKey, endKey) + 1;
  const width = Math.round(totalDays * pxPerDay);
  return {
    zoom, pxPerDay, startKey, endKey, totalDays, width, today,
    xForKey(key) { return dayDiff(startKey, key) * pxPerDay; },
    xForDate(v) { const k = dayKey(v); return k ? dayDiff(startKey, k) * pxPerDay : null; },
    keyForX(px) { return addDaysKey(startKey, Math.floor(px / pxPerDay)); },
  };
}

export function shiftKey(key: string, zoom: TimeZoom, dir: number): string {
  return addDaysKey(key, SHIFT_DAYS[zoom] * dir);
}

// ---------- Bar geometry ----------

// Configurable date sources for the bar span. `undefined` = the classic
// start_date/due_date pair. See src/data/date-source.ts for the vocabulary.
export interface DateFields {
  start?: string;
  due?: string;
}

// The bar sources a view context configures, in barGeom/buildAxis shape.
export function ctxDateFields(ctx: { startField?: string; dateField?: string }): DateFields {
  return { start: ctx.startField, due: ctx.dateField };
}

export type BarKind = "bar" | "milestone" | "none";

export interface BarGeom {
  kind: BarKind;
  x: number;        // bar left (bar) — unused for milestone
  width: number;    // bar width (bar)
  cx: number;       // center x (milestone) / bar center
  startKey: string; // resolved span (for edit math)
  endKey: string;
  // Which dates the task actually has. A "due only" task resolves startKey ==
  // endKey == due, so the drag handler needs these flags to know whether a
  // resize should FILL the missing edge (grow the span) vs slide the bar.
  hasStart: boolean;
  hasDue: boolean;
}

// Resolve a task's bar. Milestones become diamonds (no span). Tasks with only
// one of start/due collapse to a single-day bar; with neither → "none"
// (rendered in the unscheduled rail instead).
export function barGeom(t: TaskFile, axis: TimeAxis, fields?: DateFields): BarGeom {
  const s = dayKey(taskDateValue(t, fields?.start, DATE_SOURCE_START));
  const d = dayKey(taskDateValue(t, fields?.due, DATE_SOURCE_DUE));
  const hasStart = !!s, hasDue = !!d;
  const isMilestone = t.data.type === "milestone";
  if (isMilestone) {
    const at = d || s;
    if (!at) return { kind: "none", x: 0, width: 0, cx: 0, startKey: "", endKey: "", hasStart, hasDue };
    const cx = axis.xForKey(at) + axis.pxPerDay / 2;
    return { kind: "milestone", x: cx, width: 0, cx, startKey: at, endKey: at, hasStart, hasDue };
  }
  if (!s && !d) return { kind: "none", x: 0, width: 0, cx: 0, startKey: "", endKey: "", hasStart, hasDue };
  const startKey = s && d ? minKey(s, d) : (s || d)!;
  const endKey = s && d ? maxKey(s, d) : (s || d)!;
  const x = axis.xForKey(startKey);
  const width = Math.max(BAR_MIN_W, (dayDiff(startKey, endKey) + 1) * axis.pxPerDay);
  return { kind: "bar", x, width, cx: x + width / 2, startKey, endKey, hasStart, hasDue };
}

// ---------- Shared view context ----------
// A loose subset of main-view's tasksContext() — exactly what the engine reads.

export interface TimeViewContext {
  statuses: StatusDef[];
  priorities: PriorityDef[];
  priorityLabels: Record<number, string>;
  visibleFields: string[];
  features: Record<string, boolean>;
  tagsPalette: { name: string; color: string }[];
  contextLabels: { name: string; color: string }[];
  taskTypesOrder: { id: string; name?: string; color?: string; icon?: string }[];
  customFields: CustomFieldDef[];
  chipStyles: ResolvedChipStyles;
  // Bar tint source (mapped from main-view's calendarColorBy transient).
  colorBy?: string;
  // Bar date sources: startField → bar start, dateField → bar end. `undefined`
  // = start_date/due_date (see date-source.ts).
  startField?: string;
  dateField?: string;
  // Timeline: show the "Unscheduled" tray. Default true; false hides it.
  showUnscheduled?: boolean;
  subtaskStats?: Map<string, { total: number; done: number }>;
  relationshipCounts?: Map<string, number>;
  taskTitles?: Map<string, string>;
}

const COLOR_FALLBACK = "#2196F3";
export const COLOR_SOURCE_DEFAULT = "default";

// Bar accent color, mirroring calendar's resolvePillColor so the time views,
// calendar, and board all tint identically. Explicit `colorBy` source =
// single lookup (neutral if absent); default = task.color → priority → status.
export function resolveBarColor(t: TaskFile, ctx: TimeViewContext): string {
  const source = ctx.colorBy;
  const lookup = (src: string): string | undefined => {
    if (src === "status") return ctx.statuses.find((s) => s.id === t.data.status)?.color;
    if (src === "priority") return ctx.priorities.find((p) => p.id === t.data.priority)?.color;
    if (src === "context") {
      const first = (t.data.context || [])[0];
      return first ? ctx.contextLabels.find((c) => c.name === first)?.color : undefined;
    }
    if (src === "type") return ctx.taskTypesOrder.find((tt) => tt.id === t.data.type)?.color;
    if (src.startsWith("custom_field:")) {
      const id = src.slice("custom_field:".length);
      const cf = ctx.customFields.find((c) => c.id === id);
      if (!cf || !cf.options?.length) return undefined;
      const raw = t.data.custom_fields?.[id];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (value === undefined || value === null || value === "") return undefined;
      const str = String(value);
      return cf.options.find((o) => (o.value ?? o.label) === str || o.label === str)?.color;
    }
    return undefined;
  };
  if (source && source !== COLOR_SOURCE_DEFAULT) return lookup(source) || COLOR_FALLBACK;
  if (t.data.color) return t.data.color;
  return lookup("priority") || lookup("status") || COLOR_FALLBACK;
}

// Progress fraction (0..1) painted inside a bar. Prefers an explicit progress
// custom field, then the subtask done-ratio, then a status-group heuristic.
export function taskProgress(t: TaskFile, ctx: TimeViewContext): number {
  for (const cf of ctx.customFields) {
    if (cf.type !== "progress_manual" && cf.type !== "progress_auto") continue;
    const raw = effectiveCustomFieldValue(t, cf, { subtaskStats: ctx.subtaskStats });
    if (raw !== undefined && raw !== null && raw !== "") {
      return Math.max(0, Math.min(1, Number(raw) / 100));
    }
  }
  const st = ctx.subtaskStats?.get(t.data.id);
  if (st && st.total > 0) return Math.max(0, Math.min(1, st.done / st.total));
  if (t.data.status_group === "done" || t.data.status_group === "closed") return 1;
  return 0;
}

// ---------- Toolbar ----------

// Nav callbacks shared by both time views — wired by main-view to mutate the
// zoom/anchor state and re-render (same model as the calendar toolbar).
export interface TimeNavHandlers {
  onShift: (dir: number) => void;
  onZoom: (z: TimeZoom) => void;
  onToday: () => void;
}

export interface ToolbarOpts {
  zoom: TimeZoom;
  title: string;
  onZoom: (z: TimeZoom) => void;
  onShift: (dir: number) => void;
  onToday: () => void;
  // Optional slot for view-specific buttons (e.g. Gantt's dependency toggle),
  // appended to the right of the toolbar.
  extras?: (host: HTMLElement) => void;
}

export function renderTimeToolbar(parent: HTMLElement, opts: ToolbarOpts) {
  const bar = parent.createDiv({ cls: "it-tg-toolbar" });

  const nav = bar.createDiv({ cls: "it-tg-toolbar-nav" });
  const prev = nav.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": t("timeGrid.earlier") } });
  setIcon(prev, "chevron-left");
  prev.addEventListener("click", () => opts.onShift(-1));
  nav.createSpan({ cls: "it-tg-title", text: opts.title });
  const next = nav.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": t("timeGrid.later") } });
  setIcon(next, "chevron-right");
  next.addEventListener("click", () => opts.onShift(1));
  const today = nav.createEl("button", { cls: "it-btn-secondary", text: t("cal.today") });
  today.addEventListener("click", () => opts.onToday());

  bar.createDiv({ cls: "it-flex-grow" });

  if (opts.extras) { const host = bar.createDiv({ cls: "it-tg-toolbar-extras" }); opts.extras(host); }

  const zoomSeg = bar.createDiv({ cls: "it-tg-zoom" });
  for (const z of ZOOM_ORDER) {
    const b = zoomSeg.createEl("button", {
      cls: "it-tg-zoom-btn" + (opts.zoom === z ? " is-active" : ""),
      text: zoomLabel(z),
      attr: { type: "button" },
    });
    b.addEventListener("click", () => opts.onZoom(z));
  }
}

// Human title for the toolbar — the month/year the anchor sits in.
export function axisTitle(anchorKey: string): string {
  const [y, m] = anchorKey.split("-").map(Number);
  return `${monthName((m || 1) - 1)} ${y}`;
}

// ---------- Scaffold (rail + sticky axis + canvas) ----------

export interface Scaffold {
  root: HTMLElement;
  axisScroll: HTMLElement;   // owns vertical scroll (and horizontal on desktop)
  hScroll: HTMLElement;      // owns horizontal scroll: desktop = axisScroll;
                             // mobile = root (so the rail scrolls with the canvas)
  axisHeaderEl: HTMLElement; // sticky top
  canvasEl: HTMLElement;     // absolute-positioned bars live here
  railHeadEl?: HTMLElement;  // Gantt rail header (aligns with axis header)
  railBodyEl?: HTMLElement;  // Gantt rail rows (vertical-synced to canvas)
}

export function normalizeTimeRailWidth(value: number | undefined, fallback: number): number {
  const next = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(TIME_RAIL_MAX_W, Math.max(TIME_RAIL_MIN_W, Math.round(next)));
}

export function renderTimeScaffold(
  parent: HTMLElement,
  axis: TimeAxis,
  opts: { rail: boolean; bodyHeight: number; railHeadLabel?: string; railWidth?: number; onRailWidthChange?: (width: number) => void },
): Scaffold {
  const root = parent.createDiv({ cls: "it-tg" + (opts.rail ? " has-rail" : "") });

  let railEl: HTMLElement | undefined;
  let railHeadEl: HTMLElement | undefined;
  let railContentEl: HTMLElement | undefined; // the tall, scrolled inner content
  let railViewport: HTMLElement | undefined;  // the clipping viewport
  let syncRail: (() => void) | undefined;
  if (opts.rail) {
    railEl = root.createDiv({ cls: "it-tg-rail" });
    if (!Platform.isMobile) setRailWidth(railEl, opts.railWidth);
    railHeadEl = railEl.createDiv({ cls: "it-tg-rail-head" });
    if (opts.railHeadLabel) railHeadEl.createSpan({ cls: "it-tg-rail-head-label", text: opts.railHeadLabel });
    railViewport = railEl.createDiv({ cls: "it-tg-rail-body" });
    // Inner content is the full body height so it scrolls (and so absolutely
    // positioned lane gutters move with the canvas). The viewport clips it.
    railContentEl = railViewport.createDiv({ cls: "it-tg-rail-content" });
    railContentEl.style.height = `${opts.bodyHeight}px`;
    if (!Platform.isMobile && opts.onRailWidthChange) {
      const grip = root.createDiv({ cls: "it-tg-rail-resize", attr: { title: t("timeGrid.railResize") } });
      attachRailResize(grip, railEl, railHeadEl, railContentEl, opts.onRailWidthChange, () => syncRail?.());
    }
  }

  const axisScroll = root.createDiv({ cls: "it-tg-main" });
  const axisHeaderEl = axisScroll.createDiv({ cls: "it-tg-axis" });
  axisHeaderEl.style.width = `${axis.width}px`;
  const canvasEl = axisScroll.createDiv({ cls: "it-tg-canvas" });
  canvasEl.style.width = `${axis.width}px`;
  canvasEl.style.height = `${opts.bodyHeight}px`;

  // Vertical sync: the rail viewport mirrors the canvas scroll. The main area
  // owns a horizontal scrollbar, so its vertical range is taller by that
  // scrollbar's height. Add the same blank tail to the rail content or its last
  // rows stop early and drift out of alignment at the bottom.
  if (railViewport && railContentEl) {
    syncRail = () => {
      const scrollbarHeight = Math.max(0, axisScroll.offsetHeight - axisScroll.clientHeight);
      railContentEl!.style.height = `${opts.bodyHeight + scrollbarHeight}px`;
      railViewport!.scrollTop = axisScroll.scrollTop;
    };
    axisScroll.addEventListener("scroll", syncRail);
    requestAnimationFrame(syncRail);
    root.querySelector(".it-tg-rail")?.addEventListener("wheel", (e) => {
      axisScroll.scrollTop += (e as WheelEvent).deltaY;
      e.preventDefault();
    }, { passive: false });
  }

  paintAxisHeader(axisHeaderEl, axis);
  paintGrid(canvasEl, axis, opts.bodyHeight);

  // On mobile the outer frame owns the horizontal scroll so the title rail
  // scrolls together with the time area instead of staying frozen (CSS makes
  // `.it-tg` the horizontal scroller and sizes `.it-tg-main` to its content).
  // On desktop the rail stays frozen and the main area scrolls both axes.
  const hScroll = Platform.isMobile ? root : axisScroll;

  return { root, axisScroll, hScroll, axisHeaderEl, canvasEl, railHeadEl, railBodyEl: railContentEl };
}

function setRailWidth(rail: HTMLElement, width: number | undefined): number {
  const next = normalizeTimeRailWidth(width, GANTT_RAIL_DEFAULT_W);
  rail.style.flexBasis = `${next}px`;
  rail.style.width = `${next}px`;
  return next;
}

function attachRailResize(
  grip: HTMLElement,
  rail: HTMLElement,
  railHead: HTMLElement,
  railContent: HTMLElement,
  onWidthChange: (width: number) => void,
  onResize: () => void,
) {
  grip.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onWidthChange(setRailWidth(rail, measureRailFitWidth(railHead, railContent)));
    onResize();
  });
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = rail.clientWidth;
    let width = startW;
    let moved = false;
    const onMove = (ev: MouseEvent) => {
      moved = true;
      width = setRailWidth(rail, startW + ev.clientX - startX);
      onResize();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("it-col-resizing");
      if (moved) onWidthChange(width);
    };
    document.body.classList.add("it-col-resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function measureRailFitWidth(railHead: HTMLElement, railContent: HTMLElement): number {
  const measure = document.createElement("div");
  measure.className = "it-tg-rail-measure";
  document.body.appendChild(measure);
  let width = 0;
  for (const source of [railHead, ...Array.from(railContent.children)] as HTMLElement[]) {
    const clone = source.cloneNode(true) as HTMLElement;
    for (const prop of ["position", "left", "right", "top", "width", "max-width"]) clone.style.removeProperty(prop);
    clone.addClass("it-tg-measure-clone");
    measure.appendChild(clone);
    width = Math.max(width, clone.scrollWidth, Math.ceil(clone.getBoundingClientRect().width));
  }
  measure.remove();
  return normalizeTimeRailWidth(width + 2, GANTT_RAIL_DEFAULT_W);
}

// Center the viewport on a day key (used after render + on nav).
export function scrollToKey(scaffold: Scaffold, axis: TimeAxis, key: string, align: "start" | "center" = "center") {
  const x = axis.xForKey(key);
  const hs = scaffold.hScroll;
  const w = hs.clientWidth;
  // On mobile the rail scrolls inside the same horizontal scroller, so the canvas
  // starts `railOffset` px into the scroll content; on desktop the scroller is the
  // canvas area itself (offset 0).
  const railOffset = hs === scaffold.axisScroll
    ? 0
    : ((scaffold.root.querySelector(".it-tg-rail") as HTMLElement | null)?.offsetWidth ?? 0);
  const base = railOffset + x;
  const target = align === "center" ? Math.max(0, base - w / 2) : Math.max(0, base - axis.pxPerDay);
  hs.scrollLeft = target;
}

// ---------- Header + grid painting ----------

export interface Tick { x: number; width: number; label: string }

function paintAxisHeader(host: HTMLElement, axis: TimeAxis) {
  host.empty();
  const { top, bottom } = buildTicks(axis);
  const topRow = host.createDiv({ cls: "it-tg-axis-top" });
  for (const t of top) {
    const cell = topRow.createDiv({ cls: "it-tg-axis-cell" });
    cell.style.left = `${t.x}px`;
    cell.style.width = `${t.width}px`;
    cell.createSpan({ text: t.label });
  }
  const botRow = host.createDiv({ cls: "it-tg-axis-bottom" });
  for (const t of bottom) {
    const cell = botRow.createDiv({ cls: "it-tg-axis-cell" });
    cell.style.left = `${t.x}px`;
    cell.style.width = `${t.width}px`;
    if (t.label) cell.createSpan({ text: t.label });
  }
  // Today marker label on the header.
  const tx = axis.xForKey(axis.today);
  const todayTick = host.createDiv({ cls: "it-tg-axis-today" });
  todayTick.style.left = `${tx + axis.pxPerDay / 2}px`;
}

function paintGrid(canvas: HTMLElement, axis: TimeAxis, bodyHeight: number) {
  const grid = canvas.createDiv({ cls: "it-tg-grid" });
  grid.style.height = `${bodyHeight}px`;
  const { bottom } = buildTicks(axis);
  // Vertical gridlines on bottom-tier boundaries.
  for (const t of bottom) {
    const line = grid.createDiv({ cls: "it-tg-gridline" });
    line.style.left = `${t.x}px`;
  }
  // Weekend shading — only meaningful when days are wide enough to read.
  if (axis.zoom === "day" || axis.zoom === "week") {
    for (let i = 0; i < axis.totalDays; i++) {
      const key = addDaysKey(axis.startKey, i);
      const wd = weekdayOfKey(key);
      if (wd >= 5) {
        const band = grid.createDiv({ cls: "it-tg-weekend" });
        band.style.left = `${axis.xForKey(key)}px`;
        band.style.width = `${axis.pxPerDay}px`;
      }
    }
  }
  // Today line.
  const todayLine = grid.createDiv({ cls: "it-tg-today-line" });
  todayLine.style.left = `${axis.xForKey(axis.today) + axis.pxPerDay / 2}px`;
}

// Two-tier ticks per zoom. Top tier = coarse (month/year), bottom = fine
// (day/week/month/quarter). Each tick is clamped to the domain.
export function buildTicks(axis: TimeAxis): { top: Tick[]; bottom: Tick[] } {
  switch (axis.zoom) {
    case "day":     return { top: monthTicks(axis, true), bottom: dayTicks(axis) };
    case "week":    return { top: monthTicks(axis, true), bottom: weekTicks(axis) };
    case "month":   return { top: yearTicks(axis), bottom: monthTicks(axis, false) };
    case "quarter": return { top: yearTicks(axis), bottom: monthTicks(axis, false) };
    case "year":    return { top: yearTicks(axis), bottom: quarterTicks(axis) };
  }
}

function seg(axis: TimeAxis, fromKey: string, toKey: string, label: string): Tick {
  const x = axis.xForKey(fromKey);
  const width = (dayDiff(fromKey, toKey) + 1) * axis.pxPerDay;
  return { x, width, label };
}

function dayTicks(axis: TimeAxis): Tick[] {
  const out: Tick[] = [];
  for (let i = 0; i < axis.totalDays; i++) {
    const key = addDaysKey(axis.startKey, i);
    const d = key.split("-")[2];
    out.push({ x: axis.xForKey(key), width: axis.pxPerDay, label: String(Number(d)) });
  }
  return out;
}

function weekTicks(axis: TimeAxis): Tick[] {
  const out: Tick[] = [];
  // Start at the Monday on/just before the domain start.
  let cur = addDaysKey(axis.startKey, -weekdayOfKey(axis.startKey));
  while (cur <= axis.endKey) {
    const weekEnd = addDaysKey(cur, 6);
    const from = maxKey(cur, axis.startKey);
    const to = minKey(weekEnd, axis.endKey);
    const dom = from.split("-")[2];
    out.push(seg(axis, from, to, String(Number(dom))));
    cur = addDaysKey(cur, 7);
  }
  return out;
}

// `withYear`: include the year in the label ("May 2026"). Off → bare month
// ("May"), used when a year tier already sits above it.
function monthTicks(axis: TimeAxis, withYear: boolean): Tick[] {
  const out: Tick[] = [];
  let [y, m] = axis.startKey.split("-").map(Number);
  while (true) {
    const monthStart = `${y}-${pad2(m)}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const monthEnd = `${y}-${pad2(m)}-${pad2(lastDay)}`;
    if (monthStart > axis.endKey) break;
    if (monthEnd >= axis.startKey) {
      const label = withYear ? `${MONTHS_SHORT[m - 1]} ${y}` : MONTHS_SHORT[m - 1];
      out.push(seg(axis, maxKey(monthStart, axis.startKey), minKey(monthEnd, axis.endKey), label));
    }
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function quarterTicks(axis: TimeAxis): Tick[] {
  const out: Tick[] = [];
  let [y] = axis.startKey.split("-").map(Number);
  for (let yy = y; ; yy++) {
    let stop = false;
    for (let q = 0; q < 4; q++) {
      const qStartMonth = q * 3 + 1;
      const qStart = `${yy}-${pad2(qStartMonth)}-01`;
      const endMonth = qStartMonth + 2;
      const lastDay = new Date(Date.UTC(yy, endMonth, 0)).getUTCDate();
      const qEnd = `${yy}-${pad2(endMonth)}-${pad2(lastDay)}`;
      if (qStart > axis.endKey) { stop = true; break; }
      if (qEnd >= axis.startKey) {
        out.push(seg(axis, maxKey(qStart, axis.startKey), minKey(qEnd, axis.endKey), `Q${q + 1}`));
      }
    }
    if (stop) break;
  }
  return out;
}

function yearTicks(axis: TimeAxis): Tick[] {
  const out: Tick[] = [];
  let [y] = axis.startKey.split("-").map(Number);
  while (true) {
    const yStart = `${y}-01-01`;
    const yEnd = `${y}-12-31`;
    if (yStart > axis.endKey) break;
    if (yEnd >= axis.startKey) out.push(seg(axis, maxKey(yStart, axis.startKey), minKey(yEnd, axis.endKey), String(y)));
    y++;
  }
  return out;
}

// ---------- Bar drag/resize (desktop) ----------

export interface BarDragOpts {
  axis: TimeAxis;
  geom: BarGeom;
  enabled: boolean; // false on mobile → click-only
  onClick: () => void;
  // Commit a date change. `ev` is the final pointer event so callers (Timeline)
  // can also read clientY to detect a lane change.
  onCommit: (patch: { start_date?: string; due_date?: string }, ev: PointerEvent) => void;
}

// Wires pointer move/resize onto a bar element. The element is expected to be
// absolutely positioned (left/width already set). We preview by mutating
// left/width live, then commit day-snapped keys on release.
export function attachBarDrag(barEl: HTMLElement, opts: BarDragOpts) {
  const { axis, geom } = opts;
  if (!opts.enabled || geom.kind === "none") {
    barEl.addEventListener("click", (e) => { e.stopPropagation(); opts.onClick(); });
    return;
  }
  barEl.classList.add("is-editable");

  let mode: "move" | "start" | "end" | null = null;
  let downX = 0, moved = false;
  const origX = geom.x, origW = geom.width;
  // Logical span in days (1 for a single-day or due-only bar). Used to clamp
  // resizes so a bar never shrinks below one day — independent of pixel width,
  // which BAR_MIN_W inflates at small zooms.
  const spanDays = geom.kind === "bar" ? Math.max(1, dayDiff(geom.startKey, geom.endKey) + 1) : 1;

  const zoneFor = (e: PointerEvent): "move" | "start" | "end" => {
    if (geom.kind === "milestone") return "move";
    const rect = barEl.getBoundingClientRect();
    const off = e.clientX - rect.left;
    if (off <= HANDLE_W && origW > HANDLE_W * 2) return "start";
    if (off >= rect.width - HANDLE_W && origW > HANDLE_W * 2) return "end";
    return "move";
  };

  barEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    mode = zoneFor(e);
    downX = e.clientX;
    moved = false;
    barEl.setPointerCapture(e.pointerId);
    barEl.classList.add("is-dragging");
    e.stopPropagation();
    e.preventDefault();
  });

  barEl.addEventListener("pointermove", (e) => {
    if (!mode) return;
    const dxDays = Math.round((e.clientX - downX) / axis.pxPerDay);
    if (Math.abs(e.clientX - downX) > 3) moved = true;
    if (geom.kind === "milestone") {
      barEl.style.left = `${origX + dxDays * axis.pxPerDay}px`;
      return;
    }
    if (mode === "move") {
      barEl.style.left = `${origX + dxDays * axis.pxPerDay}px`;
    } else if (mode === "start") {
      const dd = Math.min(dxDays, spanDays - 1); // keep ≥ 1 day
      barEl.style.left = `${origX + dd * axis.pxPerDay}px`;
      barEl.style.width = `${origW - dd * axis.pxPerDay}px`;
    } else if (mode === "end") {
      const dd = Math.max(dxDays, -(spanDays - 1));
      barEl.style.width = `${origW + dd * axis.pxPerDay}px`;
    }
  });

  const finish = (e: PointerEvent) => {
    if (!mode) return;
    const curMode = mode;
    mode = null;
    barEl.classList.remove("is-dragging");
    try { barEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!moved) { opts.onClick(); return; }
    const dxDays = Math.round((e.clientX - downX) / axis.pxPerDay);
    if (geom.kind === "milestone") {
      const nk = addDaysKey(geom.startKey, dxDays);
      // A milestone tracks its due date (its single anchor).
      opts.onCommit({ due_date: nk }, e);
      return;
    }
    if (curMode === "move") {
      // Moving preserves which dates the task has: a due-only "deadline" stays
      // due-only (shift due), a start-only task shifts start, a real span shifts
      // both. (Avoids silently introducing a start_date on a deadline.)
      if (geom.hasStart && geom.hasDue) {
        opts.onCommit({ start_date: addDaysKey(geom.startKey, dxDays), due_date: addDaysKey(geom.endKey, dxDays) }, e);
      } else if (geom.hasDue) {
        opts.onCommit({ due_date: addDaysKey(geom.endKey, dxDays) }, e);
      } else {
        opts.onCommit({ start_date: addDaysKey(geom.startKey, dxDays) }, e);
      }
    } else if (curMode === "start") {
      // Resize the left edge: pin the right (due) edge and set the new start.
      // For a due-only task this fills in start_date so the bar grows into a
      // real span instead of sliding.
      const dd = Math.min(dxDays, spanDays - 1);
      opts.onCommit({ start_date: addDaysKey(geom.startKey, dd), due_date: geom.endKey }, e);
    } else if (curMode === "end") {
      // Resize the right edge: pin the left (start) edge and set the new due.
      // For a due-only task this writes start_date = old due, so extending by a
      // day yields start = old due, due = old due + 1 (a true 2-day span).
      const dd = Math.max(dxDays, -(spanDays - 1));
      opts.onCommit({ start_date: geom.startKey, due_date: addDaysKey(geom.endKey, dd) }, e);
    }
  };
  barEl.addEventListener("pointerup", finish);
  barEl.addEventListener("pointercancel", (e) => { mode = null; barEl.classList.remove("is-dragging"); });
}

// Whether bar editing is available (desktop only — mobile is read + tap).
export const TIME_EDIT_ENABLED = !Platform.isMobile;
