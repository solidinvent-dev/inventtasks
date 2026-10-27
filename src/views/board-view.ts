import { Notice, Platform } from "obsidian";
import type InventTasksPlugin from "../main";
import { TaskData, TaskFile, StatusDef, PriorityDef, CustomFieldDef, ResolvedChipStyles } from "../types";
import { renderCustomFieldValue } from "../ui/cf-render";
import { ViewState } from "./main-view";
import { groupTasks, GroupBucket, GroupContext } from "../data/filters";
import { statusChip, priorityChip, tagChip, applyChipStyleByKind, chipKindForGroupBy, renderGroupHeaderChip, renderListReference } from "../ui/components";
import { isOverdue, formatDate } from "../utils/dates";
import { renderIconish, renderCfTypeIcon } from "../ui/icons";
import { QuickTaskModal, type QuickTaskOptions } from "../modals/create-modals";
import { t as tr } from "../i18n";
import { applyCoverBackground } from "../data/attachments";
import { descriptionPreview } from "../data/description-preview";
import { effectiveCustomFieldValue, isEmptyCustomFieldValue } from "../data/custom-fields";
import { fireAndForget } from "../utils/async";

// The render context main-view's tasksContext() hands every view; the board
// reads only these members (the optional ones may be absent).
interface BoardContext extends GroupContext {
  statuses: StatusDef[];
  priorities: PriorityDef[];
  priorityLabels: Record<number, string>;
  visibleFields: string[];
  chipStyles?: ResolvedChipStyles;
  relationshipCounts?: Map<string, number>;
  cfShowName?: boolean;
  cfShowWhenEmpty?: boolean;
  showFieldIcons?: boolean;
}

interface RenderOpts {
  parent: HTMLElement;
  tasks: TaskFile[];
  state: ViewState;
  plugin: InventTasksPlugin;
  onTaskClick: (t: TaskFile) => void;
  context: BoardContext;
}

// Per-column "show more" counts stashed on the transient view state.
interface BoardViewState {
  __boardVisibleByColumn?: Record<string, number>;
}

/** A partial task-data patch derived from a board bucket (status, priority, tags, custom_fields, ...). */
export type GroupPatch = { [key: string]: unknown; custom_fields?: Record<string, unknown> };

function vis(opts: RenderOpts, f: string): boolean { return opts.context.visibleFields.includes(f); }
const BOARD_INITIAL_CARDS = 80;
const BOARD_LOAD_MORE_CARDS = 80;

// Optional secondary (swimlane) axis a column belongs to. When set, drops and
// "+ Add" in that column also apply the swimlane's value.
type Swim = { field: string; key: string } | null;

export function renderBoardView(opts: RenderOpts) {
  const { parent, tasks, state, context } = opts;
  parent.addClass("it-board-view");

  // For board, default groupBy=status; but allow priority/tags/…
  const groupBy = state.groupBy && state.groupBy !== "" ? state.groupBy : "status";
  const groupCtx = {
    statuses: context.statuses,
    priorities: context.priorities,
    priorityLabels: context.priorityLabels,
    tagsOrder: context.tagsOrder,
    contextOrder: context.contextOrder,
    taskTypesOrder: context.taskTypesOrder,
    tagsPalette: context.tagsPalette,
    contextLabels: context.contextLabels,
    customFields: context.customFields,
    listMeta: context.listMeta,
    subtaskStats: context.subtaskStats,
    taskTitles: context.taskTitles,
    emptyPositions: context.emptyPositions,
        fieldLabels: context.fieldLabels,
    direction: state.groupDirection,
  };

  // Canonical column set (over all tasks) so every swimlane shows the same
  // columns in the same order, even when a lane has none in a given column.
  const primaryBuckets = groupTasks(tasks, groupBy, groupCtx);

  // Sub-group (swimlanes) — second axis. Ignored if unset or same as primary.
  const subField = state.subGroupBy && state.subGroupBy !== "" && state.subGroupBy !== groupBy
    ? state.subGroupBy : "";

  if (!subField) {
    const board = parent.createDiv({ cls: "it-board" });
    for (const bucket of primaryBuckets) renderColumn(board, bucket, bucket.tasks, opts, groupBy, null);
    return;
  }

  const swimBuckets = groupTasks(tasks, subField, groupCtx);
  const lanes = parent.createDiv({ cls: "it-board-swimlanes" });
  for (const swim of swimBuckets) {
    const lane = lanes.createDiv({ cls: "it-board-swimlane" });
    renderSwimlaneHeader(lane.createDiv({ cls: "it-board-swimlane-header" }), swim, subField, context);
    const cols = lane.createDiv({ cls: "it-board-lane-cols" });
    // Group this lane's tasks by the primary axis, indexed by bucket key so we
    // can lay out the canonical columns in order (empty where the lane has none).
    const byKey = new Map(groupTasks(swim.tasks, groupBy, groupCtx).map((b) => [b.key, b.tasks]));
    for (const col of primaryBuckets) {
      renderColumn(cols, col, byKey.get(col.key) || [], opts, groupBy, { field: subField, key: swim.key });
    }
  }
}

