import { FilterCondition, FilterGroup, SortRule, TaskFile, StatusDef, CustomFieldDef, TaskData } from "../types";
import { parseDate, isOverdue, dayKey, todayKey, dayDiff, relativeBucket, bucketOrder } from "../utils/dates";
import { customFieldSortValue, effectiveCustomFieldValue } from "./custom-fields";
import { t as tr, fieldLabelFrom } from "../i18n";

// ---------- Predicates ----------

export interface CustomFieldContext {
  customFields?: CustomFieldDef[];
  subtaskStats?: Map<string, { total: number; done: number }>;
  taskTitles?: Map<string, string>;
}

// A task's data read by a field key that is only known at runtime.
type TaskRecord = TaskData & Record<string, unknown>;
// Date-like field values as the date helpers read them.
type DateText = string | null | undefined;

function getFieldValue(t: TaskFile, field: string, context: CustomFieldContext = {}): unknown {
  if (field.startsWith("custom_field:")) {
    const key = field.slice("custom_field:".length);
    const cf = context.customFields?.find((candidate) => candidate.id === key);
    return cf ? effectiveCustomFieldValue(t, cf, context) : t.data.custom_fields?.[key];
  }
  const d = t.data as TaskRecord;
  return d[field];
}

function linkedParts(raw: unknown): string[] | null {
  const value = raw as { label?: unknown; value?: unknown } | null | undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.value !== "string") return null;
  return [value.label, value.value].filter((part): part is string => typeof part === "string" && !!part);
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  const parts = linkedParts(value);
  return parts ? parts.join(" ") : null;
}

function equalsValue(value: unknown, expected: unknown): boolean {
  const parts = linkedParts(value);
  return parts ? parts.includes(String(expected)) : value === expected;
}

function timeValue(value: unknown): string | null {
  const match = typeof value === "string" ? /^(\d{2}):(\d{2})/.exec(value) : null;
  return match ? `${match[1]}:${match[2]}` : null;
}

