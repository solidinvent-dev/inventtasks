import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import type InventTasksPlugin from "../main";
import { ExportScope, BackupBundle, BackupTask, BackupList, BackupFolder, BackupSpace } from "../data/export";
import { ImportDestination } from "../data/import";
import {
  getTemplates, deleteTemplate, updateTemplate, templateSummaryText, TemplateFile, TemplateLevel,
  buildTemplateBundle, saveTemplateBundle, pruneBundle, instantiateBundle,
  ElementSelection, defaultSelection, CONFIG_SECTION_DEFS, TASK_FIELD_DEFS,
} from "../data/templates";
import { renderIconRow } from "../ui/pickers";
import { renderIconish } from "../ui/icons";
import { ConfirmModal } from "./confirm-modal";
import { t } from "../i18n";
import { fireAndForget } from "../utils/async";

function tplConfigLabel(key: string): string {
  return t(`template.config.${key}`) || key;
}
function tplTaskFieldLabel(key: string): string {
  return t(`template.taskField.${key}`) || key;
}

// ---------- Shared element selector (Save & Apply) ----------
// Renders aspect toggles + a checkbox tree of the bundle's contents, mutating
// `sel`. Re-renders itself on every change.
export function renderElementSelector(parent: HTMLElement, bundle: BackupBundle, level: TemplateLevel, sel: ElementSelection) {
  const setExcluded = (key: string, on: boolean) => { if (on) sel.excluded.delete(key); else sel.excluded.add(key); };
  const bundleHasTasks = (() => {
    let n = false;
    const wl = (bl: BackupList) => { if (bl.tasks?.length) n = true; };
    const wf = (bf: BackupFolder) => (bf.lists || []).forEach(wl);
    const ws = (bs: BackupSpace) => { (bs.folders || []).forEach(wf); (bs.lists || []).forEach(wl); };
    if (bundle.spaces) bundle.spaces.forEach(ws);
    if (bundle.space) ws(bundle.space);
    if (bundle.folder) wf(bundle.folder);
    if (bundle.list) wl(bundle.list);
    if (bundle.task) n = true;
    return n;
  })();

  // A titled group with "all / none" shortcuts.
  const groupHead = (title: string, onAll: () => void, onNone: () => void, rebuild: () => void) => {
    const h = parent.createDiv({ cls: "it-tpl-sel-group-head" });
    h.createSpan({ cls: "it-tpl-sel-title", text: title });
    const all = h.createEl("button", { cls: "it-tpl-sel-allnone", text: t("common.all"), attr: { type: "button" } });
    all.addEventListener("click", () => { onAll(); rebuild(); });
    const none = h.createEl("button", { cls: "it-tpl-sel-allnone", text: t("common.noneBtn"), attr: { type: "button" } });
    none.addEventListener("click", () => { onNone(); rebuild(); });
  };
  const checkGrid = (defs: Array<{ key: string; label: string }>, set: Set<string>, rebuild: () => void) => {
    const grid = parent.createDiv({ cls: "it-tpl-sel-aspects" });
    for (const d of defs) {
      const r = grid.createDiv({ cls: "it-tpl-sel-aspect" });
      const cb = r.createEl("input", { type: "checkbox" });
      cb.checked = set.has(d.key);
      cb.addEventListener("change", () => { if (cb.checked) set.add(d.key); else set.delete(d.key); rebuild(); });
      r.createSpan({ text: d.label });
    }
  };
  const boolRow = (label: string, val: boolean, onChange: (v: boolean) => void) => {
    const grid = parent.createDiv({ cls: "it-tpl-sel-aspects" });
    const r = grid.createDiv({ cls: "it-tpl-sel-aspect" });
    const cb = r.createEl("input", { type: "checkbox" });
    cb.checked = val;
    cb.addEventListener("change", () => onChange(cb.checked));
    r.createSpan({ text: label });
  };
  const treeRow = (host: HTMLElement, depth: number, icon: string, text: string, key: string, parentExcluded: boolean, rebuild: () => void) => {
    const r = host.createDiv({ cls: "it-tpl-sel-row" + (parentExcluded ? " is-disabled" : "") });
    r.style.paddingLeft = `${depth * 18}px`;
    const cb = r.createEl("input", { type: "checkbox" });
    cb.checked = !parentExcluded && !sel.excluded.has(key);
    cb.disabled = parentExcluded;
    cb.addEventListener("change", () => { setExcluded(key, cb.checked); rebuild(); });
    setIcon(r.createSpan({ cls: "it-tpl-sel-ic" }), icon);
    r.createSpan({ text });
  };

  const build = () => {
    // Preserve the contents/subtask tree scroll across the rebuild that every
    // checkbox toggle triggers, so the list doesn't jump to the top.
    const prevTreeScroll = (parent.querySelector<HTMLElement>(".it-tpl-sel-tree"))?.scrollTop ?? 0;
    const restoreTree = () => {
      const t = parent.querySelector<HTMLElement>(".it-tpl-sel-tree");
      if (t && prevTreeScroll > 0) { t.scrollTop = prevTreeScroll; window.requestAnimationFrame(() => { t.scrollTop = prevTreeScroll; }); }
    };
    parent.empty();
    parent.addClass("it-tpl-sel");

    if (level !== "task") {
      // Configuration sections
      groupHead(t("template.config"), () => CONFIG_SECTION_DEFS.forEach((d) => sel.configSections.add(d.key)), () => sel.configSections.clear(), build);
      checkGrid(CONFIG_SECTION_DEFS.map((d) => ({ ...d, label: tplConfigLabel(d.key) })), sel.configSections, build);
      parent.createDiv({ cls: "it-tpl-sel-title", text: t("template.views") });
      boolRow(t("template.savedViews"), sel.views, (v) => { sel.views = v; build(); });
    }

    if (bundleHasTasks) {
      groupHead(t("template.taskFields"), () => TASK_FIELD_DEFS.forEach((d) => sel.taskFields.add(d.key)), () => sel.taskFields.clear(), build);
      checkGrid(TASK_FIELD_DEFS.map((d) => ({ ...d, label: tplTaskFieldLabel(d.key) })), sel.taskFields, build);
    }

    if (level === "task") {
      parent.createDiv({ cls: "it-tpl-sel-title", text: t("template.subtasks") });
      boolRow(t("template.includeSubtasks"), sel.subtasks, (v) => { sel.subtasks = v; build(); });
      if (sel.subtasks && bundle.task_subtasks?.length) {
        const tree = parent.createDiv({ cls: "it-tpl-sel-tree" });
        for (const st of bundle.task_subtasks) treeRow(tree, 0, "circle", st.data.title || t("common.untitled"), `t:${st.data.id}`, false, build);
      }
      restoreTree();
      return;
    }

    // Contents tree (children of the scope root — the root is the item being created).
    parent.createDiv({ cls: "it-tpl-sel-title", text: t("template.contents") });
    const tree = parent.createDiv({ cls: "it-tpl-sel-tree" });
    const taskRow = (depth: number, task: BackupTask, pEx: boolean) => treeRow(tree, depth, "circle", task.data.title || t("common.untitled"), `t:${task.data.id}`, pEx, build);
    const listRow = (depth: number, bl: BackupList, pEx: boolean) => {
      const key = `l:${bl.srcPath}`;
      treeRow(tree, depth, "list", bl.config.name, key, pEx, build);
      const ex = pEx || sel.excluded.has(key);
      for (const t of bl.tasks || []) taskRow(depth + 1, t, ex);
    };
    const folderRow = (depth: number, bf: BackupFolder, pEx: boolean) => {
      const key = `f:${bf.srcPath}`;
      treeRow(tree, depth, "folder", bf.config.name, key, pEx, build);
      const ex = pEx || sel.excluded.has(key);
      for (const bl of bf.lists || []) listRow(depth + 1, bl, ex);
    };
    const spaceRow = (depth: number, bs: BackupSpace, pEx: boolean) => {
      const key = `s:${bs.srcPath}`;
      treeRow(tree, depth, "box", bs.config.name, key, pEx, build);
      const ex = pEx || sel.excluded.has(key);
      for (const bf of bs.folders || []) folderRow(depth + 1, bf, ex);
      for (const bl of bs.lists || []) listRow(depth + 1, bl, ex);
    };
    const before = tree.childElementCount;
    if (bundle.spaces) bundle.spaces.forEach((s) => spaceRow(0, s, false));
    else if (bundle.space) {
      for (const bf of bundle.space.folders || []) folderRow(0, bf, false);
      for (const bl of bundle.space.lists || []) listRow(0, bl, false);
    } else if (bundle.folder) {
      for (const bl of bundle.folder.lists || []) listRow(0, bl, false);
    } else if (bundle.list) {
      for (const t of bundle.list.tasks || []) taskRow(0, t, false);
    }
    if (tree.childElementCount === before) tree.createDiv({ cls: "it-tpl-sel-empty", text: t("template.noSubItems") });
    restoreTree();
  };
  build();
}

