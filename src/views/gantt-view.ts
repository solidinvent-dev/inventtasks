import { setIcon, Notice } from "obsidian";
import type InventTasksPlugin from "../main";
import { t as tr } from "../i18n";
import { TaskFile } from "../types";
import { ViewState } from "./main-view";
import { groupTasks, GroupBucket } from "../data/filters";
import { buildSubtaskTree, flattenSubtaskRows, maxSubtaskDepth } from "../data/subtasks";
import { getBlocks } from "../data/relationships";
import { statusChip, priorityChip, tagChip, applyChipStyleByKind, chipKindForGroupBy, renderGroupHeaderChip, renderListReference } from "../ui/components";
import { renderCustomFieldValue } from "../ui/cf-render";
import { renderIconish } from "../ui/icons";
import { formatDuration, isOverdue, todayKey } from "../utils/dates";
import { taskDateValue, isDateSourceWritable, mapDatePatch } from "../data/date-source";
import { DATE_SOURCE_DUE, DATE_SOURCE_START } from "../constants";
import {
  TimeViewContext, buildAxis, barGeom, BarGeom, resolveBarColor, taskProgress,
  renderTimeToolbar, renderTimeScaffold, scrollToKey, attachBarDrag, axisTitle,
  ROW_H, TIME_EDIT_ENABLED, TimeNavHandlers, ctxDateFields,
} from "./time-grid";

const RENDER_CHUNK_ROWS = 80;

interface GanttRenderOpts {
  parent: HTMLElement;
  tasks: TaskFile[];
  state: ViewState;
  plugin: InventTasksPlugin;
  onTaskClick: (t: TaskFile) => void;
  context: TimeViewContext;
  nav: TimeNavHandlers;
  onToggleDeps: () => void;
  onToggleProgress: () => void;
  onRailWidthChange: (width: number) => void;
}

// One rendered row. Group rows have no task; task rows carry an outline depth.
type Row =
  | { kind: "group"; bucket: GroupBucket }
  | { kind: "task"; task: TaskFile; depth: number };

