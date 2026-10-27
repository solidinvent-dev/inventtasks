import { setIcon, Notice, Platform } from "obsidian";
import { showContextMenu } from "../ui/menu";
import type InventTasksPlugin from "../main";
import { favoriteToggleItems } from "./favorites";
import { TaskFile, StatusDef, PriorityDef, CustomFieldDef, parentTaskIds } from "../types";
import { ViewState } from "./main-view";
import { appendActivity } from "../data/activity";
import { renderCustomFieldValue } from "../ui/cf-render";
import { groupTasks, GroupBucket } from "../data/filters";
import { buildSubtaskTree, flattenSubtaskRows, SubtaskTree, NestedRow, maxSubtaskDepth } from "../data/subtasks";
import { showPopover, buildDropdown, renderTagsCell, applyChipStyleByKind, chipKindForGroupBy, renderGroupHeaderChip, renderListReference } from "../ui/components";
import { renderIconish, renderFieldIcon } from "../ui/icons";
import { ConfirmModal } from "../modals/confirm-modal";
import { MoveTaskModal } from "../modals/move-modal";
import { TaskModal } from "../modals/task-modal";
import { ExportModal } from "../modals/export-modal";
import { locationKey } from "../view-state";
import { t as i18n, fieldLabel, fieldLabelFrom } from "../i18n";
import { fillCalcCell, hasAnyCalc, openCalcMenu, persistColumnCalcs } from "./column-calc";
import { customFieldText, effectiveCustomFieldValue } from "../data/custom-fields";
import { uses24HourTime } from "../utils/dates";
import { renderDateTimeInput, type DateTimeInputHandle, type DateTimeInputKind } from "../ui/datetime-field";
import { groupCollapseKey } from "../view-state";
import { MAX_TASK_TITLE_LENGTH, parseNonNegativeInteger } from "../data/task-values";

interface RenderOpts {
  parent: HTMLElement;
  tasks: TaskFile[];
  state: ViewState;
  plugin: InventTasksPlugin;
  onTaskClick: (t: TaskFile) => void;
  context: { statuses: StatusDef[]; priorities: PriorityDef[]; priorityLabels: Record<number, string>; visibleFields: string[] };
  // Re-render just the view body (preserving scroll) — for column reorder /
  // clearing selection where an index emit isn't involved.
  rerender?: () => void;
  onToggleGroup?: (bucketKey: string) => void;
}

function tableColLabel(col: string, labels?: Record<string, string>): string {
  // A custom display name (field_labels) wins over the compact short header.
  const custom = labels && labels[col];
  if (typeof custom === "string" && custom) return custom;
  switch (col) {
    case "due_date": return i18n("col.due");
    case "start_date": return i18n("col.start");
    case "time_estimate": return i18n("col.est");
    case "time_tracked": return i18n("col.tracked");
    case "sprint_points": return i18n("col.pts");
    default: return fieldLabel(col);
  }
}

const DEFAULT_WIDTH: Record<string, number> = {
  title: 260, id: 110, custom_id: 120, type: 100,
  status: 130, priority: 110, due_date: 248, start_date: 248,
  tags: 180, context: 160, time_estimate: 90, time_tracked: 90, sprint_points: 70,
  list: 150, folder: 150, space: 150, created_at: 150, updated_at: 150,
};
const INLINE_DATE_WIDTH: Record<DateTimeInputKind, number> = {
  date: 100,
  time: 58,
  datetime: 178,
};
const INLINE_DATE_WIDTH_MOBILE: Record<DateTimeInputKind, number> = {
  date: 100,
  time: 63,
  datetime: 178,
};
const INLINE_DATE_WIDTH_MOBILE_12H: Record<DateTimeInputKind, number> = {
  date: 100,
  time: 112,
  datetime: 216,
};
function inlineKindForColumn(col: string, customFields?: CustomFieldDef[]): DateTimeInputKind | null {
  if (col === "due_date" || col === "start_date") return "datetime";
  if (!col.startsWith("custom_field:")) return null;
  const id = col.slice("custom_field:".length);
  const cf = customFields?.find((field) => field.id === id);
  return cf?.type === "date" || cf?.type === "time" || cf?.type === "datetime" ? cf.type : null;
}
function headerMinWidth(label: string): number {
  // Header cells may include a field-type icon and uppercase letter spacing.
  // Keep the initial width wide enough that headers don't render clipped.
  if (Platform.isMobile) return Math.max(52, Math.ceil(label.length * 6.2) + 28);
  return Math.max(76, Math.ceil(label.length * 7.5) + 52);
}

export function colWidth(col: string, widths: Record<string, number>, customFields?: CustomFieldDef[], label?: string): number {
  const minForHeader = label ? headerMinWidth(label) : 0;
  const inlineKind = inlineKindForColumn(col, customFields);
  const inlineWidths = Platform.isMobile
    ? (uses24HourTime() ? INLINE_DATE_WIDTH_MOBILE : INLINE_DATE_WIDTH_MOBILE_12H)
    : INLINE_DATE_WIDTH;
  const base = inlineKind ? inlineWidths[inlineKind] : col.startsWith("custom_field:") ? 150 : DEFAULT_WIDTH[col] ?? 130;
  if (!Platform.isMobile && typeof widths[col] === "number") return widths[col];
  return Math.max(base, minForHeader);
}

export function shouldPersistTableWidths(): boolean {
  return !Platform.isMobile;
}

export function patchTagsForBulk(data: any, tag: string, mode: "add" | "remove") {
  const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
  return { tags: mode === "add" ? Array.from(new Set([...tags, tag])) : tags.filter((value: string) => value !== tag) };
}

export function patchCustomFieldForBulk(data: any, fieldId: string, value: any) {
  const customFields = { ...(data.custom_fields || {}) };
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) delete customFields[fieldId];
  else customFields[fieldId] = value;
  return { custom_fields: customFields };
}

export function patchAdditionalListForBulk(data: any, listPath: string, homeListPath: string | undefined, mode: "add" | "remove") {
  const current = Array.isArray(data.additional_lists) ? data.additional_lists.map(String) : [];
  if (mode === "add") {
    if (homeListPath === listPath || current.includes(listPath)) return { additional_lists: current.length ? current : undefined };
    return { additional_lists: [...current, listPath] };
  }
  const next = current.filter((path: string) => path !== listPath);
  return { additional_lists: next.length ? next : undefined };
}

export function additionalListCandidatesForBulk(lists: any[], tasks: TaskFile[], mode: "add" | "remove") {
  const userLists = lists.filter((list) => !list.config?.system_kind);
  if (mode === "add") {
    return userLists.filter((list) => tasks.some((task) => task.listPath !== list.path && !(task.data.additional_lists || []).includes(list.path)));
  }
  const removable = new Set<string>();
  for (const task of tasks) for (const path of task.data.additional_lists || []) removable.add(path);
  return userLists.filter((list) => removable.has(list.path));
}

function rememberTableScroll(opts: RenderOpts, source?: HTMLElement) {
  const wrap = source?.closest(".it-table-wrap") as HTMLElement | null;
  if (!wrap) return;
  (opts.state as any).__tableScrollLeft = wrap.scrollLeft;
  (opts.state as any).__tableScrollTop = wrap.scrollTop;
}

function restoreTableScroll(opts: RenderOpts) {
  const left = Number((opts.state as any).__tableScrollLeft);
  const top = Number((opts.state as any).__tableScrollTop);
  if (!Number.isFinite(left) && !Number.isFinite(top)) return;
  window.requestAnimationFrame(() => {
    const wrap = opts.parent.querySelector(".it-table-wrap") as HTMLElement | null;
    if (!wrap) return;
    if (Number.isFinite(left)) wrap.scrollLeft = left;
    if (Number.isFinite(top)) wrap.scrollTop = top;
  });
}

async function updateTaskPreservingTableScroll(
  opts: RenderOpts,
  source: HTMLElement | undefined,
  taskId: string,
  fn: Parameters<InventTasksPlugin["index"]["updateTask"]>[1],
) {
  rememberTableScroll(opts, source);
  await opts.plugin.index.updateTask(taskId, fn);
  restoreTableScroll(opts);
}

function renderInlineDateTimeInput(
  parent: HTMLElement,
  kind: DateTimeInputKind,
  value: any,
  onCommit: (value: string | null, handle: DateTimeInputHandle) => void,
): DateTimeInputHandle {
  return renderDateTimeInput({
    parent,
    kind,
    value,
    onCommit,
    pairClass: "it-inline-datetime-pair it-table-date",
    dateClass: "it-inline-datetime it-inline-kind-date",
    timeClass: "it-inline-datetime it-inline-kind-time",
    singleClass: (k) => `it-inline-datetime it-inline-kind-${k} it-table-date`,
    stopClick: true,
  });
}

async function updateCustomFieldValue(opts: RenderOpts, task: TaskFile, field: CustomFieldDef, value: any, handle?: DateTimeInputHandle, source?: HTMLElement) {
  if (field.required && (value === null || value === undefined || value === "")) {
    new Notice(i18n("task.notice.requiredField", { name: field.name }));
    handle?.reset(task.data.custom_fields?.[field.id]);
    return;
  }
  await updateTaskPreservingTableScroll(opts, source, task.data.id, (d) => {
    const customFields = { ...(d.custom_fields || {}) };
    if (value === null || value === undefined || value === "") delete customFields[field.id];
    else customFields[field.id] = value;
    return { data: { ...d, custom_fields: customFields } };
  });
}

function closePopovers() {
  document.querySelectorAll(".it-popover").forEach((el) => el.remove());
}

function stopCellClick(el: HTMLElement) {
  el.addEventListener("click", (e) => e.stopPropagation());
}