// "Save as template" — captures a Space/Folder/List/Task (and its subtree) as a
// reusable template.
export class SaveTemplateModal extends Modal {
  plugin: InventTasksPlugin;
  tplScope: ExportScope;
  ref: { path?: string; taskId?: string };
  private name: string;
  private description = "";
  private icon: string;
  private bundle: BackupBundle | null = null;
  private sel: ElementSelection = defaultSelection();

  constructor(app: App, plugin: InventTasksPlugin, scope: ExportScope, ref: { path?: string; taskId?: string }, defaults: { name: string; icon?: string }) {
    super(app);
    this.plugin = plugin;
    this.tplScope = scope;
    this.ref = ref;
    this.name = defaults.name || "";
    this.icon = defaults.icon || "layout-template";
  }

  async onOpen() {
    this.modalEl.addClass("it-tpl-modal");
    this.titleEl.setText(t("template.saveTitle", { level: t(`template.level.${this.tplScope}`) || this.tplScope }));
    this.contentEl.empty();
    this.contentEl.createEl("p", { cls: "setting-item-description", text: t("common.loading") });
    try {
      this.bundle = await buildTemplateBundle(this.plugin, this.tplScope, this.ref);
    } catch (e) {
      this.contentEl.empty();
      this.contentEl.createEl("p", { cls: "it-export-error", text: t("template.saveFailed", { msg: (e as Error | undefined)?.message ?? String(e) }) });
      return;
    }
    const c = this.contentEl;
    c.empty();
    c.addClass("it-modal-form");

    c.createEl("p", { cls: "setting-item-description", text: t("template.saveIntro") });

    new Setting(c).setName(t("template.templateName")).addText((inp) =>
      inp.setPlaceholder(t("template.templateNamePlaceholder")).setValue(this.name).onChange((v) => (this.name = v))
    );
    new Setting(c).setName(t("common.description")).addTextArea((inp) => {
      inp.setPlaceholder(t("template.descriptionPlaceholder")).setValue(this.description).onChange((v) => (this.description = v));
      inp.inputEl.rows = 2;
    });
    renderIconRow(c, t("common.icon"), this.icon, (v) => { this.icon = v; });

    renderElementSelector(c.createDiv(), this.bundle, this.tplScope as TemplateLevel, this.sel);

    const footer = c.createDiv({ cls: "it-modal-footer" });
    footer.createEl("button", { text: t("common.cancel"), cls: "it-btn-ghost" }).addEventListener("click", () => this.close());
    const save = footer.createEl("button", { text: t("template.saveBtn"), cls: "it-btn-primary" });
    save.addEventListener("click", fireAndForget(async () => {
      if (!this.name.trim()) { new Notice(t("template.nameRequired")); return; }
      try {
        if (!this.bundle) return;
        const pruned = pruneBundle(this.bundle, this.sel);
        await saveTemplateBundle(this.plugin, this.tplScope as TemplateLevel, pruned, { name: this.name, description: this.description, icon: this.icon });
        this.close();
      } catch (e) {
        new Notice(t("template.saveFailed", { msg: (e as Error | undefined)?.message ?? String(e) }));
      }
    }));
  }
}

