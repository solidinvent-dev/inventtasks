import { setIcon, Platform, Modal } from "obsidian";
import type InventTasksPlugin from "../main";
import { TaskFile, StatusDef, PriorityDef, ResolvedChipStyles, CustomFieldDef, TaskType, ContextLabelDef, TagDef } from "../types";
import { projectOccurrences } from "../data/recurring";
import { renderCustomFieldValue } from "../ui/cf-render";
import { effectiveCustomFieldValue, isEmptyCustomFieldValue } from "../data/custom-fields";
import { ViewState } from "./main-view";
import { parseDate, startOfMonth, endOfMonth, addDays, addMonths, isOverdue, formatDate, dayKey, todayKey, weekStartIndex } from "../utils/dates";
import { QuickTaskModal } from "../modals/create-modals";
import { statusChip, priorityChip, tagChip, applyChipStyleByKind, renderListReference } from "../ui/components";
import { renderIconish, renderCfTypeIcon } from "../ui/icons";
import { CALENDAR_COLOR_SOURCE_DEFAULT, DATE_SOURCE_DUE } from "../constants";
import { taskDateValue, isDateSourceWritable, mapDatePatch, presetForDateSource } from "../data/date-source";
import { viewLabel, weekdayShort, weekdayMin, weekdayLong, monthName, t as tr } from "../i18n";

type CalendarPeriod = "month" | "week" | "day" | "monthCompact";
const CALENDAR_PERIODS: CalendarPeriod[] = ["month", "week", "day", "monthCompact"];

export function setCalendarPeriodClass(parent: HTMLElement, current: CalendarPeriod) {
  for (const period of CALENDAR_PERIODS) parent.removeClass(`it-cal-period-${period}`);
  parent.addClass(`it-cal-period-${current}`);
}

interface CalendarContext {
  statuses: StatusDef[];
  priorities: PriorityDef[];
  priorityLabels: Record<number, string>;
  visibleFields: string[];
  features: Record<string, boolean>;
  tagsPalette: TagDef[];
  contextLabels: ContextLabelDef[];
  taskTypesOrder: Array<{ id: string; name: string; color?: string }>;
  customFields: CustomFieldDef[];
  chipStyles: ResolvedChipStyles;
  calendarColorBy?: string;
  // Which task field places the pill ("due_date" default — see date-source.ts).
  dateField?: string;
  cfShowName?: boolean;
  cfShowWhenEmpty?: boolean;
  // Built once per render in tasksContext — avoids per-pill allTasks() scans.
  subtaskStats?: Map<string, { total: number; done: number }>;
  relationshipCounts?: Map<string, number>;
}

interface RenderOpts {
  parent: HTMLElement;
  tasks: TaskFile[];
  state: ViewState;
  plugin: InventTasksPlugin;
  onTaskClick: (t: TaskFile) => void;
  context: CalendarContext;
  onShift: (n: number) => void;
  onPeriodChange: (p: CalendarPeriod) => void;
  onToday: () => void;
}

// Monday=0 … Sunday=6 — a date's own weekday, independent of the week-start
// preference (used for weekday *names* of a specific date).
function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

// Which grid column (0…6) a date occupies given the configured first day of
// week. With "Monday" this matches mondayIndex; with "Sunday" it's getDay().
function dowColumn(d: Date): number {
  return (d.getDay() - weekStartIndex() + 7) % 7;
}

// The Monday-indexed weekday that lives in grid column `c`, so we can label the
// header row (weekdayShort/Min) correctly for either week start.
function columnWeekday(c: number): number {
  const jsDay = (weekStartIndex() + c) % 7; // Sunday=0 … Saturday=6
  return (jsDay + 6) % 7;                    // → Monday=0 … Sunday=6
}

function startOfWeek(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - dowColumn(r));
  return r;
}

function isoDate(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A calendar pill entry — either a real task at its due_date, or a virtual
// future occurrence projected from a recurring task. Virtuals reference
// the same TaskFile (the "parent") but render with dashed styling and
// route clicks back to the parent without dragging or status edits.
export interface PillEntry {
  task: TaskFile;
  isVirtual: boolean;
  virtualDate?: string; // iso yyyy-mm-dd for virtuals
}

function bucketTasksByDay(
  tasks: TaskFile[],
  dateField: string | undefined,
  projection?: { horizonEnd: Date; today: Date },
): Map<string, PillEntry[]> {
  const map = new Map<string, PillEntry[]>();
  const push = (key: string, entry: PillEntry) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(entry);
  };
  // Virtual occurrences project the recurrence of the DUE date — they only
  // make sense when pills are placed by due date.
  const projectRecurring = !dateField || dateField === DATE_SOURCE_DUE;
  for (const t of tasks) {
    const raw = taskDateValue(t, dateField, DATE_SOURCE_DUE);
    if (!raw) continue;
    // Place the real pill by the value's own calendar day (timezone-safe —
    // read straight off the string, never via UTC-parsed Date).
    const key = dayKey(raw);
    if (!key) continue;
    push(key, { task: t, isVirtual: false });

    // Virtual future occurrences for recurring tasks. Projection needs a real
    // Date as the base, so parse here (only for the look-ahead math).
    if (projectRecurring && projection && t.data.recurring?.enabled) {
      const base = parseDate(t.data.due_date);
      if (base) {
        const occurrences = projectOccurrences(t.data.recurring, base, projection.horizonEnd);
        for (const occ of occurrences) {
          if (occ < projection.today) continue; // skip hypothetical past misses
          push(isoDate(occ), { task: t, isVirtual: true, virtualDate: isoDate(occ) });
        }
      }
    }
  }
  return map;
}