export function renderGanttView(opts: GanttRenderOpts) {
  const { parent, tasks, state, context } = opts;
  parent.addClass("it-gantt-view");

  if (tasks.length === 0) {
    parent.createDiv({ cls: "it-empty-state-small", text: tr("list.noTasks") });
    return;
  }

  const anchor = state.timeRefDate;
  const dateFields = ctxDateFields(context);
  const axis = buildAxis(tasks, state.ganttZoom, anchor, dateFields);
  const rows = buildRows(tasks, state, context, opts.plugin);
  const bodyHeight = Math.max(rows.length * ROW_H, 120);

  renderTimeToolbar(parent, {
    zoom: state.ganttZoom,
    title: axisTitle(anchor),
    onZoom: opts.nav.onZoom,
    onShift: opts.nav.onShift,
    onToday: opts.nav.onToday,
    extras: (host) => {
      const dep = host.createEl("button", {
        cls: "it-secondary-btn" + (state.ganttShowDependencies ? " is-active" : ""),
        attr: { type: "button", title: tr("gantt.toggleDeps") },
      });
      setIcon(dep.createSpan({ cls: "it-btn-ic" }), "git-merge");
      dep.createSpan({ text: tr("customize.dependencies") });
      dep.addEventListener("click", () => opts.onToggleDeps());

      const pr = host.createEl("button", {
        cls: "it-secondary-btn" + (state.ganttShowProgress ? " is-active" : ""),
        attr: { type: "button", title: tr("gantt.toggleProgress") },
      });
      setIcon(pr.createSpan({ cls: "it-btn-ic" }), "percent");
      pr.createSpan({ text: tr("customize.progress") });
      pr.addEventListener("click", () => opts.onToggleProgress());
    },
  });

  const scaffold = renderTimeScaffold(parent, axis, {
    rail: true,
    bodyHeight,
    railHeadLabel: tr("gantt.task"),
    railWidth: state.ganttRailWidth,
    onRailWidthChange: opts.onRailWidthChange,
  });

  // ----- Left rail rows + canvas bands (same order → aligned) -----
  const geomById = new Map<string, { geom: BarGeom; y: number }>();
  const renderRow = (row: Row, i: number) => {
    const y = i * ROW_H;
    if (row.kind === "group") {
      renderRailGroup(scaffold.railBodyEl!, row.bucket, opts);
      const band = scaffold.canvasEl.createDiv({ cls: "it-tg-band is-group" });
      band.style.top = `${y}px`;
      band.style.height = `${ROW_H}px`;
      return;
    }
    const t = row.task;
    renderRailTask(scaffold.railBodyEl!, t, row.depth, opts);
    const band = scaffold.canvasEl.createDiv({ cls: "it-tg-band" });
    band.style.top = `${y}px`;
    band.style.height = `${ROW_H}px`;
    band.addEventListener("click", () => opts.onTaskClick(t));

    const geom = barGeom(t, axis, dateFields);
    geomById.set(t.data.id, { geom, y });
    if (geom.kind === "none") return;
    renderBar(scaffold.canvasEl, t, geom, y, opts, axis);
  };

  const renderDependenciesAfterRows = () => {
    if (!scaffold.root.isConnected) return;
    // ----- Dependency arrows (blocks → blocked) overlaid on the canvas -----
    if (state.ganttShowDependencies) {
      renderDependencies(scaffold.canvasEl, geomById, axis, bodyHeight, opts);
    }
  };
  let cursor = 0;
  const renderChunk = () => {
    if (!scaffold.root.isConnected) return;
    const end = Math.min(rows.length, cursor + RENDER_CHUNK_ROWS);
    for (; cursor < end; cursor++) renderRow(rows[cursor], cursor);
    if (cursor < rows.length) window.requestAnimationFrame(renderChunk);
    else renderDependenciesAfterRows();
  };
  renderChunk();

  // Preserve scroll across data-driven re-renders (a bar edit re-renders the
  // whole view). Horizontal re-centers on the anchor only when nav cleared the
  // saved offset (prev/next/today/zoom); vertical is always restored.
  // Horizontal scroll lives on scaffold.hScroll (mobile: the outer frame, so the
  // title rail scrolls with the canvas; desktop: same element as axisScroll).
  // Vertical scroll always lives on axisScroll.
  scaffold.hScroll.addEventListener("scroll", () => {
    (state as any).__tgScrollLeft = scaffold.hScroll.scrollLeft;
  });
  scaffold.axisScroll.addEventListener("scroll", () => {
    (state as any).__tgScrollTop = scaffold.axisScroll.scrollTop;
  });
  window.requestAnimationFrame(() => {
    const sl = (state as any).__tgScrollLeft, st = (state as any).__tgScrollTop;
    if (typeof sl === "number") scaffold.hScroll.scrollLeft = sl;
    else scrollToKey(scaffold, axis, anchor, "center");
    if (typeof st === "number") scaffold.axisScroll.scrollTop = st;
  });
}

// ---------- Row model ----------

// When grouped, render group bands with flat task rows. When ungrouped and
// subtasks are expanded, render a nested outline (parent → children). Otherwise
// a flat list (collapse mode already dropped nested subtasks upstream).
function buildRows(tasks: TaskFile[], state: ViewState, context: TimeViewContext, plugin: InventTasksPlugin): Row[] {
  if (state.groupBy) {
    const buckets = groupTasks(tasks, state.groupBy, {
      statuses: context.statuses,
      priorities: context.priorities,
      priorityLabels: context.priorityLabels,
      tagsOrder: context.tagsPalette.map((t) => t.name),
      contextOrder: context.contextLabels.map((c) => c.name),
      taskTypesOrder: context.taskTypesOrder,
      tagsPalette: context.tagsPalette,
      contextLabels: context.contextLabels,
      customFields: context.customFields,
      listMeta: (context as any).listMeta,
      subtaskStats: context.subtaskStats,
      taskTitles: context.taskTitles,
      fieldLabels: (context as any).fieldLabels,
      direction: state.groupDirection,
    });
    const rows: Row[] = [];
    for (const b of buckets) {
      rows.push({ kind: "group", bucket: b });
      for (const t of b.tasks) rows.push({ kind: "task", task: t, depth: 0 });
    }
    return rows;
  }

  if (state.subtaskMode === "nested") {
    // Indent subtasks under their visible parent. (In "parents" mode subtasks
    // were already filtered out upstream; "flat" falls through to flat rows.)
    const subDepth = maxSubtaskDepth(plugin.index.resolveFeaturesForLocation(state.location));
    const tree = buildSubtaskTree(tasks);
    return flattenSubtaskRows(tree.roots, tree, undefined, subDepth).map((r) => ({ kind: "task", task: r.task, depth: r.depth }));
  }

  return tasks.map((t) => ({ kind: "task", task: t, depth: 0 }));
}