function installOutsideTextEditCommit(input: HTMLInputElement | HTMLTextAreaElement, commit: () => void): () => void {
  let disposed = false;
  let clickSuppressTimer: number | null = null;

  const cleanupClickSuppressor = () => {
    document.removeEventListener("click", stopNextClick, true);
    if (clickSuppressTimer != null) {
      window.clearTimeout(clickSuppressTimer);
      clickSuppressTimer = null;
    }
  };
  const stopNextClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    cleanupClickSuppressor();
  };
  const armClickSuppressor = () => {
    cleanupClickSuppressor();
    document.addEventListener("click", stopNextClick, true);
    clickSuppressTimer = window.setTimeout(cleanupClickSuppressor, 500);
  };
  const cleanupPointerListener = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("pointerdown", onPointerDown, true);
  };
  const onPointerDown = (e: PointerEvent) => {
    if (disposed) return;
    const target = e.target;
    if (target instanceof Node && input.contains(target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    armClickSuppressor();
    cleanupPointerListener();
    commit();
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  return cleanupPointerListener;
}

function commitOnEnterOrBlur(input: HTMLInputElement | HTMLTextAreaElement, commit: () => void, cancel?: () => void) {
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !(input instanceof HTMLTextAreaElement && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel?.();
    }
  });
  input.addEventListener("blur", commit);
}

function renderInlineTextEditor(
  td: HTMLElement,
  value: string,
  placeholder: string,
  multiline: boolean,
  onCommit: (value: string | null) => void,
  displayClass?: string,
  maxLength?: number,
) {
  td.empty();
  const input = multiline
    ? td.createEl("textarea", { cls: "it-table-edit-input it-table-edit-textarea", attr: { placeholder } })
    : td.createEl("input", { type: "text", cls: "it-table-edit-input", attr: { placeholder } });
  input.value = value;
  if (maxLength != null) input.maxLength = maxLength;
  stopCellClick(input);
  let done = false;
  let cleanupOutsideCommit: (() => void) | null = null;
  const restoreLabel = (text: string | null) => {
    td.empty();
    if (displayClass) {
      const lbl = td.createSpan({ cls: displayClass, text: text || placeholder });
      if (!text) lbl.addClass("is-empty");
    }
  };
  const finish = () => {
    if (done) return;
    done = true;
    cleanupOutsideCommit?.();
    const val = input.value.trim() || null;
    restoreLabel(val);
    onCommit(val);
  };
  const cancel = () => {
    if (done) return;
    done = true;
    cleanupOutsideCommit?.();
    restoreLabel(value || null);
  };
  cleanupOutsideCommit = installOutsideTextEditCommit(input, finish);
  commitOnEnterOrBlur(input, finish, cancel);
  input.focus({ preventScroll: true });
  input.select();
}

function renderDesktopTextEditableCell(
  td: HTMLElement,
  value: string,
  placeholder: string,
  displayClass: string,
  onCommit: (value: string | null) => void,
  onSingleClick?: () => void,
  maxLength?: number,
) {
  td.addClass("it-table-editable");
  stopCellClick(td);
  const label = td.createSpan({ cls: displayClass, text: value || placeholder });
  if (!value) label.addClass("is-empty");
  let clickTimer: number | null = null;
  if (onSingleClick) {
    td.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (clickTimer != null) window.clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => {
        clickTimer = null;
        onSingleClick();
      }, 180);
    });
  }
  td.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (clickTimer != null) {
      window.clearTimeout(clickTimer);
      clickTimer = null;
    }
    renderInlineTextEditor(td, value, placeholder, false, onCommit, displayClass, maxLength);
  });
}

function renderValuePopover(
  anchor: HTMLElement,
  value: string,
  opts: { type?: string; textarea?: boolean; min?: string; max?: string; step?: string; placeholder?: string },
  onCommit: (value: string | null) => void,
) {
  showPopover(anchor, (root) => {
    const wrap = root.createDiv({ cls: "it-table-edit-popover" });
    const input = opts.textarea
      ? wrap.createEl("textarea", { cls: "it-table-edit-input it-table-edit-textarea", attr: { placeholder: opts.placeholder || "" } })
      : wrap.createEl("input", { type: opts.type || "text", cls: "it-table-edit-input", attr: { placeholder: opts.placeholder || "" } });
    input.value = value;
    if (input instanceof HTMLInputElement) {
      if (opts.min != null) input.min = opts.min;
      if (opts.max != null) input.max = opts.max;
      if (opts.step != null) input.step = opts.step;
    }
    input.addEventListener("click", (e) => e.stopPropagation());
    const actions = wrap.createDiv({ cls: "it-table-edit-actions" });
    actions.createEl("button", { cls: "it-btn-secondary it-btn-mini", text: i18n("common.clear") }).addEventListener("click", async (e) => {
      e.stopPropagation();
      closePopovers();
      onCommit(null);
    });
    actions.createEl("button", { cls: "it-btn-primary it-btn-mini", text: i18n("common.set") }).addEventListener("click", async (e) => {
      e.stopPropagation();
      closePopovers();
      onCommit(input.value.trim() || null);
    });
    input.focus({ preventScroll: true });
  });
}

function renderNumericEditor(
  td: HTMLElement,
  value: number | undefined,
  onCommit: (value: number | undefined) => void,
  opts: { min?: string; max?: string; step?: string; mobilePopover?: boolean; wholeNonNegative?: boolean } = {},
) {
  const current = value != null ? String(value) : "";
  if (Platform.isMobile && opts.mobilePopover) {
    td.addClass("it-table-editable");
    stopCellClick(td);
    const btn = td.createEl("button", { cls: "it-table-edit-display it-table-num", text: current || "—" });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      renderValuePopover(btn, current, { type: "number", min: opts.min, max: opts.max, step: opts.step }, (next) => {
        if (opts.wholeNonNegative) {
          const checked = parseNonNegativeInteger(next);
          if (!checked.valid) return;
          onCommit(checked.value);
          return;
        }
        const n = next == null ? NaN : Number(next);
        onCommit(Number.isFinite(n) ? n : undefined);
      });
    });
    return;
  }

  const input = td.createEl("input", { type: "number", cls: "it-table-num" });
  input.value = current;
  if (opts.min != null) input.min = opts.min;
  if (opts.max != null) input.max = opts.max;
  if (opts.step != null) input.step = opts.step;
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("change", () => {
    if (opts.wholeNonNegative) {
      const checked = parseNonNegativeInteger(input.value);
      if (!checked.valid) { input.value = current; return; }
      onCommit(checked.value);
      return;
    }
    const n = Number(input.value);
    onCommit(Number.isFinite(n) ? n : undefined);
  });
}

function renderProgressDisplay(parent: HTMLElement, value: number | undefined, editable: boolean): HTMLElement {
  const pct = Math.max(0, Math.min(100, Math.round(value ?? 0)));
  const wrap = parent.createEl(editable ? "button" : "span", {
    cls: "it-table-progress" + (editable ? " it-table-progress-editable" : ""),
  });
  const track = wrap.createSpan({ cls: "it-table-progress-track" });
  track.createSpan({ cls: "it-table-progress-fill" }).style.width = `${pct}%`;
  wrap.createSpan({ cls: "it-table-progress-label", text: `${pct}%` });
  return wrap;
}

function renderProgressEditor(td: HTMLElement, value: number | undefined, onCommit: (value: number | undefined) => void) {
  td.addClass("it-table-editable");
  stopCellClick(td);
  const current = Math.max(0, Math.min(100, Math.round(value ?? 0)));
  const trigger = renderProgressDisplay(td, current, true);
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    renderValuePopover(trigger, value != null ? String(current) : "", { type: "number", min: "0", max: "100", step: "1" }, (next) => {
      const n = next == null ? NaN : Number(next);
      onCommit(Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : undefined);
    });
  });
}

function renderOptionMultiPicker(
  anchor: HTMLElement,
  selectedValues: string[],
  items: Array<{ value: string; label: string; color?: string }>,
  onChange: (values: string[]) => void,
) {
  showPopover(anchor, (root) => {
    const menu = root.createDiv({ cls: "it-popover-menu it-table-multi-picker" });
    if (items.length === 0) {
      menu.createDiv({ cls: "it-empty-row", text: i18n("filter.noOptions") });
      return;
    }
    const selected = new Set(selectedValues);
    const renderRows = () => {
      menu.empty();
      for (const item of items) {
        const row = menu.createEl("button", { cls: "it-popover-item" + (selected.has(item.value) ? " is-active" : "") });
        if (item.color) {
          const dot = row.createSpan({ cls: "it-dot" });
          dot.style.background = item.color;
        }
        row.createSpan({ text: item.label });
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          if (selected.has(item.value)) selected.delete(item.value);
          else selected.add(item.value);
          onChange(Array.from(selected));
          renderRows();
        });
      }
      menu.createDiv({ cls: "it-popover-sep" });
      menu.createEl("button", { cls: "it-popover-item it-popover-footer-item", text: i18n("common.clear") }).addEventListener("click", (e) => {
        e.stopPropagation();
        selected.clear();
        onChange([]);
        renderRows();
      });
    };
    renderRows();
  });
}

function renderTaskModalCell(td: HTMLElement, task: TaskFile, opts: RenderOpts, field: CustomFieldDef, raw: any) {
  td.addClass("it-table-editable");
  renderCustomFieldValue(td, field, raw, { task, index: opts.plugin.index, mode: "table", chipStyles: (opts.context as any).chipStyles, subtaskStats: (opts.context as any).subtaskStats });
  if (!td.textContent?.trim()) td.createSpan({ cls: "it-table-edit-display is-empty", text: "—" });
  td.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    new TaskModal(opts.plugin.app, opts.plugin, task).open();
  });
}

function renderEmptyModalCell(td: HTMLElement, task: TaskFile, opts: RenderOpts) {
  td.addClass("it-table-editable");
  td.createSpan({ cls: "it-table-edit-display is-empty", text: "—" });
  td.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    new TaskModal(opts.plugin.app, opts.plugin, task).open();
  });
}

function openDocFromTable(opts: RenderOpts, docPath: string | undefined) {
  if (!docPath) return;
  const mv = opts.plugin.getMainView?.();
  if (mv) mv.openDocLocation(docPath);
  else void opts.plugin.activateView().then(() => opts.plugin.getMainView()?.openDocLocation(docPath));
}

