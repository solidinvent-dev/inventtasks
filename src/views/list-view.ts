import { Notice, Platform, setIcon } from "obsidian";
import { showContextMenu, type MenuItem } from "../ui/menu";
import type InventTasksPlugin from "../main";
import { favoriteToggleItems } from "./favorites";
import { TaskFile, TaskData, PriorityId, CustomFieldDef, parentTaskIds } from "../types";
import { renderCustomFieldValue } from "../ui/cf-render";
import { appendActivity } from "../data/activity";
import { pickCheckboxCheckedStatus, pickCheckboxUncheckedStatus, type CheckboxAction } from "../data/status-helpers";
import { ViewState } from "./main-view";
import { groupTasks, GroupBucket } from "../data/filters";
import { buildSubtaskTree, flattenSubtaskRows, SubtaskTree, NestedRow, maxSubtaskDepth } from "../data/subtasks";
import { statusChip, priorityChip, renderTagsCell, showPopover, buildDropdown, applyChipStyleByKind, chipKindForGroupBy, renderGroupHeaderChip, renderListReference } from "../ui/components";
import { QuickTaskModal, type QuickTaskOptions } from "../modals/create-modals";
import { t as tr, fieldLabel, fieldLabelFrom } from "../i18n";
import { ConfirmModal } from "../modals/confirm-modal";
import { MoveTaskModal } from "../modals/move-modal";
import { TaskModal } from "../modals/task-modal";
import { renderIconish, renderFieldIcon } from "../ui/icons";
import { fillCalcCell, hasAnyCalc, openCalcMenu, persistColumnCalcs, type RowViewContext } from "./column-calc";
import { fireAndForget } from "../utils/async";
import { effectiveCustomFieldValue } from "../data/custom-fields";
import { renderDateTimeInput, type DateTimeInputHandle, type DateTimeInputKind } from "../ui/datetime-field";
import { groupCollapseKey } from "../view-state";
import { MAX_TASK_TITLE_LENGTH, parseNonNegativeInteger } from "../data/task-values";

interface RenderOpts {
  parent: HTMLElement;
  tasks: TaskFile[];
  state: ViewState;
  plugin: InventTasksPlugin;
  onTaskClick: (t: TaskFile) => void;
  context: RowViewContext;
  // Re-render the view body (e.g. after changing a column calculation).
  rerender?: () => void;
  onToggleGroup?: (bucketKey: string) => void;
}

// Transient bookkeeping the List view stashes on the view state between renders.
interface ListStateExtras {
  __listScrollLeft?: number;
  __listScrollTop?: number;
  __listRenderedCount?: number;
  __collapsedSubtasks?: Set<string>;
}

// Lazy-render observer kept on the scroll container across re-renders.
interface ListScroller extends HTMLElement {
  __itListIO?: IntersectionObserver;
}

type TaskMutator = (data: TaskData, body: string) => { data: TaskData; body?: string } | void;
type QuickTaskPreset = NonNullable<QuickTaskOptions["preset"]>;

function rememberListScroll(opts: RenderOpts, source?: HTMLElement) {
  const wrap = source?.closest(".it-list-wrap") as HTMLElement | null;
  if (!wrap) return;
  (opts.state as ListStateExtras).__listScrollLeft = wrap.scrollLeft;
  (opts.state as ListStateExtras).__listScrollTop = wrap.scrollTop;
}

function restoreListScroll(opts: RenderOpts) {
  const left = Number((opts.state as ListStateExtras).__listScrollLeft);
  const top = Number((opts.state as ListStateExtras).__listScrollTop);
  if (!Number.isFinite(left) && !Number.isFinite(top)) return;
  const apply = () => {
    const wrap = opts.parent.querySelector<HTMLElement>(".it-list-wrap");
    if (!wrap) return;
    if (Number.isFinite(left)) wrap.scrollLeft = left;
    if (Number.isFinite(top)) wrap.scrollTop = top;
  };
  apply();
  window.requestAnimationFrame(apply);
}

async function updateTaskPreservingListScroll(
  opts: RenderOpts,
  source: HTMLElement | undefined,
  taskId: string,
  fn: TaskMutator,
) {
  rememberListScroll(opts, source);
  await opts.plugin.index.updateTask(taskId, fn);
  restoreListScroll(opts);
}

function renderInlineDateTimeInput(
  parent: HTMLElement,
  kind: DateTimeInputKind,
  value: unknown,
  onCommit: (value: string | null, handle: DateTimeInputHandle) => void,
): DateTimeInputHandle {
  return renderDateTimeInput({
    parent,
    kind,
    value,
    onCommit,
    pairClass: "it-inline-datetime-pair",
    dateClass: "it-inline-datetime it-inline-kind-date",
    timeClass: "it-inline-datetime it-inline-kind-time",
    singleClass: (k) => `it-inline-datetime it-inline-kind-${k}`,
    stopClick: true,
  });
}

async function updateCustomFieldValue(opts: RenderOpts, task: TaskFile, field: CustomFieldDef, value: unknown, handle?: DateTimeInputHandle, source?: HTMLElement) {
  if (field.required && (value === null || value === undefined || value === "")) {
    new Notice(tr("task.notice.requiredField", { name: field.name }));
    handle?.reset(task.data.custom_fields?.[field.id]);
    return;
  }
  await updateTaskPreservingListScroll(opts, source, task.data.id, (d) => {
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
  cell: HTMLElement,
  value: string,
  placeholder: string,
  multiline: boolean,
  onCommit: (value: string | null) => void,
  displayClass?: string,
  maxLength?: number,
) {
  cell.empty();
  const input = multiline
    ? cell.createEl("textarea", { cls: "it-table-edit-input it-table-edit-textarea", attr: { placeholder } })
    : cell.createEl("input", { type: "text", cls: "it-table-edit-input", attr: { placeholder } });
  input.value = value;
  if (maxLength != null) input.maxLength = maxLength;
  stopCellClick(input);
  let done = false;
  let cleanupOutsideCommit: (() => void) | null = null;
  const restoreLabel = (text: string | null) => {
    cell.empty();
    if (displayClass) {
      const lbl = cell.createSpan({ cls: displayClass, text: text || placeholder });
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
  cell: HTMLElement,
  value: string,
  placeholder: string,
  displayClass: string,
  onCommit: (value: string | null) => void,
  onSingleClick?: () => void,
  maxLength?: number,
) {
  cell.addClass("it-table-editable");
  stopCellClick(cell);
  const label = cell.createSpan({ cls: displayClass, text: value || placeholder });
  if (!value) label.addClass("is-empty");
  let clickTimer: number | null = null;
  if (onSingleClick) {
    cell.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (clickTimer != null) window.clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => {
        clickTimer = null;
        onSingleClick();
      }, 180);
    });
  }
  cell.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (clickTimer != null) {
      window.clearTimeout(clickTimer);
      clickTimer = null;
    }
    renderInlineTextEditor(cell, value, placeholder, false, onCommit, displayClass, maxLength);
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
    actions.createEl("button", { cls: "it-btn-secondary it-btn-mini", text: tr("common.clear") }).addEventListener("click", (e) => {
      e.stopPropagation();
      closePopovers();
      onCommit(null);
    });
    actions.createEl("button", { cls: "it-btn-primary it-btn-mini", text: tr("common.set") }).addEventListener("click", (e) => {
      e.stopPropagation();
      closePopovers();
      onCommit(input.value.trim() || null);
    });
    input.focus({ preventScroll: true });
  });
}

