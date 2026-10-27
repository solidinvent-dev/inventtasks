import { App, Modal, setIcon } from "obsidian";
import { FilterCondition, FilterGroup, FilterLogic } from "../types";
import { showPopover, buildDropdown } from "../ui/components";
import { renderIconish } from "../ui/icons";
import { t } from "../i18n";

// ---------- Field metadata fed in by the caller ----------
// The caller (main-view) resolves the available fields for the current
// location and maps each to a coarse "filter type" that drives which
// operators and value input we show.
export type FilterFieldType = "text" | "number" | "date" | "time" | "dropdown" | "multi" | "checkbox";

export interface FilterFieldDef {
  key: string;            // "status" | "priority" | "custom_field:cf_x" | …
  label: string;
  type: FilterFieldType;
  options?: { value: string | number; label: string; color?: string }[];
  // Colored field-type icon (Lucide name + color), set by the caller so the
  // field picker matches the rest of the app.
  icon?: string;
  color?: string;
}

function opLabel(op: string): string {
  return t(`filter.op.${op}`) || op;
}

const OPS_BY_TYPE: Record<FilterFieldType, string[]> = {
  text: ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with", "is_empty", "is_not_empty"],
  number: ["equals", "not_equals", "gt", "lt", "gte", "lte", "between", "is_empty", "is_not_empty"],
  date: ["is_today", "is_tomorrow", "is_yesterday", "is_overdue", "before", "after", "between", "in_next", "in_last", "is_empty", "is_not_empty"],
  time: ["is", "is_not", "before", "after", "between", "is_empty", "is_not_empty"],
  dropdown: ["is", "is_not", "in", "not_in", "is_empty", "is_not_empty"],
  multi: ["any_of", "none_of", "all_of", "is_empty", "is_not_empty"],
  checkbox: ["is_checked", "is_unchecked"],
};

// Operators that take NO value input.
const NO_VALUE_OPS = new Set([
  "is_empty", "is_not_empty", "is_today", "is_tomorrow", "is_yesterday",
  "is_overdue", "is_checked", "is_unchecked",
]);

type ValueKind = "none" | "text" | "number" | "date" | "time" | "between-number" | "between-date" | "between-time" | "single-option" | "multi-option";

function valueKind(op: string, field: FilterFieldDef): ValueKind {
  if (NO_VALUE_OPS.has(op)) return "none";
  if (op === "between") return field.type === "date" ? "between-date" : field.type === "time" ? "between-time" : "between-number";
  if (op === "in" || op === "not_in" || op === "any_of" || op === "none_of" || op === "all_of") return "multi-option";
  if (op === "is" || op === "is_not") return field.type === "dropdown" ? "single-option" : field.type === "time" ? "time" : "text";
  if (op === "before" || op === "after") return field.type === "time" ? "time" : "date";
  if (op === "contains" || op === "not_contains" || op === "starts_with" || op === "ends_with") return "text";
  // gt/lt/gte/lte/equals/not_equals/in_next/in_last
  return "number";
}

export interface FilterModalOptions {
  current?: FilterGroup;
  fields: FilterFieldDef[];
  onApply: (group: FilterGroup | undefined) => void;
}

// How deep the user can nest groups (root = depth 0). Keeps the UI sane while
// still allowing things like (A AND (B OR C)) OR D.
const MAX_GROUP_DEPTH = 2;

export class FilterModal extends Modal {
  private opts: FilterModalOptions;
  // Editable copy of the whole filter tree (groups can hold conditions AND
  // nested groups, each with their own AND/OR), so arbitrary combinations
  // like (A AND B) OR (C AND D) are possible.
  private root: FilterGroup;

  constructor(app: App, opts: FilterModalOptions) {
    super(app);
    this.opts = opts;
    this.root = this.cloneGroup(opts.current) ?? { logic: "AND", conditions: [] };
  }