export function renderCalendarView(opts: RenderOpts) {
  const { parent, state } = opts;
  parent.addClass("it-calendar-view");
  // refreshContent() reuses the same .it-main-body element and only clears its
  // children. Remove the previous period marker before adding the current one
  // so Month -> Week -> Day does not leave mutually-exclusive mode classes on
  // the container (and accidentally combine their CSS as the views evolve).
  setCalendarPeriodClass(parent, state.calendarPeriod);

  renderToolbar(opts);

  switch (state.calendarPeriod) {
    case "month":
      renderMonth(opts);
      break;
    case "monthCompact":
      renderMonthCompact(opts);
      break;
    case "week":
      renderWeek(opts);
      break;
    case "day":
      renderDay(opts);
      break;
  }

  // The grid scrolls inside its own .it-cal-scroll (not .it-main-body), so the
  // main view's scroll preservation doesn't cover it. Every data-driven rebuild
  // (a task drag/edit → index change → full re-render) recreates this container
  // at top. Persist its offset on the view state and restore it after render so
  // the viewport stays put instead of jumping to the top.
  const scroll = parent.querySelector(".it-cal-scroll") as HTMLElement | null;
  if (scroll) {
    scroll.addEventListener("scroll", () => {
      (state as any).__calScrollTop = scroll.scrollTop;
      (state as any).__calScrollLeft = scroll.scrollLeft;
    });
    // The compact "Overview" always opens at the top so the day-name header and
    // the first weeks are visible (the chrome auto-collapses around it); only the
    // bottom weeks may fall below the fold. Other periods restore their offset.
    const savedTop = (state as any).__calScrollTop;
    const savedLeft = (state as any).__calScrollLeft;
    if (state.calendarPeriod !== "monthCompact" && (typeof savedTop === "number" || typeof savedLeft === "number")) {
      requestAnimationFrame(() => {
        if (typeof savedTop === "number") scroll.scrollTop = savedTop;
        if (typeof savedLeft === "number") scroll.scrollLeft = savedLeft;
      });
    }
  }
}

function renderToolbar(opts: RenderOpts) {
  const { parent, state, onShift, onPeriodChange, onToday } = opts;
  const ref = parseDate(state.calendarRefDate) || new Date();

  const toolbar = parent.createDiv({ cls: "it-cal-toolbar" });

  // Navigation cluster: prev / title / next / today
  const nav = toolbar.createDiv({ cls: "it-cal-toolbar-nav" });
  const prev = nav.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": tr("cal.prevAria") } });
  setIcon(prev, "chevron-left");
  prev.addEventListener("click", () => onShift(-1));

  nav.createSpan({ cls: "it-cal-month", text: toolbarTitle(state.calendarPeriod, ref) });

  const next = nav.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": tr("cal.nextAria") } });
  setIcon(next, "chevron-right");
  next.addEventListener("click", () => onShift(1));

  const today = nav.createEl("button", { cls: "it-btn-secondary", text: tr("cal.today") });
  today.addEventListener("click", () => onToday());

  // Spacer pushes the right cluster to the right edge.
  toolbar.createDiv({ cls: "it-flex-grow" });

  // Right cluster — recurring toggle + period switcher, grouped so they wrap to
  // the next row together when the toolbar gets narrow.
  const right = toolbar.createDiv({ cls: "it-cal-toolbar-right" });

  // Recurring projection toggle — icon-only on/off (no text). When on, virtual
  // projections of recurring tasks appear with dashed styling + a repeat badge.
  const recBtn = right.createEl("button", {
    cls: "it-icon-btn it-cal-recurring-toggle" + (state.showRecurringFuture ? " is-active" : ""),
    attr: {
      type: "button",
      "aria-pressed": String(state.showRecurringFuture),
      "aria-label": tr("cal.recurringAria"),
      title: state.showRecurringFuture ? tr("cal.recurringOn") : tr("cal.recurringOff"),
    },
  });
  setIcon(recBtn, "repeat");
  recBtn.addEventListener("click", () => {
    state.showRecurringFuture = !state.showRecurringFuture;
    opts.onPeriodChange(state.calendarPeriod); // trigger refreshContent
  });

  // Period switcher (Month / Week / Day / Overview) — styled like the view tabs.
  const tabs = right.createDiv({ cls: "it-cal-period-tabs" });
  const periods: Array<{ id: CalendarPeriod; label: string }> = [
    { id: "month", label: viewLabel("month") },
    { id: "week", label: viewLabel("week") },
    { id: "day", label: viewLabel("day") },
    { id: "monthCompact", label: viewLabel("overview") },
  ];
  for (const p of periods) {
    const btn = tabs.createEl("button", {
      cls: "it-cal-period-tab" + (state.calendarPeriod === p.id ? " is-active" : ""),
      text: p.label,
      attr: { type: "button" },
    });
    btn.addEventListener("click", () => onPeriodChange(p.id));
  }
}

