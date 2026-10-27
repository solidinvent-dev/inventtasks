import { App, Modal, Notice, Setting } from "obsidian";
import type InventTasksPlugin from "../main";
import { STATUS_TEMPLATES, DOC_ICON, resolveViewColorSet, VIEW_COLOR_INDEX } from "../constants";
import { TaskModal } from "./task-modal";
import { renderHierarchyPicker } from "./move-modal";
import { renderIconRow, renderColorRow } from "../ui/pickers";
import { renderIconish } from "../ui/icons";
import { getTemplates, templateSummaryText, TemplateLevel } from "../data/templates";
import { ApplyTemplateModal } from "./template-modals";
import { t } from "../i18n";
import { MAX_TASK_TITLE_LENGTH, validateTaskTitle } from "../data/task-values";

// Shared "Start from" picker — Blank + the templates for a level, with a small
// preview of the selected template's contents. Renders nothing if there are no
// templates for the level.
function renderStartFrom(c: HTMLElement, level: TemplateLevel, get: () => string, set: (v: string) => void) {
  const templates = getTemplates(level);
  if (templates.length === 0) return;
  new Setting(c)
    .setName(t("create.startFrom"))
    .setDesc(t("create.startFromDesc"))
    .addDropdown((d) => {
      d.addOption("blank", t("create.blank"));
      for (const tpl of templates) d.addOption(tpl.template_id, t("create.templatePrefix", { name: tpl.name }));
      d.setValue(get());
      d.onChange((v) => set(v));
    });

  const cur = get();
  if (cur !== "blank") {
    const tpl = templates.find((t) => t.template_id === cur);
    if (tpl) {
      const prev = c.createDiv({ cls: "it-tpl-pick-preview" });
      const head = prev.createDiv({ cls: "it-tpl-pick-head" });
      const ic = head.createSpan({ cls: "it-tpl-pick-icon" });
      renderIconish(ic, tpl.icon || "layout-template", { cls: "it-tpl-pick-icon-inner" });
      head.createSpan({ cls: "it-tpl-pick-name", text: tpl.name });
      head.createSpan({ cls: "it-tpl-pick-stats", text: templateSummaryText(tpl) });
      if (tpl.description) prev.createDiv({ cls: "setting-item-description", text: tpl.description });
    }
  }
}

// Live preview of how the chosen icon+color will render on the sidebar row.
function renderIdentityPreview(parent: HTMLElement, name: string, icon: string, color: string, fallback: string) {
  const wrap = parent.createDiv({ cls: "it-create-preview" });
  const swatch = wrap.createSpan({ cls: "it-create-preview-swatch" });
  swatch.style.background = color;
  const iconEl = renderIconish(swatch, icon || fallback, { cls: "it-create-preview-icon" });
  if (iconEl) iconEl.style.color = "#fff";
  wrap.createSpan({ cls: "it-create-preview-name", text: name || t("common.untitled") });
}

export class CreateSpaceModal extends Modal {
  plugin: InventTasksPlugin;
  name = "";
  icon = "🏷️";
  color = "#0091FF";
  template: keyof typeof STATUS_TEMPLATES = "kanban";
  startFrom = "blank";

  constructor(app: App, plugin: InventTasksPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.titleEl.setText(t("modal.createSpace"));
    this.render();
  }