function renderRelationshipLinks(td: HTMLElement, task: TaskFile, field: CustomFieldDef, opts: RenderOpts, raw: any) {
  const ids = Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  if (!ids.length) { renderEmptyModalCell(td, task, opts); return; }
  for (const id of ids.slice(0, 3)) {
    const linked = opts.plugin.index.tasksById.get(id);
    const label = linked ? (linked.data.title || id) : id;
    const chip = td.createEl("button", { cls: "it-chip it-chip-link it-cf-display" });
    chip.createSpan({ cls: "it-chip-link-title", text: label });
    chip.setAttribute("title", linked ? `${label} (${id})` : id);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (linked) opts.onTaskClick(linked);
    });
  }
  if (ids.length > 3) td.createSpan({ cls: "it-chip it-chip-meta it-cf-display", text: `+${ids.length - 3}` });
}

function renderDocRelationshipLinks(td: HTMLElement, task: TaskFile, field: CustomFieldDef, opts: RenderOpts, raw: any) {
  const ids = Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  if (!ids.length) { renderEmptyModalCell(td, task, opts); return; }
  for (const id of ids.slice(0, 3)) {
    const doc = opts.plugin.index.docById(id);
    const label = doc ? doc.name : id;
    const chip = td.createEl("button", { cls: "it-chip it-chip-link it-cf-display" });
    chip.createSpan({ cls: "it-chip-link-title", text: label });
    chip.setAttribute("title", label);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      openDocFromTable(opts, doc?.__path);
    });
  }
  if (ids.length > 3) td.createSpan({ cls: "it-chip it-chip-meta it-cf-display", text: `+${ids.length - 3}` });
}

function renderCustomFieldEditor(td: HTMLElement, task: TaskFile, field: CustomFieldDef, opts: RenderOpts) {
  const raw = task.data.custom_fields?.[field.id];
  const renderReadonly = () => {
    renderCustomFieldValue(td, field, raw, {
      task,
      index: opts.plugin.index,
      mode: "table",
      chipStyles: (opts.context as any).chipStyles,
      subtaskStats: (opts.context as any).subtaskStats,
    });
  };

  if (field.type === "date" || field.type === "time" || field.type === "datetime") {
    renderInlineDateTimeInput(td, field.type, raw, (value, input) => {
      void updateCustomFieldValue(opts, task, field, value, input, td);
    });
    return;
  }

  if (field.type === "url" || field.type === "email" || field.type === "phone" || field.type === "location") {
    if (raw) renderReadonly();
    else renderEmptyModalCell(td, task, opts);
    return;
  }

  if (field.type === "relationship") {
    renderRelationshipLinks(td, task, field, opts, raw);
    return;
  }

  if (field.type === "doc_relationship") {
    renderDocRelationshipLinks(td, task, field, opts, raw);
    return;
  }

  if (field.type === "text") {
    const value = String(raw ?? "");
    if (Platform.isMobile) {
      td.addClass("it-table-editable");
      stopCellClick(td);
      renderReadonly();
      if (!td.textContent?.trim()) td.createSpan({ cls: "it-table-edit-display is-empty", text: "—" });
      td.addEventListener("click", (e) => {
        e.stopPropagation();
        renderValuePopover(td, value, { placeholder: field.name }, (next) => void updateCustomFieldValue(opts, task, field, next, undefined, td));
      });
    } else {
      renderDesktopTextEditableCell(td, value, "—", "it-cf-display it-cf-text", (next) => void updateCustomFieldValue(opts, task, field, next, undefined, td));
    }
    return;
  }

  if (field.type === "textarea") {
    td.addClass("it-table-editable");
    stopCellClick(td);
    renderReadonly();
    if (!td.textContent?.trim()) td.createSpan({ cls: "it-table-edit-display is-empty", text: "—" });
    td.addEventListener("click", (e) => {
      e.stopPropagation();
      renderValuePopover(td, String(raw ?? ""), { textarea: true, placeholder: field.name }, (next) => void updateCustomFieldValue(opts, task, field, next, undefined, td));
    });
    return;
  }

  if (field.type === "number" || field.type === "money") {
    renderNumericEditor(td, raw != null ? Number(raw) : undefined, (n) => {
      void updateCustomFieldValue(opts, task, field, n, undefined, td);
    }, { step: field.type === "money" ? "0.01" : "1", mobilePopover: true });
    return;
  }

  if (field.type === "checkbox") {
    stopCellClick(td);
    const cb = td.createEl("input", { type: "checkbox", cls: "it-table-checkbox" });
    cb.checked = !!raw;
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => void updateCustomFieldValue(opts, task, field, cb.checked, undefined, td));
    return;
  }

  if (field.type === "dropdown") {
    td.addClass("it-table-editable");
    stopCellClick(td);
    const current = String(raw ?? "");
    const opt = field.options?.find((o) => (o.value ?? o.label) === current || o.label === current);
    const chip = td.createEl("button", { cls: "it-chip it-chip-tag it-table-edit-display", text: opt?.label || (current || "—") });
    if (opt?.color) chip.style.setProperty("--chip-color", opt.color);
    applyChipStyleByKind(chip, "custom_field", (opts.context as any).chipStyles);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      showPopover(chip, (root) => buildDropdown({
        parent: root,
        current: raw ?? null,
        items: [
          ...(field.options || []).map((o) => ({ value: (o.value ?? o.label) as any, label: o.label, color: o.color })),
          { value: null as any, label: "—" },
        ],
        onSelect: (v) => {
          closePopovers();
          void updateCustomFieldValue(opts, task, field, v, undefined, td);
        },
      }));
    });
    return;
  }

  if (field.type === "labels") {
    td.addClass("it-table-editable");
    stopCellClick(td);
    renderReadonly();
    if (!td.textContent?.trim()) td.createSpan({ cls: "it-table-edit-display is-empty", text: "—" });
    td.addEventListener("click", (e) => {
      e.stopPropagation();
      const selected = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
      renderOptionMultiPicker(td, selected, (field.options || []).map((o) => ({ value: o.value ?? o.label, label: o.label, color: o.color })), (values) => {
        void updateCustomFieldValue(opts, task, field, values, undefined, td);
      });
    });
    return;
  }

  if (field.type === "rating") {
    stopCellClick(td);
    const scale = Math.max(1, field.scale || 5);
    const icon = field.icon || "★";
    const value = Math.max(0, Math.min(scale, Number(raw) || 0));
    const wrap = td.createSpan({ cls: "it-cf-rating-edit" });
    for (let i = 1; i <= scale; i++) {
      const btn = wrap.createEl("button", { cls: "it-cf-rating-btn" + (i <= value ? " is-on" : ""), text: icon });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        void updateCustomFieldValue(opts, task, field, value === i ? null : i, undefined, td);
      });
    }
    return;
  }

  if (field.type === "progress_manual") {
    renderProgressEditor(td, raw != null ? Number(raw) : undefined, (n) => {
      void updateCustomFieldValue(opts, task, field, n, undefined, td);
    });
    return;
  }

  if (field.type === "progress_auto") {
    const resolved = effectiveCustomFieldValue(task, field, { subtaskStats: (opts.context as any).subtaskStats, allTasks: (opts.context as any).subtaskStats ? undefined : opts.plugin.index.allTasks() });
    renderProgressDisplay(td, Number(resolved) || 0, false);
    return;
  }

  // Complex structured fields use the full task modal editor to avoid
  // duplicating validation, file handling, and relationship pickers in cells.
  renderTaskModalCell(td, task, opts, field, raw);
}

interface SelCtl { selected: Set<string>; onToggle: () => void; }

