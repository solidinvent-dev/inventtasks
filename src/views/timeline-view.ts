import { setIcon, Notice } from "obsidian";
import type InventTasksPlugin from "../main";
import { fieldLabelFrom, t as tr } from "../i18n";
import { TaskData, TaskFile } from "../types";
import { ViewState } from "./main-view";
import { groupTasks, GroupBucket } from "../data/filters";
import { statusChip, priorityChip, tagChip, applyChipStyleByKind, chipKindForGroupBy, renderGroupHeaderChip, renderListReference } from "../ui/components";
import { formatDuration, isOverdue, todayKey } from "../utils/dates";
import { renderCustomFieldValue } from "../ui/cf-render";
import { renderIconish } from "../ui/icons";
import { isDateSourceWritable, mapDatePatch } from "../data/date-source";
import { DATE_SOURCE_DUE, DATE_SOURCE_START } from "../constants";
import {
  TimeViewContext, TimeScrollState, buildAxis, barGeom, BarGeom, resolveBarColor,
  renderTimeToolbar, renderTimeScaffold, scrollToKey, attachBarDrag, axisTitle,
  LANE_SUBROW_H, LANE_PAD, TIME_EDIT_ENABLED, TimeNavHandlers, ctxDateFields, DateFields,
} from "./time-grid";
import { fireAndForget } from "../utils/async";

const RENDER_CHUNK_LANES = 24;

interface TimelineRenderOpts {
  parent: HTMLElement;
  tasks: TaskFile[];
  state: ViewState;
  plugin: InventTasksPlugin;
  onTaskClick: (t: TaskFile) => void;
  context: TimeViewContext;
  nav: TimeNavHandlers;
  onRailWidthChange: (width: number) => void;
}

// A swimlane: the group bucket plus its laid-out (packed) bars and pixel band.
interface Lane {
  bucket: GroupBucket;
  placed: { task: TaskFile; geom: BarGeom; subRow: number }[];
  top: number;
  height: number;
  subRows: number;
}