  private render() {
    const c = this.contentEl;
    c.empty();
    c.addClass("it-modal-form");
    c.addClass("it-create-modal");

    renderIdentityPreview(c, this.name, this.icon, this.color, "🏷️");

    new Setting(c).setName(t("common.name")).addText((inp) =>
      inp.setPlaceholder(t("create.placeholderSpace")).setValue(this.name).onChange((v) => {
        this.name = v;
        const previewName = c.querySelector(".it-create-preview-name");
        if (previewName) previewName.textContent = v || t("common.untitled");
      })
    );

    renderIconRow(c, t("common.icon"), this.icon, (v) => { this.icon = v; this.render(); }, { color: this.color });
    renderColorRow(c, t("common.color"), this.color, (v) => { this.color = v; this.render(); });

    renderStartFrom(c, "space", () => this.startFrom, (v) => { this.startFrom = v; this.render(); });

    if (this.startFrom === "blank") {
      new Setting(c)
        .setName(t("create.statusTemplate"))
        .setDesc(t("create.statusTemplateDesc"))
        .addDropdown((d) =>
          d
            .addOption("kanban", t("create.statusKanban"))
            .addOption("scrum", t("create.statusScrum"))
            .addOption("marketing", t("create.statusMarketing"))
            .addOption("simple", t("create.statusSimple"))
            .setValue(this.template)
            .onChange((v) => (this.template = v as any))
        );
    }

    const actions = c.createDiv({ cls: "it-modal-footer" });
    actions.createEl("button", { text: t("common.cancel"), cls: "it-btn-ghost" }).addEventListener("click", () => this.close());
    const create = actions.createEl("button", { text: t("create.createSpace"), cls: "it-btn-primary" });
    create.addEventListener("click", async () => {
      if (!this.name.trim()) { new Notice(t("common.nameRequired")); return; }
      try {
        const tpl = this.startFrom !== "blank" ? getTemplates("space").find((t) => t.template_id === this.startFrom) : undefined;
        if (tpl) {
          this.close();
          new ApplyTemplateModal(this.app, this.plugin, tpl, {}, this.name.trim(), () => this.plugin.refreshViews()).open();
          return;
        }
        await this.plugin.index.createSpace(this.name.trim(), {
          icon: this.icon,
          color: this.color,
          statusSet: STATUS_TEMPLATES[this.template],
        });
        await this.plugin.index.scan();
        this.plugin.refreshViews();
        this.close();
      } catch (e: any) {
        new Notice(t("common.failed", { msg: e.message }));
      }
    });
  }
}

export class CreateFolderModal extends Modal {
  plugin: InventTasksPlugin;
  spacePath: string;
  name = "";
  icon = "📁";
  color = "#6647F0";
  startFrom = "blank";

  constructor(app: App, plugin: InventTasksPlugin, spacePath: string) {
    super(app);
    this.plugin = plugin;
    this.spacePath = spacePath;
  }

  onOpen() {
    this.titleEl.setText(t("modal.createFolder"));
    this.render();
  }

  private render() {
    const c = this.contentEl;
    c.empty();
    c.addClass("it-modal-form");
    c.addClass("it-create-modal");

    renderIdentityPreview(c, this.name, this.icon, this.color, "📁");

    new Setting(c).setName(t("common.name")).addText((inp) =>
      inp.setPlaceholder(t("create.placeholderFolder")).setValue(this.name).onChange((v) => {
        this.name = v;
        const previewName = c.querySelector(".it-create-preview-name");
        if (previewName) previewName.textContent = v || t("common.untitled");
      })
    );

    renderIconRow(c, t("common.icon"), this.icon, (v) => { this.icon = v; this.render(); }, { color: this.color });
    renderColorRow(c, t("common.color"), this.color, (v) => { this.color = v; this.render(); });
    renderStartFrom(c, "folder", () => this.startFrom, (v) => { this.startFrom = v; this.render(); });

    const actions = c.createDiv({ cls: "it-modal-footer" });
    actions.createEl("button", { text: t("common.cancel"), cls: "it-btn-ghost" }).addEventListener("click", () => this.close());
    const create = actions.createEl("button", { text: t("create.createFolder"), cls: "it-btn-primary" });
    create.addEventListener("click", async () => {
      if (!this.name.trim()) { new Notice(t("common.nameRequired")); return; }
      try {
        const tpl = this.startFrom !== "blank" ? getTemplates("folder").find((t) => t.template_id === this.startFrom) : undefined;
        if (tpl) {
          this.close();
          new ApplyTemplateModal(this.app, this.plugin, tpl, { spacePath: this.spacePath }, this.name.trim(), () => this.plugin.refreshViews()).open();
          return;
        }
        await this.plugin.index.createFolder(this.spacePath, this.name.trim(), { icon: this.icon, color: this.color });
        await this.plugin.index.scan();
        this.plugin.refreshViews();
        this.close();
      } catch (e: any) {
        new Notice(t("common.failed", { msg: e.message }));
      }
    });
  }
}

export class CreateListModal extends Modal {
  plugin: InventTasksPlugin;
  parentPath: string;
  name = "";
  icon = "📋";
  color = "#2196F3";
  startFrom = "blank";

  constructor(app: App, plugin: InventTasksPlugin, parentPath: string) {
    super(app);
    this.plugin = plugin;
    this.parentPath = parentPath;
  }

