// Graphical export for the Gantt / Timeline views.
//
// Renders a faithful snapshot to an offscreen <canvas> using the SAME layout
// math as the on-screen views (buildAxis / barGeom / resolveBarColor), then
// writes it into the vault as a PNG or a dependency-free single-image PDF.
// No third-party libs: the PDF embeds the canvas JPEG via the DCTDecode filter,
// which is the one image codec PDF accepts raw.

import { Notice, normalizePath } from "obsidian";
import type InventTasksPlugin from "../main";
import { TaskFile, TimeZoom } from "../types";
import { fieldLabelFrom, t as tr } from "../i18n";
import { groupTasks, GroupContext } from "./filters";
import { getBlocks } from "./relationships";
import { TimeViewContext, TimeAxis, buildRangeAxis, buildTicks, barGeom, BarGeom, resolveBarColor, taskProgress, addDaysKey, weekdayOfKey, AXIS_H, ctxDateFields, DateFields } from "../views/time-grid";
import { taskDateValue } from "./date-source";
import { DATE_SOURCE_DUE, DATE_SOURCE_START } from "../constants";
import { dayKey, formatDuration, todayKey } from "../utils/dates";
import { customFieldText, effectiveCustomFieldValue } from "./custom-fields";

export type TimeExportFormat = "png" | "pdf";
export type TimeExportTheme = "light" | "dark";

export interface TimeExportInput {
  viewType: "gantt" | "timeline";
  tasks: TaskFile[];
  context: TimeViewContext;
  zoom: TimeZoom;
  groupBy: string;            // "" → flat (Gantt)
  groupDirection: "asc" | "desc";
  showDependencies: boolean;
  showProgress: boolean;
  title: string;
  options?: Partial<TimeExportOptions>;
}

export interface TimeExportOptions {
  dateFrom: string;
  dateTo: string;
  showTaskLabels: boolean;
  showUnscheduled: boolean;
  markerEnabled: boolean;
  markerDate: string;
  theme: TimeExportTheme;
}

const BASE_RAIL_W = 230;
const MAX_DETAIL_RAIL_W = 900;
const HEADER_H = AXIS_H;
const ROW_H = 26;
const PAD = 16;
const MAX_W = 5200;          // cap canvas width; we scale the time axis to fit

const pad2 = (n: number) => n.toString().padStart(2, "0");

// Export palettes are explicit so the printed result does not depend on the
// active Obsidian theme.
function themeColors(theme: TimeExportTheme): { bg: string; surface: string; text: string; muted: string; border: string; grid: string } {
  if (theme === "dark") {
    return {
      bg: "#202020",
      surface: "#292d34",
      text: "#f2f2f2",
      muted: "#b8b8c2",
      border: "#454550",
      grid: "#3b3b45",
    };
  }
  return {
    bg: "#ffffff",
    surface: "#f8f9fa",
    text: "#292d34",
    muted: "#646464",
    border: "#e8e8e8",
    grid: "#eef0f2",
  };
}

interface Placed { task: TaskFile; geom: BarGeom; row: number }
interface LaneOut { label: string; color?: string; top: number; height: number; placed: Placed[] }
interface ExportLabel { text: string; color?: string }
/** The caller's context may carry per-location field-label overrides. */
type TimeViewContextWithLabels = TimeViewContext & { fieldLabels?: Record<string, string> };
interface UnscheduledOut { top: number; height: number; tasks: TaskFile[] }

export function defaultTimeExportRange(tasks: TaskFile[], fields?: DateFields): { dateFrom: string; dateTo: string } {
  const keys: string[] = [];
  for (const t of tasks) {
    const start = dayKey(taskDateValue(t, fields?.start, DATE_SOURCE_START));
    const due = dayKey(taskDateValue(t, fields?.due, DATE_SOURCE_DUE));
    if (start) keys.push(start);
    if (due) keys.push(due);
  }
  keys.sort();
  const today = todayKey();
  return { dateFrom: keys[0] || today, dateTo: keys[keys.length - 1] || today };
}