export function evaluateCondition(t: TaskFile, c: FilterCondition, context: CustomFieldContext = {}): boolean {
  const v = getFieldValue(t, c.field, context);
  const op = c.operator;
  switch (op) {
    case "is":
    case "equals":
      return equalsValue(v, c.value);
    case "is_not":
    case "not_equals":
      return !equalsValue(v, c.value);
    case "contains": {
      const text = textValue(v);
      return !!text && text.toLowerCase().includes(String(c.value).toLowerCase());
    }
    case "not_contains": {
      const text = textValue(v);
      return !(text && text.toLowerCase().includes(String(c.value).toLowerCase()));
    }
    case "starts_with": {
      const text = textValue(v);
      return !!text && text.toLowerCase().startsWith(String(c.value).toLowerCase());
    }
    case "ends_with": {
      const text = textValue(v);
      return !!text && text.toLowerCase().endsWith(String(c.value).toLowerCase());
    }
    case "is_empty":
      return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
    case "is_not_empty":
      return !(v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0));
    case "in":
    case "any_of":
      if (!Array.isArray(c.value)) return false;
      { const set = c.value as unknown[];
        if (Array.isArray(v)) return v.some((x) => set.includes(x));
        return set.includes(v); }
    case "not_in":
    case "none_of":
      if (!Array.isArray(c.value)) return true;
      { const set = c.value as unknown[];
        if (Array.isArray(v)) return !v.some((x) => set.includes(x));
        return !set.includes(v); }
    case "all_of":
      if (!Array.isArray(c.value) || !Array.isArray(v)) return false;
      return c.value.every((x) => v.includes(x));
    case "gt":
    case "greater_than":
      return typeof v === "number" && v > Number(c.value);
    case "lt":
    case "less_than":
      return typeof v === "number" && v < Number(c.value);
    case "gte":
      return typeof v === "number" && v >= Number(c.value);
    case "lte":
      return typeof v === "number" && v <= Number(c.value);
    case "is_today": {
      const dk = dayKey(v as DateText);
      return !!dk && dk === todayKey();
    }
    case "is_tomorrow": {
      const dk = dayKey(v as DateText);
      return !!dk && dayDiff(todayKey(), dk) === 1;
    }
    case "is_yesterday": {
      const dk = dayKey(v as DateText);
      return !!dk && dayDiff(todayKey(), dk) === -1;
    }
    case "is_overdue":
      return isOverdue(v as DateText, t.data.status_group);
    case "before": {
      const tv = timeValue(v), tref = timeValue(c.value);
      if (tv && tref) return tv < tref;
      const dk = dayKey(v as DateText); const ref = dayKey(c.value as string | null | undefined);
      return !!(dk && ref && dk < ref);
    }
    case "after": {
      const tv = timeValue(v), tref = timeValue(c.value);
      if (tv && tref) return tv > tref;
      const dk = dayKey(v as DateText); const ref = dayKey(c.value as string | null | undefined);
      return !!(dk && ref && dk > ref);
    }
    case "in_next": {
      const dk = dayKey(v as DateText);
      if (!dk) return false;
      const diff = dayDiff(todayKey(), dk);
      return diff >= 0 && diff <= Number(c.value);
    }
    case "in_last": {
      const dk = dayKey(v as DateText);
      if (!dk) return false;
      const diff = dayDiff(todayKey(), dk);
      // date falls within the past N days (inclusive of today)
      return diff <= 0 && diff >= -Number(c.value);
    }
    case "between": {
      // value is a 2-tuple [min, max]. Works for numbers and for dates
      // (ISO strings) — numeric comparison first, calendar-day fallback.
      if (!Array.isArray(c.value) || c.value.length < 2) return false;
      const [lo, hi] = c.value as unknown[];
      if (typeof v === "number") {
        const a = Number(lo), b = Number(hi);
        return v >= Math.min(a, b) && v <= Math.max(a, b);
      }
      const tv = timeValue(v), lot = timeValue(lo), hit = timeValue(hi);
      if (tv && lot && hit) {
        const loT = lot < hit ? lot : hit;
        const hiT = lot < hit ? hit : lot;
        return tv >= loT && tv <= hiT;
      }
      const dk = dayKey(v as DateText), lok = dayKey(lo as DateText), hik = dayKey(hi as DateText);
      if (dk && lok && hik) {
        const loK = lok < hik ? lok : hik;
        const hiK = lok < hik ? hik : lok;
        return dk >= loK && dk <= hiK;
      }
      return false;
    }
    case "is_checked":
      return v === true;
    case "is_unchecked":
      return v === false || v === undefined || v === null;
  }
  return false;
}

export function evaluateGroup(t: TaskFile, g: FilterGroup, context: CustomFieldContext = {}): boolean {
  if (!g.conditions || g.conditions.length === 0) return true;
  const results = g.conditions.map((c) => {
    if ((c as FilterGroup).logic) return evaluateGroup(t, c as FilterGroup, context);
    return evaluateCondition(t, c as FilterCondition, context);
  });
  return g.logic === "OR" ? results.some(Boolean) : results.every(Boolean);
}

export function applyFilters(tasks: TaskFile[], group: FilterGroup | undefined, context: CustomFieldContext = {}): TaskFile[] {
  if (!group) return tasks;
  return tasks.filter((t) => evaluateGroup(t, group, context));
}

// ---------- Sorting ----------

export interface SortContext extends CustomFieldContext {
  statuses?: StatusDef[];
  contextOrder?: string[];
  tagsOrder?: string[];
}