// "Apply template" — lets the user pick which elements of a template to
// instantiate (same selector as Save), then imports the pruned bundle.
export class ApplyTemplateModal extends Modal {
  plugin: InventTasksPlugin;
  private tpl: TemplateFile;
  private dest: ImportDestination;
  private topName: string;
  private onDone: () => void;
  private sel: ElementSelection = defaultSelection();

  constructor(app: App, plugin: InventTasksPlugin, tpl: TemplateFile, dest: ImportDestination, topName: string, onDone: () => void) {
    super(app);
    this.plugin = plugin;
    this.tpl = tpl;
    this.dest = dest;
    this.topName = topName;
    this.onDone = onDone;
  }

  onOpen() {
    this.modalEl.addClass("it-tpl-modal");
    this.titleEl.setText(t("template.applyTitle", { name: this.tpl.name }));
    const c = this.contentEl;
    c.empty();
    c.addClass("it-modal-form");
    c.createEl("p", { cls: "setting-item-description", text: t("template.applyIntro", { tplName: this.tpl.name, topName: this.topName }) });

    renderElementSelector(c.createDiv(), this.tpl.bundle, this.tpl.level, this.sel);

    const footer = c.createDiv({ cls: "it-modal-footer" });
    footer.createEl("button", { text: t("common.cancel"), cls: "it-btn-ghost" }).addEventListener("click", () => this.close());
    const apply = footer.createEl("button", { text: t("common.create"), cls: "it-btn-primary" });
    apply.addEventListener("click", fireAndForget(async () => {
      try {
        const pruned = pruneBundle(this.tpl.bundle, this.sel);
        await instantiateBundle(this.plugin, pruned, this.dest, this.topName);
        this.close();
        this.onDone();
      } catch (e) {
        new Notice(t("template.applyFailed", { msg: (e as Error | undefined)?.message ?? String(e) }));
      }
    }));
  }
}