// Header for a swimlane row — styled chip (or dot + label) + count, pinned left.
function renderSwimlaneHeader(head: HTMLElement, swim: GroupBucket, subField: string, context: BoardContext) {
  const kind = chipKindForGroupBy(subField, (id) => context.customFields?.find((f) => f.id === id)?.type);
  if (kind) {
    renderGroupHeaderChip(head, swim, kind, context.chipStyles);
  } else {
    // Non-chip axis (e.g. List): show the group icon when present, else a dot.
    if (swim.icon) {
      const ic = renderIconish(head, swim.icon, { cls: "it-group-chip-icon" });
      if (ic && swim.color) ic.style.color = swim.color;
    } else if (swim.color) {
      const dot = head.createSpan({ cls: "it-group-dot" });
      dot.style.background = swim.color;
    }
    head.createSpan({ cls: "it-board-swimlane-name", text: swim.label });
  }
  head.createSpan({ cls: "it-board-col-count", text: String(swim.tasks.length) });
}

// Renders one board column with the given cards. `swim` (when in a swimlane)
// is folded into drops / "+ Add" so the card also lands in that lane's value.
function renderColumn(container: HTMLElement, bucket: GroupBucket, cards: TaskFile[], opts: RenderOpts, groupBy: string, swim: Swim) {
  const { plugin, state, context } = opts;
  const col = container.createDiv({ cls: "it-board-col" });
  col.dataset.bucketKey = bucket.key;
  col.dataset.bucketField = groupBy;

  const header = col.createDiv({ cls: "it-board-col-header" });
  const kind = chipKindForGroupBy(groupBy, (id) =>
    context.customFields?.find((f) => f.id === id)?.type,
  );
  if (kind) {
    renderGroupHeaderChip(header, bucket, kind, context.chipStyles);
  } else {
    // Non-chip axis (e.g. List): show the group icon when present, else a dot.
    if (bucket.icon) {
      const ic = renderIconish(header, bucket.icon, { cls: "it-group-chip-icon" });
      if (ic && bucket.color) ic.style.color = bucket.color;
    } else if (bucket.color) {
      const dot = header.createSpan({ cls: "it-group-dot" });
      dot.style.background = bucket.color;
    }
    header.createSpan({ cls: "it-board-col-name", text: bucket.label });
  }
  header.createSpan({ cls: "it-board-col-count", text: String(cards.length) });

  const list = col.createDiv({ cls: "it-board-col-body" });

  // Drop/Add value = primary axis ⊕ swimlane axis.
  const customFields = context.customFields;
  const cellPatch = (): GroupPatch => mergeGroupPatches(
    computeGroupSet(groupBy, bucket.key, customFields),
    swim ? computeGroupSet(swim.field, swim.key, customFields) : {},
  );

  col.addEventListener("dragover", (e) => { e.preventDefault(); list.addClass("is-drop-target"); });
  col.addEventListener("dragleave", () => list.removeClass("is-drop-target"));
  col.addEventListener("drop", fireAndForget(async (e) => {
    e.preventDefault();
    list.removeClass("is-drop-target");
    const taskId = e.dataTransfer?.getData("text/plain");
    if (!taskId) return;
    const patch = cellPatch();
    if (Object.keys(patch).length === 0) return;
    try {
      await plugin.index.updateTask(taskId, (d: TaskData) => ({ data: applyGroupPatch(d, patch) }));
    } catch (err) {
      new Notice(tr("board.dropFailed", { msg: (err as Error).message }));
    }
  }));

  const visibleKey = `${swim ? `${swim.field}:${swim.key}|` : ""}${groupBy}:${bucket.key}`;
  const visibleByColumn = ((state as BoardViewState).__boardVisibleByColumn ||= {});
  const visibleCount = Math.min(cards.length, visibleByColumn[visibleKey] || BOARD_INITIAL_CARDS);
  for (const t of cards.slice(0, visibleCount)) renderCard(list, t, opts);
  if (visibleCount < cards.length) {
    const moreBtn = list.createEl("button", {
      cls: "it-board-load-more",
      text: tr("board.showMore", { count: cards.length - visibleCount }),
      // The visible text says how many, not which column — fine on screen where
      // position carries that, useless to a screen reader reading the button
      // out of context (and to anything else addressing one column).
      attr: { type: "button", "aria-label": tr("board.showMoreIn", { count: cards.length - visibleCount, column: bucket.label }) },
    });
    moreBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      visibleByColumn[visibleKey] = Math.min(cards.length, visibleCount + BOARD_LOAD_MORE_CARDS);
      opts.plugin.getMainView()?.fullRender();
    });
  }

  const addBtn = col.createEl("button", {
    cls: "it-board-add",
    text: tr("board.addTask"),
    attr: { type: "button", "aria-label": tr("board.addTaskTo", { column: bucket.label }) },
  });
  addBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const modalOpts: QuickTaskOptions = { preset: cellPatch() };
    const loc = state.location;
    if (loc.kind === "list") modalOpts.listPath = loc.path;
    else if (loc.kind === "folder") modalOpts.scopeFolderPath = loc.path;
    else if (loc.kind === "space") modalOpts.scopeSpacePath = loc.path;
    new QuickTaskModal(plugin.app, plugin, modalOpts).open();
  });
}

