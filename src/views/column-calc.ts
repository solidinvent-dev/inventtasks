// Column calculations — per-column aggregations shown under each group (when
// grouping is on) and at the very bottom over all rows, in the List and Table
// views. Configured per-location (shared by both views) and stored in
// PersistedViewState.columnCalcs keyed by field key.
//
// This module is intentionally view-agnostic: the views own their DOM (td vs
// grid cell, freezing, etc.) and call into here for the value extraction,
// computation, formatting, the config popover, and a small cell-filler helper.

import { ContextLocation, ColumnCalc, CalcType, CustomFieldDef, PriorityDef, ResolvedChipStyles, StatusDef, TaskFile, ViewType } from "../types";
import type { GroupContext } from "../data/filters";
import { formatDuration } from "../utils/dates";
import { showPopover } from "../ui/components";
import { locationKey } from "../view-state";
import type InventTasksPlugin from "../main";
import { customFieldText, effectiveCustomFieldValue } from "../data/custom-fields";
import { t } from "../i18n";

type FieldKind = "number" | "date" | "bool" | "text";

interface CellVal { num: number | null; bool: boolean | null; str: string; empty: boolean; }
const EMPTY_CELL: CellVal = { num: null, bool: null, str: "", empty: true };

// The render context main-view builds for the List and Table views. Declared
// here because both views also hand it to the column calculations, which only
// read the GroupContext part (custom fields, statuses, priorities, stats).
export interface RowViewContext extends GroupContext {
  statuses: StatusDef[];
  priorities: PriorityDef[];
  priorityLabels: Record<number, string>;
  visibleFields: string[];
  chipStyles?: ResolvedChipStyles;
  relationshipCounts?: Map<string, number>;
  showFieldIcons?: boolean;
  subtaskMode?: "parents" | "nested" | "flat";
}

function customFieldOf(field: string, context: GroupContext): CustomFieldDef | undefined {
  if (!field.startsWith("custom_field:")) return undefined;
  const id = field.slice("custom_field:".length);
  return context.customFields?.find((c) => c.id === id);
}

// Classifies a column so we know which calculations make sense and how to
// format numeric results.
export function fieldKind(field: string, context: GroupContext): FieldKind {
  if (field === "time_estimate" || field === "time_tracked" || field === "sprint_points" || field === "priority") return "number";
  if (field === "due_date" || field === "start_date" || field === "created_at" || field === "updated_at") return "date";
  const cf = customFieldOf(field, context);
  if (cf) {
    switch (cf.type) {
      case "number": case "money": case "rating": case "progress_manual": case "progress_auto": return "number";
      case "date": case "datetime": return "date";
      case "checkbox": return "bool";
      default: return "text";
    }
  }
  return "text";
}