function resolveOptions(input: TimeExportInput): TimeExportOptions {
  const range = defaultTimeExportRange(input.tasks, ctxDateFields(input.context));
  return {
    dateFrom: dayKey(input.options?.dateFrom) || range.dateFrom,
    dateTo: dayKey(input.options?.dateTo) || range.dateTo,
    showTaskLabels: input.options?.showTaskLabels ?? false,
    showUnscheduled: input.options?.showUnscheduled ?? false,
    markerEnabled: input.options?.markerEnabled ?? false,
    markerDate: dayKey(input.options?.markerDate) || todayKey(),
    theme: input.options?.theme === "dark" ? "dark" : "light",
  };
}

function isUnscheduled(t: TaskFile, fields?: DateFields): boolean {
  return !dayKey(taskDateValue(t, fields?.start, DATE_SOURCE_START)) && !dayKey(taskDateValue(t, fields?.due, DATE_SOURCE_DUE));
}

function intersectsRange(t: TaskFile, from: string, to: string, fields?: DateFields): boolean {
  const start = dayKey(taskDateValue(t, fields?.start, DATE_SOURCE_START));
  const due = dayKey(taskDateValue(t, fields?.due, DATE_SOURCE_DUE));
  if (!start && !due) return false;
  const lo = start && due ? (start < due ? start : due) : (start || due)!;
  const hi = start && due ? (start > due ? start : due) : (start || due)!;
  return lo <= to && hi >= from;
}

function groupContextFrom(input: TimeExportInput): GroupContext {
  const c = input.context;
  return {
    statuses: c.statuses,
    priorities: c.priorities,
    priorityLabels: c.priorityLabels,
    tagsOrder: c.tagsPalette.map((t) => t.name),
    contextOrder: c.contextLabels.map((x) => x.name),
    taskTypesOrder: c.taskTypesOrder,
    tagsPalette: c.tagsPalette,
    contextLabels: c.contextLabels,
    customFields: c.customFields,
    subtaskStats: c.subtaskStats,
    taskTitles: c.taskTitles,
    fieldLabels: (c as TimeViewContextWithLabels).fieldLabels,
    direction: input.groupDirection,
  };
}

function exportRailWidth(input: TimeExportInput, tasks: TaskFile[], options: TimeExportOptions): number {
  if (input.viewType !== "gantt" || !options.showTaskLabels) return BASE_RAIL_W;
  let width = BASE_RAIL_W;
  for (const t of tasks) {
    const estimated = 26 + estimatedTaskLabelWidth(t, input.context, true);
    width = Math.max(width, estimated);
  }
  return Math.min(MAX_DETAIL_RAIL_W, Math.ceil(width));
}

function taskLabels(t: TaskFile, context: TimeViewContext): ExportLabel[] {
  const out: ExportLabel[] = [];
  for (const field of context.visibleFields) {
    if (field === "type_icon" || field === "type") {
      const type = context.taskTypesOrder.find((x) => x.id === (t.data.type || "task"));
      out.push({ text: type?.name || type?.id || t.data.type || "Task", color: type?.color });
      continue;
    }
    if (field === "custom_id") {
      if (t.data.custom_id) out.push({ text: t.data.custom_id });
      continue;
    }
    if (field === "id") {
      out.push({ text: t.data.id });
      continue;
    }
    if (field === "status") {
      const status = context.statuses.find((x) => x.id === t.data.status);
      out.push({ text: status?.name || "No status", color: status?.color });
      continue;
    }
    if (field === "priority") {
      const priority = context.priorities.find((x) => x.id === t.data.priority);
      out.push({ text: priority?.label || "—", color: priority?.color });
      continue;
    }
    if (field === "tags") {
      for (const tag of (t.data.tags || []).slice(0, 2)) {
        out.push({ text: `#${tag}`, color: context.tagsPalette.find((x) => x.name === tag)?.color });
      }
      continue;
    }
    if (field === "context") {
      for (const label of (t.data.context || []).slice(0, 2)) {
        out.push({ text: label, color: context.contextLabels.find((x) => x.name === label)?.color });
      }
      continue;
    }
    if (field === "subtask_count") {
      const count = context.subtaskStats?.get(t.data.id)?.total ?? 0;
      if (count) out.push({ text: `↳ ${count}` });
      continue;
    }
    if (field === "relationship_count") {
      const count = context.relationshipCounts?.get(t.data.id) ?? 0;
      if (count) out.push({ text: `links ${count}` });
      continue;
    }
    if (field === "time_estimate" || field === "time_tracked") {
      const minutes = field === "time_estimate" ? t.data.time_estimate : t.data.time_tracked;
      if (minutes) out.push({ text: `${field === "time_estimate" ? "est." : "tracked"} ${formatDuration(minutes)}` });
      continue;
    }
    if (field === "sprint_points") {
      if (t.data.sprint_points != null) out.push({ text: `${t.data.sprint_points} pts` });
      continue;
    }
    if (field === "space" || field === "folder" || field === "list") {
      const location = field === "space" ? t.data.space : field === "folder" ? t.data.folder : t.data.list;
      if (location) out.push({ text: location });
      continue;
    }
    if (field.startsWith("custom_field:")) {
      const id = field.slice("custom_field:".length);
      const cf = context.customFields.find((x) => x.id === id);
      const raw: unknown = cf ? effectiveCustomFieldValue(t, cf, { subtaskStats: context.subtaskStats }) : undefined;
      const value = cf ? customFieldText(cf, raw, { taskTitles: context.taskTitles }) : "";
      if (cf && value) out.push({ text: `${cf.name}: ${value}` });
      continue;
    }
    const raw = (t.data as unknown as Record<string, unknown>)[field];
    const value = simpleValue(raw);
    if (value) out.push({ text: `${fieldLabelFrom((context as TimeViewContextWithLabels).fieldLabels, field)}: ${value}` });
  }
  return out;
}

