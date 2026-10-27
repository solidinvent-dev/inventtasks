import { App, SuggestModal } from "obsidian";
import type InventTasksPlugin from "../main";
import { ContextLocation, TaskFile } from "../types";
import { DOC_ICON, DOC_PAGE_ICON, DOC_ACCENT } from "../constants";
import { hierarchyLabel, t } from "../i18n";
import { renderIconish } from "../ui/icons";
import { taskMatchesQuery } from "../data/search-match";
import { TaskModal } from "./task-modal";
import { fireAndForget } from "../utils/async";

// One entry in the global search results — a task, a navigable container, a Doc,
// or a Doc page.
type SearchItem =
  | { kind: "task"; tf: TaskFile }
  | { kind: "space" | "folder" | "list"; path: string; name: string; icon?: string; color?: string }
  | { kind: "doc"; docPath: string; name: string; icon?: string; color?: string }
  | { kind: "docpage"; docPath: string; pageId: string; title: string; docName: string; icon?: string; color?: string };

// Global search (Cmd/Ctrl+K). Searches task titles / ids / custom-ids / tags /
// context, plus Space / Folder / List names. Empty query shows recents.
// Built on Obsidian's SuggestModal for free keyboard navigation.
export class SearchModal extends SuggestModal<SearchItem> {
  private plugin: InventTasksPlugin;
  private readonly MAX = 60;

  constructor(app: App, plugin: InventTasksPlugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder(t("search.placeholder"));
    this.limit = 80;
  }

  onOpen(): void {
    void super.onOpen();
    // The two costly scopes are toggled here rather than buried in settings:
    // this is where their effect is visible, and where a user who just failed
    // to find something will look.
    const row = createDiv({ cls: "it-search-scope" });
    this.resultContainerEl.parentElement?.insertBefore(row, this.resultContainerEl);
    this.scopeToggle(row, "searchItemBodies", t("search.scope.bodies"));
    this.scopeToggle(row, "searchCustomFieldValues", t("search.scope.customFields"));
  }

  private scopeToggle(parent: HTMLElement, key: "searchItemBodies" | "searchCustomFieldValues", label: string): void {
    const wrap = parent.createEl("label", { cls: "it-search-scope-item" });
    const box = wrap.createEl("input", { type: "checkbox" });
    box.checked = !!this.plugin.prefs[key];
    wrap.createSpan({ text: label });
    // A click inside a SuggestModal would otherwise reach the prompt and take
    // focus off the query field, so keep it here and hand focus straight back.
    wrap.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("change", fireAndForget(async () => {
      this.plugin.prefs[key] = box.checked;
      await this.plugin.saveSettings();
      this.inputEl.focus();
      this.inputEl.dispatchEvent(new Event("input"));   // re-run with the new scope
    }));
  }

  getSuggestions(query: string): SearchItem[] {
    const idx = this.plugin.index;
    const q = query.trim().toLowerCase();

    // Empty query → recent tasks (most recent first).
    if (!q) {
      const out: SearchItem[] = [];
      for (const id of this.plugin.prefs.recentTaskIds || []) {
        const tf = idx.tasksById.get(id);
        if (tf && !idx.isSystemTask(tf) && !tf.data.archived) out.push({ kind: "task", tf });
      }
      return out.slice(0, 25);
    }

    const items: SearchItem[] = [];
    const scope = {
      bodies: !!this.plugin.prefs.searchItemBodies,
      customFields: !!this.plugin.prefs.searchCustomFieldValues,
    };
    // Tasks
    for (const tf of idx.allTasks()) {
      if (idx.isSystemTask(tf) || tf.data.archived) continue;
      if (taskMatchesQuery(tf.data, tf.body, q, scope)) items.push({ kind: "task", tf });
      if (items.length > 200) break; // safety cap before container scan
    }
    // Containers (spaces / folders / lists)
    for (const s of idx.spaces) {
      if (s.config.hidden) continue;
      if (s.config.name.toLowerCase().includes(q)) {
        items.push({ kind: "space", path: s.path, name: s.config.name, icon: s.config.icon, color: s.config.color });
      }
      for (const l of s.lists) {
        if (l.config.hidden || l.config.system_kind) continue;
        if (l.config.name.toLowerCase().includes(q)) items.push({ kind: "list", path: l.path, name: l.config.name, icon: l.config.icon, color: l.config.color });
      }
      for (const f of s.folders) {
        if (f.config.name.toLowerCase().includes(q)) items.push({ kind: "folder", path: f.path, name: f.config.name, icon: f.config.icon, color: f.config.color });
        for (const l of f.lists) {
          if (l.config.hidden || l.config.system_kind) continue;
          if (l.config.name.toLowerCase().includes(q)) items.push({ kind: "list", path: l.path, name: l.config.name, icon: l.config.icon, color: l.config.color });
        }
      }
    }
    // Docs (by name)
    for (const d of idx.docs) {
      if ((d.name || "").toLowerCase().includes(q) && d.__path) {
        items.push({ kind: "doc", docPath: d.__path, name: d.name, icon: d.icon, color: d.color });
      }
    }
    // Doc pages (by title + body content)
    for (const p of idx.docPages) {
      const hit = (p.title || "").toLowerCase().includes(q) || (p.__body || "").toLowerCase().includes(q);
      if (!hit) continue;
      const doc = idx.docById(p.doc_id);
      if (!doc?.__path) continue;
      items.push({ kind: "docpage", docPath: doc.__path, pageId: p.page_id, title: p.title, docName: doc.name, icon: p.icon, color: p.color || doc.color });
    }
    return items.slice(0, this.MAX);
  }