export function sortTasks(
  tasks: TaskFile[],
  rules: SortRule[] | undefined,
  opts: SortContext = {},
): TaskFile[] {
  if (!rules || rules.length === 0) return tasks;
  const statusOrder = new Map<string, number>();
  opts.statuses?.forEach((s, i) => statusOrder.set(s.id, s.order ?? i));
  // Decorate–sort–undecorate: sort keys are computed ONCE per task instead of
  // inside the comparator (which runs O(n log n) times and used to re-parse
  // dates / re-resolve custom fields on every comparison).
  const decorated = tasks.map((t) => ({
    t,
    keys: rules.map((r) => getSortValue(t, r.field, statusOrder, opts)),
  }));
  decorated.sort((a, b) => {
    for (let i = 0; i < rules.length; i++) {
      const av = a.keys[i];
      const bv = b.keys[i];
      const aEmpty = av === null || av === undefined;
      const bEmpty = bv === null || bv === undefined;
      // Missing values sink to the bottom in BOTH directions. Reversing a sort
      // is about reordering the values that exist, not about promoting the ones
      // that are absent — "due date, newest first" must not open with a block of
      // undated Items. Running this before the direction flip is what keeps it
      // stable, since negating the comparison would otherwise lift them to the top.
      if (aEmpty || bEmpty) {
        if (aEmpty && bEmpty) continue; // tie — let the next rule decide
        return aEmpty ? 1 : -1;
      }
      const cmp = compareValues(av, bv);
      if (cmp !== 0) return rules[i].direction === "desc" ? -cmp : cmp;
    }
    return 0;
  });
  return decorated.map((d) => d.t);
}

function getSortValue(t: TaskFile, field: string, statusOrder: Map<string, number>, opts: SortContext): unknown {
  if (field === "status") return statusOrder.get(t.data.status || "") ?? 999;
  // Missing values are reported as null, never as a sentinel like 99 or
  // Infinity. A sentinel is an ordinary value to the comparator, so it rides
  // along with the direction flip and lands FIRST on a descending sort — and
  // two Infinities subtract to NaN, which makes the comparator inconsistent and
  // the resulting order arbitrary. null routes them through the empty branch
  // instead, which keeps them at the bottom either way.
  if (field === "priority") return t.data.priority ?? null;
  if (field === "start_date") {
    const d = parseDate(t.data.start_date) || parseDate(t.data.due_date);
    return d ? d.getTime() : null;
  }
  if (field === "due_date" || field === "created_at" || field === "updated_at") {
    const d = parseDate(t.data[field]);
    return d ? d.getTime() : null;
  }
  if (field === "title") return (t.data.title || "").toLowerCase();
  if (field === "context") {
    const arr = t.data.context || [];
    if (arr.length === 0) return null;
    // Sort by config index of the first label so the ordering matches grouping.
    if (opts.contextOrder?.length) {
      const idx = opts.contextOrder.indexOf(arr[0]);
      return idx >= 0 ? idx : 999;
    }
    return arr[0].toLowerCase();
  }
  if (field === "tags") {
    const arr = t.data.tags || [];
    if (arr.length === 0) return null;
    if (opts.tagsOrder?.length) {
      const idx = opts.tagsOrder.indexOf(arr[0]);
      return idx >= 0 ? idx : 999;
    }
    return arr[0].toLowerCase();
  }
  if (field.startsWith("custom_field:")) {
    const id = field.slice(13);
    const cf = opts.customFields?.find((candidate) => candidate.id === id);
    const value = cf ? effectiveCustomFieldValue(t, cf, opts) : t.data.custom_fields?.[id];
    if (!cf) {
      if (value === undefined || value === null) return null;
      const shown: { toString(): string } = value;
      return String(shown).toLowerCase();
    }
    return customFieldSortValue(cf, value, opts);
  }
  return (t.data as TaskRecord)[field];
}

function compareValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) {
    if (b === null || b === undefined) return 0;
    return 1;
  }
  if (b === null || b === undefined) return -1;
  // Compare, don't subtract: Infinity - Infinity is NaN, and a comparator that
  // returns NaN leaves the sort order undefined.
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  return 0;
}

// ---------- Grouping ----------