function simpleValue(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "";
  if (Array.isArray(raw)) return raw.map(simpleValue).filter(Boolean).join(", ");
  if (typeof raw === "object") {
    const o = raw as { label?: string | number; value?: string | number; name?: string | number };
    return String(o.label || o.value || o.name || "");
  }
  const primitive = raw as string | number | boolean;
  return String(primitive);
}

function estimatedTaskLabelWidth(t: TaskFile, context: TimeViewContext, showTaskLabels: boolean): number {
  const labels = showTaskLabels ? taskLabels(t, context) : [];
  const titleWidth = Math.min(labels.length ? 220 : Number.POSITIVE_INFINITY, (t.data.title || tr("common.untitled")).length * 6.4);
  return titleWidth + 7 + labels.reduce((sum, x) => sum + x.text.length * 5.8 + 14, 0);
}

function drawTaskLabelLine(
  g: CanvasRenderingContext2D, t: TaskFile, context: TimeViewContext, showTaskLabels: boolean,
  x: number, y: number, maxW: number, col: ReturnType<typeof themeColors>,
) {
  const labels = showTaskLabels ? taskLabels(t, context) : [];
  g.font = "12px sans-serif"; g.textBaseline = "middle"; g.fillStyle = col.text;
  const titleMax = labels.length ? Math.min(220, Math.max(90, maxW * 0.42)) : maxW;
  const title = clip(g, t.data.title || tr("common.untitled"), titleMax);
  g.fillText(title, x, y);
  let cursor = x + Math.min(titleMax, g.measureText(title).width) + 7;
  const right = x + maxW;
  for (const label of labels) {
    g.font = "10px sans-serif";
    const width = g.measureText(label.text).width + 10;
    if (cursor + width > right) {
      if (cursor + 8 <= right) { g.fillStyle = col.muted; g.fillText("…", cursor, y); }
      break;
    }
    roundRect(g, cursor, y - 8, width, 16, 5);
    g.save(); g.globalAlpha = 0.14; g.fillStyle = label.color || col.muted; g.fill(); g.restore();
    g.save(); g.globalAlpha = 0.55; g.strokeStyle = label.color || col.muted; g.lineWidth = 1; g.stroke(); g.restore();
    g.fillStyle = col.text; g.fillText(label.text, cursor + 5, y);
    cursor += width + 4;
  }
}