// ---------- Rail ----------

function renderRailGroup(rail: HTMLElement, bucket: GroupBucket, opts: GanttRenderOpts) {
  const row = rail.createDiv({ cls: "it-tg-rail-row is-group" });
  const kind = chipKindForGroupBy(opts.state.groupBy, (id) => opts.context.customFields.find((f) => f.id === id)?.type);
  renderGroupHeaderChip(row, bucket, kind, opts.context.chipStyles);
  row.createSpan({ cls: "it-tg-rail-count", text: String(bucket.tasks.length) });
}

function renderRailTask(rail: HTMLElement, t: TaskFile, depth: number, opts: GanttRenderOpts) {
  const { context } = opts;
  const row = rail.createDiv({ cls: "it-tg-rail-row" });
  row.style.paddingLeft = `${10 + depth * 16}px`;
  if (depth > 0) row.createSpan({ cls: "it-tg-rail-twig", text: "↳" });

  if (context.visibleFields.includes("type_icon")) {
    const ttype = context.taskTypesOrder.find((x) => x.id === t.data.type);
    const wrap = row.createSpan({ cls: "it-tg-rail-type" });
    const ic = renderIconish(wrap, (ttype as any)?.icon || typeEmoji(t.data.type), { cls: "it-tg-rail-type-icon" });
    if (ic && ttype?.color) ic.style.color = ttype.color;
  }
  if (context.visibleFields.includes("custom_id") && t.data.custom_id) row.createSpan({ cls: "it-tg-rail-id", text: t.data.custom_id });
  else if (context.visibleFields.includes("id")) row.createSpan({ cls: "it-tg-rail-id", text: t.data.id });

  const titleSpan = row.createSpan({ cls: "it-tg-rail-title", text: t.data.title || tr("common.untitled") });
  if (t.data.status_group === "done" || t.data.status_group === "closed") titleSpan.addClass("is-done");

  // Non-CF meta fields (status, priority, tags, counts) bundled in one span.
  const meta = row.createSpan({ cls: "it-tg-rail-meta" });
  for (const field of context.visibleFields) renderRailMetaField(meta, field, t, opts);
  if (meta.childElementCount === 0) meta.remove();

  // Custom fields each get their own direct flex column so they sit to the
  // right of the title (which shrinks) without competing with each other.
  // The title column expands when the rail is wide; narrowing just clips text.
  for (const field of context.visibleFields) {
    if (!field.startsWith("custom_field:")) continue;
    const id = field.slice("custom_field:".length);
    const cf = context.customFields.find((candidate) => candidate.id === id);
    if (!cf) continue;
    const raw = t.data.custom_fields?.[id];
    const col = row.createSpan({ cls: "it-tg-rail-cf-col", attr: { title: cf.name } });
    renderCustomFieldValue(col, cf, raw, {
      task: t,
      index: opts.plugin.index,
      mode: "board",
      chipStyles: context.chipStyles,
      subtaskStats: context.subtaskStats,
    });
    if (col.childElementCount === 0 && !col.textContent) col.remove();
  }

  // Unscheduled affordance — clickable due-date icon (desktop). Mobile stays read-only.
  const fields = ctxDateFields(context);
  const noDates = !taskDateValue(t, fields.start, DATE_SOURCE_START) && !taskDateValue(t, fields.due, DATE_SOURCE_DUE);
  if (noDates && t.data.type !== "milestone") {
    if (TIME_EDIT_ENABLED && isDateSourceWritable(fields.due, DATE_SOURCE_DUE)) {
      const icon = row.createSpan({ cls: "it-tg-schedule-icon", attr: { title: tr("gantt.setDueToday") } });
      setIcon(icon, "calendar-clock");
      icon.addEventListener("click", async (e) => {
        e.stopPropagation();
        await opts.plugin.index.updateTask(t.data.id, (d) => ({ data: { ...d, ...mapDatePatch(d, { due_date: todayKey() }, fields.start, fields.due) } }));
      });
    } else {
      row.createSpan({ cls: "it-tg-rail-unscheduled", text: "—" });
    }
  }

  row.addEventListener("click", () => opts.onTaskClick(t));
}