function renderCard(parent: HTMLElement, t: TaskFile, opts: RenderOpts) {
  // HTML5 drag-and-drop doesn't work on touch, so on mobile cards aren't
  // draggable; status/group is changed by tapping the card to open the task
  // modal instead (product decision).
  const mobile = Platform.isMobile;
  const card = parent.createDiv({ cls: "it-card", attr: { draggable: mobile ? "false" : "true" } });
  card.dataset.taskId = t.data.id;
  if (t.data.color) card.style.setProperty("--card-accent", t.data.color);

  if (!mobile) {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", t.data.id);
      card.addClass("is-dragging");
    });
    card.addEventListener("dragend", () => card.removeClass("is-dragging"));
  }
  card.addEventListener("click", () => opts.onTaskClick(t));

  // Cover image
  if (vis(opts, "cover") && t.data.cover_image) {
    const cover = card.createDiv({ cls: "it-card-cover" });
    applyCoverBackground(cover, opts.plugin.index, t.data.cover_image);
  }

  // Header row (type icon + id/custom_id). Title always shown right after.
  const hasTopContent = vis(opts, "type_icon") || vis(opts, "id") || vis(opts, "custom_id");
  if (hasTopContent) {
    const top = card.createDiv({ cls: "it-card-top" });
    if (vis(opts, "type_icon")) {
      const types = opts.plugin.index.resolveTaskTypes({ listPath: t.listPath });
      const ttype = types.find((x) => x.id === t.data.type);
      const wrap = top.createSpan({ cls: "it-card-type" });
      const typeIconEl = renderIconish(wrap, ttype?.icon || typeEmojiSmall(t.data.type), { cls: "it-card-type-icon" });
      if (ttype?.color && typeIconEl) typeIconEl.style.color = ttype.color;
    }
    if (vis(opts, "custom_id") && t.data.custom_id) top.createSpan({ cls: "it-card-id", text: t.data.custom_id });
    else if (vis(opts, "id")) top.createSpan({ cls: "it-card-id", text: t.data.id });
  }

  const title = card.createDiv({ cls: "it-card-title", text: t.data.title || tr("common.untitled") });
  if (t.data.status_group === "done" || t.data.status_group === "closed") title.addClass("is-done");

  // Multiple Lists: small "linked from home list" marker when this card is
  // shown in a list that isn't the task's home.
  {
    const loc = opts.state.location;
    if (loc.kind === "list" && t.listPath && t.listPath !== loc.path) {
      const home = opts.plugin.index.findList(t.listPath)?.config.name || tr("board.anotherList");
      const b = card.createDiv({ cls: "it-card-linked", text: `↪ ${home}` });
      b.title = tr("board.linkedFromHome", { home });
    }
  }

  // Single flex-wrap field area. Order follows `visibleFields`, so user-defined
  // ordering in View defaults is honored. Each field uses the SAME chip helpers
  // as List view → identical colors, icons, sizing.
  const fields = card.createDiv({ cls: "it-card-fields" });
  const customFields = opts.context.customFields;

  // Skip these fields here — they've already been rendered above (or below).
  const renderedAlready = new Set(["cover", "type_icon", "id", "custom_id", "checkbox", "description_preview"]);

  for (const field of opts.context.visibleFields) {
    if (renderedAlready.has(field)) continue;
    renderField(fields, field, t, opts, customFields);
  }
  if (fields.children.length === 0) fields.remove();

  // Description preview (separate, last) — full-width text, not a chip.
  if (vis(opts, "description_preview")) {
    const preview = descriptionPreview(t.body, t.data.title);
    if (preview) card.createDiv({ cls: "it-card-desc-preview", text: preview });
  }
}