// Extracts a task's value for a column in the three shapes a calculation might
// need: numeric, boolean, and text — plus whether it's "empty".
export function cellValue(t: TaskFile, field: string, plugin: InventTasksPlugin, context: GroupContext): CellVal {
  const d = t.data;
  const num = (v: number | string | null | undefined): CellVal => (v == null || v === "" ? { ...EMPTY_CELL } : { num: Number(v), bool: null, str: String(v), empty: isNaN(Number(v)) });
  const str = (v: string | null | undefined): CellVal => { const s = v ? String(v) : ""; return { num: null, bool: null, str: s, empty: s.trim() === "" }; };

  switch (field) {
    case "time_estimate": return num(d.time_estimate);
    case "time_tracked": return num(d.time_tracked);
    case "sprint_points": return num(d.sprint_points);
    case "priority": {
      if (d.priority == null) return { ...EMPTY_CELL };
      const lab = context.priorities?.find((p) => p.id === d.priority)?.label ?? String(d.priority);
      return { num: Number(d.priority), bool: null, str: lab, empty: false };
    }
    case "due_date": case "start_date": case "created_at": case "updated_at": {
      const v = d[field];
      return { num: v ? (Date.parse(String(v)) || null) : null, bool: null, str: v ? String(v).slice(0, 10) : "", empty: !v };
    }
    case "title": return str(d.title);
    case "id": return str(d.id);
    case "custom_id": return str(d.custom_id);
    case "type": return str(d.type || "task");
    case "status": return str(context.statuses?.find((s) => s.id === d.status)?.name || d.status || "");
    case "tags": { const a = d.tags || []; return { num: null, bool: null, str: a.join(", "), empty: a.length === 0 }; }
    case "context": { const a = d.context || []; return { num: null, bool: null, str: a.join(", "), empty: a.length === 0 }; }
    case "list": case "folder": case "space": {
      const ln = plugin.index.findList(t.listPath || "");
      let name = "";
      if (field === "list") name = ln?.config.name || d.list || "";
      else if (field === "folder") { const f = ln?.folderPath ? plugin.index.findFolder(ln.folderPath) : undefined; name = f?.config.name || d.folder || ""; }
      else { const sp = ln?.spacePath ? plugin.index.findSpace(ln.spacePath) : undefined; name = sp?.config.name || d.space || ""; }
      return str(name);
    }
  }

  const cf = customFieldOf(field, context);
  if (cf) {
    const raw: unknown = effectiveCustomFieldValue(t, cf, {
      subtaskStats: context.subtaskStats,
      taskTitles: context.taskTitles,
    });
    if (cf.type === "checkbox") {
      const b = raw === true;
      return { num: b ? 1 : 0, bool: b, str: b ? "true" : "", empty: raw == null };
    }
    if (cf.type === "number" || cf.type === "money" || cf.type === "rating" || cf.type === "progress_manual" || cf.type === "progress_auto") {
      const n = typeof raw === "number" ? raw : (raw != null && raw !== "" && !isNaN(Number(raw)) ? Number(raw) : null);
      return { num: n, bool: null, str: n == null ? "" : String(n), empty: n == null };
    }
    if (cf.type === "date" || cf.type === "datetime") {
      const ds = raw as string | null | undefined;
      return { num: ds ? (Date.parse(String(ds)) || null) : null, bool: null, str: ds ? String(ds).slice(0, 10) : "", empty: !ds };
    }
    const s = customFieldText(cf, raw, { taskTitles: context.taskTitles });
    return { num: null, bool: null, str: s, empty: s.trim() === "" };
  }
  return { ...EMPTY_CELL };
}

// ---------- Calculation catalogue ----------

const ALL_KINDS: FieldKind[] = ["number", "date", "bool", "text"];
interface CalcDef { type: CalcType; kinds: FieldKind[]; needs?: "pattern" | "match"; numeric?: boolean; }

const CALC_DEFS: CalcDef[] = [
  { type: "count", kinds: ALL_KINDS },
  { type: "count_filled", kinds: ALL_KINDS },
  { type: "count_empty", kinds: ALL_KINDS },
  { type: "count_unique", kinds: ["number", "date", "text"] },
  { type: "sum", kinds: ["number"], numeric: true },
  { type: "avg", kinds: ["number"], numeric: true },
  { type: "min", kinds: ["number", "date"], numeric: true },
  { type: "max", kinds: ["number", "date"], numeric: true },
  { type: "range", kinds: ["number"], numeric: true },
  { type: "checked", kinds: ["bool"] },
  { type: "checked_percent", kinds: ["bool"] },
  { type: "regex_count", kinds: ALL_KINDS, needs: "pattern" },
  { type: "equals_count", kinds: ALL_KINDS, needs: "match" },
];

export function calcDefsFor(field: string, context: GroupContext): CalcDef[] {
  const k = fieldKind(field, context);
  return CALC_DEFS.filter((d) => d.kinds.includes(k));
}

// ---------- Compute ----------