export interface GroupBucket {
  key: string;
  label: string;
  color?: string;
  order?: number;
  // Optional icon (emoji or Lucide name) shown in the group header — set for
  // List groups (the list's icon) and Task-type groups (the type's icon).
  icon?: string;
  tasks: TaskFile[];
}

export interface GroupContext extends CustomFieldContext {
  statuses?: StatusDef[];
  priorities?: { id: number; label: string; color?: string }[];
  priorityLabels?: Record<number, string>;
  // Ordered names from each palette / typeset, used so group buckets follow
  // the user's configured order instead of alphabetical fallback.
  tagsOrder?: string[];
  contextOrder?: string[];
  taskTypesOrder?: { id: string; name?: string; color?: string; icon?: string }[];
  // List name → its icon/color, so grouping by List can show the list icon in
  // the group header (groupTasks has no index access of its own).
  listMeta?: Map<string, { icon?: string; color?: string }>;
  // Palettes / definitions used to resolve bucket COLOR and human LABEL
  // when grouping by a colored axis. Without these the buckets render as
  // gray chips with raw technical values.
  tagsPalette?: { name: string; color: string }[];
  contextLabels?: { name: string; color: string }[];
  customFields?: import("../types").CustomFieldDef[];
  // Where the "empty" bucket lands per axis (0 = before all items).
  // Effective order = emptyPosition - 0.5, so it sits between integer-indexed
  // real items.
  emptyPositions?: { status?: number; priority?: number; tags?: number; context?: number; type?: number };
  // Custom DISPLAY names for built-in fields (from resolveFieldLabels). Used so
  // the empty/"No X" bucket reflects a renamed field (e.g. Priority→Speed shows
  // "No Speed", not "No priority"). Display-only.
  fieldLabels?: Record<string, string>;
  direction?: "asc" | "desc";
}