export function renderTableView(opts: RenderOpts) {
  const { parent, tasks, state, context, plugin } = opts;
  parent.addClass("it-table-view");

  // Tear down any lazy-render observer from a previous render into this same
  // scroll container (refreshContent reuses the body element).
  const scroller = parent;
  (scroller as any).__itTableIO?.disconnect?.();
  (scroller as any).__itTableIO = undefined;

  if (tasks.length === 0) {
    parent.createDiv({ cls: "it-empty-state-small", text: i18n("list.noTasks") });
    return;
  }

  // Columns — title always first (it's the frozen column).
  const visible = context.visibleFields.slice();
  if (!visible.includes("title")) visible.unshift("title");
  else { visible.splice(visible.indexOf("title"), 1); visible.unshift("title"); }

  const customFields = (context as any).customFields as CustomFieldDef[] | undefined;
  const fieldLabels = (context as any).fieldLabels as Record<string, string> | undefined;
  const headerLabel = (col: string): string => {
    if (col.startsWith("custom_field:")) return customFields?.find((c) => c.id === col.slice(13))?.name || col.slice(13);
    return tableColLabel(col, fieldLabels);
  };

  const widths: Record<string, number> = state.tableColWidths || (state.tableColWidths = {});
  const selected: Set<string> = (state as any).__tableSelected instanceof Set
    ? (state as any).__tableSelected
    : ((state as any).__tableSelected = new Set<string>());

  // ---- Bulk-edit bar (in place, no full re-render on selection change) ----
  const bulkBar = parent.createDiv({ cls: "it-bulk-bar" });
  const updateBulkBar = () => renderBulkBar(bulkBar, selected, opts);

  // ---- Subtask nesting (mirror of List view) ----
  const nested = (context as any).subtaskMode === "nested";
  const tree: SubtaskTree | null = nested ? buildSubtaskTree(tasks) : null;
  const collapsed: Set<string> = ((state as any).__collapsedSubtasks ||= new Set<string>());
  const groupSource = nested ? tree!.roots : tasks;
  const subDepth = maxSubtaskDepth(plugin.index.resolveFeaturesForLocation(state.location));
  const rowsFor = (group: GroupBucket): NestedRow[] =>
    tree ? flattenSubtaskRows(group.tasks, tree, collapsed, subDepth)
         : group.tasks.map((t) => ({ task: t, depth: 0, hasChildren: false }));

  // ---- Grouping ----
  const groups = state.groupBy
    ? groupTasks(groupSource, state.groupBy, {
        statuses: context.statuses,
        priorities: context.priorities,
        priorityLabels: context.priorityLabels,
        tagsOrder: (context as any).tagsOrder,
        contextOrder: (context as any).contextOrder,
        taskTypesOrder: (context as any).taskTypesOrder,
        tagsPalette: (context as any).tagsPalette,
        contextLabels: (context as any).contextLabels,
        customFields: (context as any).customFields,
        listMeta: (context as any).listMeta,
        subtaskStats: (context as any).subtaskStats,
        taskTitles: (context as any).taskTitles,
        emptyPositions: (context as any).emptyPositions,
        fieldLabels: (context as any).fieldLabels,
        direction: state.groupDirection,
      })
    : [{ key: "__all", label: "", tasks: groupSource } as GroupBucket];

  // ---- Table + fixed-layout colgroup (enables resize + freeze) ----
  const tableWrap = parent.createDiv({ cls: "it-table-wrap" });
  const rememberedLeft = Number((state as any).__tableScrollLeft);
  const rememberedTop = Number((state as any).__tableScrollTop);
  if (Number.isFinite(rememberedLeft)) tableWrap.scrollLeft = rememberedLeft;
  if (Number.isFinite(rememberedTop)) tableWrap.scrollTop = rememberedTop;
  window.requestAnimationFrame(() => {
    if (Number.isFinite(rememberedLeft)) tableWrap.scrollLeft = rememberedLeft;
    if (Number.isFinite(rememberedTop)) tableWrap.scrollTop = rememberedTop;
  });
  const table = tableWrap.createEl("table", { cls: "it-table is-fixed" });
  const colgroup = table.createEl("colgroup");
  colgroup.createEl("col", { cls: "it-col-select" });
  const colEls: Record<string, HTMLElement> = {};
  for (const col of visible) {
    const c = colgroup.createEl("col");
    c.style.width = colWidth(col, widths, customFields, headerLabel(col)) + "px";
    colEls[col] = c;
  }
  colgroup.createEl("col", { cls: "it-col-actions" });

  // Table width = sum of column widths (explicit px). Keeps fixed-layout
  // clipping honest — columns shrink below content and the wrap scrolls
  // horizontally when the total exceeds it.
  const setTableWidth = () => {
    let total = 34 + 44;
    for (const col of visible) total += colWidth(col, widths, customFields, headerLabel(col));
    table.style.width = total + "px";
  };
  setTableWidth();

  const tbody = table.createEl("tbody");

  const persistWidths = () => {
    if (!shouldPersistTableWidths()) return;
    const map = plugin.prefs.viewStateByLocation || {};
    const key = locationKey(state.location);
    map[key] = { ...(map[key] || {}), tableColWidths: { ...widths } };
    plugin.prefs.viewStateByLocation = map;
    void plugin.saveSettings();
  };

  // Excel-style autofit: size the column to its widest rendered content. We
  // briefly drop fixed layout + this column's width so content sizes naturally,
  // measure the column's cells, then restore. (Measures currently-rendered rows.)
  const autofitCol = (col: string) => {
    const colEl = colEls[col];
    const idx = 1 + visible.indexOf(col); // 0 = the selection column
    if (idx < 1) return;
    table.removeClass("is-fixed");
    colEl.style.removeProperty("width");
    void table.offsetWidth; // force reflow into content-based layout
    let max = 40;
    tbody.querySelectorAll("tr.it-table-row, tr.it-table-colhead-row").forEach((el) => {
      const cell = (el as HTMLElement).children[idx] as HTMLElement | undefined;
      if (cell) max = Math.max(max, cell.offsetWidth);
    });
    table.addClass("is-fixed");
    const w = Math.min(600, Math.max(colWidth(col, {}, customFields, headerLabel(col)), Math.ceil(max) + 2));
    colEl.style.width = w + "px";
    widths[col] = w;
    setTableWidth();
    persistWidths();
  };

  const syncSelectAll = () => {
    const all = tasks.length > 0 && tasks.every((t) => selected.has(t.data.id));
    const some = !all && tasks.some((t) => selected.has(t.data.id));
    tbody.querySelectorAll(".it-table-selall").forEach((el) => {
      const cb = el as HTMLInputElement;
      cb.checked = all;
      cb.indeterminate = some;
    });
  };

  const reorderCols = (from: string, to: string) => {
    if (from === to || from === "title" || to === "title") return;
    const order = visible.slice();
    const a = order.indexOf(from);
    if (a < 0) return;
    order.splice(a, 1);
    const b = order.indexOf(to);
    if (b < 0) return;
    order.splice(b, 0, from);
    state.visibleFields = order.filter((c) => c !== "title");
    opts.rerender?.();
  };

  const renderColumnHeaderRow = () => {
    const r = tbody.createEl("tr", { cls: "it-table-colhead-row" });

    const selTh = r.createEl("th", { cls: "it-table-sel-col it-table-frozen-sel" });
    const selAll = selTh.createEl("input", { type: "checkbox", cls: "it-table-selall" });
    selAll.addEventListener("click", (e) => e.stopPropagation());
    selAll.addEventListener("change", () => {
      for (const t of tasks) { if (selAll.checked) selected.add(t.data.id); else selected.delete(t.data.id); }
      tbody.querySelectorAll(".it-table-row").forEach((el) => {
        const tr = el as HTMLElement;
        const id = tr.dataset.taskId;
        const on = !!id && selected.has(id);
        tr.classList.toggle("is-selected", on);
        const cb = tr.querySelector(".it-table-rowsel") as HTMLInputElement | null;
        if (cb) cb.checked = on;
      });
      updateBulkBar();
      syncSelectAll();
    });

    for (const col of visible) {
      const th = r.createEl("th", { cls: col === "title" ? "it-table-title-col it-table-frozen" : "" });
      // Icon + label go in an inner flex wrapper — NEVER set display:flex on the
      // <th> itself, that drops it out of the table layout (broken header).
      const thInner = th.createDiv({ cls: "it-th-inner" });
      if ((opts.context as any).showFieldIcons) renderFieldIcon(thInner, col, customFields as any); // colored field-type icon
      thInner.createSpan({ cls: "it-th-label", text: headerLabel(col) });

      // Column reorder (drag) and resize are pointer/mouse-only — disabled on
      // mobile, where columns are managed via "Customize fields" instead.
      if (col !== "title" && !Platform.isMobile) {
        th.setAttribute("draggable", "true");
        th.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("text/itcol", col); th.addClass("is-dragging-col"); });
        th.addEventListener("dragend", () => th.removeClass("is-dragging-col"));
        th.addEventListener("dragover", (e) => { e.preventDefault(); th.addClass("is-col-drop"); });
        th.addEventListener("dragleave", () => th.removeClass("is-col-drop"));
        th.addEventListener("drop", (e) => {
          e.preventDefault(); th.removeClass("is-col-drop");
          const from = e.dataTransfer?.getData("text/itcol");
          if (from) reorderCols(from, col);
        });
      }

      if (!Platform.isMobile) {
        const grip = th.createDiv({ cls: "it-col-resize" });
        grip.addEventListener("click", (e) => e.stopPropagation());
        // Double-click the grip → autofit the column to its widest content.
        grip.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); autofitCol(col); });
        grip.addEventListener("mousedown", (e) => {
          e.preventDefault(); e.stopPropagation();
          const startX = e.clientX;
          const startW = colWidth(col, widths, customFields, headerLabel(col));
          const onMove = (ev: MouseEvent) => {
            // Tiny floor only (keeps the grip grabbable) — content clips by design.
            const w = Math.max(24, Math.round(startW + (ev.clientX - startX)));
            widths[col] = w;
            colEls[col].style.width = w + "px";
            setTableWidth();
          };
          const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.classList.remove("it-col-resizing");
            persistWidths();
          };
          document.body.classList.add("it-col-resizing");
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        });
      }
    }
    r.createEl("th", { cls: "it-table-act-col" });
  };

  const renderGroupRow = (group: GroupBucket) => {
    const gr = tbody.createEl("tr", { cls: "it-table-grouprow" });
    const cell = gr.createEl("td", { attr: { colspan: String(visible.length + 2) } });
    const header = cell.createDiv({ cls: "it-table-group-header" });
    const collapsed = new Set(state.collapsedGroups?.table || []).has(groupCollapseKey(state.groupBy, group.key));
    const toggle = header.createEl("button", {
      cls: "it-icon-btn it-icon-btn-mini it-group-collapse-btn",
      attr: { type: "button", "aria-label": i18n(collapsed ? "action.expandGroup" : "action.collapseGroup") },
    });
    setIcon(toggle, collapsed ? "chevron-right" : "chevron-down");
    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      opts.onToggleGroup?.(group.key);
    });
    const kind = chipKindForGroupBy(state.groupBy, (id) =>
      ((opts.context as any).customFields as Array<{ id: string; type: string }> | undefined)
        ?.find((f) => f.id === id)?.type,
    );
    if (kind) {
      renderGroupHeaderChip(header, group, kind, (opts.context as any).chipStyles);
    } else {
      // Non-chip axis (e.g. List): show the group icon when present, else a dot.
      if (group.icon) {
        const ic = renderIconish(header, group.icon, { cls: "it-group-chip-icon" });
        if (ic && group.color) ic.style.color = group.color;
      } else if (group.color) {
        const dot = header.createSpan({ cls: "it-group-dot" }); dot.style.background = group.color;
      }
      header.createSpan({ text: group.label, cls: "it-table-group-label" });
    }
    header.createSpan({ text: `${group.tasks.length}`, cls: "it-group-count" });
  };

  const sel: SelCtl = { selected, onToggle: () => { updateBulkBar(); syncSelectAll(); } };

  // ---- Per-group calculation summary row ----
  const renderGroupSummaryRow = (group: GroupBucket) => {
    const calcs = state.columnCalcs?.table || {};
    const r = tbody.createEl("tr", { cls: "it-table-summary-row" });
    r.createEl("td", { cls: "it-table-sel-col it-table-frozen-sel" });
    for (const col of visible) {
      const td = r.createEl("td", { cls: col === "title" ? "it-table-title-col it-table-frozen" : "" });
      fillCalcCell(td, col, calcs[col], group.tasks, plugin, context, "group");
    }
    r.createEl("td", { cls: "it-table-act-col" });
  };

  // ---- Flatten + incremental render (virtualization) ----
  type TItem =
    | { kind: "grouprow"; group: GroupBucket }
    | { kind: "colhead" }
    | { kind: "row"; row: NestedRow }
    | { kind: "groupsummary"; group: GroupBucket };
  const showGroupSummaries = !!state.groupBy && hasAnyCalc(state.columnCalcs?.table);
  const collapsedGroups = new Set(state.collapsedGroups?.table || []);
  const items: TItem[] = [];
  for (const group of groups) {
    if (state.groupBy) items.push({ kind: "grouprow", group });
    if (state.groupBy && collapsedGroups.has(groupCollapseKey(state.groupBy, group.key))) continue;
    items.push({ kind: "colhead" });
    for (const r of rowsFor(group)) items.push({ kind: "row", row: r });
    if (showGroupSummaries) items.push({ kind: "groupsummary", group });
  }

  const toggleCollapse = (id: string) => {
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    opts.rerender?.();
  };

  let next = 0;
  const renderChunk = (count: number) => {
    const end = Math.min(items.length, next + count);
    for (; next < end; next++) {
      const it = items[next];
      if (it.kind === "grouprow") renderGroupRow(it.group);
      else if (it.kind === "colhead") renderColumnHeaderRow();
      else if (it.kind === "groupsummary") renderGroupSummaryRow(it.group);
      else renderTableRow(tbody, it.row, opts, visible, sel, toggleCollapse, collapsed);
    }
    (state as any).__tableRenderedCount = next;
    syncSelectAll();
  };

  // ---- Grand footer (over all tasks) — also the surface for configuring
  // per-column calculations (click a footer cell). Sticky to the table bottom.
  const renderFooter = () => {
    const calcs = state.columnCalcs?.table || {};
    const tfoot = table.createEl("tfoot");
    const r = tfoot.createEl("tr", { cls: "it-table-footer" });
    r.createEl("td", { cls: "it-table-sel-col it-table-frozen-sel" });
    for (const col of visible) {
      const td = r.createEl("td", { cls: (col === "title" ? "it-table-title-col it-table-frozen " : "") + "it-calc-clickable" });
      const calc = calcs[col];
      fillCalcCell(td, col, calc, tasks, plugin, context, "footer");
      if (col === "title" && !calc) td.createSpan({ cls: "it-calc-sigma", text: "Σ" });
      td.addEventListener("click", (e) => {
        e.stopPropagation();
        openCalcMenu({
          anchor: td, field: col, fieldLabel: headerLabel(col), current: (state.columnCalcs?.table || {})[col], plugin, context,
          onChange: (nextCalc) => {
            const map = { ...(state.columnCalcs?.table || {}) };
            if (nextCalc) map[col] = nextCalc; else delete map[col];
            state.columnCalcs = { ...(state.columnCalcs || {}), table: map };
            persistColumnCalcs(plugin, state.location, "table", map);
            opts.rerender?.();
          },
        });
      });
    }
    r.createEl("td", { cls: "it-table-act-col" });
  };
  renderFooter();

  updateBulkBar();

  const VIRTUAL_THRESHOLD = 120;
  if (items.length <= VIRTUAL_THRESHOLD) {
    renderChunk(items.length);
    return;
  }

  const prev = Number((state as any).__tableRenderedCount) || 0;
  renderChunk(Math.min(items.length, Math.max(80, prev)));
  if (next < items.length) {
    const sentinelRow = tbody.createEl("tr", { cls: "it-table-sentinel" });
    const sCell = sentinelRow.createEl("td", { attr: { colspan: String(visible.length + 2) } });
    sCell.addClass("it-table-sentinel-cell");
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      renderChunk(60);
      if (next >= items.length) { io.disconnect(); sentinelRow.remove(); (scroller as any).__itTableIO = undefined; }
      else tbody.appendChild(sentinelRow);
      // The .it-table-wrap (flex:1) is the actual scroll container — not body.
    }, { root: tableWrap, rootMargin: "0px 0px 900px 0px" });
    io.observe(sentinelRow);
    (scroller as any).__itTableIO = io;
  }
}