function renderRailMetaField(meta: HTMLElement, field: string, t: TaskFile, opts: GanttRenderOpts) {
  const { context } = opts;
  if (field === "type_icon" || field === "custom_id" || field === "id") return;
  if (field === "status") {
    statusChip(meta, context.statuses.find((s) => s.id === t.data.status), undefined, context.chipStyles);
    return;
  }
  if (field === "priority") {
    priorityChip(meta, t.data.priority, context.priorities, undefined, context.chipStyles);
    return;
  }
  if (field === "tags") {
    const colorByName = new Map(context.tagsPalette.map((td) => [td.name, td.color]));
    for (const tg of (t.data.tags || []).slice(0, 2)) tagChip(meta, tg, colorByName.get(tg), undefined, context.chipStyles);
    return;
  }
  if (field === "context") {
    const colorByName = new Map(context.contextLabels.map((cl) => [cl.name, cl.color]));
    for (const cl of (t.data.context || []).slice(0, 2)) {
      const chip = meta.createSpan({ cls: "it-chip it-chip-tag", text: cl });
      const color = colorByName.get(cl);
      if (color) chip.style.setProperty("--chip-color", color);
      applyChipStyleByKind(chip, "context", context.chipStyles);
    }
    return;
  }
  if (field === "subtask_count") {
    const count = context.subtaskStats?.get(t.data.id)?.total ?? 0;
    if (count > 0) meta.createSpan({ cls: "it-chip it-chip-meta", text: `↳ ${count}` });
    return;
  }
  if (field === "relationship_count") {
    const count = context.relationshipCounts?.get(t.data.id) ?? 0;
    if (count > 0) meta.createSpan({ cls: "it-chip it-chip-meta", text: `🔗 ${count}` });
    return;
  }
  if (field === "time_estimate" || field === "time_tracked") {
    const minutes = field === "time_estimate" ? t.data.time_estimate : t.data.time_tracked;
    if (minutes) meta.createSpan({ cls: "it-chip it-chip-meta", text: `${field === "time_estimate" ? "⏱" : "⏲"} ${formatDuration(minutes)}` });
    return;
  }
  if (field === "sprint_points") {
    if (t.data.sprint_points != null) meta.createSpan({ cls: "it-chip it-chip-meta", text: `${t.data.sprint_points} pts` });
    return;
  }
  if (field === "list" || field === "folder" || field === "space") {
    renderListReference(meta, t, opts.plugin.index, field);
    return;
  }
  // custom_field:* is rendered as a dedicated flex column in renderRailTask, not here.
}

// ---------- Bars ----------

function renderBar(canvas: HTMLElement, t: TaskFile, geom: BarGeom, y: number, opts: GanttRenderOpts, axis: ReturnType<typeof buildAxis>) {
  const { context } = opts;
  const color = resolveBarColor(t, context);
  const midTop = y + (ROW_H - 22) / 2;

  if (geom.kind === "milestone") {
    const dia = canvas.createDiv({ cls: "it-tg-milestone", attr: { title: t.data.title || tr("gantt.milestone") } });
    dia.dataset.taskId = t.data.id;
    dia.style.left = `${geom.cx}px`;
    dia.style.top = `${y + ROW_H / 2}px`;
    dia.style.setProperty("--bar-color", color);
    const label = canvas.createSpan({ cls: "it-tg-milestone-label", text: t.data.title || "" });
    label.style.left = `${geom.cx + 12}px`;
    label.style.top = `${y + (ROW_H - 16) / 2}px`;
    commitDrag(dia, t, geom, axis, opts);
    return;
  }

  // Bars and milestones name their Item, the way Board cards do — a chart
  // element is otherwise identifiable only by its label text.
  const bar = canvas.createDiv({ cls: "it-tg-bar" });
  bar.dataset.taskId = t.data.id;
  bar.style.left = `${geom.x}px`;
  bar.style.top = `${midTop}px`;
  bar.style.width = `${geom.width}px`;
  bar.style.setProperty("--bar-color", color);
  if (isOverdue(t.data.due_date, t.data.status_group)) bar.addClass("is-overdue");

  if (opts.state.ganttShowProgress) {
    const p = taskProgress(t, context);
    if (p > 0) {
      const fill = bar.createDiv({ cls: "it-tg-bar-progress" });
      fill.style.width = `${Math.round(p * 100)}%`;
    }
  }
  // Resize handles (visual; the whole bar listens via pointer zones).
  if (TIME_EDIT_ENABLED) {
    bar.createDiv({ cls: "it-tg-bar-handle is-start" });
    bar.createDiv({ cls: "it-tg-bar-handle is-end" });
  }
  bar.createSpan({ cls: "it-tg-bar-label", text: t.data.title || tr("common.untitled") });

  commitDrag(bar, t, geom, axis, opts);
}