function renderNumericEditor(
  cell: HTMLElement,
  value: number | undefined,
  onCommit: (value: number | undefined) => void,
  opts: { min?: string; max?: string; step?: string; mobilePopover?: boolean; wholeNonNegative?: boolean } = {},
) {
  const current = value != null ? String(value) : "";
  if (Platform.isMobile && opts.mobilePopover) {
    cell.addClass("it-table-editable");
    stopCellClick(cell);
    const btn = cell.createEl("button", { cls: "it-table-edit-display it-table-num", text: current || "—" });
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

  const input = cell.createEl("input", { type: "number", cls: "it-table-num" });
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

function renderProgressEditor(cell: HTMLElement, value: number | undefined, onCommit: (value: number | undefined) => void) {
  cell.addClass("it-table-editable");
  stopCellClick(cell);
  const current = Math.max(0, Math.min(100, Math.round(value ?? 0)));
  const trigger = renderProgressDisplay(cell, current, true);
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
      menu.createDiv({ cls: "it-empty-row", text: tr("filter.noOptions") });
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
      menu.createEl("button", { cls: "it-popover-item it-popover-footer-item", text: tr("common.clear") }).addEventListener("click", (e) => {
        e.stopPropagation();
        selected.clear();
        onChange([]);
        renderRows();
      });
    };
    renderRows();
  });
}

function renderTaskModalCell(cell: HTMLElement, task: TaskFile, opts: RenderOpts, field: CustomFieldDef, raw: unknown) {
  cell.addClass("it-table-editable");
  renderCustomFieldValue(cell, field, raw, { task, index: opts.plugin.index, mode: "list", chipStyles: opts.context.chipStyles, subtaskStats: opts.context.subtaskStats });
  if (!cell.textContent?.trim()) cell.createSpan({ cls: "it-table-edit-display is-empty", text: "—" });
  cell.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    new TaskModal(opts.plugin.app, opts.plugin, task).open();
  });
}

function renderEmptyModalCell(cell: HTMLElement, task: TaskFile, opts: RenderOpts) {
  cell.addClass("it-table-editable");
  cell.createSpan({ cls: "it-table-edit-display is-empty", text: "—" });
  cell.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    new TaskModal(opts.plugin.app, opts.plugin, task).open();
  });
}

function openDocFromList(opts: RenderOpts, docPath: string | undefined) {
  if (!docPath) return;
  const mv = opts.plugin.getMainView?.();
  if (mv) mv.openDocLocation(docPath);
  else void opts.plugin.activateView().then(() => opts.plugin.getMainView()?.openDocLocation(docPath));
}

function renderRelationshipLinks(cell: HTMLElement, task: TaskFile, _field: CustomFieldDef, opts: RenderOpts, raw: unknown) {
  const ids = Array.isArray(raw) ? (raw as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (!ids.length) { renderEmptyModalCell(cell, task, opts); return; }
  for (const id of ids.slice(0, 3)) {
    const linked = opts.plugin.index.tasksById.get(id);
    const label = linked ? (linked.data.title || id) : id;
    const chip = cell.createEl("button", { cls: "it-chip it-chip-link it-cf-display" });
    chip.createSpan({ cls: "it-chip-link-title", text: label });
    chip.setAttribute("title", linked ? `${label} (${id})` : id);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (linked) opts.onTaskClick(linked);
    });
  }
  if (ids.length > 3) cell.createSpan({ cls: "it-chip it-chip-meta it-cf-display", text: `+${ids.length - 3}` });
}

function renderDocRelationshipLinks(cell: HTMLElement, task: TaskFile, _field: CustomFieldDef, opts: RenderOpts, raw: unknown) {
  const ids = Array.isArray(raw) ? (raw as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (!ids.length) { renderEmptyModalCell(cell, task, opts); return; }
  for (const id of ids.slice(0, 3)) {
    const doc = opts.plugin.index.docById(id);
    const label = doc ? doc.name : id;
    const chip = cell.createEl("button", { cls: "it-chip it-chip-link it-cf-display" });
    chip.createSpan({ cls: "it-chip-link-title", text: label });
    chip.setAttribute("title", label);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      openDocFromList(opts, doc?.__path);
    });
  }
  if (ids.length > 3) cell.createSpan({ cls: "it-chip it-chip-meta it-cf-display", text: `+${ids.length - 3}` });
}

// Rating and progress widgets carry their own hover, so their cell keeps a
// flat background (`.it-cf-flat-hover`; stands in for a CSS :has()).
const LIST_FLAT_HOVER_WIDGETS = ".it-cf-rating-edit, .it-table-progress, .it-cf-progress";

function renderCustomFieldEditor(cell: HTMLElement, task: TaskFile, field: CustomFieldDef, opts: RenderOpts) {
  renderCustomFieldEditorContent(cell, task, field, opts);
  cell.toggleClass("it-cf-flat-hover", !!cell.querySelector(LIST_FLAT_HOVER_WIDGETS));
}