export function renderTimelineView(opts: TimelineRenderOpts) {
  const { parent, tasks, state, context } = opts;
  parent.addClass("it-timeline-view");

  if (tasks.length === 0) {
    parent.createDiv({ cls: "it-empty-state-small", text: tr("list.noTasks") });
    return;
  }

  const anchor = state.timeRefDate;
  const dateFields = ctxDateFields(context);
  const axis = buildAxis(tasks, state.timelineZoom, anchor, dateFields);

  // Timeline always groups into lanes; fall back to status (like Board) when no
  // grouping is chosen, so there's never a single undifferentiated lane.
  const groupBy = state.groupBy || "status";
  const buckets = groupTasks(tasks, groupBy, {
    statuses: context.statuses,
    priorities: context.priorities,
    priorityLabels: context.priorityLabels,
    tagsOrder: context.tagsPalette.map((t) => t.name),
    contextOrder: context.contextLabels.map((c) => c.name),
    taskTypesOrder: context.taskTypesOrder,
    tagsPalette: context.tagsPalette,
    contextLabels: context.contextLabels,
    customFields: context.customFields,
    listMeta: context.listMeta,
    subtaskStats: context.subtaskStats,
    taskTitles: context.taskTitles,
    fieldLabels: context.fieldLabels,
    direction: state.groupDirection,
  });

  // Pack each lane and accumulate vertical offsets.
  const lanes: Lane[] = [];
  let top = 0;
  const unscheduled: TaskFile[] = [];
  const unscheduledSeen = new Set<string>();
  for (const bucket of buckets) {
    const placed = packLane(bucket.tasks, axis, dateFields);
    const scheduledIds = new Set(placed.map((p) => p.task.data.id));
    // A task can appear in several lanes (multi-value grouping); only list it
    // once in the unscheduled tray.
    for (const t of bucket.tasks) {
      if (!scheduledIds.has(t.data.id) && !unscheduledSeen.has(t.data.id)) {
        unscheduledSeen.add(t.data.id);
        unscheduled.push(t);
      }
    }
    const subRows = Math.max(1, placed.reduce((m, p) => Math.max(m, p.subRow + 1), 0));
    const height = subRows * LANE_SUBROW_H + LANE_PAD * 2;
    lanes.push({ bucket, placed, top, height, subRows });
    top += height;
  }
  const bodyHeight = Math.max(top, 120);

  renderTimeToolbar(parent, {
    zoom: state.timelineZoom,
    title: axisTitle(anchor),
    onZoom: opts.nav.onZoom,
    onShift: opts.nav.onShift,
    onToday: opts.nav.onToday,
  });

  const scaffold = renderTimeScaffold(parent, axis, {
    rail: true,
    bodyHeight,
    railHeadLabel: railLabel(groupBy, context.fieldLabels),
    railWidth: state.timelineRailWidth,
    onRailWidthChange: opts.onRailWidthChange,
  });
  const rail = scaffold.railBodyEl!;
  rail.addClass("is-lane-mode");

  // Lane bands (canvas) + gutter labels (rail), aligned by absolute top/height.
  const renderLane = (lane: Lane) => {
    const band = scaffold.canvasEl.createDiv({ cls: "it-tg-lane" });
    band.style.top = `${lane.top}px`;
    band.style.height = `${lane.height}px`;
    band.dataset.laneKey = lane.bucket.key;

    const gutter = rail.createDiv({ cls: "it-tg-lane-gutter" });
    gutter.style.top = `${lane.top}px`;
    gutter.style.height = `${lane.height}px`;
    const kind = chipKindForGroupBy(groupBy, (id) => context.customFields.find((f) => f.id === id)?.type);
    renderGroupHeaderChip(gutter, lane.bucket, kind, context.chipStyles);
    gutter.createSpan({ cls: "it-tg-rail-count", text: String(lane.bucket.tasks.length) });

    for (const p of lane.placed) {
      renderBar(scaffold.canvasEl, p.task, p.geom, lane.top + LANE_PAD + p.subRow * LANE_SUBROW_H, opts, axis, lanes, groupBy);
    }
  };
  let cursor = 0;
  const renderChunk = () => {
    if (!scaffold.root.isConnected) return;
    const end = Math.min(lanes.length, cursor + RENDER_CHUNK_LANES);
    for (; cursor < end; cursor++) renderLane(lanes[cursor]);
    if (cursor < lanes.length) window.requestAnimationFrame(renderChunk);
  };
  renderChunk();

  // Unscheduled tray below the timeline — chips for tasks without dates.
  // Toggleable (inherited view-default / saved view); capped to 1/3 + scroll.
  if (unscheduled.length && opts.context.showUnscheduled !== false) renderUnscheduledTray(parent, unscheduled, opts);

  // Preserve scroll across re-renders; horizontal re-centers only when nav
  // cleared the saved offset (prev/next/today/zoom); vertical always restored.
  // Horizontal scroll lives on scaffold.hScroll (mobile: the outer frame, so the
  // title rail scrolls with the canvas; desktop: same element as axisScroll).
  // Vertical scroll always lives on axisScroll.
  scaffold.hScroll.addEventListener("scroll", () => {
    (state as TimeScrollState).__tgScrollLeft = scaffold.hScroll.scrollLeft;
  });
  scaffold.axisScroll.addEventListener("scroll", () => {
    (state as TimeScrollState).__tgScrollTop = scaffold.axisScroll.scrollTop;
  });
  window.requestAnimationFrame(() => {
    const sl = (state as TimeScrollState).__tgScrollLeft, st = (state as TimeScrollState).__tgScrollTop;
    if (typeof sl === "number") scaffold.hScroll.scrollLeft = sl;
    else scrollToKey(scaffold, axis, anchor, "center");
    if (typeof st === "number") scaffold.axisScroll.scrollTop = st;
  });
}