  renderSuggestion(item: SearchItem, el: HTMLElement) {
    el.addClass("it-search-item");
    const iconWrap = el.createSpan({ cls: "it-search-icon" });

    if (item.kind === "task") {
      const tf = item.tf;
      const types = this.plugin.index.resolveTaskTypes({ listPath: tf.listPath });
      const ttype = types.find((x) => x.id === tf.data.type);
      const ico = renderIconish(iconWrap, ttype?.icon || "check-square", { cls: "it-search-icon-glyph" });
      if (ico && ttype?.color) ico.style.color = ttype.color;
      const body = el.createDiv({ cls: "it-search-body" });
      body.createDiv({ cls: "it-search-title", text: tf.data.title || t("common.untitled") });
      const subParts: string[] = [];
      if (tf.data.custom_id) subParts.push(tf.data.custom_id);
      else subParts.push(tf.data.id);
      const list = tf.listPath ? this.plugin.index.findList(tf.listPath) : undefined;
      if (list) subParts.push(list.config.name);
      body.createDiv({ cls: "it-search-sub", text: `${t("search.task")} · ${subParts.join(" · ")}` });
      return;
    }

    if (item.kind === "doc") {
      const ico = renderIconish(iconWrap, item.icon || DOC_ICON, { cls: "it-search-icon-glyph" });
      if (ico) ico.style.color = item.color || DOC_ACCENT;
      const body = el.createDiv({ cls: "it-search-body" });
      body.createDiv({ cls: "it-search-title", text: item.name });
      body.createDiv({ cls: "it-search-sub", text: t("search.doc") });
      return;
    }

    if (item.kind === "docpage") {
      const ico = renderIconish(iconWrap, item.icon || DOC_PAGE_ICON, { cls: "it-search-icon-glyph" });
      if (ico && item.color) ico.style.color = item.color;
      const body = el.createDiv({ cls: "it-search-body" });
      body.createDiv({ cls: "it-search-title", text: item.title || t("common.untitled") });
      body.createDiv({ cls: "it-search-sub", text: `${t("search.page")} · ${item.docName}` });
      return;
    }

    const fallback = item.kind === "space" ? "🏷️" : item.kind === "folder" ? "📁" : "📋";
    const ico = renderIconish(iconWrap, item.icon || fallback, { cls: "it-search-icon-glyph" });
    if (ico && item.color) ico.style.color = item.color;
    const body = el.createDiv({ cls: "it-search-body" });
    body.createDiv({ cls: "it-search-title", text: item.name });
    const label = item.kind === "space" ? hierarchyLabel("space") : item.kind === "folder" ? hierarchyLabel("folder") : hierarchyLabel("list");
    body.createDiv({ cls: "it-search-sub", text: label });
  }

  onChooseSuggestion(item: SearchItem) {
    if (item.kind === "task") {
      const mv = this.plugin.getMainView();
      if (mv) {
        mv.openTask(item.tf);
      } else {
        // No main view open — open the task modal directly (and record recency).
        this.plugin.pushRecentTask(item.tf.data.id);
        new TaskModal(this.app, this.plugin, item.tf).open();
      }
      return;
    }
    // Docs / pages open the Doc view (optionally at a specific page).
    if (item.kind === "doc" || item.kind === "docpage") {
      const pageId = item.kind === "docpage" ? item.pageId : undefined;
      const mv = this.plugin.getMainView();
      if (mv) mv.openDocLocation(item.docPath, pageId);
      else void this.plugin.activateView().then(() => this.plugin.getMainView()?.openDocLocation(item.docPath, pageId));
      return;
    }
    const loc: ContextLocation =
      item.kind === "space" ? { kind: "space", path: item.path }
      : item.kind === "folder" ? { kind: "folder", path: item.path }
      : { kind: "list", path: item.path };
    const mv = this.plugin.getMainView();
    if (mv) {
      mv.selectLocation(loc);
    } else {
      void this.plugin.activateView().then(() => this.plugin.getMainView()?.selectLocation(loc));
    }
  }
}