// Build the export canvas. Returns the canvas + its CSS pixel size.
function renderToCanvas(input: TimeExportInput): HTMLCanvasElement {
  const options = resolveOptions(input);
  const axis = buildRangeAxis(input.zoom, options.dateFrom, options.dateTo);
  const scale = axis.width > MAX_W ? MAX_W / axis.width : 1;
  const axisW = Math.round(axis.width * scale);
  const isTimeline = input.viewType === "timeline";
  const dateFields = ctxDateFields(input.context);
  const rangedTasks = input.tasks.filter((t) => intersectsRange(t, options.dateFrom, options.dateTo, dateFields));
  const unscheduled = input.tasks.filter((t) => isUnscheduled(t, dateFields));
  const tasks = isTimeline ? rangedTasks : input.tasks.filter((t) => isUnscheduled(t, dateFields) || intersectsRange(t, options.dateFrom, options.dateTo, dateFields));
  const railW = exportRailWidth(input, tasks, options);
  const sx = (x: number) => railW + x * scale;

  // Layout: Gantt = one row per task (grouped); Timeline = packed lanes.
  const lanes: LaneOut[] = [];
  let bodyTop = HEADER_H;
  const groupBy = isTimeline ? (input.groupBy || "status") : input.groupBy;

  if (groupBy) {
    const buckets = groupTasks(tasks, groupBy, groupContextFrom(input));
    for (const b of buckets) {
      if (isTimeline) {
        const placed = packLane(b.tasks, axis, scale, input.context, options.showTaskLabels);
        const rows = Math.max(1, placed.reduce((m, p) => Math.max(m, p.row + 1), 0));
        const height = rows * ROW_H + 8;
        lanes.push({ label: b.label, color: b.color, top: bodyTop, height, placed });
        bodyTop += height;
      } else {
        // Gantt grouped: header row + one row per task.
        const placed: Placed[] = b.tasks.map((task, i) => ({ task, geom: barGeom(task, axis, dateFields), row: i + 1 }));
        const height = (b.tasks.length + 1) * ROW_H + 4;
        lanes.push({ label: b.label, color: b.color, top: bodyTop, height, placed });
        bodyTop += height;
      }
    }
  } else {
    // Gantt flat: one lane, one row per task.
    const placed: Placed[] = tasks.map((task, i) => ({ task, geom: barGeom(task, axis, dateFields), row: i }));
    lanes.push({ label: "", top: bodyTop, height: tasks.length * ROW_H + 4, placed });
    bodyTop += tasks.length * ROW_H + 4;
  }

  const chartBottom = bodyTop;
  let unscheduledOut: UnscheduledOut | undefined;
  if (isTimeline && options.showUnscheduled && unscheduled.length) {
    const top = bodyTop + 8;
    unscheduledOut = { top, height: 26 + unscheduled.length * ROW_H + 8, tasks: unscheduled };
    bodyTop = top + unscheduledOut.height;
  }

  const width = railW + axisW;
  const height = bodyTop + PAD;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = createEl("canvas");
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const g = canvas.getContext("2d")!;
  g.scale(dpr, dpr);
  const col = themeColors(options.theme);

  // Background
  g.fillStyle = col.bg; g.fillRect(0, 0, width, height);
  g.fillStyle = col.surface; g.fillRect(0, 0, railW, chartBottom); // rail strip

  // Title
  g.fillStyle = col.text;
  g.font = "600 14px sans-serif";
  g.textBaseline = "middle";
  g.fillText(input.title, 12, HEADER_H / 2);

  // Axis header — same two-tier tick layout as the on-screen view.
  drawAxisHeader(g, axis, sx, scale, chartBottom, railW, col);

  if (options.markerEnabled) drawDateMarker(g, axis, sx, options.markerDate, chartBottom);

  // Lanes + bars.
  const barCenters = new Map<string, { x1: number; x2: number; y: number; kind: BarGeom["kind"] }>();
  for (const lane of lanes) {
    // Lane separator + gutter label.
    g.strokeStyle = col.border; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, lane.top); g.lineTo(width, lane.top); g.stroke();
    if (lane.label) {
      if (lane.color) { g.fillStyle = lane.color; g.fillRect(8, lane.top + 9, 8, 8); }
      g.fillStyle = col.text; g.font = "600 12px sans-serif";
      g.fillText(clip(g, lane.label, railW - 30), lane.color ? 22 : 10, lane.top + 14);
    }

    for (const p of lane.placed) {
      const y = lane.top + (input.viewType === "timeline" ? 4 : 0) + p.row * ROW_H + (input.viewType === "timeline" ? 4 : 4);
      // Gantt rail label per task.
      if (!isTimeline) {
        drawTaskLabelLine(g, p.task, input.context, options.showTaskLabels, 10, y + ROW_H / 2, railW - 16, col);
      }
      withChartClip(g, railW, axisW, chartBottom, () => {
        drawBar(g, p, axis, sx, scale, y, width, input, options, col, barCenters);
      });
    }
  }

  if (unscheduledOut) drawUnscheduled(g, unscheduledOut, width, input.context, options.showTaskLabels, col);

  // Dependency arrows (Gantt).
  if (input.viewType === "gantt" && input.showDependencies) {
    withChartClip(g, railW, axisW, chartBottom, () => {
      g.strokeStyle = col.muted; g.lineWidth = 1.2;
      for (const t of tasks) {
        const from = barCenters.get(t.data.id);
        if (!from) continue;
        for (const target of getBlocks(t)) {
          const to = barCenters.get(target);
          if (!to) continue;
          const elbow = Math.max(from.x2 + 8, to.x1 - 8);
          g.beginPath();
          g.moveTo(from.x2, from.y); g.lineTo(elbow, from.y);
          g.lineTo(elbow, to.y); g.lineTo(to.x1, to.y); g.stroke();
          g.beginPath(); g.moveTo(to.x1 - 5, to.y - 3); g.lineTo(to.x1, to.y); g.lineTo(to.x1 - 5, to.y + 3); g.stroke();
        }
      }
    });
  }
  return canvas;
}