function renderCustomFieldEditorContent(cell: HTMLElement, task: TaskFile, field: CustomFieldDef, opts: RenderOpts) {
  const raw = task.data.custom_fields?.[field.id];
  const renderReadonly = () => {
    renderCustomFieldValue(cell, field, raw, {
      task,
      index: opts.plugin.index,
      mode: "list",
      chipStyles: opts.context.chipStyles,
      subtaskStats: opts.context.subtaskStats,
    });
  };

  if (field.type === "date" || field.type === "time" || field.type === "datetime") {
    renderInlineDateTimeInput(cell, field.type, raw, (value, input) => {
      void updateCustomFieldValue(opts, task, field, value, input, cell);
    });
    return;
  }

  if (field.type === "url" || field.type === "email" || field.type === "phone" || field.type === "location") {
    if (raw) renderReadonly();
    else renderEmptyModalCell(cell, task, opts);
    return;
  }

  if (field.type === "relationship") {
    renderRelationshipLinks(cell, task, field, opts, raw);
    return;
  }

  if (field.type === "doc_relationship") {
    renderDocRelationshipLinks(cell, task, field, opts, raw);
    return;
  }

  if (field.type === "text") {
    const value = String((raw as string | null | undefined) ?? "");
    if (Platform.isMobile) {
      cell.addClass("it-table-editable");
      stopCellClick(cell);
      renderReadonly();
      if (!cell.textContent?.trim()) cell.createSpan({ cls: "it-table-edit-display is-empty", text: "—" });
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        renderValuePopover(cell, value, { placeholder: field.name }, (next) => void updateCustomFieldValue(opts, task, field, next, undefined, cell));
      });
    } else {
      renderDesktopTextEditableCell(cell, value, "—", "it-cf-display it-cf-text", (next) => void updateCustomFieldValue(opts, task, field, next, undefined, cell));
    }
    return;
  }

  if (field.type === "textarea") {
    cell.addClass("it-table-editable");
    stopCellClick(cell);
    renderReadonly();
    if (!cell.textContent?.trim()) cell.createSpan({ cls: "it-table-edit-display is-empty", text: "—" });
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      renderValuePopover(cell, String((raw as string | null | undefined) ?? ""), { textarea: true, placeholder: field.name }, (next) => void updateCustomFieldValue(opts, task, field, next, undefined, cell));
    });
    return;
  }

  if (field.type === "number" || field.type === "money") {
    renderNumericEditor(cell, raw != null ? Number(raw) : undefined, (n) => {
      void updateCustomFieldValue(opts, task, field, n, undefined, cell);
    }, { step: field.type === "money" ? "0.01" : "1", mobilePopover: true });
    return;
  }

  if (field.type === "checkbox") {
    stopCellClick(cell);
    const cb = cell.createEl("input", { type: "checkbox", cls: "it-table-checkbox" });
    cb.checked = !!raw;
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => void updateCustomFieldValue(opts, task, field, cb.checked, undefined, cell));
    return;
  }

  if (field.type === "dropdown") {
    cell.addClass("it-table-editable");
    stopCellClick(cell);
    const current = String((raw as string | null | undefined) ?? "");
    const opt = field.options?.find((o) => (o.value ?? o.label) === current || o.label === current);
    const chip = cell.createEl("button", { cls: "it-chip it-chip-tag it-table-edit-display", text: opt?.label || (current || "—") });
    if (opt?.color) chip.style.setProperty("--chip-color", opt.color);
    applyChipStyleByKind(chip, "custom_field", opts.context.chipStyles);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      showPopover(chip, (root) => buildDropdown<string | null>({
        parent: root,
        current: (raw as string | null | undefined) ?? null,
        items: [
          ...(field.options || []).map((o) => ({ value: o.value ?? o.label, label: o.label, color: o.color })),
          { value: null, label: "—" },
        ],
        onSelect: (v) => {
          closePopovers();
          void updateCustomFieldValue(opts, task, field, v, undefined, cell);
        },
      }));
    });
    return;
  }

  if (field.type === "labels") {
    cell.addClass("it-table-editable");
    stopCellClick(cell);
    renderReadonly();
    if (!cell.textContent?.trim()) cell.createSpan({ cls: "it-table-edit-display is-empty", text: "—" });
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      const scalar = raw as string | number | boolean | null | undefined;
      const selected = Array.isArray(raw) ? raw.map(String) : scalar ? [String(scalar)] : [];
      renderOptionMultiPicker(cell, selected, (field.options || []).map((o) => ({ value: o.value ?? o.label, label: o.label, color: o.color })), (values) => {
        void updateCustomFieldValue(opts, task, field, values, undefined, cell);
      });
    });
    return;
  }

  if (field.type === "rating") {
    stopCellClick(cell);
    const scale = Math.max(1, field.scale || 5);
    const icon = field.icon || "★";
    const value = Math.max(0, Math.min(scale, Number(raw) || 0));
    const wrap = cell.createSpan({ cls: "it-cf-rating-edit" });
    for (let i = 1; i <= scale; i++) {
      const btn = wrap.createEl("button", { cls: "it-cf-rating-btn" + (i <= value ? " is-on" : ""), text: icon });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        void updateCustomFieldValue(opts, task, field, value === i ? null : i, undefined, cell);
      });
    }
    return;
  }

  if (field.type === "progress_manual") {
    renderProgressEditor(cell, raw != null ? Number(raw) : undefined, (n) => {
      void updateCustomFieldValue(opts, task, field, n, undefined, cell);
    });
    return;
  }

  if (field.type === "progress_auto") {
    const resolved: unknown = effectiveCustomFieldValue(task, field, { subtaskStats: opts.context.subtaskStats, allTasks: opts.context.subtaskStats ? undefined : opts.plugin.index.allTasks() });
    renderProgressDisplay(cell, Number(resolved) || 0, false);
    return;
  }

  renderTaskModalCell(cell, task, opts, field, raw);
}

// Fields that are part of the "title cluster" — they render inside the title
// cell (checkbox + type icon to its left; id/custom_id prefix; subtask /
// relationship badges after the text) rather than as their own reorderable
// column. Everything else becomes an ordered column driven by visible_fields.
const TITLE_CLUSTER = new Set([
  "title", "checkbox", "type_icon", "id", "custom_id",
  "subtask_count", "relationship_count",
]);

function listColLabel(field: string, labels?: Record<string, string>): string {
  // A custom display name (from field_labels) always wins — even over the
  // compact short header — so a renamed field reads consistently everywhere.
  const custom = labels && labels[field];
  if (typeof custom === "string" && custom) return custom;
  switch (field) {
    case "due_date": return tr("col.due");
    case "start_date": return tr("col.start");
    case "time_estimate": return tr("col.est");
    case "time_tracked": return tr("col.tracked");
    case "sprint_points": return tr("col.pts");
    default: return fieldLabel(field);
  }
}

function isVisible(opts: RenderOpts, field: string): boolean {
  return opts.context.visibleFields.includes(field);
}