export function groupTasks(
  tasks: TaskFile[],
  field: string,
  context: GroupContext
): GroupBucket[] {
  const buckets = new Map<string, GroupBucket>();
  const addToBucket = (key: string, label: string, color: string | undefined, order: number | undefined, t: TaskFile, icon?: string) => {
    if (!buckets.has(key)) {
      buckets.set(key, { key, label, color, order, icon, tasks: [] });
    }
    buckets.get(key)!.tasks.push(t);
  };
  const TAIL = 999_999;
  // Empty bucket order = emptyPosition - 0.5 → sits between integer indices.
  // Default emptyPosition = 0 → order = -0.5 → empty appears first (Asc).
  const emptyOrder = (axis: keyof NonNullable<GroupContext["emptyPositions"]>): number => {
    const pos = context.emptyPositions?.[axis];
    return (typeof pos === "number" ? pos : 0) - 0.5;
  };
  // "No <field>" label for an empty bucket — honors a renamed field (custom
  // display name wins, else the localized default field label).
  const emptyLabel = (axis: string): string =>
    tr("group.noValue", { field: fieldLabelFrom(context.fieldLabels, axis) });
  for (const t of tasks) {
    if (field === "status") {
      const s = context.statuses?.find((x) => x.id === t.data.status);
      const idx = context.statuses?.findIndex((x) => x.id === t.data.status) ?? -1;
      const isEmpty = !t.data.status || idx < 0;
      const key = isEmpty ? "__no_status" : t.data.status!;
      const order = isEmpty ? emptyOrder("status") : idx;
      addToBucket(key, isEmpty ? emptyLabel("status") : (s?.name || key), s?.color, order, t);
    } else if (field === "priority") {
      const p = t.data.priority;
      const isEmpty = !p;
      const key = isEmpty ? "__no_priority" : String(p);
      const lbl = isEmpty ? emptyLabel("priority") : (context.priorityLabels?.[p] ?? `Priority ${p}`);
      const idx = isEmpty ? -1 : (context.priorities?.findIndex((x) => x.id === p) ?? -1);
      const color = isEmpty ? undefined : context.priorities?.find((x) => x.id === p)?.color;
      const order = isEmpty ? emptyOrder("priority") : (idx >= 0 ? idx : TAIL);
      addToBucket(key, lbl, color, order, t);
    } else if (field === "tags") {
      const tags = t.data.tags || [];
      if (tags.length === 0) {
        addToBucket("__no_tags", emptyLabel("tags"), undefined, emptyOrder("tags"), t);
      } else {
        for (const tg of tags) {
          const idx = context.tagsOrder ? context.tagsOrder.indexOf(tg) : -1;
          const color = context.tagsPalette?.find((x) => x.name === tg)?.color;
          addToBucket(tg, tg, color, idx >= 0 ? idx : TAIL, t);
        }
      }
    } else if (field === "context") {
      const ctx = t.data.context || [];
      if (ctx.length === 0) {
        addToBucket("__no_context", emptyLabel("context"), undefined, emptyOrder("context"), t);
      } else {
        for (const cl of ctx) {
          const idx = context.contextOrder ? context.contextOrder.indexOf(cl) : -1;
          const color = context.contextLabels?.find((x) => x.name === cl)?.color;
          addToBucket(cl, cl, color, idx >= 0 ? idx : TAIL, t);
        }
      }
    } else if (field === "due_date") {
      const b = relativeBucket(t.data.due_date);
      addToBucket(b, b, undefined, bucketOrder(b), t);
    } else if (field === "start_date") {
      const b = relativeBucket(t.data.start_date);
      addToBucket(b, b, undefined, bucketOrder(b), t);
    } else if (field === "type") {
      const k = t.data.type || "task";
      const idx = context.taskTypesOrder ? context.taskTypesOrder.findIndex((x) => x.id === k) : -1;
      const def = context.taskTypesOrder?.find((x) => x.id === k);
      addToBucket(k, def?.name || k, def?.color, idx >= 0 ? idx : TAIL, t, def?.icon);
    } else if (field === "list") {
      const k = t.data.list || "__no_list";
      const meta = t.data.list ? context.listMeta?.get(t.data.list) : undefined;
      addToBucket(k, t.data.list || emptyLabel("list"), meta?.color, undefined, t, meta?.icon);
    } else if (field.startsWith("custom_field:")) {
      const id = field.slice(13);
      const cf = context.customFields?.find((f) => f.id === id);
      const v = cf ? effectiveCustomFieldValue(t, cf, context) : t.data.custom_fields?.[id];
      addCustomFieldBuckets(cf, v, addToBucket, t, TAIL, context);
    } else {
      addToBucket("__all", "All", undefined, 0, t);
    }
  }
  const direction = context.direction ?? "asc";
  const sorted = Array.from(buckets.values()).sort((a, b) => {
    const ao = a.order;
    const bo = b.order;
    if (ao !== undefined && bo !== undefined) {
      if (ao !== bo) return ao - bo;
    } else if (ao !== undefined) return -1;
    else if (bo !== undefined) return 1;
    return a.label.localeCompare(b.label);
  });
  return direction === "desc" ? sorted.reverse() : sorted;
}