function withChartClip(g: CanvasRenderingContext2D, railW: number, axisW: number, chartBottom: number, draw: () => void) {
  g.save();
  g.beginPath();
  g.rect(railW, HEADER_H, axisW, Math.max(0, chartBottom - HEADER_H));
  g.clip();
  draw();
  g.restore();
}

function packLane(tasks: TaskFile[], axis: TimeAxis, scale: number, context: TimeViewContext, showTaskLabels: boolean): Placed[] {
  const items = tasks.map((task) => ({ task, geom: barGeom(task, axis, ctxDateFields(context)) })).filter((it) => it.geom.kind !== "none");
  items.sort((a, b) => (a.geom.kind === "milestone" ? a.geom.cx : a.geom.x) - (b.geom.kind === "milestone" ? b.geom.cx : b.geom.x));
  const ends: number[] = [];
  const out: Placed[] = [];
  for (const it of items) {
    const left = (it.geom.kind === "milestone" ? it.geom.cx - 10 : it.geom.x) * scale;
    const barRight = (it.geom.kind === "milestone" ? it.geom.cx + 10 : it.geom.x + it.geom.width) * scale;
    const labelStart = (it.geom.kind === "milestone" ? it.geom.cx * scale + 12 : it.geom.x * scale + 6);
    const right = Math.max(barRight, labelStart + estimatedTaskLabelWidth(it.task, context, showTaskLabels));
    let row = ends.findIndex((e) => e <= left - 6);
    if (row === -1) { row = ends.length; ends.push(right); } else ends[row] = right;
    out.push({ task: it.task, geom: it.geom, row });
  }
  return out;
}

function drawBar(
  g: CanvasRenderingContext2D, p: Placed, axis: TimeAxis,
  sx: (x: number) => number, scale: number, y: number, canvasWidth: number, input: TimeExportInput,
  options: TimeExportOptions, col: ReturnType<typeof themeColors>,
  centers: Map<string, { x1: number; x2: number; y: number; kind: BarGeom["kind"] }>,
) {
  const color = resolveBarColor(p.task, input.context);
  const h = 16;
  if (p.geom.kind === "none") return;
  if (p.geom.kind === "milestone") {
    const cx = sx(p.geom.cx), cy = y + ROW_H / 2 - 2;
    g.fillStyle = color;
    g.beginPath(); g.moveTo(cx, cy - 7); g.lineTo(cx + 7, cy); g.lineTo(cx, cy + 7); g.lineTo(cx - 7, cy); g.closePath(); g.fill();
    drawTaskLabelLine(g, p.task, input.context, input.viewType === "timeline" && options.showTaskLabels, cx + 12, cy, Math.max(0, canvasWidth - cx - 18), col);
    centers.set(p.task.data.id, { x1: cx - 7, x2: cx + 7, y: cy, kind: "milestone" });
    return;
  }
  const x = sx(p.geom.x), w = Math.max(4, p.geom.width * scale);
  roundRect(g, x, y + (ROW_H - h) / 2, w, h, 4);
  g.fillStyle = withAlpha(color, 0.28); g.fill();
  if (input.showProgress) {
    const prog = taskProgress(p.task, input.context);
    if (prog > 0) { roundRect(g, x, y + (ROW_H - h) / 2, Math.max(4, w * prog), h, 4); g.fillStyle = color; g.fill(); }
  }
  g.strokeStyle = color; g.lineWidth = 1; roundRect(g, x, y + (ROW_H - h) / 2, w, h, 4); g.stroke();
  drawTaskLabelLine(g, p.task, input.context, input.viewType === "timeline" && options.showTaskLabels, x + 6, y + ROW_H / 2, Math.max(0, canvasWidth - x - 12), col);
  centers.set(p.task.data.id, { x1: x, x2: x + w, y: y + ROW_H / 2, kind: "bar" });
}