  // Deep-clone a group tree so edits don't mutate the live view until Apply.
  private cloneGroup(g?: FilterGroup): FilterGroup | undefined {
    if (!g) return undefined;
    return {
      logic: g.logic === "OR" ? "OR" : "AND",
      conditions: (g.conditions || []).map((c) =>
        this.isChildGroup(c)
          ? this.cloneGroup(c)!
          : { ...(c as FilterCondition), value: Array.isArray((c as FilterCondition).value) ? [...(c as FilterCondition).value] : (c as FilterCondition).value }
      ),
    };
  }

  private isChildGroup(c: FilterCondition | FilterGroup): c is FilterGroup {
    return !!(c as FilterGroup).logic && Array.isArray((c as FilterGroup).conditions);
  }

  // Drop conditions whose field no longer exists and empty groups; returns
  // undefined for a fully-empty tree.
  private pruneGroup(g: FilterGroup): FilterGroup | undefined {
    const kept: (FilterCondition | FilterGroup)[] = [];
    for (const ch of g.conditions) {
      if (this.isChildGroup(ch)) {
        const pg = this.pruneGroup(ch);
        if (pg && pg.conditions.length) kept.push(pg);
      } else if (this.fieldFor((ch as FilterCondition).field)) {
        kept.push(ch);
      }
    }
    return kept.length ? { logic: g.logic, conditions: kept } : undefined;
  }