// Grid line name for a field's column. Built-in field keys are already valid
// CSS idents (letters/underscore); custom fields get a `cf-` prefix on the
// escaped id. The same function feeds both the grid-template-columns line
// names and each cell's `grid-column`, so they always line up.
function colLine(field: string): string {
  if (field.startsWith("custom_field:")) return `cf-${cssEscape(field.slice("custom_field:".length))}`;
  return cssEscape(field);
}

// The ordered list of property columns derived from visible_fields: the user's
// order, minus the title-cluster fields, minus custom fields that no longer
// resolve (deleted CF definitions would otherwise reserve an empty column).
function orderedColumns(opts: RenderOpts): string[] {
  const customFields = (opts.context.customFields as Array<{ id: string }>) || [];
  const cfExists = (id: string) => customFields.some((cf) => cf.id === id);
  return opts.context.visibleFields.filter((f) => {
    if (TITLE_CLUSTER.has(f)) return false;
    if (f.startsWith("custom_field:")) return cfExists(f.slice("custom_field:".length));
    return true;
  });
}

export function renderListView(opts: RenderOpts) {
  const { parent, tasks, state, plugin, context } = opts;
  parent.addClass("it-list-view");

  // Tear down any lazy-render observer from a previous render into this same
  // scroll container (refreshContent reuses the body element). Done before the
  // empty-state early return so a now-empty list doesn't leave one dangling.
  const scroller = parent;
  (scroller as ListScroller).__itListIO?.disconnect?.();
  (scroller as ListScroller).__itListIO = undefined;

  if (tasks.length === 0) {
    parent.createDiv({ cls: "it-empty-state-small", text: tr("list.noTasks") });
    if (state.location.kind === "list") {
      const cta = parent.createEl("button", { cls: "it-btn-primary", text: tr("list.newTask") });
      cta.addEventListener("click", () => new QuickTaskModal(plugin.app, plugin, (state.location as { path: string }).path).open());
    }
    return;
  }

  // Nested mode: group only the ROOTS (a parent + its subtasks stay together in
  // the parent's group), then expand each root's subtree under it. Flat/parents
  // mode groups the whole set (subtasks already excluded upstream for parents).
  const nested = context.subtaskMode === "nested";
  const tree: SubtaskTree | null = nested ? buildSubtaskTree(tasks) : null;
  const collapsed: Set<string> = ((state as ListStateExtras).__collapsedSubtasks ||= new Set<string>());
  const groupSource = nested ? tree!.roots : tasks;

  const buckets = state.groupBy
    ? groupTasks(groupSource, state.groupBy, {
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
      })
    : [{ key: "__all", label: tr("list.tasks"), tasks: groupSource } as GroupBucket];

  // Per-bucket display rows (depth-annotated). Flat: each task at depth 0.
  // Nested: DFS expand each root in the bucket (collapsed parents hide kids).
  const subDepth = maxSubtaskDepth(plugin.index.resolveFeaturesForLocation(state.location));
  const rowsFor = (bucket: GroupBucket): NestedRow[] =>
    tree ? flattenSubtaskRows(bucket.tasks, tree, collapsed, subDepth)
         : bucket.tasks.map((t) => ({ task: t, depth: 0, hasChildren: false }));

  const cols = orderedColumns(opts);

  const wrap = parent.createDiv({ cls: "it-list-wrap" });
  wrap.addEventListener("scroll", () => {
    (state as ListStateExtras).__listScrollLeft = wrap.scrollLeft;
    (state as ListStateExtras).__listScrollTop = wrap.scrollTop;
  });
  const rememberedLeft = Number((state as ListStateExtras).__listScrollLeft);
  const rememberedTop = Number((state as ListStateExtras).__listScrollTop);
  if (Number.isFinite(rememberedLeft)) wrap.scrollLeft = rememberedLeft;
  if (Number.isFinite(rememberedTop)) wrap.scrollTop = rememberedTop;
  window.requestAnimationFrame(() => {
    if (Number.isFinite(rememberedLeft)) wrap.scrollLeft = rememberedLeft;
    if (Number.isFinite(rememberedTop)) wrap.scrollTop = rememberedTop;
  });
  const grid = wrap.createDiv({ cls: "it-list-grid" });

  // Build the grid template from the leading cluster + ordered property
  // columns. This is what makes column ordering actually follow the user's
  // visible_fields order (previously the template was fixed, so reordering in
  // View defaults had no visible effect).
  const tracks: string[] = [];
  if (isVisible(opts, "checkbox")) tracks.push("[check] max-content");
  if (isVisible(opts, "type_icon")) tracks.push("[type] max-content");
  tracks.push("[title] minmax(240px, 1fr)");
  for (const f of cols) tracks.push(`[${colLine(f)}] max-content`);
  tracks.push("[actions] max-content");
  grid.style.gridTemplateColumns = tracks.join(" ");

  // Flatten the grouped buckets into one ordered item list. Rendering it
  // incrementally (initial screenful + lazy chunks via IntersectionObserver)
  // means a 1000+ task list paints instantly instead of building every row
  // synchronously up front. Group-card rounding (.it-card-end / :last-child)
  // keeps working because items are appended in document order.
  type ListItem =
    | { kind: "group"; bucket: GroupBucket }
    | { kind: "colhead" }
    | { kind: "row"; row: NestedRow }
    | { kind: "groupsummary"; tasks: TaskFile[] }
    | { kind: "grandsummary" };
  const showGroupSummaries = !!state.groupBy && hasAnyCalc(state.columnCalcs?.list);
  const collapsedGroups = new Set(state.collapsedGroups?.list || []);
  const items: ListItem[] = [];
  for (const bucket of buckets) {
    const rows = rowsFor(bucket);
    items.push({ kind: "group", bucket });
    if (state.groupBy && collapsedGroups.has(groupCollapseKey(state.groupBy, bucket.key))) continue;
    items.push({ kind: "colhead" });
    for (const r of rows) items.push({ kind: "row", row: r });
    if (showGroupSummaries) items.push({ kind: "groupsummary", tasks: rows.map((r) => r.task) });
  }
  // Grand summary over all rows — always present (it's also the surface for
  // configuring per-column calculations).
  items.push({ kind: "grandsummary" });

  // Toggling a parent's collapse re-renders the body.
  const toggleCollapse = (id: string) => {
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    opts.rerender?.();
  };

  // The row or column header right before a group header or the grand total
  // closes its card (rounded bottom corners). Items are appended in order, so
  // the previous child is final when the next group starts; the lazy-render
  // sentinel may sit in between and is skipped.
  const closeCardBeforeNext = () => {
    let prev = grid.lastElementChild;
    if (prev?.hasClass("it-list-sentinel")) prev = prev.previousElementSibling;
    if (prev && (prev.hasClass("it-row") || prev.hasClass("it-list-col-header"))) prev.addClass("it-card-end");
  };

  let next = 0;
  const renderChunk = (count: number) => {
    const end = Math.min(items.length, next + count);
    for (; next < end; next++) {
      const it = items[next];
      if (it.kind === "group" || it.kind === "grandsummary") closeCardBeforeNext();
      if (it.kind === "group") renderGroupHeader(grid, it.bucket, opts, cols);
      else if (it.kind === "colhead") renderColumnHeader(grid, opts, cols);
      else if (it.kind === "groupsummary") renderSummaryRow(grid, opts, cols, it.tasks, "group");
      else if (it.kind === "grandsummary") renderSummaryRow(grid, opts, cols, tasks, "grand");
      else renderRow(grid, it.row, opts, cols, toggleCollapse, collapsed);
    }
    // Remember how far we've rendered so a data-driven re-render (e.g. ticking
    // a checkbox while scrolled deep) restores the same extent, letting the
    // main view's scroll preservation land where the user was.
    (state as ListStateExtras).__listRenderedCount = next;
  };

  const VIRTUAL_THRESHOLD = 120;
  if (items.length <= VIRTUAL_THRESHOLD) {
    renderChunk(items.length);
    return;
  }

  // Initial extent: a screenful, or however far we'd rendered before a refresh.
  const prev = Number((state as ListStateExtras).__listRenderedCount) || 0;
  renderChunk(Math.min(items.length, Math.max(80, prev)));

  if (next < items.length) {
    const sentinel = grid.createDiv({ cls: "it-list-sentinel" });
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      renderChunk(60);
      if (next >= items.length) {
        io.disconnect();
        sentinel.remove();
        (scroller as ListScroller).__itListIO = undefined;
      } else {
        grid.appendChild(sentinel); // keep the sentinel as the last child
      }
    }, { root: scroller, rootMargin: "0px 0px 900px 0px" });
    io.observe(sentinel);
    (scroller as ListScroller).__itListIO = io;
  }
}