// ---------- Bulk-edit bar ----------
function renderBulkBar(bar: HTMLElement, selected: Set<string>, opts: RenderOpts) {
  bar.empty();
  const { plugin, context } = opts;
  const fieldLabels = (context as any).fieldLabels as Record<string, string> | undefined;
  const flabel = (key: string) => fieldLabelFrom(fieldLabels, key);
  const count = selected.size;
  if (count === 0) { bar.hide(); return; }
  bar.show();

  bar.createSpan({ cls: "it-bulk-count", text: i18n("table.bulkSelectedCount", { count }) });
  const ids = () => Array.from(selected);
  const closePop = () => document.querySelectorAll(".it-popover").forEach((el) => el.remove());

  const mkBtn = (label: string, icon: string, danger = false) => {
    const b = bar.createEl("button", { cls: "it-secondary-btn it-btn-mini" + (danger ? " is-danger" : ""), attr: { type: "button" } });
    setIcon(b.createSpan({ cls: "it-btn-ic" }), icon);
    b.createSpan({ text: label });
    return b;
  };

  mkBtn(flabel("status"), "circle-dot").addEventListener("click", (e) => {
    showPopover(e.currentTarget as HTMLElement, (root) => buildDropdown({
      parent: root, current: undefined as any,
      items: context.statuses.map((s) => ({ value: s.id, label: s.name, color: s.color })),
      onSelect: async (v) => { closePop(); await plugin.index.bulkUpdateTasks(ids(), () => ({ status: v })); },
    }));
  });

  mkBtn(flabel("priority"), "flag").addEventListener("click", (e) => {
    showPopover(e.currentTarget as HTMLElement, (root) => buildDropdown({
      parent: root, current: undefined as any,
      items: [...context.priorities.map((p) => ({ value: p.id as any, label: p.label, color: p.color })), { value: null as any, label: i18n("action.noPriority") }],
      onSelect: async (v) => { closePop(); await plugin.index.bulkUpdateTasks(ids(), () => ({ priority: v ?? null })); },
    }));
  });

  mkBtn(flabel("type"), "shapes").addEventListener("click", (e) => {
    showPopover(e.currentTarget as HTMLElement, (root) => buildDropdown({
      parent: root, current: undefined as any,
      items: plugin.index.resolveTaskTypesForLocation(opts.state.location).map((tt) => ({ value: tt.id, label: tt.name, color: tt.color, icon: tt.icon })),
      onSelect: async (v) => { closePop(); await plugin.index.bulkUpdateTasks(ids(), () => ({ type: v })); },
    }));
  });

  mkBtn(flabel("due_date"), "calendar").addEventListener("click", (e) => {
    showPopover(e.currentTarget as HTMLElement, (root) => {
      const w = root.createDiv({ cls: "it-date-popover" });
      const input = w.createEl("input", { type: "date" });
      const set = w.createEl("button", { cls: "it-btn-primary", text: i18n("common.set") });
      const clr = w.createEl("button", { cls: "it-btn-secondary", text: i18n("common.clear") });
      set.addEventListener("click", async () => { closePop(); await plugin.index.bulkUpdateTasks(ids(), () => ({ due_date: input.value || null })); });
      clr.addEventListener("click", async () => { closePop(); await plugin.index.bulkUpdateTasks(ids(), () => ({ due_date: null })); });
    });
  });

  mkBtn(flabel("context"), "tags").addEventListener("click", (e) => {
    showPopover(e.currentTarget as HTMLElement, (root) => {
      const labels = plugin.index.resolveContextLabelsForLocation(opts.state.location);
      if (labels.length === 0) { root.createDiv({ cls: "it-empty-row", text: i18n("action.noContextLabels") }); return; }
      buildDropdown({
        parent: root, current: undefined as any,
        items: labels.map((cl) => ({ value: cl.name, label: cl.name, color: cl.color })),
        // Context is multi-value: add the chosen label to each selected task
        // (deduped), keeping any labels they already have.
        onSelect: async (v) => { closePop(); await plugin.index.bulkUpdateTasks(ids(), (d) => ({ context: Array.from(new Set([...(d.context || []), v])) })); },
      });
    });
  });

  mkBtn(flabel("tags"), "tag").addEventListener("click", (e) => {
    showPopover(e.currentTarget as HTMLElement, (root) => {
      const palette = plugin.index.resolveTagsPaletteForLocation(opts.state.location);
      const colors = new Map(palette.map((tag) => [tag.name, tag.color]));
      const names = new Set(palette.map((tag) => tag.name));
      // Keep legacy/ad-hoc tags usable even when the configured palette is
      // empty or incomplete. The current Table scope is already in memory.
      for (const task of opts.tasks) for (const tag of task.data.tags || []) names.add(tag);
      for (const id of ids()) {
        for (const tag of plugin.index.tasksById.get(id)?.data.tags || []) names.add(tag);
      }
      const items = Array.from(names).map((tag) => ({ value: tag, label: tag, color: colors.get(tag) }));
      const applyTag = async (tag: string, mode: "add" | "remove") => {
        closePop();
        await plugin.index.bulkUpdateTasks(ids(), (d) => patchTagsForBulk(d, tag, mode));
      };
      const showTags = (mode: "add" | "remove") => {
        root.empty();
        if (!items.length) { root.createDiv({ cls: "it-empty-row", text: i18n("filter.noOptions") }); return; }
        buildDropdown({ parent: root, current: undefined, items, onSelect: (tag) => void applyTag(tag, mode) });
      };
      const menu = root.createDiv({ cls: "it-popover-menu" });
      const add = menu.createEl("button", { cls: "it-popover-item" });
      setIcon(add.createSpan({ cls: "it-popover-icon" }), "plus");
      add.createSpan({ text: i18n("common.add") });
      add.addEventListener("click", (ev) => { ev.stopPropagation(); showTags("add"); });
      const remove = menu.createEl("button", { cls: "it-popover-item" });
      setIcon(remove.createSpan({ cls: "it-popover-icon" }), "minus");
      remove.createSpan({ text: i18n("common.remove") });
      remove.addEventListener("click", (ev) => { ev.stopPropagation(); showTags("remove"); });
      menu.createDiv({ cls: "it-popover-sep" });
      menu.createEl("button", { cls: "it-popover-item it-popover-footer-item", text: i18n("common.clear") }).addEventListener("click", async (ev) => {
        ev.stopPropagation(); closePop();
        await plugin.index.bulkUpdateTasks(ids(), () => ({ tags: [] }));
      });
    });
  });

  mkBtn(i18n("task.customFields.title"), "list-restart").addEventListener("click", (e) => {
    showPopover(e.currentTarget as HTMLElement, (root) => {
      const supported = new Set([
        "text", "textarea", "markdown", "number", "money", "date", "datetime", "time",
        "checkbox", "url", "email", "phone", "dropdown", "labels", "rating", "progress_manual",
      ]);
      const fields = plugin.index.resolveCustomFieldsForLocation(opts.state.location).filter((field) => supported.has(field.type));
      if (!fields.length) { root.createDiv({ cls: "it-empty-row", text: i18n("task.customFields.empty") }); return; }

      const applyValue = async (field: CustomFieldDef, value: any) => {
        closePop();
        await plugin.index.bulkUpdateTasks(ids(), (d) => patchCustomFieldForBulk(d, field.id, value));
      };
      const addActions = (wrap: HTMLElement, field: CustomFieldDef, readValue: () => any) => {
        const actions = wrap.createDiv({ cls: "it-table-edit-actions" });
        if (!field.required) actions.createEl("button", { cls: "it-btn-secondary it-btn-mini", text: i18n("common.clear") }).addEventListener("click", () => void applyValue(field, null));
        actions.createEl("button", { cls: "it-btn-primary it-btn-mini", text: i18n("common.apply") }).addEventListener("click", () => {
          const value = readValue();
          if (field.required && (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0))) {
            new Notice(i18n("task.notice.requiredField", { name: field.name }));
            return;
          }
          void applyValue(field, value);
        });
      };
      const editField = (field: CustomFieldDef) => {
        root.empty();
        const wrap = root.createDiv({ cls: "it-table-edit-popover" });
        wrap.createDiv({ cls: "it-calc-menu-title", text: field.name + (field.required ? " *" : "") });

        if (field.type === "dropdown") {
          buildDropdown({
            parent: wrap, current: undefined,
            items: (field.options || []).map((option) => ({ value: option.value ?? option.label, label: option.label, color: option.color })),
            onSelect: (value) => void applyValue(field, value),
            footer: field.required ? undefined : [{ label: i18n("common.clear"), onClick: () => void applyValue(field, null) }],
          });
          return;
        }
        if (field.type === "checkbox") {
          buildDropdown({
            parent: wrap, current: undefined,
            items: [
              { value: true as any, label: i18n("filter.op.is_checked") },
              { value: false as any, label: i18n("filter.op.is_unchecked") },
            ],
            onSelect: (value) => void applyValue(field, value),
            footer: field.required ? undefined : [{ label: i18n("common.clear"), onClick: () => void applyValue(field, null) }],
          });
          return;
        }
        if (field.type === "labels") {
          const chosen = new Set<string>();
          const options = wrap.createDiv({ cls: "it-popover-menu it-table-multi-picker" });
          for (const option of field.options || []) {
            const value = option.value ?? option.label;
            const row = options.createEl("button", { cls: "it-popover-item" });
            if (option.color) { const dot = row.createSpan({ cls: "it-dot" }); dot.style.background = option.color; }
            row.createSpan({ text: option.label });
            row.addEventListener("click", (ev) => { ev.stopPropagation(); if (chosen.has(value)) chosen.delete(value); else chosen.add(value); row.toggleClass("is-active", chosen.has(value)); });
          }
          addActions(wrap, field, () => Array.from(chosen));
          return;
        }

        const multiline = field.type === "textarea" || field.type === "markdown";
        const input = multiline
          ? wrap.createEl("textarea", { cls: "it-table-edit-input it-table-edit-textarea" })
          : wrap.createEl("input", { cls: "it-table-edit-input" });
        if (input instanceof HTMLInputElement) {
          input.type = field.type === "number" || field.type === "money" || field.type === "rating" || field.type === "progress_manual"
            ? "number" : field.type === "datetime" ? "datetime-local" : field.type;
          if (field.type === "money") input.step = "0.01";
          if (field.type === "rating") { input.min = "1"; input.max = String(field.scale || 5); input.step = "1"; }
          if (field.type === "progress_manual") { input.min = "0"; input.max = "100"; input.step = "1"; }
        }
        addActions(wrap, field, () => {
          const raw = input.value.trim();
          if (raw === "") return null;
          if (["number", "money", "rating", "progress_manual"].includes(field.type)) {
            const numeric = Number(raw);
            if (!Number.isFinite(numeric)) return null;
            if (field.type === "rating") return Math.max(1, Math.min(field.scale || 5, Math.round(numeric)));
            if (field.type === "progress_manual") return Math.max(0, Math.min(100, numeric));
            return numeric;
          }
          if (["url", "email", "phone"].includes(field.type)) return { value: raw };
          return raw;
        });
        input.focus({ preventScroll: true });
      };

      buildDropdown({
        parent: root, current: undefined,
        items: fields.map((field) => ({ value: field.id, label: field.name + (field.required ? " *" : "") })),
        onSelect: (fieldId) => { const field = fields.find((candidate) => candidate.id === fieldId); if (field) editField(field); },
      });
    });
  });

  if (plugin.index.resolveFeaturesForLocation(opts.state.location).multiple_lists !== false) {
    mkBtn(i18n("task.lists.title"), "list-plus").addEventListener("click", (e) => {
      showPopover(e.currentTarget as HTMLElement, (root) => {
        const selectedTasks = ids().map((id) => plugin.index.tasksById.get(id)).filter((task): task is TaskFile => !!task);
        const allLists = plugin.index.allLists();
        const labelForList = (list: ReturnType<typeof plugin.index.allLists>[number]) => {
          const space = list.spacePath ? plugin.index.findSpace(list.spacePath) : undefined;
          return space ? `${space.config.name} / ${list.config.name}` : list.config.name;
        };
        const addable = additionalListCandidatesForBulk(allLists, selectedTasks, "add");
        const removable = additionalListCandidatesForBulk(allLists, selectedTasks, "remove");
        const applyList = async (listPath: string, mode: "add" | "remove") => {
          closePop();
          const homePaths = new Map(selectedTasks.map((task) => [task.data.id, task.listPath]));
          await plugin.index.bulkUpdateTasks(ids(), (d) => patchAdditionalListForBulk(d, listPath, homePaths.get(d.id), mode));
        };
        const showLists = (mode: "add" | "remove") => {
          root.empty();
          const source = mode === "add" ? addable : removable;
          if (!source.length) { root.createDiv({ cls: "it-empty-row", text: i18n("picker.noOtherLists") }); return; }
          buildDropdown({
            parent: root, current: undefined,
            items: source.map((list) => ({ value: list.path, label: labelForList(list), color: list.config.color, icon: list.config.icon || "📋" })),
            onSelect: (path) => void applyList(path, mode),
          });
        };
        const menu = root.createDiv({ cls: "it-popover-menu" });
        const add = menu.createEl("button", { cls: "it-popover-item" });
        setIcon(add.createSpan({ cls: "it-popover-icon" }), "plus");
        add.createSpan({ text: i18n("common.add") });
        add.addEventListener("click", (event) => { event.stopPropagation(); showLists("add"); });
        const remove = menu.createEl("button", { cls: "it-popover-item" });
        setIcon(remove.createSpan({ cls: "it-popover-icon" }), "minus");
        remove.createSpan({ text: i18n("common.remove") });
        remove.addEventListener("click", (event) => { event.stopPropagation(); showLists("remove"); });
      });
    });
  }

  mkBtn(i18n("action.moveToList"), "folder-input").addEventListener("click", (e) => {
    showPopover(e.currentTarget as HTMLElement, (root) => {
      const lists = plugin.index.allLists();
      if (lists.length === 0) { root.createDiv({ cls: "it-empty-row", text: i18n("picker.noOtherLists") }); return; }
      buildDropdown({
        parent: root, current: undefined as any,
        items: lists.map((l) => {
          const sp = l.spacePath ? plugin.index.findSpace(l.spacePath) : undefined;
          return { value: l.path, label: sp ? `${sp.config.name} / ${l.config.name}` : l.config.name, color: l.config.color, icon: l.config.icon || "📋" };
        }),
        onSelect: async (v) => {
          closePop();
          for (const id of ids()) { try { await plugin.index.moveTask(id, v); } catch { /* skip individual failures */ } }
          selected.clear();
          opts.rerender ? opts.rerender() : renderBulkBar(bar, selected, opts);
        },
      });
    });
  });

  mkBtn(i18n("menu.duplicate"), "copy-plus").addEventListener("click", (e) => {
    showPopover(e.currentTarget as HTMLElement, (root) => {
      const lists = plugin.index.allLists().filter((list) => !list.config.system_kind);
      if (!lists.length) { root.createDiv({ cls: "it-empty-row", text: i18n("picker.noOtherLists") }); return; }
      buildDropdown({
        parent: root, current: undefined as any,
        items: lists.map((list) => {
          const space = list.spacePath ? plugin.index.findSpace(list.spacePath) : undefined;
          return { value: list.path, label: space ? `${space.config.name} / ${list.config.name}` : list.config.name, color: list.config.color, icon: list.config.icon || "📋" };
        }),
        onSelect: async (targetListPath) => {
          closePop();
          try {
            const copies = await plugin.index.copyTasks(ids(), targetListPath);
            new Notice(i18n("table.bulkCopied", { count: copies.length }));
            selected.clear();
            opts.rerender?.();
          } catch (error: any) {
            new Notice(i18n("common.failed", { msg: error?.message ?? String(error) }));
          }
        },
      });
    });
  });

  mkBtn(i18n("common.export"), "download").addEventListener("click", () => {
    const tasks = ids().map((id) => plugin.index.tasksById.get(id)).filter((task): task is TaskFile => !!task);
    const cols = ((context as any).visibleFields || []).slice();
    if (!cols.includes("title")) cols.unshift("title");
    else { cols.splice(cols.indexOf("title"), 1); cols.unshift("title"); }
    new ExportModal(plugin.app, plugin, {
      scope: "view",
      viewName: i18n("table.bulkExportName", { count: tasks.length }),
      viewTasks: tasks,
      viewCols: cols,
      viewCtx: context,
    }).open();
  });

  const inArchive = opts.state.location.kind === "archived";
  if (!inArchive) {
    const mergeBtn = mkBtn(i18n("common.merge"), "git-merge");
    mergeBtn.disabled = count < 2;
    mergeBtn.addEventListener("click", (event) => {
      const selectedTasks = ids().map((id) => plugin.index.tasksById.get(id)).filter((task): task is TaskFile => !!task);
      showPopover(event.currentTarget as HTMLElement, (root) => {
        root.createDiv({ cls: "it-calc-menu-title", text: i18n("merge.selectTarget") });
        buildDropdown({
          parent: root,
          current: undefined as any,
          items: selectedTasks.map((task) => ({
            value: task.data.id,
            label: `${task.data.title || task.data.id} · ${task.data.id}`,
            icon: task.data.icon,
            color: task.data.color,
          })),
          onSelect: (targetId) => {
            closePop();
            const target = plugin.index.tasksById.get(targetId);
            if (!target) return;
            new ConfirmModal(plugin.app, {
              title: i18n("merge.confirmTitle"),
              message: i18n("merge.confirmMessage", { count: count - 1, title: target.data.title || target.data.id }),
              confirmLabel: i18n("common.merge"),
              onConfirm: () => {
                void (async () => {
                  try {
                    const result = await plugin.index.mergeTasks(ids(), targetId);
                    new Notice(i18n("table.bulkMerged", { count: result.mergedIds.length, title: result.target.data.title || result.target.data.id }));
                    selected.clear();
                    opts.rerender?.();
                  } catch (error: any) {
                    new Notice(i18n("common.failed", { msg: error?.message ?? String(error) }));
                  }
                })();
              },
            }).open();
          },
        });
      });
    });
  }
  mkBtn(i18n(inArchive ? "common.unarchive" : "common.archive"), inArchive ? "archive-restore" : "archive").addEventListener("click", async () => {
    try {
      await plugin.index.setTasksArchived(ids(), !inArchive);
      new Notice(i18n(inArchive ? "table.bulkUnarchived" : "table.bulkArchived", { count }));
      selected.clear();
      opts.rerender?.();
    } catch (error: any) {
      new Notice(i18n("common.failed", { msg: error?.message ?? String(error) }));
    }
  });

  mkBtn(i18n("common.delete"), "trash", true).addEventListener("click", () => {
    new ConfirmModal(plugin.app, {
      title: i18n("action.deleteSelected"),
      message: i18n("common.tasks", { count }),
      destructive: true,
      confirmLabel: i18n("common.delete"),
      onConfirm: async () => {
        for (const id of ids()) { try { await plugin.index.deleteTask(id); } catch { /* skip */ } }
        selected.clear();
      },
    }).open();
  });

  const clear = bar.createEl("button", { cls: "it-btn-ghost it-btn-mini", text: i18n("common.clear"), attr: { type: "button" } });
  clear.addEventListener("click", () => { selected.clear(); opts.rerender ? opts.rerender() : renderBulkBar(bar, selected, opts); });
}