  onOpen() {
    this.titleEl.setText(t("modal.createList"));
    this.render();
  }

  private render() {
    const c = this.contentEl;
    c.empty();
    c.addClass("it-modal-form");
    c.addClass("it-create-modal");

    renderIdentityPreview(c, this.name, this.icon, this.color, "📋");

    new Setting(c).setName(t("common.name")).addText((inp) =>
      inp.setPlaceholder(t("create.placeholderList")).setValue(this.name).onChange((v) => {
        this.name = v;
        const previewName = c.querySelector(".it-create-preview-name");
        if (previewName) previewName.textContent = v || t("common.untitled");
      })
    );

    renderIconRow(c, t("common.icon"), this.icon, (v) => { this.icon = v; this.render(); }, { color: this.color });
    renderColorRow(c, t("common.color"), this.color, (v) => { this.color = v; this.render(); });
    renderStartFrom(c, "list", () => this.startFrom, (v) => { this.startFrom = v; this.render(); });

    const actions = c.createDiv({ cls: "it-modal-footer" });
    actions.createEl("button", { text: t("common.cancel"), cls: "it-btn-ghost" }).addEventListener("click", () => this.close());
    const create = actions.createEl("button", { text: t("create.createList"), cls: "it-btn-primary" });
    create.addEventListener("click", async () => {
      if (!this.name.trim()) { new Notice(t("common.nameRequired")); return; }
      try {
        const tpl = this.startFrom !== "blank" ? getTemplates("list").find((t) => t.template_id === this.startFrom) : undefined;
        if (tpl) {
          // Destination parent may be a space or a folder.
          const dest = this.plugin.index.findFolder(this.parentPath) ? { folderPath: this.parentPath } : { spacePath: this.parentPath };
          this.close();
          new ApplyTemplateModal(this.app, this.plugin, tpl, dest, this.name.trim(), () => this.plugin.refreshViews()).open();
          return;
        }
        await this.plugin.index.createList(this.parentPath, this.name.trim(), { icon: this.icon, color: this.color });
        await this.plugin.index.scan();
        this.plugin.refreshViews();
        this.close();
      } catch (e: any) {
        new Notice(t("common.failed", { msg: e.message }));
      }
    });
  }
}

// Create a Doc directly under a Space or Folder (it then appears as a sidebar
// item, like a List). Name + icon + color, consistent with CreateListModal.
export class CreateDocModal extends Modal {
  plugin: InventTasksPlugin;
  parentPath: string;
  name = "";
  icon = DOC_ICON;
  color: string;

  constructor(app: App, plugin: InventTasksPlugin, parentPath: string) {
    super(app);
    this.plugin = plugin;
    this.parentPath = parentPath;
    // Default to the scheme's Docs color so new docs match the palette.
    this.color = resolveViewColorSet(plugin.prefs.viewColorScheme, plugin.prefs.viewColors)[VIEW_COLOR_INDEX.doc];
  }

  onOpen() {
    this.titleEl.setText(t("modal.createDoc"));
    this.render();
  }

  private render() {
    const c = this.contentEl;
    c.empty();
    c.addClass("it-modal-form");
    c.addClass("it-create-modal");

    renderIdentityPreview(c, this.name, this.icon, this.color, DOC_ICON);

    new Setting(c).setName(t("common.name")).addText((inp) =>
      inp.setPlaceholder(t("create.placeholderDoc")).setValue(this.name).onChange((v) => {
        this.name = v;
        const previewName = c.querySelector(".it-create-preview-name");
        if (previewName) previewName.textContent = v || t("common.untitled");
      })
    );

    renderIconRow(c, t("common.icon"), this.icon, (v) => { this.icon = v; this.render(); }, { color: this.color });
    renderColorRow(c, t("common.color"), this.color, (v) => { this.color = v; this.render(); });

    const actions = c.createDiv({ cls: "it-modal-footer" });
    actions.createEl("button", { text: t("common.cancel"), cls: "it-btn-ghost" }).addEventListener("click", () => this.close());
    const create = actions.createEl("button", { text: t("create.createDoc"), cls: "it-btn-primary" });
    create.addEventListener("click", async () => {
      if (!this.name.trim()) { new Notice(t("common.nameRequired")); return; }
      try {
        const isFolder = !!this.plugin.index.findFolder(this.parentPath);
        const locArg = isFolder ? { folderPath: this.parentPath } : { spacePath: this.parentPath };
        const locKey = isFolder ? `folder:${this.parentPath}` : `space:${this.parentPath}`;
        await this.plugin.index.createDoc(this.name.trim(), locArg, locKey, { icon: this.icon, color: this.color });
        this.plugin.refreshViews();
        this.close();
      } catch (e: any) {
        new Notice(t("common.failed", { msg: e.message }));
      }
    });
  }
}