// Renders one group's header row (styled chip + count + inline "+ Task").
function renderGroupHeader(grid: HTMLElement, bucket: GroupBucket, opts: RenderOpts, _cols: string[]) {
  const { plugin, context, state } = opts;
  const header = grid.createDiv({ cls: "it-group-header" });
  // Inner wrapper holds the label/count/actions and is sticky-left (see CSS) so
  // the group identity stays visible while scrolling the columns horizontally.
  // The header itself spans the full grid width, so it can't stick on its own.
  const inner = header.createDiv({ cls: "it-group-header-inner" });
  if (state.groupBy) {
    const collapsed = new Set(state.collapsedGroups?.list || []).has(groupCollapseKey(state.groupBy, bucket.key));
    if (collapsed) header.addClass("is-collapsed");
    const toggle = inner.createEl("button", {
      cls: "it-icon-btn it-icon-btn-mini it-group-collapse-btn",
      attr: { type: "button", "aria-label": tr(collapsed ? "action.expandGroup" : "action.collapseGroup") },
    });
    setIcon(toggle, collapsed ? "chevron-right" : "chevron-down");
    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      opts.onToggleGroup?.(bucket.key);
    });
  }
  const kind = chipKindForGroupBy(state.groupBy, (id) =>
    context.customFields?.find((f) => f.id === id)?.type,
  );
  renderGroupHeaderChip(inner, bucket, kind, context.chipStyles);
  inner.createSpan({ text: `${bucket.tasks.length}`, cls: "it-group-count" });
  // Actions sit on the RIGHT (direct child of the header, not the left cluster)
  // and are sticky-right so "+ Task" stays visible during horizontal scroll.
  const headerActions = header.createDiv({ cls: "it-group-actions" });
  const addBtn = headerActions.createEl("button", {
    cls: "it-btn-ghost-mini it-group-add-btn",
    text: tr("list.addTask"),
    attr: { type: "button" },
  });
  addBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const preset = computeBucketDefaults(bucket.key, state.groupBy, context);
    const modalOpts: QuickTaskOptions = { preset };
    const loc = state.location;
    if (loc.kind === "list") modalOpts.listPath = loc.path;
    else if (loc.kind === "folder") modalOpts.scopeFolderPath = loc.path;
    else if (loc.kind === "space") modalOpts.scopeSpacePath = loc.path;
    new QuickTaskModal(plugin.app, plugin, modalOpts).open();
  });
}

function renderColumnHeader(grid: HTMLElement, opts: RenderOpts, cols: string[]) {
  const head = grid.createDiv({ cls: "it-list-col-header it-subgrid-row" });

  const customFields = opts.context.customFields || [];
  const cfFor = (field: string): CustomFieldDef | undefined =>
    field.startsWith("custom_field:") ? customFields.find((c) => c.id === field.slice("custom_field:".length)) : undefined;
  const fieldLabels = opts.context.fieldLabels;
  const labelFor = (field: string): string => {
    const cf = cfFor(field);
    if (cf) return cf.name || field.slice("custom_field:".length);
    return listColLabel(field, fieldLabels);
  };

  const showIcons = !!opts.context.showFieldIcons;
  const add = (gridCol: string, field: string, label: string) => {
    const cell = head.createDiv({ cls: "it-list-col-header-cell" });
    cell.style.gridColumn = gridCol;
    if (showIcons) renderFieldIcon(cell, field, customFields); // colored field-type icon
    cell.createSpan({ text: label });
  };

  // Skip checkbox/type — they're decorative icons without a meaningful header.
  add("title", "title", fieldLabelFrom(fieldLabels, "title"));
  for (const f of cols) add(colLine(f), f, labelFor(f));
}