// ---------- CSV export ----------
export function csvEscape(s: string): string {
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function csvCellValue(t: TaskFile, col: string, plugin: InventTasksPlugin, context: any): string {
  const d = t.data;
  const ctx = context;
  switch (col) {
    case "title": return d.title || "";
    case "id": return d.id || "";
    case "custom_id": return d.custom_id || "";
    case "type": return d.type || "task";
    case "status": return ctx.statuses.find((s: StatusDef) => s.id === d.status)?.name || d.status || "";
    case "priority": return ctx.priorities.find((p: PriorityDef) => p.id === d.priority)?.label || "";
    case "due_date": return d.due_date || "";
    case "start_date": return d.start_date || "";
    case "created_at": return d.created_at || "";
    case "updated_at": return d.updated_at || "";
    case "tags": return (d.tags || []).join("; ");
    case "context": return (d.context || []).join("; ");
    case "time_estimate": return d.time_estimate != null ? String(d.time_estimate) : "";
    case "time_tracked": return d.time_tracked != null ? String(d.time_tracked) : "";
    case "sprint_points": return d.sprint_points != null ? String(d.sprint_points) : "";
  }
  if (col === "list" || col === "folder" || col === "space") {
    const ln = plugin.index.findList(t.listPath || "");
    if (col === "list") return ln?.config.name || d.list || "";
    if (col === "folder") {
      const f = ln?.folderPath ? plugin.index.findFolder(ln.folderPath) : undefined;
      return f?.config.name || d.folder || "";
    }
    const sp = ln?.spacePath ? plugin.index.findSpace(ln.spacePath) : undefined;
    return sp?.config.name || d.space || "";
  }
  if (col.startsWith("custom_field:")) {
    const id = col.slice(13);
    const cf = ctx.customFields?.find((c: CustomFieldDef) => c.id === id);
    if (!cf) return "";
    const raw = effectiveCustomFieldValue(t, cf, { subtaskStats: ctx.subtaskStats });
    return customFieldText(cf, raw, { taskTitles: ctx.taskTitles });
  }
  return "";
}

// ---------- Rows / cells ----------
function renderTableRow(tbody: HTMLElement, nrow: NestedRow, opts: RenderOpts, visible: string[], sel: SelCtl, toggleCollapse?: (id: string) => void, collapsed?: Set<string>) {
  const { plugin, onTaskClick } = opts;
  const t = nrow.task;
  const tr = tbody.createEl("tr", { cls: "it-table-row" + (sel.selected.has(t.data.id) ? " is-selected" : "") + (nrow.depth > 0 ? " is-subtask" : "") });
  tr.dataset.taskId = t.data.id;
  const nest = { depth: nrow.depth, hasChildren: nrow.hasChildren, collapsed: !!collapsed?.has(t.data.id), toggle: toggleCollapse };

  // Selection checkbox (frozen left)
  const selTd = tr.createEl("td", { cls: "it-table-sel-col it-table-frozen-sel" });
  const cb = selTd.createEl("input", { type: "checkbox", cls: "it-table-rowsel" });
  cb.checked = sel.selected.has(t.data.id);
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", () => {
    if (cb.checked) sel.selected.add(t.data.id); else sel.selected.delete(t.data.id);
    tr.classList.toggle("is-selected", cb.checked);
    sel.onToggle();
  });

  tr.addEventListener("click", () => onTaskClick(t));

  for (const col of visible) renderTableCell(tr, t, col, opts, nest);

  const actTd = tr.createEl("td", { cls: "it-table-actions it-table-act-col" });
  const more = actTd.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": i18n("common.more") } });
  setIcon(more, "more-horizontal");
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const items: any[] = [
      { label: i18n("action.open"), icon: "expand", onClick: () => onTaskClick(t) },
      { label: i18n("action.openMd"), icon: "file-text", onClick: () => plugin.index.openTaskInEditor(t.data.id) },
      { label: i18n("action.moveToList"), icon: "folder-input", onClick: () => new MoveTaskModal(plugin.app, plugin, t.data.id).open() },
    ];
    const loc = opts.state.location;
    if (loc.kind === "list" && t.listPath && t.listPath !== loc.path) {
      items.push({
        label: i18n("action.removeFromList"),
        icon: "x",
        onClick: () => new ConfirmModal(plugin.app, {
          title: i18n("modal.deleteConfirm"),
          message: i18n("action.removeFromList"),
          destructive: true,
          confirmLabel: i18n("common.remove"),
          onConfirm: () => plugin.index.removeTaskFromList(t.data.id, loc.path),
        }).open(),
      });
    }
    items.push("separator");
    items.push(...favoriteToggleItems(plugin, t.data.id));
    items.push("separator");
    items.push({ label: i18n("common.delete"), icon: "trash", danger: true, onClick: () => new ConfirmModal(plugin.app, { title: i18n("modal.deleteConfirm"), message: i18n("action.moveToTrash", { title: t.data.title }), destructive: true, onConfirm: () => plugin.index.deleteTask(t.data.id) }).open() });
    showContextMenu(e, items);
  });
}