function drawDateMarker(g: CanvasRenderingContext2D, axis: TimeAxis, sx: (x: number) => number, date: string, height: number) {
  if (date < axis.startKey || date > axis.endKey) return;
  const x = sx(axis.xForKey(date) + axis.pxPerDay / 2);
  g.strokeStyle = "#FF02F0"; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(x, HEADER_H); g.lineTo(x, height); g.stroke();
  g.fillStyle = "#FF02F0";
  g.beginPath(); g.moveTo(x - 4, HEADER_H - 5); g.lineTo(x + 4, HEADER_H - 5); g.lineTo(x, HEADER_H); g.closePath(); g.fill();
}

function drawUnscheduled(
  g: CanvasRenderingContext2D, tray: UnscheduledOut, width: number, context: TimeViewContext,
  showTaskLabels: boolean, col: ReturnType<typeof themeColors>,
) {
  g.fillStyle = col.surface; g.fillRect(0, tray.top, width, tray.height);
  g.strokeStyle = col.border; g.lineWidth = 1;
  g.strokeRect(0.5, tray.top + 0.5, width - 1, tray.height - 1);
  g.fillStyle = col.muted; g.font = "600 12px sans-serif"; g.textBaseline = "middle";
  g.fillText(`Unscheduled · ${tray.tasks.length}`, 10, tray.top + 15);
  tray.tasks.forEach((t, i) => {
    const y = tray.top + 26 + i * ROW_H + ROW_H / 2;
    g.fillStyle = resolveBarColor(t, context);
    g.fillRect(10, y - 4, 8, 8);
    drawTaskLabelLine(g, t, context, showTaskLabels, 26, y, width - 38, col);
  });
}