// Renders a calculation summary row spanning the grid (subgrid). `mode`:
//   "grand" → totals over all rows; cells are clickable to configure the
//             per-column calculation (and show a short label + value).
//   "group" → per-group totals; read-only, value only.
function renderSummaryRow(grid: HTMLElement, opts: RenderOpts, cols: string[], tasks: TaskFile[], mode: "grand" | "group") {
  const { plugin, context, state } = opts;
  const calcs = state.columnCalcs?.list || {};
  const row = grid.createDiv({ cls: "it-list-summary" + (mode === "grand" ? " is-grand" : " is-group") });
  row.addClass("it-subgrid-row");

  const customFields = (context.customFields as Array<{ id: string; name: string }>) || [];
  const fieldLabels = context.fieldLabels;
  const labelFor = (field: string): string => {
    if (field === "title") return fieldLabelFrom(fieldLabels, "title");
    if (field.startsWith("custom_field:")) {
      const id = field.slice("custom_field:".length);
      return customFields.find((c) => c.id === id)?.name || id;
    }
    return listColLabel(field, fieldLabels);
  };

  // The grand row gets a leading "Σ" marker in the title cell when that column
  // has no calc of its own, so the footer reads as a totals row.
  for (const field of ["title", ...cols]) {
    const cell = row.createDiv({ cls: "it-list-summary-cell" + (field === "title" ? " it-list-summary-title" : "") });
    cell.style.gridColumn = field === "title" ? "title" : colLine(field);
    const calc = calcs[field];
    fillCalcCell(cell, field, calc, tasks, plugin, context, mode === "grand" ? "footer" : "group");
    if (mode === "grand" && field === "title" && !calc) {
      cell.addClass("is-empty");
      cell.createSpan({ cls: "it-calc-sigma", text: "Σ" });
    }
    if (mode === "grand") {
      cell.addClass("it-calc-clickable");
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        openCalcMenu({
          anchor: cell, field, fieldLabel: labelFor(field), current: calcs[field], plugin, context,
          onChange: (next) => {
            const map = { ...(state.columnCalcs?.list || {}) };
            if (next) map[field] = next; else delete map[field];
            state.columnCalcs = { ...(state.columnCalcs || {}), list: map };
            persistColumnCalcs(plugin, state.location, "list", map);
            opts.rerender?.();
          },
        });
      });
    }
  }
}

function renderRow(parent: HTMLElement, nrow: NestedRow, opts: RenderOpts, cols: string[], toggleCollapse?: (id: string) => void, collapsed?: Set<string>) {
  const { plugin, context, onTaskClick } = opts;
  const t = nrow.task;
  const row = parent.createDiv({ cls: "it-row" + (nrow.depth > 0 ? " is-subtask" : "") });
  // Rows and property cells name what they stand for, the way Board cards and
  // Gantt bars do; column position alone depends on visible_fields order.
  row.dataset.taskId = t.data.id;
  if (t.data.color) row.style.setProperty("--row-accent", t.data.color);

  const isDone = t.data.status_group === "done" || t.data.status_group === "closed";

  // ---- Leading cluster: checkbox ----
  if (isVisible(opts, "checkbox")) {
    const checkbox = row.createEl("input", { type: "checkbox", cls: "it-row-check" });
    checkbox.addClass("it-gc-check");
    checkbox.checked = isDone;
    checkbox.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      rememberListScroll(opts, checkbox);
    });
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("focus", () => restoreListScroll(opts));
    checkbox.addEventListener("change", fireAndForget(async () => {
      const set = plugin.index.resolveStatusSet(t.listPath).statuses;
      const preference = plugin.index.resolveViewDefaultValue<CheckboxAction>(
        "list", "checkbox_action", opts.state.location,
        (v) => v === "done" || v === "closed", "done",
      );
      const target = checkbox.checked
        ? pickCheckboxCheckedStatus(set, preference)
        : pickCheckboxUncheckedStatus(set);
      if (target) await updateTaskPreservingListScroll(opts, checkbox, t.data.id, (d) => ({
        data: { ...d, status: target, activity: appendActivity(d.activity, { kind: "status", from: d.status ?? null, to: target }) },
      }));
    }));
  }

  // ---- Leading cluster: type icon (emoji or Lucide) ----
  if (isVisible(opts, "type_icon")) {
    const types = plugin.index.resolveTaskTypes({ listPath: t.listPath });
    const ttype = types.find((x) => x.id === t.data.type);
    const wrap = row.createSpan({ cls: "it-row-type" });
    wrap.addClass("it-gc-type");
    const typeIconEl = renderIconish(wrap, ttype?.icon || typeEmoji(t.data.type), { cls: "it-row-type-icon" });
    if (ttype?.color && typeIconEl) typeIconEl.style.color = ttype.color;
  }

  // ---- Title (always shown) + id/custom_id prefix + count badges ----
  const title = row.createDiv({ cls: "it-row-title" });
  title.addClass("it-gc-title");
  // Subtask presentation: indent by depth (nested mode); a chevron collapses a
  // parent's children; a twig "↳" marks any subtask row so it's identifiable in
  // every mode (in flat mode subtasks are depth 0 but still get the marker).
  const isSub = parentTaskIds(t.data).length > 0;
  if (nrow.depth > 0) title.style.paddingLeft = `${nrow.depth * 18}px`;
  if (nrow.hasChildren && toggleCollapse) {
    const isCol = !!collapsed?.has(t.data.id);
    const chev = title.createSpan({ cls: "it-row-subtask-toggle", attr: { "aria-label": isCol ? tr("action.expandSubtasks") : tr("action.collapseSubtasks") } });
    setIcon(chev, isCol ? "chevron-right" : "chevron-down");
    chev.addEventListener("click", (e) => { e.stopPropagation(); toggleCollapse(t.data.id); });
  } else if (nrow.depth > 0 || isSub) {
    setIcon(title.createSpan({ cls: "it-row-subtask-twig" }), "corner-down-right");
  }
  if (isVisible(opts, "id") || isVisible(opts, "custom_id")) {
    const idText = isVisible(opts, "custom_id") && t.data.custom_id
      ? t.data.custom_id
      : (isVisible(opts, "id") ? t.data.id : "");
    if (idText) title.createSpan({ cls: "it-row-id", text: idText });
  }
  if (Platform.isMobile) {
    const titleSpan = title.createSpan({ cls: "it-row-title-text", text: t.data.title || tr("common.untitled") });
    if (isDone) titleSpan.addClass("is-done");
  } else {
    const titleEdit = title.createSpan({ cls: "it-row-title-edit" });
    renderDesktopTextEditableCell(
      titleEdit,
      t.data.title || "",
      tr("common.untitled"),
      "it-row-title-text" + (isDone ? " is-done" : ""),
      fireAndForget(async (value: string | null) => {
        if (!value || value === t.data.title) return;
        await updateTaskPreservingListScroll(opts, titleEdit, t.data.id, (d) => ({
          data: { ...d, title: value, activity: appendActivity(d.activity, { kind: "title", from: d.title ?? null, to: value }) },
        }));
      }),
      () => opts.onTaskClick(t),
      MAX_TASK_TITLE_LENGTH,
    );
  }

  if (isVisible(opts, "subtask_count")) {
    const sub = context.subtaskStats?.get(t.data.id)?.total ?? 0;
    if (sub > 0) {
      const badge = title.createSpan({ cls: "it-row-subtask-badge", text: `↳ ${sub}` });
      badge.title = tr("list.subitemsCount", { count: sub });
    }
  }
  if (isVisible(opts, "relationship_count")) {
    const rc = context.relationshipCounts?.get(t.data.id) ?? 0;
    if (rc > 0) title.createSpan({ cls: "it-row-subtask-badge", text: `🔗 ${rc}` });
  }
  // Multiple Lists: mark rows shown here that actually live in another list.
  {
    const loc = opts.state.location;
    if (loc.kind === "list" && t.listPath && t.listPath !== loc.path) {
      const home = plugin.index.findList(t.listPath)?.config.name || tr("board.anotherList");
      const b = title.createSpan({ cls: "it-row-linked-badge", text: "↪" });
      b.title = tr("board.linkedFromHome", { home });
    }
  }

  // ---- Ordered property columns ----
  for (const f of cols) renderPropertyCell(row, t, f, opts);

  // ---- Actions ----
  const actions = row.createDiv({ cls: "it-row-actions" });
  actions.addClass("it-gc-actions");
  const more = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": tr("common.more") } });
  setIcon(more, "more-horizontal");
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const items: MenuItem[] = [
      { label: tr("action.openModal"), icon: "expand", onClick: () => opts.onTaskClick(t) },
      { label: tr("action.openMd"), icon: "file-text", onClick: () => void plugin.index.openTaskInEditor(t.data.id) },
      { label: tr("action.moveToList"), icon: "folder-input", onClick: () => new MoveTaskModal(plugin.app, plugin, t.data.id).open() },
    ];
    // Multiple Lists: when viewing a list this task is only linked into, offer
    // to unlink it here (instead of only the destructive whole-task delete).
    const loc = opts.state.location;
    if (loc.kind === "list" && t.listPath && t.listPath !== loc.path) {
      items.push({
        label: tr("action.removeFromList"),
        icon: "x",
        onClick: () => new ConfirmModal(plugin.app, {
          title: tr("modal.deleteConfirm"),
          message: tr("action.removeFromList"),
          destructive: true,
          confirmLabel: tr("common.remove"),
          onConfirm: () => void plugin.index.removeTaskFromList(t.data.id, loc.path),
        }).open(),
      });
    }
    items.push("separator");
    items.push(...favoriteToggleItems(plugin, t.data.id));
    items.push("separator");
    items.push({ label: tr("common.delete"), icon: "trash", danger: true, onClick: () => new ConfirmModal(plugin.app, { title: tr("modal.deleteConfirm"), message: tr("action.moveToTrash", { title: t.data.title }), destructive: true, onConfirm: () => void plugin.index.deleteTask(t.data.id) }).open() });
    showContextMenu(e, items);
  });

  row.addEventListener("click", () => onTaskClick(t));
}