// Renders a shallow tree of a template's contents.
function renderBundleTree(parent: HTMLElement, tpl: TemplateFile) {
  const b = tpl.bundle;
  const tree = parent.createDiv({ cls: "it-tpl-tree" });
  const line = (depth: number, icon: string | null, text: string, muted?: string) => {
    const r = tree.createDiv({ cls: "it-tpl-tree-row" });
    r.style.paddingLeft = `${depth * 16}px`;
    if (icon) setIcon(r.createSpan({ cls: "it-tpl-tree-ic" }), icon);
    r.createSpan({ text });
    if (muted) r.createSpan({ cls: "it-tpl-tree-muted", text: ` · ${muted}` });
  };
  const renderList = (bl: BackupList, depth: number) => {
    line(depth, "list", bl.config.name, t("common.tasks", { count: bl.tasks?.length || 0 }));
    for (const task of (bl.tasks || []).slice(0, 8)) line(depth + 1, "circle", task.data.title || t("common.untitled"));
    if ((bl.tasks?.length || 0) > 8) line(depth + 1, null, t("common.moreItems", { count: bl.tasks.length - 8 }));
  };
  const renderFolder = (bf: BackupFolder, depth: number) => {
    line(depth, "folder", bf.config.name, t("common.lists", { count: bf.lists?.length || 0 }));
    (bf.lists || []).forEach((bl: BackupList) => renderList(bl, depth + 1));
  };
  const renderSpace = (bs: BackupSpace, depth: number) => {
    line(depth, "box", bs.config.name);
    (bs.folders || []).forEach((bf: BackupFolder) => renderFolder(bf, depth + 1));
    (bs.lists || []).forEach((bl: BackupList) => renderList(bl, depth + 1));
  };
  if (b.spaces) b.spaces.forEach((s) => renderSpace(s, 0));
  if (b.space) renderSpace(b.space, 0);
  if (b.folder) renderFolder(b.folder, 0);
  if (b.list) renderList(b.list, 0);
  if (b.task) {
    line(0, "check-square", b.task.data.title || t("list.task"), t("common.subtasks", { count: b.task_subtasks?.length || 0 }));
    for (const s of (b.task_subtasks || []).slice(0, 8)) line(1, "circle", s.data.title || t("common.untitled"));
    if ((b.task_subtasks?.length || 0) > 8) line(1, null, t("common.moreItems", { count: b.task_subtasks!.length - 8 }));
  }
}

// Template manager — browse, preview, rename / edit details, delete.
export class TemplateManagerModal extends Modal {
  plugin: InventTasksPlugin;
  private selectedId: string | null = null;
  private editing = false;

  constructor(app: App, plugin: InventTasksPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.modalEl.addClass("it-tpl-manager");
    this.titleEl.setText(t("modal.templates"));
    this.render();
  }