// Greedy track packing: each task lands in the first sub-row whose last bar
// ends before this one starts (with a small gap), else a new sub-row.
function packLane(tasks: TaskFile[], axis: ReturnType<typeof buildAxis>, dateFields: DateFields): Lane["placed"] {
  const items = tasks
    .map((task) => ({ task, geom: barGeom(task, axis, dateFields) }))
    .filter((it) => it.geom.kind !== "none")
    .sort((a, b) => barLeft(a.geom) - barLeft(b.geom));
  const trackEnds: number[] = [];
  const GAP = 6;
  const out: Lane["placed"] = [];
  for (const it of items) {
    const left = barLeft(it.geom);
    const right = barRight(it.geom);
    let row = trackEnds.findIndex((end) => end <= left - GAP);
    if (row === -1) { row = trackEnds.length; trackEnds.push(right); }
    else trackEnds[row] = right;
    out.push({ task: it.task, geom: it.geom, subRow: row });
  }
  return out;
}

function barLeft(g: BarGeom): number { return g.kind === "milestone" ? g.cx - 10 : g.x; }
function barRight(g: BarGeom): number { return g.kind === "milestone" ? g.cx + 10 : g.x + g.width; }

function renderBar(
  canvas: HTMLElement,
  t: TaskFile,
  geom: BarGeom,
  y: number,
  opts: TimelineRenderOpts,
  axis: ReturnType<typeof buildAxis>,
  lanes: Lane[],
  groupBy: string,
) {
  const { context } = opts;
  const color = resolveBarColor(t, context);

  if (geom.kind === "milestone") {
    const dia = canvas.createDiv({ cls: "it-tg-milestone is-timeline", attr: { title: t.data.title || tr("gantt.milestone") } });
    dia.style.left = `${geom.cx}px`;
    dia.style.top = `${y + LANE_SUBROW_H / 2 - 2}px`;
    dia.style.setProperty("--bar-color", color);
    attachBar(dia, t, geom, opts, axis, lanes, groupBy);
    return;
  }

  const bar = canvas.createDiv({ cls: "it-tg-bar is-timeline" });
  bar.style.left = `${geom.x}px`;
  bar.style.top = `${y + 3}px`;
  bar.style.width = `${geom.width}px`;
  bar.style.setProperty("--bar-color", color);
  if (isOverdue(t.data.due_date, t.data.status_group)) bar.addClass("is-overdue");

  if (TIME_EDIT_ENABLED) {
    bar.createDiv({ cls: "it-tg-bar-handle is-start" });
    bar.createDiv({ cls: "it-tg-bar-handle is-end" });
  }
  const meta = bar.createSpan({ cls: "it-tg-bar-meta" });
  for (const field of context.visibleFields) renderTimelineMetaField(meta, field, t, opts);
  if (meta.childElementCount === 0) meta.remove();
  bar.createSpan({ cls: "it-tg-bar-label", text: t.data.title || tr("common.untitled") });

  attachBar(bar, t, geom, opts, axis, lanes, groupBy);
}