// Per-type bucket builder for custom fields. Resolves the human-readable
// LABEL (not the technical value) and a COLOR per bucket based on the
// field's type. Critical because the old "String(v)" code:
//   - showed dropdown option *values* instead of *labels*
//   - showed "[object Object]" for {label, value} types (url/email/phone/location)
//   - joined labels arrays into a single comma-separated bucket
//   - never picked up option colors at all → all-gray group chips
function addCustomFieldBuckets(
  cf: import("../types").CustomFieldDef | undefined,
  v: unknown,
  push: (key: string, label: string, color: string | undefined, order: number | undefined, t: TaskFile) => void,
  t: TaskFile,
  TAIL: number,
  context: GroupContext,
): void {
  const isEmptyRaw =
    v === undefined || v === null || v === "" ||
    (Array.isArray(v) && v.length === 0);
  if (isEmptyRaw) {
    // Reflect the (custom-named) field: "No <field>" — falling back to a
    // generic "Empty" only when the field definition is missing.
    push("__empty", cf ? tr("group.noValue", { field: cf.name }) : tr("group.empty"), undefined, -0.5, t);
    return;
  }
  const shown: { toString(): string } = v;
  // Type-less fallback (CF def missing) — best-effort string display.
  if (!cf) {
    push(String(shown), String(shown), undefined, undefined, t);
    return;
  }
  const opts = cf.options ?? [];
  const findOpt = (raw: unknown) => opts.find((o) => (o.value ?? o.label) === raw);
  switch (cf.type) {
    case "dropdown": {
      const opt = findOpt(v);
      const key = String(shown);
      const idx = opts.findIndex((o) => (o.value ?? o.label) === v);
      push(key, opt?.label ?? key, opt?.color, idx >= 0 ? idx : TAIL, t);
      return;
    }
    case "labels": {
      const arr: unknown[] = Array.isArray(v) ? v : [v];
      for (const item of arr) {
        const opt = findOpt(item);
        const key = String(item);
        const idx = opts.findIndex((o) => (o.value ?? o.label) === item);
        push(key, opt?.label ?? key, opt?.color, idx >= 0 ? idx : TAIL, t);
      }
      return;
    }
    case "url":
    case "email":
    case "phone": {
      // Linked values are stored as { label?, value }; back-compat: bare strings too.
      const linked = v as { label?: unknown; value?: unknown } | string;
      const value = typeof linked === "object" && linked && "value" in linked ? linked.value : linked;
      const label = typeof linked === "object" && linked && linked.label ? linked.label : value;
      push(String(value), String(label), undefined, undefined, t);
      return;
    }
    case "location": {
      // Location has its own { label?, url?, lat?, lng? } shape. Keep a stable,
      // writable bucket key instead of collapsing objects to "[object Object]".
      if (typeof v === "object" && v) {
        const loc = v as { label?: string; url?: string; lat?: number | null; lng?: number | null };
        const coords = loc.lat != null && loc.lng != null ? `${loc.lat},${loc.lng}` : "";
        const key = String(loc.url || coords || loc.label || "");
        push(key, String(loc.label || coords || loc.url || key), undefined, undefined, t);
      } else {
        push(String(shown), String(shown), undefined, undefined, t);
      }
      return;
    }
    case "checkbox": {
      push(v ? "true" : "false", v ? "Yes" : "No", undefined, v ? 0 : 1, t);
      return;
    }
    case "money": {
      const n = Number(v);
      const cur = (cf.currency || "PLN").toUpperCase();
      let s: string;
      try { s = new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(n); }
      catch { s = `${n.toFixed(2)} ${cur}`; }
      push(String(shown), s, undefined, undefined, t);
      return;
    }
    case "rating": {
      const n = Math.max(0, Math.min(cf.scale || 5, Number(v) || 0));
      push(String(n), `${(cf.icon || "★").repeat(n)} (${n}/${cf.scale || 5})`, undefined, n, t);
      return;
    }
    case "progress_manual":
    case "progress_auto": {
      const p = Math.round(Number(v) || 0);
      push(String(p), `${p}%`, undefined, p, t);
      return;
    }
    case "attachment": {
      const count = Array.isArray(v) ? v.length : 0;
      push(String(count), `${count} file${count === 1 ? "" : "s"}`, undefined, count, t);
      return;
    }
    case "relationship": {
      const arr: unknown[] = Array.isArray(v) ? v : [v];
      for (const id of arr) push(String(id), context.taskTitles?.get(String(id)) || String(id), undefined, undefined, t);
      return;
    }
    default: {
      // text / textarea / number / date / datetime / time → string passthrough
      const s = String(shown);
      push(s, s, undefined, undefined, t);
    }
  }
}