function toolbarTitle(period: CalendarPeriod, ref: Date): string {
  if (period === "month" || period === "monthCompact") {
    return `${monthName(ref.getMonth())} ${ref.getFullYear()}`;
  }
  if (period === "week") {
    const start = startOfWeek(ref);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const sameYear = start.getFullYear() === end.getFullYear();
    if (sameMonth) {
      return `${monthName(start.getMonth())} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
    }
    if (sameYear) {
      return `${monthName(start.getMonth()).slice(0, 3)} ${start.getDate()} – ${monthName(end.getMonth()).slice(0, 3)} ${end.getDate()}, ${start.getFullYear()}`;
    }
    return `${monthName(start.getMonth()).slice(0, 3)} ${start.getDate()}, ${start.getFullYear()} – ${monthName(end.getMonth()).slice(0, 3)} ${end.getDate()}, ${end.getFullYear()}`;
  }
  // day
  return `${weekdayLong(mondayIndex(ref))}, ${monthName(ref.getMonth())} ${ref.getDate()}, ${ref.getFullYear()}`;
}

// ---------- MONTH ----------

function buildProjectionOpts(opts: RenderOpts): { horizonEnd: Date; today: Date } | undefined {
  if (!opts.state.showRecurringFuture) return undefined;
  const months = Math.max(1, Math.min(12, opts.plugin.prefs.recurringProjectionMonths || 3));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return { today, horizonEnd: addMonths(today, months) };
}

function renderMonth(opts: RenderOpts) {
  const { parent, tasks, state } = opts;
  const ref = parseDate(state.calendarRefDate) || new Date();
  const monthStart = startOfMonth(ref);
  const monthEnd = endOfMonth(ref);

  const scroll = parent.createDiv({ cls: "it-cal-scroll" });
  const grid = scroll.createDiv({ cls: "it-cal-grid is-month" });
  for (let i = 0; i < 7; i++) grid.createDiv({ cls: "it-cal-dayname", text: weekdayShort(columnWeekday(i)) });

  const firstWeekday = dowColumn(monthStart);
  const totalDays = monthEnd.getDate();
  const cells = Math.ceil((firstWeekday + totalDays) / 7) * 7;

  const tasksByDay = bucketTasksByDay(tasks, opts.context.dateField, buildProjectionOpts(opts));
  const tk = todayKey();

  for (let i = 0; i < cells; i++) {
    const cellDate = new Date(monthStart);
    cellDate.setDate(monthStart.getDate() + (i - firstWeekday));
    // The day a cell stands for, so anything addressing the grid (drop
    // targets, tests, future keyboard navigation) reads it instead of
    // recomputing it from the cell's position.
    const cell = grid.createDiv({ cls: "it-cal-cell" });
    cell.dataset.date = isoDate(cellDate);
    if (cellDate.getMonth() !== ref.getMonth()) cell.addClass("is-other-month");
    if (isoDate(cellDate) === tk) cell.addClass("is-today");

    renderCellHead(cell, cellDate, opts);
    renderCellPills(cell, tasksByDay.get(isoDate(cellDate)) || [], { limit: 4 }, opts);
    attachDayDnd(cell, cellDate, opts);
  }
}

// ---------- MONTH (compact "Overview") ----------

// A Google-Calendar-style month that fits the viewport width (no horizontal
// scroll): narrow columns, tiny day-name bars, thin colored task bars whose
// titles truncate at the column edge. Individual bars are too small to tap
// reliably, so the whole day cell opens an enlarged day sheet (CalendarDayModal)
// where tasks can be picked and a new one created.
function renderMonthCompact(opts: RenderOpts) {
  const { parent, tasks, state } = opts;
  const ref = parseDate(state.calendarRefDate) || new Date();
  const monthStart = startOfMonth(ref);
  const monthEnd = endOfMonth(ref);

  // Day-name header sits OUTSIDE the scroller so it stays pinned while the weeks
  // below scroll (the user wants the header kept, only the bottom hidden).
  const daynames = parent.createDiv({ cls: "it-cal-compact-head" });
  for (let i = 0; i < 7; i++) daynames.createDiv({ cls: "it-cal-dayname", text: weekdayMin(columnWeekday(i)) });

  const scroll = parent.createDiv({ cls: "it-cal-scroll is-compact-scroll" });
  const grid = scroll.createDiv({ cls: "it-cal-grid is-month-compact" });

  // The pull-down-to-reveal-chrome gesture (and the suppression of Obsidian's own
  // pull-down menu) is wired up by the main view, which owns the chrome + window
  // capture listeners. See MainView.setupOverviewGesture.

  const firstWeekday = dowColumn(monthStart);
  const totalDays = monthEnd.getDate();
  const cells = Math.ceil((firstWeekday + totalDays) / 7) * 7;

  const tasksByDay = bucketTasksByDay(tasks, opts.context.dateField, buildProjectionOpts(opts));
  const tk = todayKey();

  // Keep each cell's entries + its bars container so we can (re)fill the bars to
  // however many actually fit once the grid has a measured height. Pre-layout we
  // can't know the cell height (it stretches to fill the scroller), so a fixed
  // cap would waste space on desktop (tall cells) and overflow on a phone.
  const cellSlots: Array<{ bars: HTMLElement; entries: PillEntry[] }> = [];

  for (let i = 0; i < cells; i++) {
    const cellDate = new Date(monthStart);
    cellDate.setDate(monthStart.getDate() + (i - firstWeekday));
    const iso = isoDate(cellDate);
    const cell = grid.createDiv({ cls: "it-cal-cell is-compact-cell" });
    cell.dataset.date = iso;
    if (cellDate.getMonth() !== ref.getMonth()) cell.addClass("is-other-month");
    if (iso === tk) cell.addClass("is-today");

    const head = cell.createDiv({ cls: "it-cal-cell-head" });
    head.createSpan({ cls: "it-cal-cell-day", text: String(cellDate.getDate()) });

    const entries = tasksByDay.get(iso) || [];
    const bars = cell.createDiv({ cls: "it-cal-cbars" });
    cellSlots.push({ bars, entries });

    // Tap anywhere on the day → enlarged sheet (the thin bars are not tap targets).
    const dayDate = new Date(cellDate);
    cell.addEventListener("click", () => {
      new CalendarDayModal(opts, iso, dayDate, entries).open();
    });
  }

  // Bar geometry mirrors the CSS (.it-cal-cbar height + .it-cal-cbars gap).
  const BAR_H = 14;
  const GAP = 2;
  const ROW = BAR_H + GAP;
  let lastCap = -1;
  const fill = () => {
    const sample = grid.querySelector(".it-cal-cbars") as HTMLElement | null;
    const avail = sample?.clientHeight ?? 0;
    // Pre-layout (0 height) → fall back to a small cap so something shows.
    const cap = avail > 0 ? Math.max(1, Math.floor((avail + GAP) / ROW)) : 3;
    if (cap === lastCap) return;
    lastCap = cap;
    for (const slot of cellSlots) {
      slot.bars.empty();
      const entries = slot.entries;
      if (entries.length <= cap) {
        for (const e of entries) renderCompactBar(slot.bars, e, opts);
      } else {
        // Reserve the last row for the "+N more" counter.
        const show = Math.max(1, cap - 1);
        for (let i = 0; i < show; i++) renderCompactBar(slot.bars, entries[i], opts);
        slot.bars.createDiv({ cls: "it-cal-cbar-more", text: `+${entries.length - show}` });
      }
    }
  };

  // Initial fill once laid out, then keep it in sync as the grid resizes (desktop
  // window resize, panel splits, rotation). The observer self-disconnects when the
  // grid leaves the DOM (next render replaces it).
  requestAnimationFrame(fill);
  const ro = new ResizeObserver(() => {
    if (!grid.isConnected) { ro.disconnect(); return; }
    fill();
  });
  ro.observe(grid);
}

// Thin, non-interactive bar: configured color + truncated title only. The parent
// cell owns the tap, so bars ignore pointer events (see CSS).
function renderCompactBar(parent: HTMLElement, entry: PillEntry, opts: RenderOpts) {
  const t = entry.task;
  const bar = parent.createDiv({ cls: "it-cal-cbar" + (entry.isVirtual ? " is-virtual" : "") });
  bar.style.setProperty("--pill-color", resolvePillColor(t, opts.context));
  if (isOverdue(t.data.due_date, t.data.status_group)) bar.addClass("is-overdue");
  bar.createSpan({ cls: "it-cal-cbar-title", text: t.data.title || tr("common.untitled") });
}

// Enlarged per-day sheet for the compact overview. Lists the day's tasks as big
// tap targets (pick one → opens it) and offers a single "New task" action that
// pre-fills the day (and the current list/folder/space scope), mirroring the
// per-cell "+" button used by the other calendar modes.
class CalendarDayModal extends Modal {
  private opts: RenderOpts;
  private iso: string;
  private date: Date;
  private entries: PillEntry[];

  constructor(opts: RenderOpts, iso: string, date: Date, entries: PillEntry[]) {
    super(opts.plugin.app);
    this.opts = opts;
    this.iso = iso;
    this.date = date;
    this.entries = entries;
  }

  onOpen() {
    this.modalEl.addClass("it-cal-day-modal");
    this.titleEl.setText(
      `${weekdayLong(mondayIndex(this.date))}, ${monthName(this.date.getMonth())} ${this.date.getDate()}, ${this.date.getFullYear()}`,
    );

    const c = this.contentEl;
    c.empty();

    const list = c.createDiv({ cls: "it-cal-day-list" });
    if (this.entries.length === 0) {
      list.createDiv({ cls: "it-cal-day-empty", text: tr("cal.noTasks") });
    } else {
      for (const e of this.entries) this.renderRow(list, e);
    }

    const actions = c.createDiv({ cls: "it-cal-day-actions" });
    const addBtn = actions.createEl("button", { cls: "it-cal-day-add", attr: { type: "button" } });
    setIcon(addBtn, "plus");
    addBtn.createSpan({ text: tr("cal.newTask") });
    addBtn.addEventListener("click", () => {
      this.close();
      // Seed whichever field the calendar is placed by, so the clicked day
      // pre-fills (due_date, start_date, or a date custom field). Read-only
      // sources (created/updated) yield no preset.
      const preset = presetForDateSource(this.opts.context.dateField, this.iso);
      const modalOpts: any = Object.keys(preset).length ? { preset } : {};
      const loc = this.opts.state.location;
      if (loc.kind === "list") modalOpts.listPath = loc.path;
      else if (loc.kind === "folder") modalOpts.scopeFolderPath = loc.path;
      else if (loc.kind === "space") modalOpts.scopeSpacePath = loc.path;
      new QuickTaskModal(this.opts.plugin.app, this.opts.plugin, modalOpts).open();
    });
  }

  private renderRow(parent: HTMLElement, entry: PillEntry) {
    const t = entry.task;
    const ctx = this.opts.context;
    const row = parent.createDiv({ cls: "it-cal-day-row" + (entry.isVirtual ? " is-virtual" : "") });
    row.style.setProperty("--pill-color", resolvePillColor(t, ctx));
    if (isOverdue(t.data.due_date, t.data.status_group)) row.addClass("is-overdue");

    const body = row.createDiv({ cls: "it-cal-day-row-body" });
    const titleRow = body.createDiv({ cls: "it-cal-day-row-title-row" });
    if (entry.isVirtual) {
      const repeat = titleRow.createSpan({ cls: "it-cal-pill-repeat" });
      setIcon(repeat, "repeat");
    }
    titleRow.createSpan({ cls: "it-cal-day-row-title", text: t.data.title || tr("common.untitled") });

    const meta = body.createDiv({ cls: "it-cal-day-row-meta" });
    const so = ctx.statuses.find((s) => s.id === t.data.status);
    if (so) statusChip(meta, so, undefined, ctx.chipStyles);
    if (t.data.priority) priorityChip(meta, t.data.priority, ctx.priorities, undefined, ctx.chipStyles);
    if (meta.children.length === 0) meta.remove();

    row.addEventListener("click", () => {
      this.close();
      this.opts.onTaskClick(t);
    });
  }
}

// ---------- WEEK ----------

function renderWeek(opts: RenderOpts) {
  const { parent, tasks, state } = opts;
  const ref = parseDate(state.calendarRefDate) || new Date();
  const weekStart = startOfWeek(ref);

  const scroll = parent.createDiv({ cls: "it-cal-scroll" });
  const grid = scroll.createDiv({ cls: "it-cal-grid is-week" });
  // Day-name headers, same as Month
  for (let i = 0; i < 7; i++) grid.createDiv({ cls: "it-cal-dayname", text: weekdayShort(columnWeekday(i)) });

  const tasksByDay = bucketTasksByDay(tasks, opts.context.dateField, buildProjectionOpts(opts));
  const tk = todayKey();

  for (let i = 0; i < 7; i++) {
    const cellDate = addDays(weekStart, i);
    const cell = grid.createDiv({ cls: "it-cal-cell is-week-cell" });
    cell.dataset.date = isoDate(cellDate);
    if (isoDate(cellDate) === tk) cell.addClass("is-today");

    renderCellHead(cell, cellDate, opts);
    renderCellPills(cell, tasksByDay.get(isoDate(cellDate)) || [], { limit: 12 }, opts);
    attachDayDnd(cell, cellDate, opts);
  }
}

// ---------- DAY ----------

function renderDay(opts: RenderOpts) {
  const { parent, tasks, state } = opts;
  const ref = parseDate(state.calendarRefDate) || new Date();
  const cellDate = new Date(ref);
  cellDate.setHours(0, 0, 0, 0);

  const scroll = parent.createDiv({ cls: "it-cal-scroll" });
  const grid = scroll.createDiv({ cls: "it-cal-grid is-day" });
  // Single day-name header — keeps visual consistency with Month/Week
  grid.createDiv({ cls: "it-cal-dayname", text: weekdayShort(mondayIndex(cellDate)) });

  const tasksByDay = bucketTasksByDay(tasks, opts.context.dateField, buildProjectionOpts(opts));
  const cell = grid.createDiv({ cls: "it-cal-cell is-day-cell" });
  cell.dataset.date = isoDate(cellDate);
  if (isoDate(cellDate) === todayKey()) cell.addClass("is-today");

  renderCellHead(cell, cellDate, opts);
  const dayTasks = tasksByDay.get(isoDate(cellDate)) || [];
  renderCellPills(cell, dayTasks, { limit: Number.POSITIVE_INFINITY }, opts);
  if (dayTasks.length === 0) {
    cell.createDiv({ cls: "it-cal-empty", text: tr("cal.noTasks") });
  }
  attachDayDnd(cell, cellDate, opts);
}

// ---------- SHARED CELL PARTS ----------

function renderCellHead(
  cell: HTMLElement,
  cellDate: Date,
  opts: RenderOpts
) {
  const { state, plugin } = opts;
  const head = cell.createDiv({ cls: "it-cal-cell-head" });
  const dayLabel = head.createSpan({ cls: "it-cal-cell-day" });
  // Always just the day number — the column header above already shows the
  // short name ("Sun", "Mon", …) so repeating "Sunday" inside the cell is
  // redundant and would overflow the today-circle in narrow widths.
  dayLabel.setText(String(cellDate.getDate()));

  const cellIso = isoDate(cellDate);
  const addBtn = head.createEl("button", {
    cls: "it-icon-btn it-icon-btn-mini it-cal-add-btn",
    attr: { "aria-label": tr("cal.addTaskAria"), type: "button" },
  });
  setIcon(addBtn, "plus");
  addBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Seed whichever field the calendar is placed by, so the clicked day
    // pre-fills (due_date, start_date, or a date custom field). Read-only
    // sources (created/updated) yield no preset.
    const preset = presetForDateSource(opts.context.dateField, cellIso);
    const modalOpts: any = Object.keys(preset).length ? { preset } : {};
    const loc = state.location;
    if (loc.kind === "list") modalOpts.listPath = loc.path;
    else if (loc.kind === "folder") modalOpts.scopeFolderPath = loc.path;
    else if (loc.kind === "space") modalOpts.scopeSpacePath = loc.path;
    new QuickTaskModal(plugin.app, plugin, modalOpts).open();
  });
}

function renderCellPills(
  cell: HTMLElement,
  entries: PillEntry[],
  pillOpts: { limit: number },
  opts: RenderOpts
) {
  const limit = pillOpts.limit;
  const expandable = isFinite(limit) && entries.length > limit;

  // Wrap pills + toggle in a container so we can re-render in place when the
  // user expands/collapses the cell — the surrounding grid row grows naturally
  // to fit the new content height.
  const wrap = cell.createDiv({ cls: "it-cal-pills" });
  let expanded = false;

  const render = () => {
    wrap.empty();
    const visible = expanded || !expandable ? entries : entries.slice(0, limit);
    for (const e of visible) renderPill(wrap, e, opts);
    if (expandable) {
      const toggle = wrap.createEl("button", {
        cls: "it-cal-more",
        text: expanded ? tr("cal.showLess") : tr("cal.more", { count: entries.length - limit }),
        attr: { type: "button", "aria-expanded": String(expanded) },
      });
      if (expanded) toggle.addClass("is-expanded");
      toggle.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        expanded = !expanded;
        cell.toggleClass("is-expanded", expanded);
        render();
      });
    }
  };
  render();
}

function renderPill(parent: HTMLElement, entry: PillEntry, opts: RenderOpts) {
  const { context, onTaskClick } = opts;
  const t = entry.task;
  // Mobile pills are intentionally minimal — color + title only (product
  // decision): the extra field chips don't fit small day cells, and drag to
  // reschedule is replaced by editing the date inside the task modal.
  const mobile = Platform.isMobile;
  // Read-only date sources (created/updated) can't be rescheduled by drag.
  const dragOk = !entry.isVirtual && !mobile && isDateSourceWritable(context.dateField, DATE_SOURCE_DUE);
  const pill = parent.createDiv({
    cls: "it-cal-pill" + (entry.isVirtual ? " is-virtual" : ""),
    attr: { draggable: dragOk ? "true" : "false" },
  });
  if (entry.isVirtual) pill.setAttribute("title", `Recurring · projected for ${entry.virtualDate}. Click to open the parent item.`);

  pill.style.setProperty("--pill-color", resolvePillColor(t, context));
  if (isOverdue(t.data.due_date, t.data.status_group)) pill.addClass("is-overdue");

  // Row 1 — title + the very top-most decorations (type icon, ID prefix). The
  // title is always shown; everything else is gated by visibleFields, matching
  // the same control surface as List/Board/Table. On mobile we keep just the
  // title for a clean, scannable single line.
  const head = pill.createDiv({ cls: "it-cal-pill-head" });
  if (!mobile) {
    if (entry.isVirtual) {
      const repeatBadge = head.createSpan({ cls: "it-cal-pill-repeat" });
      setIcon(repeatBadge, "repeat");
    }
    if (isVis(opts, "type_icon")) {
      const ttype = context.taskTypesOrder.find((x) => x.id === t.data.type);
      const wrap = head.createSpan({ cls: "it-cal-pill-type" });
      const icon = renderIconish(wrap, (ttype as any)?.icon || typeEmoji(t.data.type), { cls: "it-cal-pill-type-icon" });
      if (icon && ttype?.color) icon.style.color = ttype.color;
    }
    if ((isVis(opts, "custom_id") || isVis(opts, "id"))) {
      const idText = (isVis(opts, "custom_id") && t.data.custom_id) ? t.data.custom_id
        : (isVis(opts, "id") ? t.data.id : "");
      if (idText) head.createSpan({ cls: "it-cal-pill-id", text: idText });
    }
  }
  head.createSpan({ text: t.data.title || tr("common.untitled"), cls: "it-cal-pill-title" });

  // Row 2 — chip strip for everything else. Stays hidden if no field actually
  // produces a chip (so single-line pills don't grow taller for nothing).
  // Skipped entirely on mobile.
  if (!mobile) {
    const fields = pill.createDiv({ cls: "it-cal-pill-fields" });
    const renderedAlready = new Set(["type_icon", "id", "custom_id"]);
    for (const field of context.visibleFields) {
      if (renderedAlready.has(field)) continue;
      renderField(fields, field, t, opts);
    }
    if (fields.children.length === 0) fields.remove();
  }

  pill.addEventListener("click", (e) => { e.stopPropagation(); onTaskClick(t); });
  // Virtual occurrences must not be draggable (would imply changing due_date,
  // which doesn't make sense for a projection). Drag is also disabled on mobile.
  if (dragOk) {
    pill.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData("text/plain", t.data.id);
      // Use an explicit drag image clipped to the pill's box. The browser's
      // default drag snapshot otherwise captures painted content wider than the
      // box (e.g. a long linked-tasks chip), making the translucent ghost bleed
      // into the neighbouring day cells.
      const rect = pill.getBoundingClientRect();
      const cell = pill.closest(".it-cal-cell") as HTMLElement | null;
      const w = Math.round(Math.min(rect.width, cell ? cell.clientWidth : rect.width));
      const ghost = pill.cloneNode(true) as HTMLElement;
      Object.assign(ghost.style, {
        position: "fixed", top: "-1000px", left: "0",
        width: `${w}px`, maxWidth: `${w}px`, height: `${Math.round(rect.height)}px`,
        margin: "0", overflow: "hidden", pointerEvents: "none",
      });
      document.body.appendChild(ghost);
      const offX = Math.max(0, Math.min(Math.round(e.offsetX), w - 1));
      e.dataTransfer.setDragImage(ghost, offX, Math.round(e.offsetY));
      // The browser snapshots synchronously; drop the clone right after.
      setTimeout(() => ghost.remove(), 0);
    });
  }
}

function isVis(opts: RenderOpts, field: string): boolean {
  return opts.context.visibleFields.includes(field);
}

// Renders a single configured field on the pill. Mirrors the chip helpers used
// by List/Board/Table so visual styling stays consistent across views.
function renderField(parent: HTMLElement, field: string, t: TaskFile, opts: RenderOpts) {
  const { context } = opts;
  const chipStyles = context.chipStyles;

  if (field === "status") {
    const so = context.statuses.find((s) => s.id === t.data.status);
    statusChip(parent, so, undefined, chipStyles);
    return;
  }
  if (field === "priority") {
    priorityChip(parent, t.data.priority, context.priorities, undefined, chipStyles);
    return;
  }
  if (field === "start_date") {
    if (t.data.start_date) {
      parent.createSpan({ cls: "it-chip it-chip-date", text: "▶ " + formatDate(t.data.start_date) });
    }
    return;
  }
  if (field === "tags") {
    const tagColorMap = new Map(context.tagsPalette.map((td) => [td.name, td.color]));
    for (const tg of t.data.tags || []) tagChip(parent, tg, tagColorMap.get(tg), undefined, chipStyles);
    return;
  }
  if (field === "context") {
    const colorByName: Record<string, string> = {};
    for (const cl of context.contextLabels) colorByName[cl.name] = cl.color;
    for (const cl of (t.data.context || [])) {
      const chip = parent.createSpan({ cls: "it-chip it-chip-tag", text: cl });
      if (colorByName[cl]) chip.style.setProperty("--chip-color", colorByName[cl]);
      applyChipStyleByKind(chip, "context", chipStyles);
    }
    return;
  }
  if (field === "subtask_count") {
    const c = context.subtaskStats?.get(t.data.id)?.total ?? 0;
    if (c > 0) parent.createSpan({ cls: "it-chip it-chip-meta", text: `↳ ${c}` });
    return;
  }
  if (field === "relationship_count") {
    const c = context.relationshipCounts?.get(t.data.id) ?? 0;
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
    const cf = context.customFields.find((x) => x.id === id);
    if (!cf) return;
    const raw = effectiveCustomFieldValue(t, cf, { subtaskStats: context.subtaskStats });
    const isEmpty = isEmptyCustomFieldValue(raw);
    // Resolved once in tasksContext (transient override ⊕ inherited config).
    const showWhenEmpty = context.cfShowWhenEmpty ?? false;
    const showName = context.cfShowName ?? false;
    if (isEmpty && !showWhenEmpty) return;
    const wrap = parent.createSpan({ cls: "it-chip it-chip-meta it-cal-cf-chip" });
    if ((context as any).showFieldIcons) renderCfTypeIcon(wrap, cf.type); // colored type icon leads the chip
    if (showName) wrap.createSpan({ text: `${cf.name}: `, cls: "it-cal-cf-label" });
    if (!isEmpty) renderCustomFieldValue(wrap, cf, raw, { task: t, index: opts.plugin.index, mode: "calendar", chipStyles: context.chipStyles, subtaskStats: context.subtaskStats });
    return;
  }
}

// Picks the pill's accent color from the configured `color_by` source. When the
// task has multiple values for that source (e.g. several context labels), the
// first one's color is used — matches the spec's "first element" rule.
function resolvePillColor(t: TaskFile, ctx: CalendarContext): string {
  const FALLBACK = "#2196F3";
  const source = ctx.calendarColorBy;

  const lookupColor = (src: string): string | undefined => {
    if (src === "status") return ctx.statuses.find((s) => s.id === t.data.status)?.color;
    if (src === "priority") return ctx.priorities.find((p) => p.id === t.data.priority)?.color;
    if (src === "context") {
      const first = (t.data.context || [])[0];
      if (!first) return undefined;
      return ctx.contextLabels.find((c) => c.name === first)?.color;
    }
    if (src === "type") return ctx.taskTypesOrder.find((tt) => tt.id === t.data.type)?.color;
    if (src.startsWith("custom_field:")) {
      const id = src.slice("custom_field:".length);
      const cf = ctx.customFields.find((c) => c.id === id);
      if (!cf || !cf.options?.length) return undefined;
      const raw = t.data.custom_fields?.[id];
      // dropdown → single string; labels → array; both pick the first present value.
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (value === undefined || value === null || value === "") return undefined;
      const str = String(value);
      const opt = cf.options.find((o) => (o.value ?? o.label) === str || o.label === str);
      return opt?.color;
    }
    return undefined;
  };

  // Explicit source — single attempt; no fallback chain to keep the choice
  // honest. When the task lacks a value for that source, fall back to neutral
  // so the pill still renders without misleading color.
  if (source && source !== CALENDAR_COLOR_SOURCE_DEFAULT) {
    return lookupColor(source) || FALLBACK;
  }

  // Default: legacy fallback chain (task.color → priority → status → neutral).
  if (t.data.color) return t.data.color;
  const pri = lookupColor("priority"); if (pri) return pri;
  const stat = lookupColor("status"); if (stat) return stat;
  return FALLBACK;
}

function attachDayDnd(cell: HTMLElement, cellDate: Date, opts: RenderOpts) {
  const { plugin } = opts;
  const dateField = opts.context.dateField;
  // Read-only sources (created/updated stamps) can't be rescheduled by drag.
  if (!isDateSourceWritable(dateField, DATE_SOURCE_DUE)) return;
  cell.addEventListener("dragover", (e) => { e.preventDefault(); cell.addClass("is-drop-target"); });
  cell.addEventListener("dragleave", () => cell.removeClass("is-drop-target"));
  cell.addEventListener("drop", async (e) => {
    e.preventDefault();
    cell.removeClass("is-drop-target");
    const id = e.dataTransfer?.getData("text/plain");
    if (!id) return;
    await plugin.index.updateTask(id, (d) => ({ data: { ...d, ...mapDatePatch(d, { due_date: isoDate(cellDate) }, undefined, dateField) } }));
  });
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

function formatMins(m: number): string {
  if (!m) return "";
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min}m`;
  if (min === 0) return `${h}h`;
  return `${h}h${min}m`;
}