function renderTimelineMetaField(meta: HTMLElement, field: string, t: TaskFile, opts: TimelineRenderOpts) {
  const { context } = opts;
  if (field === "type_icon") {
    const type = context.taskTypesOrder.find((candidate) => candidate.id === t.data.type);
    if (type?.icon) renderIconish(meta, type.icon, { cls: "it-tg-bar-type-icon" });
    return;
  }
  if (field === "custom_id" || field === "id") {
    const value = field === "custom_id" ? t.data.custom_id : t.data.id;
    if (value) meta.createSpan({ cls: "it-chip it-chip-meta", text: value });
    return;
  }
  if (field === "status") {
    statusChip(meta, context.statuses.find((status) => status.id === t.data.status), undefined, context.chipStyles);
    return;
  }
  if (field === "priority") {
    priorityChip(meta, t.data.priority, context.priorities, undefined, context.chipStyles);
    return;
  }
  if (field === "tags") {
    const colors = new Map(context.tagsPalette.map((tag) => [tag.name, tag.color]));
    for (const tag of (t.data.tags || []).slice(0, 2)) tagChip(meta, tag, colors.get(tag), undefined, context.chipStyles);
    return;
  }
  if (field === "context") {
    const colors = new Map(context.contextLabels.map((label) => [label.name, label.color]));
    for (const label of (t.data.context || []).slice(0, 2)) {
      const chip = meta.createSpan({ cls: "it-chip it-chip-tag", text: label });
      const color = colors.get(label);
      if (color) chip.style.setProperty("--chip-color", color);
      applyChipStyleByKind(chip, "context", context.chipStyles);
    }
    return;
  }
  if (field === "subtask_count" || field === "relationship_count") {
    const count = field === "subtask_count"
      ? context.subtaskStats?.get(t.data.id)?.total ?? 0
      : context.relationshipCounts?.get(t.data.id) ?? 0;
    if (count) {
      const text = field === "subtask_count" ? `↳ ${count}` : tr("chip.linksCount", { count });
      meta.createSpan({ cls: "it-chip it-chip-meta", text });
    }
    return;
  }
  if (field === "time_estimate" || field === "time_tracked") {
    const minutes = field === "time_estimate" ? t.data.time_estimate : t.data.time_tracked;
    if (minutes) {
      const dur = formatDuration(minutes);
      const text = field === "time_estimate" ? tr("chip.timeEst", { duration: dur }) : tr("chip.timeTracked", { duration: dur });
      meta.createSpan({ cls: "it-chip it-chip-meta", text });
    }
    return;
  }
  if (field === "sprint_points") {
    if (t.data.sprint_points != null) meta.createSpan({ cls: "it-chip it-chip-meta", text: tr("chip.sprintPts", { count: t.data.sprint_points }) });
    return;
  }
  if (field === "list" || field === "folder" || field === "space") {
    renderListReference(meta, t, opts.plugin.index, field);
    return;
  }
  if (field.startsWith("custom_field:")) {
    const id = field.slice("custom_field:".length);
    const cf = context.customFields.find((candidate) => candidate.id === id);
    if (!cf) return;
    const wrap = meta.createSpan({ cls: "it-tg-bar-cf", attr: { title: cf.name } });
    renderCustomFieldValue(wrap, cf, t.data.custom_fields?.[id], {
      task: t,
      index: opts.plugin.index,
      mode: "board",
      chipStyles: context.chipStyles,
      subtaskStats: context.subtaskStats,
    });
    if (wrap.childElementCount === 0) wrap.remove();
  }
}

// Wires drag/resize (dates) + lane reassignment on drop. The pointer's final Y
// decides whether the task also moves to another swimlane (group value).
function attachBar(el: HTMLElement, t: TaskFile, geom: BarGeom, opts: TimelineRenderOpts, axis: ReturnType<typeof buildAxis>, lanes: Lane[], groupBy: string) {
  const fields = ctxDateFields(opts.context);
  // Read-only sources (created/updated stamps) → click-only bars.
  const writable = isDateSourceWritable(fields.start, DATE_SOURCE_START) && isDateSourceWritable(fields.due, DATE_SOURCE_DUE);
  attachBarDrag(el, {
    axis,
    geom,
    enabled: TIME_EDIT_ENABLED && writable,
    onClick: () => opts.onTaskClick(t),
    onCommit: fireAndForget(async (patch, ev) => {
      const canvas = el.closest<HTMLElement>(".it-tg-canvas");
      let lanePatch: Record<string, unknown> = {};
      // Lane reassignment is only safe for single-valued axes. Multi-valued
      // (tags/context/custom field) or structural ("list") grouping would
      // overwrite/relocate destructively, so dragging only reschedules there.
      const laneChangeable = groupBy === "status" || groupBy === "priority" || groupBy === "type";
      if (canvas && laneChangeable) {
        const rect = canvas.getBoundingClientRect();
        const yInCanvas = ev.clientY - rect.top;
        const lane = lanes.find((l) => yInCanvas >= l.top && yInCanvas < l.top + l.height);
        if (lane && lane.bucket.key !== currentLaneKey(t, groupBy)) {
          lanePatch = groupPatch(groupBy, lane.bucket.key);
        }
      }
      try {
        await opts.plugin.index.updateTask(t.data.id, (d: TaskData) => ({ data: { ...d, ...mapDatePatch(d, patch, fields.start, fields.due), ...lanePatch } }));
      } catch (err) { new Notice(tr("common.failed", { msg: (err as Error).message })); }
    }),
  });
}