function commitDrag(el: HTMLElement, t: TaskFile, geom: BarGeom, axis: ReturnType<typeof buildAxis>, opts: GanttRenderOpts) {
  const fields = ctxDateFields(opts.context);
  // Read-only sources (created/updated stamps) → click-only bars.
  const writable = isDateSourceWritable(fields.start, DATE_SOURCE_START) && isDateSourceWritable(fields.due, DATE_SOURCE_DUE);
  attachBarDrag(el, {
    axis, geom, enabled: TIME_EDIT_ENABLED && writable,
    onClick: () => opts.onTaskClick(t),
    onCommit: async (patch) => {
      try {
        await opts.plugin.index.updateTask(t.data.id, (d) => ({ data: { ...d, ...mapDatePatch(d, patch, fields.start, fields.due) } }));
      } catch (err: any) { new Notice(tr("gantt.rescheduleFailed", { msg: err.message })); }
    },
  });
}

// ---------- Dependency arrows ----------

function renderDependencies(
  canvas: HTMLElement,
  geomById: Map<string, { geom: BarGeom; y: number }>,
  axis: ReturnType<typeof buildAxis>,
  bodyHeight: number,
  opts: GanttRenderOpts,
) {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.classList.add("it-tg-deps");
  svg.setAttribute("width", String(axis.width));
  svg.setAttribute("height", String(bodyHeight));

  let drew = false;
  for (const t of opts.tasks) {
    const from = geomById.get(t.data.id);
    if (!from || from.geom.kind === "none") continue;
    const blocks = getBlocks(t); // t blocks these → arrow t → blocked
    for (const targetId of blocks) {
      const to = geomById.get(targetId);
      if (!to || to.geom.kind === "none") continue;
      const target = opts.plugin.index.tasksById.get(targetId);
      const fromRight = from.geom.kind === "milestone" ? from.geom.cx : from.geom.x + from.geom.width;
      const fromY = from.y + ROW_H / 2;
      const toLeft = to.geom.kind === "milestone" ? to.geom.cx : to.geom.x;
      const toY = to.y + ROW_H / 2;
      // Violated when the dependent starts before the blocker is due, or the
      // dependent is already overdue while still open.
      const violated = (target && isOverdue(target.data.due_date, target.data.status_group)) ||
        (to.geom.startKey && from.geom.endKey && to.geom.startKey < from.geom.endKey);
      drawArrow(svg, svgNS, fromRight, fromY, toLeft, toY, !!violated);
      drew = true;
    }
  }
  if (drew) canvas.appendChild(svg); // only attach when there's something to show
}

function drawArrow(svg: SVGElement, ns: string, x1: number, y1: number, x2: number, y2: number, violated: boolean) {
  const elbow = Math.max(x1 + 12, x2 - 12);
  const d = `M ${x1} ${y1} H ${elbow} V ${y2} H ${x2}`;
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("class", "it-tg-dep-path" + (violated ? " is-violated" : ""));
  svg.appendChild(path);
  // Arrowhead at the target.
  const head = document.createElementNS(ns, "path");
  head.setAttribute("d", `M ${x2 - 6} ${y2 - 4} L ${x2} ${y2} L ${x2 - 6} ${y2 + 4}`);
  head.setAttribute("class", "it-tg-dep-head" + (violated ? " is-violated" : ""));
  svg.appendChild(head);
}

function typeEmoji(type?: string): string {
  switch (type) {
    case "bug": return "🐛";
    case "story": return "📖";
    case "epic": return "🎯";
    case "feature": return "✨";
    case "meeting": return "📅";
    case "milestone": return "💎";
    default: return "✓";
  }
}