function drawAxisHeader(g: CanvasRenderingContext2D, axis: TimeAxis, sx: (x: number) => number, scale: number, height: number, railW: number, col: ReturnType<typeof themeColors>) {
  const { top, bottom } = buildTicks(axis);
  const tierH = HEADER_H / 2;
  g.fillStyle = col.surface; g.fillRect(railW, 0, 100000, HEADER_H);
  g.strokeStyle = col.border; g.lineWidth = 1;
  g.beginPath();
  g.moveTo(railW, tierH); g.lineTo(100000, tierH);
  g.moveTo(0, HEADER_H); g.lineTo(100000, HEADER_H);
  g.stroke();

  const drawTier = (ticks: ReturnType<typeof buildTicks>["top"], y: number, font: string, color: string) => {
    for (const t of ticks) {
      const x = sx(t.x);
      const width = t.width * scale;
      g.strokeStyle = col.border; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + tierH); g.stroke();
      if (!t.label || width <= 2) continue;
      g.save();
      g.beginPath(); g.rect(x + 1, y + 1, Math.max(0, width - 2), tierH - 2); g.clip();
      g.fillStyle = color; g.font = font;
      g.fillText(t.label, x + 6, y + tierH / 2);
      g.restore();
    }
  };

  g.textBaseline = "middle";
  drawTier(top, 0, "600 11px sans-serif", col.text);
  drawTier(bottom, tierH, "11px sans-serif", col.muted);

  // Weekend shading mirrors the UI on the two zooms where individual days
  // remain wide enough to be useful.
  if (axis.zoom === "day" || axis.zoom === "week") {
    g.save();
    g.fillStyle = col.surface; g.globalAlpha = 0.55;
    for (let i = 0; i < axis.totalDays; i++) {
      const key = addDaysKey(axis.startKey, i);
      if (weekdayOfKey(key) < 5) continue;
      g.fillRect(sx(axis.xForKey(key)), HEADER_H, axis.pxPerDay * scale, height - HEADER_H);
    }
    g.restore();
  }

  // Gridlines below the header follow the same bottom-tier boundaries as the UI.
  for (const t of bottom) {
    const x = sx(t.x);
    g.strokeStyle = col.grid; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, HEADER_H); g.lineTo(x, height); g.stroke();
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function clip(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && g.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

// ---------- File output ----------

export async function exportTimeView(plugin: InventTasksPlugin, fmt: TimeExportFormat, input: TimeExportInput): Promise<boolean> {
  if (input.tasks.length === 0) { new Notice(tr("notice.timelineNothing")); return false; }
  const options = resolveOptions(input);
  if (options.dateFrom > options.dateTo) { new Notice(tr("notice.timelineDateRange")); return false; }
  let canvas: HTMLCanvasElement;
  try {
    canvas = renderToCanvas(input);
  } catch (err) {
    new Notice(tr("notice.timelineRenderFailed", { msg: (err as Error).message }));
    return false;
  }
  const stamp = new Date();
  const base = `${input.viewType}-${stamp.getFullYear()}${pad2(stamp.getMonth() + 1)}${pad2(stamp.getDate())}-${pad2(stamp.getHours())}${pad2(stamp.getMinutes())}`;
  const dir = "_exports";
  try { if (!(await plugin.app.vault.adapter.exists(dir))) await plugin.app.vault.adapter.mkdir(dir); } catch { /* best effort */ }

  if (fmt === "png") {
    const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
    if (!blob) { new Notice(tr("notice.timelinePngFailed")); return false; }
    const buf = await blob.arrayBuffer();
    const path = normalizePath(`${dir}/${base}.png`);
    await plugin.app.vault.adapter.writeBinary(path, buf);
    new Notice(tr("notice.timelineSaved", { path }));
    return true;
  }

  // PDF — embed the canvas JPEG.
  const jpegUrl = canvas.toDataURL("image/jpeg", 0.92);
  const jpeg = dataUrlToBytes(jpegUrl);
  const pdf = buildSingleImagePdf(jpeg, canvas.width, canvas.height);
  const path = normalizePath(`${dir}/${base}.pdf`);
  // `pdf` wraps a freshly allocated buffer of exactly its length → pass directly.
  await plugin.app.vault.adapter.writeBinary(path, pdf.buffer);
  new Notice(tr("notice.timelineSaved", { path }));
  return true;
}

function dataUrlToBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Minimal one-page PDF embedding a single JPEG (DCTDecode). Page is fit to a
// max width (in points) preserving aspect, so it prints sensibly.
function buildSingleImagePdf(jpeg: Uint8Array, imgW: number, imgH: number): Uint8Array<ArrayBuffer> {
  const maxPt = 1400;
  const pageW = Math.min(maxPt, imgW);
  const pageH = Math.round((imgH / imgW) * pageW);
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (data: Uint8Array | string) => {
    const b = typeof data === "string" ? enc.encode(data) : data;
    chunks.push(b); len += b.length;
  };
  const obj = (n: number, body: string) => { offsets[n] = len; push(`${n} 0 obj\n${body}\nendobj\n`); };

  push("%PDF-1.3\n");
  obj(1, "<</Type/Catalog/Pages 2 0 R>>");
  obj(2, "<</Type/Pages/Kids[3 0 R]/Count 1>>");
  obj(3, `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${pageW} ${pageH}]/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>`);
  // Image XObject (header + raw JPEG stream).
  offsets[4] = len;
  push(`4 0 obj\n<</Type/XObject/Subtype/Image/Width ${imgW}/Height ${imgH}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpeg.length}>>\nstream\n`);
  push(jpeg);
  push("\nendstream\nendobj\n");
  // Content stream draws the image scaled to the page.
  const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
  obj(5, `<</Length ${content.length}>>\nstream\n${content}\nendstream`);

  const xrefOff = len;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefOff}\n%%EOF`);

  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