// Renders a single field as a chip into the card's `fields` area. Uses the
// same chip helpers as List view so visuals stay consistent.
function renderField(
  parent: HTMLElement,
  field: string,
  t: TaskFile,
  opts: RenderOpts,
  customFields?: Array<{ id: string; name: string }>
) {
  const chipStyles = opts.context.chipStyles;
  if (field === "status") {
    const so = opts.context.statuses.find((s) => s.id === t.data.status);
    statusChip(parent, so, undefined, chipStyles);
    return;
  }
  if (field === "priority") {
    priorityChip(parent, t.data.priority, opts.context.priorities, undefined, chipStyles);
    return;
  }
  if (field === "due_date") {
    if (t.data.due_date) {
      const overdue = isOverdue(t.data.due_date, t.data.status_group);
      const chip = parent.createSpan({ cls: "it-chip it-chip-date" + (overdue ? " it-chip-overdue" : "") });
      chip.setText("📅 " + formatDate(t.data.due_date));
    }
    return;
  }
  if (field === "start_date") {
    if (t.data.start_date) {
      const chip = parent.createSpan({ cls: "it-chip it-chip-date" });
      chip.setText("▶ " + formatDate(t.data.start_date));
    }
    return;
  }
  if (field === "tags") {
    const tagsPalette = opts.plugin.index.resolveTagsPalette({ listPath: t.listPath });
    const tagColorMap = new Map(tagsPalette.map((td) => [td.name, td.color]));
    for (const tg of t.data.tags || []) tagChip(parent, tg, tagColorMap.get(tg), undefined, chipStyles);
    return;
  }
  if (field === "context") {
    const labels = opts.plugin.index.resolveContextLabels({ listPath: t.listPath });
    const colorByName: Record<string, string> = {};
    for (const cl of labels) colorByName[cl.name] = cl.color;
    for (const cl of (t.data.context || [])) {
      const chip = parent.createSpan({ cls: "it-chip it-chip-tag", text: cl });
      if (colorByName[cl]) chip.style.setProperty("--chip-color", colorByName[cl]);
      applyChipStyleByKind(chip, "context", chipStyles);
    }
    return;
  }
  if (field === "subtask_count") {
    const c = opts.context.subtaskStats?.get(t.data.id)?.total ?? 0;
    if (c > 0) parent.createSpan({ cls: "it-chip it-chip-meta", text: `↳ ${c}` });
    return;
  }
  if (field === "relationship_count") {
    const c = opts.context.relationshipCounts?.get(t.data.id) ?? 0;
    if (c > 0) parent.createSpan({ cls: "it-chip it-chip-meta", text: `🔗 ${c}` });
    return;
  }
  if (field === "time_estimate") {
    if (t.data.time_estimate) parent.createSpan({ cls: "it-chip it-chip-meta", text: `⏱ ${formatMins(t.data.time_estimate)}` });
    return;
  }
  if (field === "time_tracked") {
    if (t.data.time_tracked) parent.createSpan({ cls: "it-chip it-chip-meta", text: `⏲ ${formatMins(t.data.time_tracked)}` });
    return;
  }
  if (field === "sprint_points") {
    if (t.data.sprint_points != null) parent.createSpan({ cls: "it-chip it-chip-meta", text: `${t.data.sprint_points} pts` });
    return;
  }
  if (field === "list" || field === "folder" || field === "space") {
    renderListReference(parent, t, opts.plugin.index, field);
    return;
  }
  if (field.startsWith("custom_field:")) {
    const id = field.slice("custom_field:".length);
    const cf = (customFields as CustomFieldDef[] | undefined)?.find((x) => x.id === id);
    if (!cf) return;
    const raw: unknown = effectiveCustomFieldValue(t, cf, { subtaskStats: opts.context.subtaskStats });
    const isEmpty = isEmptyCustomFieldValue(raw);
    // Resolved once in tasksContext (transient override ⊕ inherited config).
    const showWhenEmpty = opts.context.cfShowWhenEmpty ?? true;
    const showName = opts.context.cfShowName ?? true;
    if (isEmpty && !showWhenEmpty) return;
    const wrap = parent.createSpan({ cls: "it-chip it-chip-meta it-board-cf-chip" });
    if (opts.context.showFieldIcons) renderCfTypeIcon(wrap, cf.type); // colored type icon leads the chip
    if (showName) wrap.createSpan({ text: `${cf.name}: `, cls: "it-board-cf-label" });
    if (!isEmpty) renderCustomFieldValue(wrap, cf, raw, { task: t, index: opts.plugin.index, mode: "board", chipStyles, subtaskStats: opts.context.subtaskStats });
    return;
  }
}