  private render() {
    const c = this.contentEl;
    const prevListScroll = (c.querySelector<HTMLElement>(".it-tpl-mgr-list"))?.scrollTop ?? 0;
    c.empty();
    const templates = getTemplates();
    if (templates.length === 0) {
      c.createEl("p", { cls: "setting-item-description", text: t("template.empty") });
      return;
    }
    if (!this.selectedId || !templates.some((t) => t.template_id === this.selectedId)) {
      this.selectedId = templates[0].template_id;
      this.editing = false;
    }
    const selected = templates.find((t) => t.template_id === this.selectedId)!;

    const wrap = c.createDiv({ cls: "it-tpl-mgr" });

    // ---- left: list ----
    const list = wrap.createDiv({ cls: "it-tpl-mgr-list" });
    for (const t of templates) {
      const row = list.createDiv({ cls: "it-tpl-mgr-row" + (t.template_id === this.selectedId ? " is-active" : "") });
      const ic = row.createSpan({ cls: "it-tpl-mgr-row-ic" });
      renderIconish(ic, t.icon || "layout-template", { cls: "it-tpl-mgr-row-ic-inner" });
      const meta = row.createDiv({ cls: "it-tpl-mgr-row-meta" });
      meta.createDiv({ cls: "it-tpl-mgr-row-name", text: t.name });
      meta.createDiv({ cls: "it-tpl-mgr-row-sub", text: `${t.level} · ${templateSummaryText(t)}` });
      row.addEventListener("click", () => { this.selectedId = t.template_id; this.editing = false; this.render(); });
    }
    if (prevListScroll > 0) { list.scrollTop = prevListScroll; window.requestAnimationFrame(() => { list.scrollTop = prevListScroll; }); }

    // ---- right: preview / edit ----
    const pane = wrap.createDiv({ cls: "it-tpl-mgr-pane" });
    if (this.editing) {
      this.renderEdit(pane, selected);
    } else {
      this.renderPreview(pane, selected);
    }
  }

  private renderPreview(pane: HTMLElement, tpl: TemplateFile) {
    const head = pane.createDiv({ cls: "it-tpl-mgr-head" });
    const ic = head.createSpan({ cls: "it-tpl-mgr-head-ic" });
    renderIconish(ic, tpl.icon || "layout-template", { cls: "it-tpl-mgr-head-ic-inner" });
    const ht = head.createDiv();
    ht.createDiv({ cls: "it-tpl-mgr-head-name", text: tpl.name });
    ht.createDiv({ cls: "it-tpl-mgr-head-sub", text: `${tpl.level} · ${templateSummaryText(tpl)}` });

    if (tpl.description) pane.createEl("p", { cls: "setting-item-description", text: tpl.description });
    pane.createEl("p", { cls: "it-tpl-mgr-created", text: t("template.created", { date: new Date(tpl.createdAt).toLocaleString() }) });

    pane.createDiv({ cls: "it-tpl-mgr-tree-title", text: t("template.contents") });
    renderBundleTree(pane, tpl);

    const actions = pane.createDiv({ cls: "it-modal-footer" });
    const edit = actions.createEl("button", { cls: "it-btn-secondary", text: t("template.renameEdit") });
    edit.addEventListener("click", () => { this.editing = true; this.render(); });
    const del = actions.createEl("button", { cls: "it-btn-danger", text: t("common.delete") });
    del.addEventListener("click", () => {
      new ConfirmModal(this.app, {
        title: t("template.deleteTitle"),
        message: t("template.deleteMsg", { name: tpl.name }),
        destructive: true,
        confirmLabel: t("common.delete"),
        onConfirm: fireAndForget(async () => { await deleteTemplate(this.plugin, tpl); this.selectedId = null; this.render(); }),
      }).open();
    });
  }

  private renderEdit(pane: HTMLElement, tpl: TemplateFile) {
    let name = tpl.name;
    let description = tpl.description || "";
    let icon = tpl.icon || "layout-template";
    pane.addClass("it-modal-form");
    new Setting(pane).setName(t("common.name")).addText((inp) => inp.setValue(name).onChange((v) => (name = v)));
    new Setting(pane).setName(t("common.description")).addTextArea((inp) => {
      inp.setValue(description).onChange((v) => (description = v));
      inp.inputEl.rows = 3;
    });
    renderIconRow(pane, t("common.icon"), icon, (v) => { icon = v; });

    const actions = pane.createDiv({ cls: "it-modal-footer" });
    actions.createEl("button", { cls: "it-btn-ghost", text: t("common.cancel") }).addEventListener("click", () => { this.editing = false; this.render(); });
    actions.createEl("button", { cls: "it-btn-primary", text: t("common.save") }).addEventListener("click", fireAndForget(async () => {
      if (!name.trim()) { new Notice(t("common.nameRequired")); return; }
      await updateTemplate(this.plugin, tpl, { name, description, icon });
      this.editing = false;
      this.render();
    }));
  }
}