// Renders a single property field as its own grid cell, placed at the column
// named by colLine(field). Display matches the previous list-view look; only
// the placement is now order-driven.
function renderPropertyCell(row: HTMLElement, t: TaskFile, field: string, opts: RenderOpts) {
  const { plugin, context } = opts;
  const chipStyles = context.chipStyles;
  const gcol = colLine(field);

  // Custom fields — each gets its own column (`cf-{id}`). Display goes through
  // the polymorphic cf-render dispatcher so per-type rendering stays consistent.
  if (field.startsWith("custom_field:")) {
    const id = field.slice("custom_field:".length);
    const cf = context.customFields?.find((c) => c.id === id);
    const cell = row.createDiv({ cls: "it-row-cf-cell", attr: { "data-field": field } });
    cell.style.gridColumn = gcol;
    if (cf) {
      renderCustomFieldEditor(cell, t, cf, opts);
    }
    return;
  }

  switch (field) {
    case "type": {
      const cell = row.createDiv({ cls: "it-row-cell", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      stopCellClick(cell);
      const types = plugin.index.resolveTaskTypes({ listPath: t.listPath });
      const current = types.find((tt) => tt.id === (t.data.type || "task"));
      const chip = cell.createEl("button", { cls: "it-chip it-chip-tag it-table-edit-display", text: current?.name || t.data.type || "task" });
      if (current?.color) chip.style.setProperty("--chip-color", current.color);
      if (current?.icon) renderIconish(chip.createSpan({ cls: "it-group-chip-icon" }), current.icon);
      applyChipStyleByKind(chip, "task_type", chipStyles);
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        showPopover(chip, (root) => buildDropdown({
          parent: root,
          current: t.data.type || "task",
          items: types.map((tt) => ({ value: tt.id, label: tt.name, color: tt.color, icon: tt.icon })),
          onSelect: fireAndForget(async (v: string) => {
            closePopovers();
            await updateTaskPreservingListScroll(opts, cell, t.data.id, (d) => ({ data: { ...d, type: v } }));
          }),
        }));
      });
      return;
    }
    case "status": {
      const cell = row.createDiv({ cls: "it-row-cell", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      const statusObj = context.statuses.find((s) => s.id === t.data.status);
      statusChip(cell, statusObj, (e) => {
        // Dropdown offers the item's own effective set (home-List inheritance),
        // not the scope union — a pick is always valid for this item.
        const itemStatuses = plugin.index.resolveStatusSet(t.listPath).statuses;
        showPopover(e.currentTarget as HTMLElement, (root) => {
          buildDropdown({
            parent: root,
            current: t.data.status,
            items: itemStatuses.map((s) => ({ value: s.id, label: s.name, color: s.color })),
            onSelect: fireAndForget(async (v: string) => {
              await updateTaskPreservingListScroll(opts, cell, t.data.id, (d) => ({
                data: { ...d, status: v, activity: appendActivity(d.activity, { kind: "status", from: d.status ?? null, to: v }) },
              }));
              document.querySelectorAll(".it-popover").forEach((el) => el.remove());
            }),
          });
        });
      }, chipStyles);
      return;
    }
    case "priority": {
      const cell = row.createDiv({ cls: "it-row-cell", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      priorityChip(cell, t.data.priority, context.priorities, (e) => {
        showPopover(e.currentTarget as HTMLElement, (root) => {
          buildDropdown<PriorityId | null>({
            parent: root,
            current: t.data.priority,
            items: [
              ...context.priorities.map((p) => ({ value: p.id, label: p.label, color: p.color })),
              { value: null, label: tr("action.noPriority"), color: "#9E9E9E" },
            ],
            onSelect: fireAndForget(async (v: PriorityId | null) => {
              await updateTaskPreservingListScroll(opts, cell, t.data.id, (d) => ({ data: { ...d, priority: v ?? null } }));
              document.querySelectorAll(".it-popover").forEach((el) => el.remove());
            }),
          });
        });
      }, chipStyles);
      return;
    }
    case "due_date": {
      const cell = row.createDiv({ cls: "it-row-cell", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      renderInlineDateTimeInput(cell, "datetime", t.data.due_date, (value) => {
        void updateTaskPreservingListScroll(opts, cell, t.data.id, (d) => ({ data: { ...d, due_date: value } }));
      });
      return;
    }
    case "start_date": {
      const cell = row.createDiv({ cls: "it-row-cell", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      renderInlineDateTimeInput(cell, "datetime", t.data.start_date, (value) => {
        void updateTaskPreservingListScroll(opts, cell, t.data.id, (d) => ({ data: { ...d, start_date: value } }));
      });
      return;
    }
    case "tags": {
      const cell = row.createDiv({ cls: "it-row-tags", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      const tagsPalette = plugin.index.resolveTagsPalette({ listPath: t.listPath });
      renderTagsCell(cell, t.data.tags || [], tagsPalette, 2, chipStyles);
      if (!(t.data.tags || []).length) cell.createSpan({ cls: "it-table-add-placeholder", text: "+ tag" });
      cell.addClass("it-table-editable");
      stopCellClick(cell);
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        const map = new Map<string, { value: string; label: string; color?: string }>();
        for (const tag of tagsPalette) map.set(tag.name, { value: tag.name, label: tag.name, color: tag.color });
        for (const tag of t.data.tags || []) if (!map.has(tag)) map.set(tag, { value: tag, label: tag });
        renderOptionMultiPicker(cell, t.data.tags || [], Array.from(map.values()), fireAndForget(async (values: string[]) => {
          await updateTaskPreservingListScroll(opts, cell, t.data.id, (d) => ({ data: { ...d, tags: values } }));
        }));
      });
      return;
    }
    case "context": {
      const cell = row.createDiv({ cls: "it-row-context", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      const labels = plugin.index.resolveContextLabels({ listPath: t.listPath });
      const colorByName: Record<string, string> = {};
      for (const cl of labels) colorByName[cl.name] = cl.color;
      for (const cl of (t.data.context || [])) {
        const chip = cell.createSpan({ cls: "it-chip it-chip-tag", text: cl });
        if (colorByName[cl]) chip.style.setProperty("--chip-color", colorByName[cl]);
        applyChipStyleByKind(chip, "context", chipStyles);
      }
      if (!(t.data.context || []).length) cell.createSpan({ cls: "it-table-add-placeholder", text: "+ context" });
      cell.addClass("it-table-editable");
      stopCellClick(cell);
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        renderOptionMultiPicker(cell, t.data.context || [], labels.map((cl) => ({ value: cl.name, label: cl.name, color: cl.color })), fireAndForget(async (values: string[]) => {
          await updateTaskPreservingListScroll(opts, cell, t.data.id, (d) => ({ data: { ...d, context: values } }));
        }));
      });
      return;
    }
    case "time_estimate": {
      const cell = row.createDiv({ cls: "it-row-meta", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      renderNumericEditor(cell, t.data.time_estimate, (n) => {
        void updateTaskPreservingListScroll(opts, cell, t.data.id, (d) => ({ data: { ...d, time_estimate: n } }));
      }, { min: "0", step: "1", mobilePopover: true, wholeNonNegative: true });
      return;
    }
    case "time_tracked": {
      const cell = row.createDiv({ cls: "it-row-meta", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      renderNumericEditor(cell, t.data.time_tracked, (n) => {
        void updateTaskPreservingListScroll(opts, cell, t.data.id, (d) => ({ data: { ...d, time_tracked: n } }));
      }, { min: "0", step: "1", mobilePopover: true, wholeNonNegative: true });
      return;
    }
    case "sprint_points": {
      const cell = row.createDiv({ cls: "it-row-meta", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      renderNumericEditor(cell, t.data.sprint_points, (n) => {
        void updateTaskPreservingListScroll(opts, cell, t.data.id, (d) => ({ data: { ...d, sprint_points: n } }));
      }, { min: "0", step: "1", mobilePopover: true, wholeNonNegative: true });
      return;
    }
    case "space":
    case "folder":
    case "list": {
      const cell = row.createDiv({ cls: "it-row-labels", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      renderListReference(cell, t, plugin.index, field);
      return;
    }
    case "created_at": {
      const cell = row.createDiv({ cls: "it-row-meta", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      if (t.data.created_at) cell.createSpan({ cls: "it-chip it-chip-meta", text: (t.data.created_at || "").slice(0, 16).replace("T", " ") });
      return;
    }
    case "updated_at": {
      const cell = row.createDiv({ cls: "it-row-meta", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      if (t.data.updated_at) cell.createSpan({ cls: "it-chip it-chip-meta", text: (t.data.updated_at || "").slice(0, 16).replace("T", " ") });
      return;
    }
    default: {
      // Unknown field — reserve the column so alignment stays intact.
      const cell = row.createDiv({ cls: "it-row-cell", attr: { "data-field": field } });
      cell.style.gridColumn = gcol;
      return;
    }
  }
}

function typeEmoji(type?: string): string {
  switch (type) {
    case "bug": return "🐛";
    case "story": return "📖";
    case "epic": return "🎯";
    case "feature": return "✨";
    case "meeting": return "📅";
    case "milestone": return "💎";
    case "campaign": return "📢";
    case "record": return "📇";
    default: return "✓";
  }
}

function computeBucketDefaults(key: string, groupBy: string, _ctx: unknown): QuickTaskPreset {
  if (groupBy === "status") return { status: key };
  if (groupBy === "priority") {
    const n = parseInt(key, 10);
    return { priority: isNaN(n) ? null : (n as PriorityId) };
  }
  if (groupBy === "tags") {
    if (key === "__no_tags") return {};
    return { tags: [key] };
  }
  if (groupBy === "context") {
    if (key === "__no_context") return {};
    return { context: [key] };
  }
  if (groupBy === "type") return { type: key };
  return {};
}

// Safe enough subset for CSS identifiers used in `grid-column` line names.
function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}