function typeEmojiSmall(type?: string): string {
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

function formatMins(m: number): string {
  if (!m) return "";
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min}m`;
  if (min === 0) return `${h}h`;
  return `${h}h${min}m`;
}

export function computeGroupSet(groupBy: string, bucketKey: string, customFields?: CustomFieldDef[]): GroupPatch {
  if (groupBy === "status") return bucketKey === "__no_status" ? { status: null } : { status: bucketKey };
  if (groupBy === "priority") {
    if (bucketKey === "__no_priority") return { priority: null };
    const n = parseInt(bucketKey, 10);
    return { priority: isNaN(n) ? null : n };
  }
  if (groupBy === "tags") {
    if (bucketKey === "__no_tags") return { tags: [] };
    return { tags: [bucketKey] };
  }
  if (groupBy === "context") {
    if (bucketKey === "__no_context") return {};
    return { context: [bucketKey] };
  }
  if (groupBy === "type") return { type: bucketKey };
  if (groupBy.startsWith("custom_field:")) {
    const id = groupBy.slice("custom_field:".length);
    if (!id) return {};
    if (bucketKey === "__empty") return { custom_fields: { [id]: undefined } };
    const cf = customFields?.find((f) => f.id === id);
    let value: unknown = bucketKey;
    switch (cf?.type) {
      case "number":
      case "money":
      case "rating":
      case "progress_manual": {
        const n = Number(bucketKey);
        if (!Number.isFinite(n)) return {};
        value = n;
        break;
      }
      case "checkbox":
        value = bucketKey === "true";
        break;
      case "labels":
      case "relationship":
      case "doc_relationship":
        value = [bucketKey];
        break;
      case "url":
      case "email":
      case "phone":
        value = { value: bucketKey };
        break;
      case "location":
        value = { url: bucketKey };
        break;
      // Derived/file values cannot be reconstructed from a board bucket.
      case "progress_auto":
      case "attachment":
        return {};
    }
    return { custom_fields: { [id]: value } };
  }
  return {};
}

/** Combine primary + swimlane patches without dropping either custom field. */
export function mergeGroupPatches(...patches: unknown[]): GroupPatch {
  const out: GroupPatch = {};
  let custom: Record<string, unknown> | undefined;
  for (const patch of patches) {
    if (!patch || typeof patch !== "object") continue;
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (key === "custom_fields" && value && typeof value === "object") {
        custom = { ...(custom || {}), ...(value as Record<string, unknown>) };
      } else {
        out[key] = value;
      }
    }
  }
  if (custom) out.custom_fields = custom;
  return out;
}

/** Apply a board bucket patch while preserving unrelated custom-field data. */
export function applyGroupPatch(data: TaskFile["data"], patch: GroupPatch): TaskFile["data"] {
  const next: TaskFile["data"] = { ...data, ...patch };
  if (patch?.custom_fields && typeof patch.custom_fields === "object") {
    const custom = { ...(data.custom_fields || {}) };
    for (const [id, value] of Object.entries(patch.custom_fields)) {
      if (value === undefined) delete custom[id];
      else custom[id] = value;
    }
    next.custom_fields = custom;
  }
  return next;
}