function renderTableCell(tr: HTMLElement, t: TaskFile, col: string, opts: RenderOpts, nest?: { depth: number; hasChildren: boolean; collapsed: boolean; toggle?: (id: string) => void }) {
  const { plugin, context } = opts;
  switch (col) {
    case "id":
      tr.createEl("td", { text: t.data.id, cls: "it-table-id" });
      break;
    case "custom_id":
      tr.createEl("td", { text: t.data.custom_id || "", cls: "it-table-id" });
      break;
    case "type":
      {
        const td = tr.createEl("td", { cls: "it-table-meta" });
        stopCellClick(td);
        const types = plugin.index.resolveTaskTypes({ listPath: t.listPath });
        const current = types.find((tt) => tt.id === (t.data.type || "task"));
        const chip = td.createEl("button", { cls: "it-chip it-chip-tag it-table-edit-display", text: current?.name || t.data.type || "task" });
        if (current?.color) chip.style.setProperty("--chip-color", current.color);
        if (current?.icon) renderIconish(chip.createSpan({ cls: "it-group-chip-icon" }), current.icon);
        applyChipStyleByKind(chip, "task_type", (context as any).chipStyles);
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          showPopover(chip, (root) => buildDropdown({
            parent: root,
            current: t.data.type || "task",
            items: types.map((tt) => ({ value: tt.id, label: tt.name, color: tt.color, icon: tt.icon })),
            onSelect: async (v) => {
              closePopovers();
              await updateTaskPreservingTableScroll(opts, td, t.data.id, (d) => ({ data: { ...d, type: v } }));
            },
          }));
        });
      }
      break;
    case "title": {
      const titleTd = tr.createEl("td", { cls: "it-table-title it-table-title-col it-table-frozen" });
      if (t.data.status_group === "done" || t.data.status_group === "closed") titleTd.addClass("is-done");
      // Subtask presentation: indent + collapse chevron / twig (mirror of List).
      // A twig marks any subtask row (identifiable in flat mode too).
      const isSub = parentTaskIds(t.data).length > 0;
      if (nest && nest.depth > 0) titleTd.style.paddingLeft = `${4 + nest.depth * 18}px`;
      if (nest && nest.hasChildren && nest.toggle) {
        const chev = titleTd.createSpan({ cls: "it-row-subtask-toggle" });
        setIcon(chev, nest.collapsed ? "chevron-right" : "chevron-down");
        chev.addEventListener("click", (e) => { e.stopPropagation(); nest.toggle!(t.data.id); });
      } else if ((nest && nest.depth > 0) || isSub) {
        setIcon(titleTd.createSpan({ cls: "it-row-subtask-twig" }), "corner-down-right");
      }
      if (Platform.isMobile) {
        titleTd.createSpan({ text: t.data.title || i18n("common.untitled") });
      } else {
        renderDesktopTextEditableCell(titleTd, t.data.title || "", i18n("common.untitled"), "it-table-title-text", async (value) => {
          if (!value || value === t.data.title) return;
          await updateTaskPreservingTableScroll(opts, titleTd, t.data.id, (d) => ({
            data: { ...d, title: value, activity: appendActivity(d.activity, { kind: "title", from: d.title ?? null, to: value }) },
          }));
        }, () => opts.onTaskClick(t), MAX_TASK_TITLE_LENGTH);
      }
      break;
    }
    case "status": {
      const statusTd = tr.createEl("td");
      const so = context.statuses.find((s) => s.id === t.data.status);
      const chip = statusTd.createEl("button", { cls: "it-chip it-chip-status", text: so?.name || "—" });
      if (so) { chip.style.setProperty("--chip-color", so.color); chip.setAttribute("data-group", so.group); }
      applyChipStyleByKind(chip, "status", (context as any).chipStyles);
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        // Item's own effective set (not the scope union) — see list-view.
        const itemStatuses = plugin.index.resolveStatusSet(t.listPath).statuses;
        showPopover(chip, (root) => {
          buildDropdown({
            parent: root,
            current: t.data.status,
            items: itemStatuses.map((s) => ({ value: s.id, label: s.name, color: s.color })),
            onSelect: async (v) => {
              await updateTaskPreservingTableScroll(opts, statusTd, t.data.id, (d) => ({
                data: { ...d, status: v, activity: appendActivity(d.activity, { kind: "status", from: d.status ?? null, to: v }) },
              }));
              document.querySelectorAll(".it-popover").forEach((el) => el.remove());
            },
          });
        });
      });
      break;
    }
    case "priority": {
      const prioTd = tr.createEl("td");
      const pdef = t.data.priority ? context.priorities.find((p) => p.id === t.data.priority) : undefined;
      const pchip = prioTd.createEl("button", { cls: "it-chip it-chip-priority", text: pdef?.label || "—" });
      if (pdef) pchip.style.setProperty("--chip-color", pdef.color);
      applyChipStyleByKind(pchip, "priority", (context as any).chipStyles);
      pchip.addEventListener("click", (e) => {
        e.stopPropagation();
        showPopover(pchip, (root) => {
          buildDropdown({
            parent: root,
            current: t.data.priority,
            items: [
              ...context.priorities.map((p) => ({ value: p.id as any, label: p.label, color: p.color })),
              { value: null as any, label: i18n("action.noPriority") },
            ],
            onSelect: async (v) => {
              await updateTaskPreservingTableScroll(opts, prioTd, t.data.id, (d) => ({ data: { ...d, priority: v ?? null } }));
              document.querySelectorAll(".it-popover").forEach((el) => el.remove());
            },
          });
        });
      });
      break;
    }
    case "due_date": {
      const td = tr.createEl("td");
      renderInlineDateTimeInput(td, "datetime", t.data.due_date, (value) => {
        void updateTaskPreservingTableScroll(opts, td, t.data.id, (d) => ({ data: { ...d, due_date: value } }));
      });
      break;
    }
    case "start_date": {
      const td = tr.createEl("td");
      renderInlineDateTimeInput(td, "datetime", t.data.start_date, (value) => {
        void updateTaskPreservingTableScroll(opts, td, t.data.id, (d) => ({ data: { ...d, start_date: value } }));
      });
      break;
    }
    case "tags": {
      const td = tr.createEl("td");
      const wrap = td.createDiv({ cls: "it-table-tags" });
      const tagsPalette = plugin.index.resolveTagsPalette({ listPath: t.listPath });
      renderTagsCell(wrap, t.data.tags || [], tagsPalette, 2, (context as any).chipStyles);
      if (!(t.data.tags || []).length) wrap.createSpan({ cls: "it-table-add-placeholder", text: "+ tag" });
      td.addClass("it-table-editable");
      stopCellClick(td);
      td.addEventListener("click", (e) => {
        e.stopPropagation();
        const map = new Map<string, { value: string; label: string; color?: string }>();
        for (const tag of tagsPalette) map.set(tag.name, { value: tag.name, label: tag.name, color: tag.color });
        for (const tag of t.data.tags || []) if (!map.has(tag)) map.set(tag, { value: tag, label: tag });
        renderOptionMultiPicker(td, t.data.tags || [], Array.from(map.values()), async (values) => {
          await updateTaskPreservingTableScroll(opts, td, t.data.id, (d) => ({ data: { ...d, tags: values } }));
        });
      });
      break;
    }
    case "context": {
      const td = tr.createEl("td");
      const wrap = td.createDiv({ cls: "it-table-tags" });
      const labels = plugin.index.resolveContextLabels({ listPath: t.listPath });
      const colorByName: Record<string, string> = {};
      for (const cl of labels) colorByName[cl.name] = cl.color;
      for (const cl of (t.data.context || [])) {
        const chip = wrap.createSpan({ cls: "it-chip it-chip-tag", text: cl });
        if (colorByName[cl]) chip.style.setProperty("--chip-color", colorByName[cl]);
        applyChipStyleByKind(chip, "context", (context as any).chipStyles);
      }
      if (!(t.data.context || []).length) wrap.createSpan({ cls: "it-table-add-placeholder", text: "+ context" });
      td.addClass("it-table-editable");
      stopCellClick(td);
      td.addEventListener("click", (e) => {
        e.stopPropagation();
        renderOptionMultiPicker(td, t.data.context || [], labels.map((cl) => ({ value: cl.name, label: cl.name, color: cl.color })), async (values) => {
          await updateTaskPreservingTableScroll(opts, td, t.data.id, (d) => ({ data: { ...d, context: values } }));
        });
      });
      break;
    }
    case "time_estimate": {
      const td = tr.createEl("td");
      renderNumericEditor(td, t.data.time_estimate, (n) => {
        void updateTaskPreservingTableScroll(opts, td, t.data.id, (d) => ({ data: { ...d, time_estimate: n } }));
      }, { min: "0", step: "1", mobilePopover: true, wholeNonNegative: true });
      break;
    }
    case "time_tracked": {
      const td = tr.createEl("td");
      renderNumericEditor(td, t.data.time_tracked, (n) => {
        void updateTaskPreservingTableScroll(opts, td, t.data.id, (d) => ({ data: { ...d, time_tracked: n } }));
      }, { min: "0", step: "1", mobilePopover: true, wholeNonNegative: true });
      break;
    }
    case "sprint_points": {
      const td = tr.createEl("td");
      renderNumericEditor(td, t.data.sprint_points, (n) => {
        void updateTaskPreservingTableScroll(opts, td, t.data.id, (d) => ({ data: { ...d, sprint_points: n } }));
      }, { min: "0", step: "1", mobilePopover: true, wholeNonNegative: true });
      break;
    }
    case "list": {
      const td = tr.createEl("td", { cls: "it-table-meta" });
      renderListReference(td, t, opts.plugin.index, "list");
      break;
    }
    case "folder": {
      const td = tr.createEl("td", { cls: "it-table-meta" });
      renderListReference(td, t, opts.plugin.index, "folder");
      break;
    }
    case "space": {
      const td = tr.createEl("td", { cls: "it-table-meta" });
      renderListReference(td, t, opts.plugin.index, "space");
      break;
    }
    case "created_at":
      tr.createEl("td", { text: (t.data.created_at || "").slice(0, 16).replace("T", " "), cls: "it-table-meta" });
      break;
    case "updated_at":
      tr.createEl("td", { text: (t.data.updated_at || "").slice(0, 16).replace("T", " "), cls: "it-table-meta" });
      break;
    default:
      if (col.startsWith("custom_field:")) {
        const id = col.slice(13);
        const cf = ((opts.context as any).customFields as CustomFieldDef[] | undefined)?.find((c) => c.id === id);
        const td = tr.createEl("td", { cls: "it-table-meta it-table-cf" });
        if (cf) {
          renderCustomFieldEditor(td, t, cf, opts);
        }
      } else {
        tr.createEl("td", { text: "", cls: "it-table-meta" });
      }
  }
}