function renderUnscheduledTray(parent: HTMLElement, tasks: TaskFile[], opts: TimelineRenderOpts) {
  const tray = parent.createDiv({ cls: "it-tg-unscheduled" });
  const head = tray.createDiv({ cls: "it-tg-unscheduled-head" });
  setIcon(head.createSpan({ cls: "it-btn-ic" }), "inbox");
  head.createSpan({ text: tr("timeline.unscheduled", { count: tasks.length }) });
  const list = tray.createDiv({ cls: "it-tg-unscheduled-list" });
  for (const t of tasks) {
    const chip = list.createDiv({ cls: "it-tg-unscheduled-chip" });
    chip.style.setProperty("--bar-color", resolveBarColor(t, opts.context));
    chip.createSpan({ cls: "it-tg-unscheduled-title", text: t.data.title || tr("common.untitled") });
    const fields = ctxDateFields(opts.context);
    if (TIME_EDIT_ENABLED && isDateSourceWritable(fields.due, DATE_SOURCE_DUE)) {
      const icon = chip.createSpan({ cls: "it-tg-schedule-icon", attr: { title: tr("gantt.setDueToday") } });
      setIcon(icon, "calendar-clock");
      icon.addEventListener("click", fireAndForget(async (e) => {
        e.stopPropagation();
        await opts.plugin.index.updateTask(t.data.id, (d: TaskData) => ({ data: { ...d, ...mapDatePatch(d, { due_date: todayKey() }, fields.start, fields.due) } }));
      }));
    }
    chip.addEventListener("click", () => opts.onTaskClick(t));
  }
}

// ---------- group helpers (mirror board-view's drop semantics) ----------

function currentLaneKey(t: TaskFile, groupBy: string): string {
  if (groupBy === "status") return t.data.status || "__no_status";
  if (groupBy === "priority") return t.data.priority ? String(t.data.priority) : "__no_priority";
  if (groupBy === "type") return t.data.type || "task";
  if (groupBy === "list") return t.data.list || "__no_list";
  // tags/context/custom_field are multi-valued — no single "current" lane; skip
  // reassignment for those (return a sentinel that never matches).
  return "__multi__";
}

function groupPatch(groupBy: string, bucketKey: string): Record<string, unknown> {
  if (groupBy === "status") return bucketKey === "__no_status" ? { status: null } : { status: bucketKey };
  if (groupBy === "priority") {
    if (bucketKey === "__no_priority") return { priority: null };
    const n = parseInt(bucketKey, 10);
    return { priority: isNaN(n) ? null : n };
  }
  if (groupBy === "type") return { type: bucketKey };
  if (groupBy === "tags") return bucketKey.startsWith("__") ? {} : { tags: [bucketKey] };
  if (groupBy === "context") return bucketKey.startsWith("__") ? {} : { context: [bucketKey] };
  return {};
}

function railLabel(groupBy: string, labels?: Record<string, string>): string {
  if (groupBy.startsWith("custom_field:")) return tr("field.field");
  const known = ["due_date", "list", "type", "tags", "context", "status", "priority"];
  if (known.includes(groupBy)) return fieldLabelFrom(labels, groupBy);
  return tr("timeline.lane");
}
