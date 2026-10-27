import { App, Modal } from "obsidian";
import type InventTasksPlugin from "../main";
import type { DocMeta } from "../types";
import { DOC_ICON, DOC_ACCENT } from "../constants";
import { renderIconish } from "../ui/icons";
import { renderSourceBanner } from "./move-modal";
import { hierarchyLabel, t } from "../i18n";

export interface DocPickerOptions {
  title?: string;
  multi?: boolean;
  /** Doc ids to hide (already linked). */
  excludeIds?: string[];
  /** Optional source banner (the task we're linking from). */
  source?: { title: string; icon?: string; color?: string };
  contextLabel?: string;
  confirmLabel?: string;
  onPick: (docIds: string[]) => void;
}

// Pick one or many Docs to link. Mirrors TaskPickerModal: grouped by location,
// searchable, multi-select. Reuses the move/task-picker CSS for a consistent look.
export class DocPickerModal extends Modal {
  private plugin: InventTasksPlugin;
  private opts: DocPickerOptions;
  private selected = new Set<string>();
  private query = "";

  constructor(app: App, plugin: InventTasksPlugin, opts: DocPickerOptions) {
    super(app);
    this.plugin = plugin;
    this.opts = opts;
  }

  onOpen() {
    this.containerEl.addClass("it-move-modal-container");
    this.containerEl.addClass("it-task-picker-container");
    this.titleEl.setText(this.opts.title || t("picker.pickDoc"));

    const c = this.contentEl;
    c.empty();
    c.addClass("it-move-modal");
    c.addClass("it-task-picker");

    if (this.opts.source) {
      renderSourceBanner(
        c,
        { name: this.opts.source.title, icon: this.opts.source.icon || "✓", color: this.opts.source.color },
        this.opts.contextLabel ? [{ label: this.opts.contextLabel }] : undefined,
      );
    }

    c.createDiv({ cls: "it-move-modal-section-label", text: this.opts.multi === false ? t("picker.chooseDoc") : t("picker.chooseDocs") });

    const searchWrap = c.createDiv({ cls: "it-move-modal-search-wrap" });
    const searchInput = searchWrap.createEl("input", {
      type: "text",
      cls: "it-move-modal-search",
      attr: { placeholder: t("picker.searchDocs") },
    });

    const listEl = c.createDiv({ cls: "it-move-modal-list it-task-picker-list" });
    let confirmBtn: HTMLButtonElement;

    const exclude = new Set(this.opts.excludeIds ?? []);
    const candidates = this.plugin.index.docs.filter((d) => !exclude.has(d.doc_id));

    if (candidates.length === 0) {
      c.createDiv({ cls: "it-move-modal-empty", text: t("picker.noDocsToLink") });
      const footer = c.createDiv({ cls: "it-move-modal-footer" });
      const cancel = footer.createEl("button", { cls: "it-secondary-btn", text: t("common.close") });
      cancel.addEventListener("click", () => this.close());
      return;
    }

    const render = () => {
      listEl.empty();
      const needle = this.query.trim().toLowerCase();
      const groups = this.groupByLocation(candidates, needle);
      if (groups.length === 0) {
        listEl.createDiv({ cls: "it-move-modal-empty", text: t("picker.noDocsMatch") });
        return;
      }
      for (const g of groups) {
        const groupEl = listEl.createDiv({ cls: "it-move-modal-group" });
        const groupHeader = groupEl.createDiv({ cls: "it-move-modal-group-header" });
        const sIcon = renderIconish(groupHeader, g.icon || "🏷️", { cls: "it-move-modal-group-icon" });
        if (sIcon && g.color) sIcon.style.color = g.color;
        groupHeader.createSpan({ text: g.label, cls: "it-move-modal-group-name" });
        groupHeader.createSpan({ text: `${g.docs.length}`, cls: "it-task-picker-group-count" });
        for (const d of g.docs) this.renderDocOption(groupEl, d, confirmBtn);
      }
    };

    searchInput.addEventListener("input", () => { this.query = searchInput.value; render(); });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.opts.multi !== false && this.selected.size > 0) {
        e.preventDefault();
        confirm();
      }
    });
    setTimeout(() => searchInput.focus(), 0);

    const footer = c.createDiv({ cls: "it-move-modal-footer" });
    const cancel = footer.createEl("button", { cls: "it-secondary-btn", text: t("common.cancel") });
    cancel.addEventListener("click", () => this.close());

    const confirm = () => {
      const ids = Array.from(this.selected);
      if (ids.length === 0) return;
      this.opts.onPick(ids);
      this.close();
    };

    if (this.opts.multi !== false) {
      confirmBtn = footer.createEl("button", { cls: "it-btn-primary", text: this.opts.confirmLabel || t("common.link") });
      confirmBtn.disabled = true;
      confirmBtn.addEventListener("click", confirm);
    }

    // Re-run render now that confirmBtn exists so option toggles can update it.
    render();
  }

  private locationMeta(key: string | undefined): { label: string; icon?: string; color?: string } {
    const idx = this.plugin.index;
    if (key?.startsWith("space:")) {
      const s = idx.findSpace(key.slice("space:".length));
      return { label: s?.config.name || hierarchyLabel("space"), icon: s?.config.icon, color: s?.config.color };
    }
    if (key?.startsWith("folder:")) {
      const f = idx.findFolder(key.slice("folder:".length));
      const s = f ? idx.findSpace(f.spacePath) : undefined;
      return { label: f ? `${s?.config.name ? s.config.name + " / " : ""}${f.config.name}` : hierarchyLabel("folder"), icon: f?.config.icon, color: f?.config.color };
    }
    if (key?.startsWith("list:")) {
      const l = idx.findList(key.slice("list:".length));
      return { label: l?.config.name || hierarchyLabel("list"), icon: l?.config.icon, color: l?.config.color };
    }
    return { label: t("common.other") };
  }

  private groupByLocation(
    docs: DocMeta[],
    needle: string,
  ): Array<{ key: string; label: string; icon?: string; color?: string; docs: DocMeta[] }> {
    const map = new Map<string, { key: string; label: string; icon?: string; color?: string; docs: DocMeta[] }>();
    for (const d of docs) {
      if (needle && !(d.name || "").toLowerCase().includes(needle)) continue;
      const key = d.location || "__none";
      let bucket = map.get(key);
      if (!bucket) {
        const m = this.locationMeta(d.location);
        bucket = { key, label: m.label, icon: m.icon, color: m.color, docs: [] };
        map.set(key, bucket);
      }
      bucket.docs.push(d);
    }
    return Array.from(map.values())
      .map((b) => ({ ...b, docs: b.docs.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  private renderDocOption(parent: HTMLElement, d: DocMeta, confirmBtn?: HTMLButtonElement) {
    const el = parent.createDiv({ cls: "it-move-modal-option it-task-picker-option" });
    if (this.selected.has(d.doc_id)) el.addClass("is-selected");

    const bar = el.createDiv({ cls: "it-move-modal-option-bar" });
    bar.style.background = d.color || DOC_ACCENT;

    const toggle = () => {
      if (this.opts.multi === false) {
        this.opts.onPick([d.doc_id]);
        this.close();
        return;
      }
      if (this.selected.has(d.doc_id)) this.selected.delete(d.doc_id);
      else this.selected.add(d.doc_id);
      el.toggleClass("is-selected", this.selected.has(d.doc_id));
      const cb = el.querySelector("input.it-task-picker-check") as HTMLInputElement | null;
      if (cb) cb.checked = this.selected.has(d.doc_id);
      if (confirmBtn) {
        confirmBtn.disabled = this.selected.size === 0;
        confirmBtn.textContent = this.selected.size > 1 ? t("picker.linkCount", { count: this.selected.size }) : (this.opts.confirmLabel || t("common.link"));
      }
    };

    if (this.opts.multi !== false) {
      const cb = el.createEl("input", { type: "checkbox", cls: "it-task-picker-check" });
      cb.checked = this.selected.has(d.doc_id);
      cb.addEventListener("click", (ev) => { ev.stopPropagation(); toggle(); });
    }

    const content = el.createDiv({ cls: "it-move-modal-option-content" });
    const header = content.createDiv({ cls: "it-move-modal-option-header" });
    const ico = renderIconish(header, d.icon || DOC_ICON, { cls: "it-move-modal-option-icon" });
    if (ico) ico.style.color = d.color || DOC_ACCENT;
    header.createSpan({ text: d.name || t("common.untitled"), cls: "it-move-modal-option-name" });

    const meta = content.createDiv({ cls: "it-move-modal-option-meta it-task-picker-meta" });
    meta.createSpan({ text: t("common.pages", { count: this.plugin.index.pagesForDoc(d.doc_id).length }), cls: "it-task-picker-id" });

    el.addEventListener("click", () => toggle());
  }
}
