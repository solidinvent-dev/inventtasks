import { App, Modal, Notice, setIcon } from "obsidian";
import type InventTasksPlugin from "../main";
import type { DocMeta } from "../types";
import { DOC_ICON, DOC_ACCENT } from "../constants";
import { renderIconish } from "../ui/icons";
import { ConfirmModal } from "./confirm-modal";
import { MoveDocModal } from "./move-modal";
import { hierarchyLabel, t } from "../i18n";
import { fireAndForget } from "../utils/async";

// Workspace-wide list of every Doc, with open / move / delete actions. Opened
// from the sidebar header (next to Workspace settings).
export class DocsManagerModal extends Modal {
  private plugin: InventTasksPlugin;
  private query = "";
  private unsub?: () => void;

  constructor(app: App, plugin: InventTasksPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.containerEl.addClass("it-move-modal-container");
    this.titleEl.setText(t("modal.docsManager"));
    // Live-refresh when docs change (move/delete elsewhere).
    this.unsub = this.plugin.index.onChange(() => this.renderList());
    this.render();
  }

  onClose() {
    this.unsub?.();
    this.contentEl.empty();
  }

  private listEl!: HTMLElement;

  private render() {
    const c = this.contentEl;
    c.empty();
    c.addClass("it-move-modal");
    c.addClass("it-docs-manager");

    c.createDiv({ cls: "it-move-modal-section-label", text: t("modal.docsManagerAll") });

    const searchWrap = c.createDiv({ cls: "it-move-modal-search-wrap" });
    const search = searchWrap.createEl("input", { type: "text", cls: "it-move-modal-search", attr: { placeholder: t("modal.docsSearch") } });
    search.value = this.query;
    search.addEventListener("input", () => { this.query = search.value; this.renderList(); });
    window.setTimeout(() => search.focus(), 0);

    this.listEl = c.createDiv({ cls: "it-move-modal-list" });
    this.renderList();

    const footer = c.createDiv({ cls: "it-move-modal-footer" });
    footer.createEl("button", { cls: "it-secondary-btn", text: t("common.close") }).addEventListener("click", () => this.close());
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
      const s = l?.spacePath ? idx.findSpace(l.spacePath) : undefined;
      return { label: l ? `${s?.config.name ? s.config.name + " / " : ""}${l.config.name}` : hierarchyLabel("list"), icon: l?.config.icon, color: l?.config.color };
    }
    return { label: t("common.other") };
  }

  private renderList() {
    if (!this.listEl) return;
    this.listEl.empty();
    const needle = this.query.trim().toLowerCase();
    const docs = this.plugin.index.docs
      .filter((d) => !needle || (d.name || "").toLowerCase().includes(needle));

    if (docs.length === 0) {
      this.listEl.createDiv({ cls: "it-move-modal-empty", text: this.plugin.index.docs.length === 0 ? t("docsMgr.noDocs") : t("docsMgr.noMatch") });
      return;
    }

    // Group by location for readability.
    const groups = new Map<string, { label: string; icon?: string; color?: string; docs: DocMeta[] }>();
    for (const d of docs) {
      const key = d.location || "__none";
      let g = groups.get(key);
      if (!g) { const m = this.locationMeta(d.location); g = { label: m.label, icon: m.icon, color: m.color, docs: [] }; groups.set(key, g); }
      g.docs.push(d);
    }
    const ordered = Array.from(groups.values())
      .map((g) => ({ ...g, docs: g.docs.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.label.localeCompare(b.label));

    for (const g of ordered) {
      const groupEl = this.listEl.createDiv({ cls: "it-move-modal-group" });
      const head = groupEl.createDiv({ cls: "it-move-modal-group-header" });
      const sIcon = renderIconish(head, g.icon || "🏷️", { cls: "it-move-modal-group-icon" });
      if (sIcon && g.color) sIcon.style.color = g.color;
      head.createSpan({ text: g.label, cls: "it-move-modal-group-name" });
      head.createSpan({ text: `${g.docs.length}`, cls: "it-task-picker-group-count" });
      for (const d of g.docs) this.renderRow(groupEl, d);
    }
  }

  private renderRow(parent: HTMLElement, d: DocMeta) {
    const row = parent.createDiv({ cls: "it-move-modal-option it-docs-manager-row" });
    // The whole row opens the Doc (and closes the manager) — the icon buttons
    // are precise variants, not the only click target.
    row.addEventListener("click", () => this.openDoc(d));
    const bar = row.createDiv({ cls: "it-move-modal-option-bar" });
    bar.style.background = d.color || DOC_ACCENT;

    const content = row.createDiv({ cls: "it-move-modal-option-content" });
    const header = content.createDiv({ cls: "it-move-modal-option-header" });
    const ico = renderIconish(header, d.icon || DOC_ICON, { cls: "it-move-modal-option-icon" });
    if (ico) ico.style.color = d.color || DOC_ACCENT;
    header.createSpan({ text: d.name || t("common.untitled"), cls: "it-move-modal-option-name" });
    const meta = content.createDiv({ cls: "it-move-modal-option-meta" });
    meta.createSpan({ text: t("common.pages", { count: this.plugin.index.pagesForDoc(d.doc_id).length }) });

    const actions = row.createDiv({ cls: "it-docs-manager-actions" });
    const open = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { type: "button", title: t("action.open"), "aria-label": t("docsMgr.openDoc") } });
    setIcon(open, "external-link");
    open.addEventListener("click", (e) => { e.stopPropagation(); this.openDoc(d); });

    const move = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { type: "button", title: t("docsMgr.moveTo"), "aria-label": t("move.moveDoc") } });
    setIcon(move, "folder-input");
    move.addEventListener("click", (e) => { e.stopPropagation(); new MoveDocModal(this.app, this.plugin, d.doc_id, () => this.renderList()).open(); });

    const del = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini it-danger", attr: { type: "button", title: t("common.delete"), "aria-label": t("action.deleteDoc") } });
    setIcon(del, "trash");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      new ConfirmModal(this.app, {
        title: t("docsMgr.deleteTitle"),
        message: t("docsMgr.deleteMsg", { name: d.name }),
        destructive: true,
        onConfirm: fireAndForget(async () => { await this.plugin.index.deleteDoc(d.doc_id); new Notice(t("docsMgr.deleted", { name: d.name })); }),
      }).open();
    });
  }

  private openDoc(d: DocMeta) {
    if (!d.__path) return;
    this.close();
    const mv = this.plugin.getMainView();
    if (mv) mv.openDocLocation(d.__path);
    else void this.plugin.activateView().then(() => this.plugin.getMainView()?.openDocLocation(d.__path!));
  }
}