export interface QuickTaskOptions {
  // If known, the list picker is skipped.
  listPath?: string;
  // Restrict the list picker to a subtree of the workspace.
  scopeSpacePath?: string;
  scopeFolderPath?: string;
  // Pre-filled task fields (from group bucket / calendar day / "Add subtask" / etc.)
  preset?: {
    status?: string;
    priority?: 1 | 2 | 3 | 4 | null;
    due_date?: string;
    start_date?: string;
    // Seed values for date/datetime custom fields (keyed by field id) — used
    // when a calendar placed by a custom date field creates a task on a day.
    custom_fields?: Record<string, any>;
    tags?: string[];
    context?: string[];
    type?: string;
    // When set, the new task is created as a subtask of this task ID. The modal
    // title + banner reflect that, and createTask wires up parent_task.
    parent_task?: string;
  };
}

export class QuickTaskModal extends Modal {
  plugin: InventTasksPlugin;
  selectedListPath: string | null;
  preset: NonNullable<QuickTaskOptions["preset"]>;
  scopeSpacePath?: string;
  scopeFolderPath?: string;
  title = "";
  startFrom = "blank";

  // Backward-compatible signature: (app, plugin, listPath: string) still works.
  constructor(app: App, plugin: InventTasksPlugin, listPathOrOpts?: string | QuickTaskOptions) {
    super(app);
    this.plugin = plugin;
    const opts: QuickTaskOptions =
      typeof listPathOrOpts === "string"
        ? { listPath: listPathOrOpts }
        : (listPathOrOpts ?? {});
    this.selectedListPath = opts.listPath ?? null;
    this.preset = opts.preset ?? {};
    this.scopeSpacePath = opts.scopeSpacePath;
    this.scopeFolderPath = opts.scopeFolderPath;
  }

  // Resolve the candidate lists honoring the scope (used to detect empty state
  // and to auto-pick the only candidate). Hidden system Spaces and their
  // purpose-built Reminders / Short notes lists are not general-purpose
  // destinations, so a new Item can never be aimed at them.
  private candidateListPaths(): string[] {
    const out: string[] = [];
    for (const space of this.plugin.index.userSpaces) {
      if (this.scopeSpacePath && space.path !== this.scopeSpacePath) continue;
      if (!this.scopeFolderPath) {
        for (const list of space.lists) if (!list.config.system_kind) out.push(list.path);
      }
      for (const folder of space.folders) {
        if (this.scopeFolderPath && folder.path !== this.scopeFolderPath) continue;
        for (const list of folder.lists) if (!list.config.system_kind) out.push(list.path);
      }
    }
    return out;
  }

  private presetSummary(): string {
    const parts: string[] = [];
    if (this.preset.status) parts.push(`status=${this.preset.status}`);
    if (this.preset.priority) parts.push(`priority=${this.preset.priority}`);
    if (this.preset.due_date) parts.push(`due=${this.preset.due_date}`);
    if (this.preset.start_date) parts.push(`start=${this.preset.start_date}`);
    if (this.preset.tags?.length) parts.push(`tags=${this.preset.tags.join(",")}`);
    if (this.preset.context?.length) parts.push(`context=${this.preset.context.join(",")}`);
    if (this.preset.type) parts.push(`type=${this.preset.type}`);
    return parts.join(" · ");
  }