function fmtNumber(v: number, field: string, plugin: InventTasksPlugin, context: GroupContext): string {
  if (field === "time_estimate" || field === "time_tracked") return formatDuration(Math.round(v)) || "0m";
  const cf = customFieldOf(field, context);
  if (cf?.type === "money") {
    const cur = (cf.currency || plugin.prefs.defaultCurrency || "PLN").toUpperCase();
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(v);
    } catch {
      return `${(Math.round(v * 100) / 100).toFixed(2)} ${cur}`;
    }
  }
  return (Math.round(v * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

const FACTOR_TYPES = new Set<CalcType>(["sum", "avg", "min", "max", "range"]);

export function computeCalc(calc: ColumnCalc, tasks: TaskFile[], field: string, plugin: InventTasksPlugin, context: GroupContext): string {
  const acc = (t: TaskFile) => cellValue(t, field, plugin, context);
  const kind = fieldKind(field, context);
  switch (calc.type) {
    case "count": return String(tasks.length);
    case "count_filled": return String(tasks.filter((t) => !acc(t).empty).length);
    case "count_empty": return String(tasks.filter((t) => acc(t).empty).length);
    case "count_unique": {
      const s = new Set<string>();
      for (const t of tasks) { const v = acc(t); if (!v.empty) s.add(v.str); }
      return String(s.size);
    }
    case "checked": return String(tasks.filter((t) => acc(t).bool === true).length);
    case "checked_percent": {
      if (!tasks.length) return "0%";
      const c = tasks.filter((t) => acc(t).bool === true).length;
      return Math.round((c / tasks.length) * 100) + "%";
    }
    case "regex_count": {
      let re: RegExp;
      try { re = new RegExp(calc.pattern || ""); } catch { return t("calc.regexError"); }
      return String(tasks.filter((t) => re.test(acc(t).str)).length);
    }
    case "equals_count": {
      const m = (calc.match || "").trim().toLowerCase();
      if (m === "") return "0";
      return String(tasks.filter((t) => acc(t).str.trim().toLowerCase() === m).length);
    }
    case "sum": case "avg": case "min": case "max": case "range": {
      if (kind === "date" && (calc.type === "min" || calc.type === "max")) {
        let best: string | null = null;
        for (const t of tasks) {
          const v = acc(t); if (v.empty || !v.str) continue;
          if (best === null) best = v.str;
          else if (calc.type === "min" ? v.str < best : v.str > best) best = v.str;
        }
        return best ?? "—";
      }
      const nums: number[] = [];
      for (const t of tasks) { const n = acc(t).num; if (n != null && !isNaN(n)) nums.push(n); }
      if (!nums.length) return "—";
      let val: number;
      if (calc.type === "sum") val = nums.reduce((a, b) => a + b, 0);
      else if (calc.type === "avg") val = nums.reduce((a, b) => a + b, 0) / nums.length;
      else if (calc.type === "min") val = Math.min(...nums);
      else if (calc.type === "max") val = Math.max(...nums);
      else val = Math.max(...nums) - Math.min(...nums);
      if (typeof calc.factor === "number" && isFinite(calc.factor)) val = val * calc.factor;
      return fmtNumber(val, field, plugin, context);
    }
  }
  return "";
}

export function calcShortLabel(calc: ColumnCalc): string {
  let l = t(`calc.short.${calc.type}`) || calc.type;
  if (FACTOR_TYPES.has(calc.type) && typeof calc.factor === "number" && isFinite(calc.factor) && calc.factor !== 1) {
    l += ` ×${calc.factor}`;
  }
  return l;
}

// ---------- Persistence ----------

// Persists the per-column calculations for ONE view type at a location,
// preserving the other views' calcs. Calculations are per-view (a List's
// footer is independent from the same location's Table footer).
export function persistColumnCalcs(plugin: InventTasksPlugin, location: ContextLocation, viewType: ViewType, calcs: Record<string, ColumnCalc>) {
  const map = plugin.prefs.viewStateByLocation || {};
  const key = locationKey(location);
  const entry = map[key] || {};
  const byView = { ...(entry.columnCalcs || {}) };
  byView[viewType] = { ...calcs };
  map[key] = { ...entry, columnCalcs: byView };
  plugin.prefs.viewStateByLocation = map;
  void plugin.saveSettings();
}

export function hasAnyCalc(calcs?: Record<string, ColumnCalc>): boolean {
  return !!calcs && Object.keys(calcs).length > 0;
}

// ---------- Cell rendering ----------

// Fills a footer / summary cell with the computed value.
//  mode "footer" → grand total: short label + value, and gets `is-empty` (so
//                  hover can prompt "Calculate") when no calc is configured.
//  mode "group"  → per-group: value only (compact), read-only.
export function fillCalcCell(
  el: HTMLElement, field: string, calc: ColumnCalc | undefined,
  tasks: TaskFile[], plugin: InventTasksPlugin, context: GroupContext, mode: "footer" | "group",
) {
  el.empty();
  if (!calc) { if (mode === "footer") el.addClass("is-empty"); return; }
  el.removeClass("is-empty");
  const val = computeCalc(calc, tasks, field, plugin, context);
  if (mode === "footer") {
    el.createSpan({ cls: "it-calc-label", text: calcShortLabel(calc) });
    el.createSpan({ cls: "it-calc-val", text: val });
  } else {
    el.createSpan({ cls: "it-calc-val", text: val });
    el.title = `${calcShortLabel(calc)}: ${val}`;
  }
}

// ---------- Config popover ----------

function closeAllPopovers() {
  document.querySelectorAll(".it-popover").forEach((el) => el.remove());
}

// Opens the per-column calculation picker anchored to `anchor`. Calls
// `onChange(calc | null)` when the user applies a calc or removes it.
export function openCalcMenu(opts: {
  anchor: HTMLElement;
  field: string;
  fieldLabel: string;
  current?: ColumnCalc;
  plugin: InventTasksPlugin;
  context: GroupContext;
  onChange: (calc: ColumnCalc | null) => void;
}) {
  const { anchor, field, fieldLabel, current, context } = opts;
  const kind = fieldKind(field, context);
  const defs = calcDefsFor(field, context);
  let draft: ColumnCalc = current ? { ...current } : { type: defs[0]?.type || "count" };

  showPopover(anchor, (root) => {
    const build = () => {
      root.empty();
      root.addClass("it-calc-menu");
      root.createDiv({ cls: "it-calc-menu-title", text: fieldLabel });

      const def = defs.find((x) => x.type === draft.type);
      const isImmediate = (d?: CalcDef) => !!d && !d.needs && !(kind === "number" && d.numeric);

      const list = root.createDiv({ cls: "it-calc-opts" });
      for (const d of defs) {
        const btn = list.createEl("button", { cls: "it-calc-opt" + (draft.type === d.type ? " is-active" : ""), attr: { type: "button" } });
        btn.createSpan({ text: t(`calc.${d.type}`) });
        btn.addEventListener("click", () => {
          if (isImmediate(d)) {
            // No parameters → apply right away (1-click for count/checked/etc.).
            closeAllPopovers();
            opts.onChange({ type: d.type });
            return;
          }
          draft = { ...draft, type: d.type };
          build();
        });
      }

      // Parameter inputs for the active type.
      const params = root.createDiv({ cls: "it-calc-params" });
      if (draft.type === "regex_count") {
        params.createDiv({ cls: "it-calc-param-label", text: t("calc.regexPattern") });
        const inp = params.createEl("input", { cls: "it-input", attr: { type: "text", placeholder: t("calc.regexPlaceholder") } });
        inp.value = draft.pattern || "";
        inp.addEventListener("input", () => { draft.pattern = inp.value; refreshApply(); });
      } else if (draft.type === "equals_count") {
        params.createDiv({ cls: "it-calc-param-label", text: t("calc.equalsValue") });
        const inp = params.createEl("input", { cls: "it-input", attr: { type: "text", placeholder: t("calc.equalsPlaceholder") } });
        inp.value = draft.match || "";
        inp.addEventListener("input", () => { draft.match = inp.value; refreshApply(); });
      }
      if (kind === "number" && def?.numeric) {
        params.createDiv({ cls: "it-calc-param-label", text: t("calc.factor") });
        const inp = params.createEl("input", { cls: "it-input", attr: { type: "number", step: "any", placeholder: t("calc.factorPlaceholder") } });
        inp.value = draft.factor != null ? String(draft.factor) : "";
        inp.addEventListener("input", () => { const n = parseFloat(inp.value); draft.factor = isNaN(n) ? undefined : n; });
      }

      const foot = root.createDiv({ cls: "it-calc-foot" });
      const left = foot.createEl("button", { cls: "it-btn-ghost it-btn-mini", text: current ? t("common.remove") : t("common.cancel"), attr: { type: "button" } });
      left.addEventListener("click", () => { closeAllPopovers(); if (current) opts.onChange(null); });
      const apply = foot.createEl("button", { cls: "it-btn-primary it-btn-mini", text: t("common.apply"), attr: { type: "button" } });
      apply.addEventListener("click", () => {
        if (!canApply()) return;
        closeAllPopovers();
        opts.onChange({ ...draft });
      });

      const canApply = (): boolean => {
        if (draft.type === "regex_count") {
          if (!draft.pattern) return false;
          try { new RegExp(draft.pattern); } catch { return false; }
          return true;
        }
        if (draft.type === "equals_count") return !!(draft.match && draft.match.trim());
        return true;
      };
      const refreshApply = () => { apply.disabled = !canApply(); };
      refreshApply();
    };
    build();
  });
}