  onOpen() {
    this.modalEl.addClass("it-filter-modal");
    this.titleEl.setText(t("modal.filters"));
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private fieldFor(key: string): FilterFieldDef | undefined {
    return this.opts.fields.find((f) => f.key === key);
  }

  private render() {
    const c = this.contentEl;
    c.empty();
    c.addClass("it-modal-form");

    // ---- Group tree ----
    const tree = c.createDiv({ cls: "it-filter-tree" });
    this.renderGroup(tree, this.root, true, 0);

    // ---- Footer ----
    const footer = c.createDiv({ cls: "it-modal-footer" });
    const clear = footer.createEl("button", { cls: "it-btn-ghost", text: t("filter.clearAll"), attr: { type: "button" } });
    clear.addEventListener("click", () => {
      this.opts.onApply(undefined);
      this.close();
    });
    footer.createDiv({ cls: "it-flex-grow" });
    const cancel = footer.createEl("button", { cls: "it-btn-ghost", text: t("common.cancel"), attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const apply = footer.createEl("button", { cls: "it-btn-primary", text: t("common.apply"), attr: { type: "button" } });
    apply.addEventListener("click", () => {
      const pruned = this.pruneGroup(this.root);
      this.opts.onApply(pruned && pruned.conditions.length ? pruned : undefined);
      this.close();
    });
  }

  // Render one group (recursively): an AND/OR toggle, its rows (conditions +
  // nested groups), and the add controls.
  private renderGroup(parent: HTMLElement, group: FilterGroup, isRoot: boolean, depth: number, removeSelf?: () => void) {
    const box = parent.createDiv({ cls: "it-filter-group" + (isRoot ? " is-root" : "") });

    // Header: Match [All (AND) | Any (OR)] + remove (nested only)
    const head = box.createDiv({ cls: "it-filter-group-head" });
    head.createSpan({ cls: "it-field-label", text: t("filter.match") });
    const seg = head.createDiv({ cls: "it-tri-state" });
    for (const l of ["AND", "OR"] as const) {
      const btn = seg.createEl("button", {
        cls: "it-tri-state-btn" + (group.logic === l ? " is-active" : ""),
        text: l === "AND" ? t("filter.allAnd") : t("filter.anyOr"),
        attr: { type: "button" },
      });
      btn.addEventListener("click", () => { group.logic = l; this.render(); });
    }
    head.createDiv({ cls: "it-flex-grow" });
    if (!isRoot && removeSelf) {
      const rmG = head.createEl("button", { cls: "it-icon-btn it-icon-btn-mini it-danger", attr: { type: "button", "aria-label": t("filter.removeGroup") } });
      setIcon(rmG, "trash-2");
      rmG.addEventListener("click", () => { removeSelf(); this.render(); });
    }

    // Rows
    const body = box.createDiv({ cls: "it-filter-group-body" });
    if (group.conditions.length === 0) {
      body.createDiv({ cls: "it-empty-row", text: t("filter.noConditions") });
    } else {
      group.conditions.forEach((child, i) => {
        const remove = () => { group.conditions.splice(i, 1); this.render(); };
        if (this.isChildGroup(child)) this.renderGroup(body, child, false, depth + 1, remove);
        else this.renderConditionRow(body, child as FilterCondition, remove);
      });
    }

    // Add controls
    const addRow = box.createDiv({ cls: "it-filter-add-row" });
    const addCond = addRow.createEl("button", { cls: "it-btn-secondary", text: t("filter.addCondition"), attr: { type: "button" } });
    addCond.addEventListener("click", () => {
      const field = this.opts.fields[0];
      if (!field) return;
      const op = OPS_BY_TYPE[field.type][0];
      group.conditions.push({ field: field.key, operator: op, value: this.defaultValue(op, field) });
      this.render();
    });
    if (depth < MAX_GROUP_DEPTH) {
      const addGrp = addRow.createEl("button", { cls: "it-btn-secondary", text: t("filter.addGroup"), attr: { type: "button" } });
      addGrp.addEventListener("click", () => {
        group.conditions.push({ logic: "AND", conditions: [] });
        this.render();
      });
    }
  }

  private renderConditionRow(parent: HTMLElement, cond: FilterCondition, removeSelf: () => void) {
    const field = this.fieldFor(cond.field) || this.opts.fields[0];
    const row = parent.createDiv({ cls: "it-filter-cond" });

    // Field picker — custom dropdown so each field shows its colored type icon
    // (a native <select> can't), consistent with the rest of the app.
    const fieldBtn = row.createEl("button", { cls: "it-input it-filter-field it-filter-fieldbtn", attr: { type: "button" } });
    if (field.icon) {
      const ic = renderIconish(fieldBtn, field.icon, { cls: "it-cf-type-ic" });
      if (ic && field.color) ic.style.color = field.color;
    }
    fieldBtn.createSpan({ cls: "it-filter-fieldbtn-label", text: field.label });
    setIcon(fieldBtn.createSpan({ cls: "it-filter-fieldbtn-caret" }), "chevron-down");
    fieldBtn.addEventListener("click", () => {
      showPopover(fieldBtn, (root) => {
        buildDropdown({
          parent: root,
          current: cond.field,
          items: this.opts.fields.map((f) => ({ value: f.key, label: f.label, icon: f.icon, color: f.color })),
          onSelect: (key) => {
            const nf = this.fieldFor(key)!;
            cond.field = nf.key;
            cond.operator = OPS_BY_TYPE[nf.type][0];
            cond.value = this.defaultValue(cond.operator, nf);
            document.querySelectorAll(".it-popover").forEach((el) => el.remove());
            this.render();
          },
        });
      });
    });

    // Operator select
    const opSel = row.createEl("select", { cls: "it-input it-filter-op" });
    for (const op of OPS_BY_TYPE[field.type]) {
      const o = opSel.createEl("option", { value: op, text: opLabel(op) });
      if (op === cond.operator) o.selected = true;
    }
    opSel.addEventListener("change", () => {
      const prevKind = valueKind(cond.operator, field);
      cond.operator = opSel.value;
      const nextKind = valueKind(cond.operator, field);
      if (prevKind !== nextKind) cond.value = this.defaultValue(cond.operator, field);
      this.render();
    });

    // Value input
    const valWrap = row.createDiv({ cls: "it-filter-value" });
    this.renderValueInput(valWrap, cond, field);

    // Remove
    const rm = row.createEl("button", { cls: "it-icon-btn it-icon-btn-mini it-danger", attr: { type: "button", "aria-label": t("filter.removeCondition") } });
    rm.setText("×");
    rm.addEventListener("click", () => removeSelf());
  }

  private defaultValue(op: string, field: FilterFieldDef): any {
    const kind = valueKind(op, field);
    switch (kind) {
      case "none": return null;
      case "multi-option": return [];
      case "single-option": return field.options?.[0]?.value ?? "";
      case "between-number": return [0, 0];
      case "between-date": return ["", ""];
      case "between-time": return ["", ""];
      case "number": return op === "in_next" || op === "in_last" ? 7 : 0;
      default: return "";
    }
  }

  private renderValueInput(parent: HTMLElement, cond: FilterCondition, field: FilterFieldDef) {
    const kind = valueKind(cond.operator, field);
    switch (kind) {
      case "none":
        return;
      case "text": {
        const i = parent.createEl("input", { type: "text", cls: "it-input" });
        i.value = cond.value ?? "";
        i.placeholder = t("common.value");
        i.addEventListener("input", () => { cond.value = i.value; });
        return;
      }
      case "number": {
        const i = parent.createEl("input", { type: "number", cls: "it-input it-input-small" });
        i.value = cond.value === "" || cond.value == null ? "" : String(cond.value);
        i.addEventListener("input", () => {
          const n = parseFloat(i.value);
          cond.value = isNaN(n) ? "" : n;
        });
        return;
      }
      case "date": {
        const i = parent.createEl("input", { type: "date", cls: "it-input" });
        i.value = (cond.value || "").slice(0, 10);
        i.addEventListener("change", () => { cond.value = i.value || ""; });
        return;
      }
      case "time": {
        const i = parent.createEl("input", { type: "time", cls: "it-input" });
        i.value = (cond.value || "").slice(0, 5);
        i.addEventListener("change", () => { cond.value = i.value || ""; });
        return;
      }
      case "between-number":
      case "between-date":
      case "between-time": {
        const pair: any[] = Array.isArray(cond.value) ? cond.value : [kind === "between-number" ? 0 : "", kind === "between-number" ? 0 : ""];
        cond.value = pair;
        const type = kind === "between-date" ? "date" : kind === "between-time" ? "time" : "number";
        const lo = parent.createEl("input", { type, cls: "it-input it-input-small" });
        lo.value = pair[0] != null ? String(pair[0]) : "";
        parent.createSpan({ text: "–", cls: "it-filter-between-sep" });
        const hi = parent.createEl("input", { type, cls: "it-input it-input-small" });
        hi.value = pair[1] != null ? String(pair[1]) : "";
        const set = (idx: number, raw: string) => {
          pair[idx] = type === "number" ? (raw === "" ? "" : parseFloat(raw)) : raw;
        };
        lo.addEventListener("input", () => set(0, lo.value));
        hi.addEventListener("input", () => set(1, hi.value));
        return;
      }
      case "single-option": {
        const sel = parent.createEl("select", { cls: "it-input" });
        const opts = field.options || [];
        for (const o of opts) {
          const el = sel.createEl("option", { value: String(o.value), text: o.label });
          if (String(o.value) === String(cond.value)) el.selected = true;
        }
        sel.addEventListener("change", () => {
          const chosen = opts.find((o) => String(o.value) === sel.value);
          cond.value = chosen ? chosen.value : sel.value;
        });
        return;
      }
      case "multi-option": {
        const cur: any[] = Array.isArray(cond.value) ? cond.value : [];
        cond.value = cur;
        const wrap = parent.createDiv({ cls: "it-filter-multi" });
        const opts = field.options || [];
        if (opts.length === 0) {
          wrap.createSpan({ cls: "it-empty-inline", text: t("filter.noOptions") });
          return;
        }
        for (const o of opts) {
          const active = cur.some((x) => String(x) === String(o.value));
          const chip = wrap.createEl("button", { cls: "it-chip it-chip-tag" + (active ? " is-active" : ""), text: o.label, attr: { type: "button" } });
          if (o.color) chip.style.setProperty("--chip-color", o.color);
          chip.addEventListener("click", () => {
            const at = cur.findIndex((x) => String(x) === String(o.value));
            if (at >= 0) cur.splice(at, 1); else cur.push(o.value);
            chip.toggleClass("is-active", at < 0);
          });
        }
        return;
      }
    }
  }
}