  onOpen() {
    // Subtask-aware: when a parent is preset, this is a "New subtask" flow.
    const parentTask = this.preset.parent_task ? this.plugin.index.tasksById.get(this.preset.parent_task) : undefined;
    this.titleEl.setText(parentTask ? t("modal.newSubtask") : t("modal.newTask"));
    const c = this.contentEl;
    c.empty();
    c.addClass("it-modal-form");
    c.addClass("it-quick-task-modal");

    // Subtask banner — make the parent relationship obvious before creating.
    if (parentTask) {
      const banner = c.createDiv({ cls: "it-quick-subtask-banner" });
      const ic = banner.createSpan({ cls: "it-quick-subtask-ic" });
      renderIconish(ic, parentTask.data.icon || "corner-down-right", { cls: "it-quick-subtask-ic-inner" });
      banner.createSpan({ cls: "it-quick-subtask-label", text: t("create.subtaskOf") });
      banner.createSpan({ cls: "it-quick-subtask-parent", text: parentTask.data.title || parentTask.data.id });
    }

    // List picker — only if the caller didn't already specify one.
    if (!this.selectedListPath) {
      const candidates = this.candidateListPaths();
      if (candidates.length === 0) {
        c.createDiv({ cls: "it-empty-row", text: t("create.noListsInScope") });
        const close = c.createEl("button", { text: t("common.close"), cls: "it-btn-ghost" });
        close.addEventListener("click", () => this.close());
        return;
      }

      // Auto-pick when there's only one option (skip the picker UI).
      if (candidates.length === 1) {
        this.selectedListPath = candidates[0];
      } else {
        c.createDiv({ cls: "it-move-modal-section-label", text: t("create.pickList") });
        const pickerWrap = c.createDiv({ cls: "it-move-modal it-quick-task-picker" });
        renderHierarchyPicker(pickerWrap, this.plugin, {
          kinds: ["list"],
          scopeSpacePath: this.scopeSpacePath,
          scopeFolderPath: this.scopeFolderPath,
          searchPlaceholder: t("create.searchLists"),
          emptyText: t("create.noListsMatch"),
          onSelect: (item) => {
            this.selectedListPath = item?.path ?? null;
          },
        });
      }
    }

    // Preset summary (optional — helps the user understand what'll be filled in)
    const summary = this.presetSummary();
    if (summary) {
      c.createDiv({ cls: "setting-item-description", text: t("create.prefilled", { summary }) });
    }

    renderStartFrom(c, "task", () => this.startFrom, (v) => { this.startFrom = v; });

    const input = c.createEl("input", {
      type: "text",
      cls: "it-modal-input",
      attr: { required: "true", maxlength: String(MAX_TASK_TITLE_LENGTH) },
    });
    input.placeholder = t("create.taskTitle");
    input.addEventListener("input", () => input.setCustomValidity(""));
    setTimeout(() => input.focus(), 30);

    const submit = async () => {
      const checkedTitle = validateTaskTitle(input.value);
      if (!checkedTitle.valid) {
        const message = checkedTitle.reason === "required"
          ? t("err.taskTitleRequired")
          : t("err.taskTitleTooLong", { max: String(MAX_TASK_TITLE_LENGTH) });
        input.setCustomValidity(message);
        input.reportValidity();
        new Notice(message);
        return;
      }
      this.title = checkedTitle.value;
      if (!this.selectedListPath) {
        new Notice(t("common.pickListFirst"));
        return;
      }
      try {
        const tpl = this.startFrom !== "blank" ? getTemplates("task").find((t) => t.template_id === this.startFrom) : undefined;
        if (tpl) {
          this.close();
          new ApplyTemplateModal(this.app, this.plugin, tpl, { listPath: this.selectedListPath }, this.title, () => this.plugin.refreshViews()).open();
          return;
        }
        const tf = await this.plugin.index.createTask({
          listPath: this.selectedListPath,
          title: this.title,
          ...this.preset,
        });
        new Notice(t("create.taskCreated", { id: tf.data.id }));
        this.close();
        this.plugin.refreshViews();
        // Open the full task modal so the user can fine-tune the rest of the fields.
        const fresh = this.plugin.index.tasksById.get(tf.data.id) ?? tf;
        new TaskModal(this.app, this.plugin, fresh, { editDescription: true }).open();
      } catch (e: any) {
        new Notice(t("common.failed", { msg: e.message }));
      }
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); submit(); }
      else if (ev.key === "Escape") this.close();
    });

    const actions = c.createDiv({ cls: "it-modal-footer" });
    actions.createEl("button", { text: t("common.cancel"), cls: "it-btn-ghost" }).addEventListener("click", () => this.close());
    const create = actions.createEl("button", { text: t("common.create"), cls: "it-btn-primary" });
    create.addEventListener("click", submit);
  }
}
