import { App, Component, MarkdownRenderer, Modal, Notice, setIcon } from "obsidian";
import type InventTasksPlugin from "../main";
import type { CommentEntry, TaskFile } from "../types";
import type { SystemListKind } from "../data/workspace-index";
import { ConfirmModal } from "../modals/confirm-modal";
import { MoveTaskModal } from "../modals/move-modal";
import { TaskPickerModal } from "../modals/task-picker-modal";
import { DocPickerModal } from "../modals/doc-picker-modal";
import { TaskModal } from "../modals/task-modal";
import { DOC_ACCENT, DOC_ICON } from "../constants";
import { appendActivity } from "../data/activity";
import { addComment, editComment, moveComment, removeComment } from "../data/comments";
import { addRelated, getRelated, removeRelated } from "../data/relationships";
import { buildDropdown, priorityChip, statusChip, tagChip, showPopover, applyChipStyleByKind } from "../ui/components";
import { renderFieldIcon, renderIconish } from "../ui/icons";
import { fieldLabelFrom, t } from "../i18n";
import { formatDate } from "../utils/dates";
import { renderDateTimeInput } from "../ui/datetime-field";
import { notificationHasTime, notificationSeverityForDate, notificationSortDateTimeKey } from "./notifications-view";

export type SystemViewKind = SystemListKind;

interface RenderSystemListViewOptions {
  parent: HTMLElement;
  plugin: InventTasksPlugin;
  kind: SystemViewKind;
  onTaskClick: (task: TaskFile) => void;
  rerender: () => void;
}

function descriptionFromBody(task: TaskFile): string {
  return (task.body || "").replace(/^\s*# .*(?:\r?\n|$)/, "").trim();
}

function sortTasks(plugin: InventTasksPlugin, kind: SystemViewKind, tasks: TaskFile[]): TaskFile[] {
  return tasks.slice().sort((a, b) => {
    if (kind === "reminders") {
      const ad = a.data.due_date ? notificationSortDateTimeKey(plugin, a.data.due_date) : "9999-12-31:1:99:99";
      const bd = b.data.due_date ? notificationSortDateTimeKey(plugin, b.data.due_date) : "9999-12-31:1:99:99";
      return ad.localeCompare(bd) || (a.data.created_at || "").localeCompare(b.data.created_at || "");
    }
    return (b.data.created_at || "").localeCompare(a.data.created_at || "");
  });
}

function titleForKind(kind: SystemViewKind): string {
  return kind === "reminders" ? t("nav.reminders") : t("nav.shortNotes");
}

function emptyTitle(kind: SystemViewKind): string {
  return kind === "reminders" ? t("system.reminders.emptyTitle") : t("system.shortNotes.emptyTitle");
}

function emptyDesc(kind: SystemViewKind): string {
  return kind === "reminders" ? t("system.reminders.emptyDesc") : t("system.shortNotes.emptyDesc");
}

export function renderSystemListView(opts: RenderSystemListViewOptions) {
  const { parent, plugin, kind } = opts;
  parent.empty();
  parent.addClass("it-system-list");
  parent.removeClass("it-notifications");

  const list = plugin.index.systemList(kind);
  const flabels = plugin.index.resolveFieldLabels({ listPath: list?.path });
  const tasks = sortTasks(plugin, kind, list?.taskFiles ?? []);
  const title = titleForKind(kind);
  const description = kind === "reminders" ? t("system.reminders.desc") : t("system.shortNotes.desc");

  const head = parent.createDiv({ cls: "it-notifications-head" });
  const heading = head.createEl("h2", { attr: { title: description } });
  setIcon(heading.createSpan({ cls: "it-notifications-title-icon" }), kind === "reminders" ? "alarm-clock" : "sticky-note");
  heading.createSpan({ text: title });
  const headActions = head.createDiv({ cls: "it-notifications-head-actions" });
  const count = headActions.createDiv({ cls: "it-notifications-count" });
  count.createSpan({ text: String(tasks.length) });
  const addLabel = kind === "reminders" ? t("system.reminders.add") : t("system.shortNotes.add");
  const addBtn = headActions.createEl("button", { cls: "it-secondary-btn it-system-add-btn", attr: { "aria-label": addLabel } });
  setIcon(addBtn.createSpan({ cls: "it-btn-ic" }), "plus");
  addBtn.createSpan({ text: addLabel });
  addBtn.addEventListener("click", () => new SystemItemModal(plugin.app, plugin, kind, undefined, opts.rerender).open());

  if (!list) {
    parent.createDiv({ cls: "it-notifications-empty-title", text: t("system.listMissing") });
    return;
  }

  if (tasks.length === 0) {
    const empty = parent.createDiv({ cls: "it-notifications-empty" });
    empty.createDiv({ cls: "it-notifications-empty-title", text: emptyTitle(kind) });
    empty.createDiv({ cls: "it-notifications-empty-desc", text: emptyDesc(kind) });
    return;
  }

  const rows = parent.createDiv({ cls: "it-notifications-list" });
  for (const task of tasks) {
    const severity = kind === "reminders" ? notificationSeverityForDate(plugin, task.data.due_date) : "info";
    const row = rows.createDiv({ cls: `it-notification-row it-system-row is-${severity}${kind === "reminders" ? " is-reminder" : ""}` });
    row.addEventListener("click", () => new SystemItemModal(plugin.app, plugin, kind, task, opts.rerender).open());
    row.createDiv({ cls: "it-notification-marker" });
    const body = row.createDiv({ cls: "it-notification-body" });
    const title = body.createDiv({ cls: "it-notification-title" });
    if (kind === "reminders") {
      const reminderIcon = title.createSpan({ cls: "it-notification-reminder-icon" });
      setIcon(reminderIcon, "alarm-clock");
    }
    title.createSpan({ text: task.data.title || t("common.untitled") });
    const metaParts: string[] = [];
    if (task.data.due_date) metaParts.push(`${fieldLabelFrom(flabels, "due_date")}: ${formatDate(task.data.due_date, { withTime: notificationHasTime(task.data.due_date), format: plugin.prefs.dateFormat })}`);
    if (kind === "short_notes" && task.data.created_at) metaParts.push(`${fieldLabelFrom(flabels, "created_at")}: ${formatDate(task.data.created_at, { format: plugin.prefs.dateFormat })}`);
    const attCount = Array.isArray(task.data.attachments) ? task.data.attachments.length : 0;
    if (attCount > 0) metaParts.push(t("system.attachmentsCount", { count: String(attCount) }));
    body.createDiv({ cls: "it-notification-meta", text: metaParts.join(" · ") });
    const desc = descriptionFromBody(task);
    if (desc) body.createDiv({ cls: "it-notification-submeta", text: desc.length > 180 ? `${desc.slice(0, 180)}...` : desc });

    const actions = row.createDiv({ cls: "it-notification-actions" });
    const edit = actions.createEl("button", { cls: "it-icon-btn it-notification-icon-btn", attr: { "aria-label": t("common.edit"), title: t("common.edit") } });
    setIcon(edit, "pencil");
    edit.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      new SystemItemModal(plugin.app, plugin, kind, task, opts.rerender, { editDescription: true }).open();
    });
    const del = actions.createEl("button", { cls: "it-icon-btn it-notification-icon-btn it-danger", attr: { "aria-label": t("common.delete"), title: t("common.delete") } });
    setIcon(del, "trash-2");
    del.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      new ConfirmModal(plugin.app, {
        title: t("system.deleteTitle"),
        message: t("system.deleteMsg", { title: task.data.title || t("common.untitled") }),
        destructive: true,
        onConfirm: async () => {
          await plugin.index.deleteTask(task.data.id);
          opts.rerender();
        },
      }).open();
    });
  }
}

export class SystemItemModal extends Modal {
  private comp = new Component();
  private descriptionEditing = false;
  private editingCommentId: string | null = null;

  constructor(
    app: App,
    private plugin: InventTasksPlugin,
    private kind: SystemViewKind,
    private task: TaskFile | undefined,
    private onSaved: () => void,
    options: { editDescription?: boolean } = {},
  ) {
    super(app);
    this.descriptionEditing = !task || options.editDescription === true;
  }

  onOpen() {
    this.modalEl.addClass("it-task-modal");
    this.modalEl.addClass("it-system-item-modal");
    this.titleEl.empty();
    this.comp.load();
    void this.ensureTask().then(() => this.render());
    const unsub = this.plugin.index.onChange(() => {
      if (!this.task) return;
      const fresh = this.plugin.index.tasksById.get(this.task.data.id);
      if (fresh) {
        this.task = fresh;
        this.render();
      } else {
        this.close();
      }
    });
    this.comp.register(unsub);
  }

  onClose() {
    this.comp.unload();
    this.contentEl.empty();
  }

  private systemTypeMeta() {
    return this.kind === "reminders"
      ? { id: "reminder", name: t("nav.reminders"), icon: "alarm-clock", color: "#F59E0B" }
      : { id: "short_note", name: t("nav.shortNotes"), icon: "sticky-note", color: "#14B8A6" };
  }

  // Location-aware built-in field label for this item's system list.
  private flabel(key: string): string {
    return fieldLabelFrom(this.plugin.index.resolveFieldLabels({ listPath: this.task?.listPath }), key);
  }

  private async ensureTask(): Promise<void> {
    if (this.task) return;
    let list = this.plugin.index.systemList(this.kind);
    if (!list) {
      await this.plugin.index.ensureSystemLists();
      await this.plugin.index.scan();
      list = this.plugin.index.systemList(this.kind);
    }
    if (!list) throw new Error(t("system.listMissing"));
    const meta = this.systemTypeMeta();
    this.task = await this.plugin.index.createTask({
      listPath: list.path,
      title: t("common.untitled"),
      type: meta.id,
      body: `\n# ${t("common.untitled")}\n`,
    });
    this.onSaved();
  }

  private async patch(fn: (data: any, body: string) => { data: any; body?: string } | void) {
    if (!this.task) return;
    try {
      await this.plugin.index.updateTask(this.task.data.id, fn);
      this.onSaved();
    } catch (e: any) {
      new Notice(t("task.notice.updateFailed", { msg: e.message }));
    }
  }

  private render() {
    if (!this.task) return;
    const task = this.task;
    const data = task.data;
    const statusSet = this.plugin.index.resolveStatusSet(task.listPath).statuses;
    const status = statusSet.find((s) => s.id === data.status) || statusSet.find((s) => s.is_default) || statusSet[0];
    const priorities = this.plugin.index.resolvePriorities({ listPath: task.listPath });
    const chipStyles = this.plugin.index.resolveChipStyles({ listPath: task.listPath });
    const type = this.systemTypeMeta();

    const c = this.contentEl;
    c.empty();
    c.addClass("it-modal-form");
    c.addClass("it-system-task-modal-body");

    const header = c.createDiv({ cls: "it-task-header" });
    const topRow = header.createDiv({ cls: "it-task-header-top" });
    const typeBadge = topRow.createDiv({ cls: "it-type-badge" });
    const typeIcon = renderIconish(typeBadge, type.icon, { cls: "it-type-badge-icon" });
    if (typeIcon) typeIcon.style.color = type.color;
    typeBadge.createSpan({ text: type.name });

    const actions = topRow.createDiv({ cls: "it-task-header-actions" });
    const moveBtn = actions.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": t("task.header.moveToList") } });
    setIcon(moveBtn, "folder-input");
    moveBtn.addEventListener("click", () => {
      if (this.task) new MoveTaskModal(this.app, this.plugin, this.task.data.id).open();
    });
    const delBtn = actions.createEl("button", { cls: "it-icon-btn it-danger", attr: { "aria-label": t("task.header.delete") } });
    setIcon(delBtn, "trash");
    delBtn.addEventListener("click", () => {
      new ConfirmModal(this.app, {
        title: t("task.confirm.deleteTitle"),
        message: t("task.confirm.deleteMsg", { title: data.title || t("common.untitled") }),
        destructive: true,
        onConfirm: async () => {
          await this.plugin.index.deleteTask(data.id);
          this.onSaved();
          this.close();
        },
      }).open();
    });

    this.renderBreadcrumb(header);

    const titleEl = c.createEl("input", { type: "text", cls: "it-task-title-input" });
    titleEl.value = data.title || "";
    titleEl.placeholder = t("task.titlePlaceholder");
    titleEl.addEventListener("change", async () => {
      const next = titleEl.value.trim() || t("common.untitled");
      if (next !== data.title) {
        await this.patch((d) => ({
          data: { ...d, title: next, type: type.id, activity: appendActivity(d.activity, { kind: "title", from: d.title, to: next }) },
        }));
      }
    });

    this.renderDescriptionSection(c);

    const fieldsWrap = c.createDiv({ cls: "it-task-fields" });
    const bar = fieldsWrap.createDiv({ cls: "it-fields-bar it-primary-fields-bar" });
    renderFieldIcon(bar, "status");
    statusChip(bar, status, (e) => {
      showPopover(e.currentTarget as HTMLElement, (root) => {
        buildDropdown({
          parent: root,
          current: data.status,
          items: statusSet.map((s) => ({ value: s.id, label: s.name, color: s.color })),
          onSelect: async (value) => {
            document.querySelectorAll(".it-popover").forEach((el) => el.remove());
            const so = statusSet.find((s) => s.id === value);
            await this.patch((d) => ({
              data: {
                ...d,
                status: value,
                status_group: so?.group,
                type: type.id,
                activity: appendActivity(d.activity, { kind: "status", from: d.status ?? null, to: value }),
              },
            }));
          },
        });
      });
    }, chipStyles);

    renderFieldIcon(bar, "priority");
    priorityChip(bar, data.priority, priorities, (e) => {
      showPopover(e.currentTarget as HTMLElement, (root) => {
        buildDropdown({
          parent: root,
          current: data.priority,
          items: [
            ...priorities.map((p) => ({ value: p.id as any, label: p.label, color: p.color })),
            { value: null as any, label: t("task.header.noPriority"), color: "#9E9E9E" },
          ],
          onSelect: async (value) => {
            await this.patch((d) => ({
              data: { ...d, priority: value ?? null, type: type.id, activity: appendActivity(d.activity, { kind: "priority", from: d.priority ?? null, to: value ?? null }) },
            }));
            document.querySelectorAll(".it-popover").forEach((el) => el.remove());
          },
        });
      });
    }, chipStyles);

    const datesBar = fieldsWrap.createDiv({ cls: "it-task-field-row it-task-date-row" });
    const dueWrap = datesBar.createDiv({ cls: "it-field-group" });
    this.renderFieldLabel(dueWrap, "due_date", this.flabel("due_date"));
    renderDateTimeInput({
      parent: dueWrap,
      kind: "datetime",
      value: data.due_date,
      onCommit: (next) => void this.patch((d) => ({ data: { ...d, due_date: next, type: type.id, activity: appendActivity(d.activity, { kind: "due_date", from: d.due_date ?? null, to: next }) } })),
      pairClass: "it-modal-datetime-pair",
      dateClass: "it-mdt it-mdt-date",
      timeClass: "it-mdt it-mdt-time",
    });

    this.renderTagsSection(c, chipStyles);
    this.renderContextSection(c, chipStyles);
    this.renderRelatedSection(c);
    this.renderDocumentsSection(c);
    if (this.plugin.prefs.activityConfig.showComments) this.renderCommentsSection(c);

    const footer = c.createDiv({ cls: "it-task-footer" });
    footer.createSpan({ text: data.id });
    if (data.created_at) footer.createSpan({ text: `${this.flabel("created_at")}: ${formatDate(data.created_at, { withTime: true })}` });
    if (data.updated_at) footer.createSpan({ text: `${this.flabel("updated_at")}: ${formatDate(data.updated_at, { withTime: true })}` });
  }

  private renderBreadcrumb(parent: HTMLElement) {
    if (!this.task) return;
    const list = this.plugin.index.findList(this.task.listPath || "");
    const space = list?.spacePath ? this.plugin.index.findSpace(list.spacePath) : undefined;
    const breadcrumb = parent.createDiv({ cls: "it-breadcrumb" });
    const segments = [
      space ? { label: space.config.name, icon: space.config.icon, color: space.config.color } : undefined,
      list ? { label: list.config.name, icon: list.config.icon, color: list.config.color } : undefined,
    ].filter(Boolean) as Array<{ label: string; icon?: string; color?: string }>;
    segments.forEach((seg, index) => {
      if (index > 0) breadcrumb.createSpan({ text: "/", cls: "it-breadcrumb-sep" });
      const el = breadcrumb.createSpan({ cls: "it-breadcrumb-seg" });
      const icon = renderIconish(el, seg.icon || "📋", { cls: "it-breadcrumb-icon" });
      if (icon && seg.color) icon.style.color = seg.color;
      el.createSpan({ text: seg.label, cls: "it-breadcrumb-name" });
    });
  }

  private renderFieldLabel(parent: HTMLElement, key: string, label?: string) {
    const lbl = parent.createSpan({ cls: "it-field-label" });
    renderFieldIcon(lbl, key);
    lbl.createSpan({ text: label ?? this.flabel(key) });
    return lbl;
  }

  private renderTagsSection(parent: HTMLElement, chipStyles: any) {
    if (!this.task) return;
    const task = this.task;
    const sec = parent.createDiv({ cls: "it-section" });
    const head = sec.createDiv({ cls: "it-section-title-row" });
    const title = head.createDiv({ cls: "it-section-title" });
    renderFieldIcon(title, "tags");
    title.createSpan({ text: this.flabel("tags") });
    const list = sec.createDiv({ cls: "it-tags-list" });
    const render = () => {
      list.empty();
      const palette = this.plugin.index.resolveTagsPalette({ listPath: task.listPath });
      const colorMap = new Map(palette.map((tag) => [tag.name, tag.color]));
      for (const tag of task.data.tags || []) {
        const chip = tagChip(list, tag, colorMap.get(tag), undefined, chipStyles);
        const remove = chip.createSpan({ text: "×", cls: "it-tag-remove" });
        remove.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          await this.patch((d) => ({ data: { ...d, tags: (d.tags || []).filter((x: string) => x !== tag) } }));
        });
      }
      const add = list.createEl("button", { cls: "it-chip it-chip-add", text: t("task.tags.add") });
      add.addEventListener("click", () => {
        showPopover(add, (root) => {
          const input = root.createEl("input", { type: "text", cls: "it-tag-picker-input", attr: { placeholder: t("task.tags.searchPlaceholder") } });
          const results = root.createDiv({ cls: "it-tag-picker-list" });
          const refresh = () => {
            results.empty();
            const query = input.value.trim().toLowerCase();
            const current = new Set(task.data.tags || []);
            for (const tag of palette.filter((p) => !query || p.name.toLowerCase().includes(query))) {
              const row = results.createEl("button", { cls: "it-tag-picker-item" + (current.has(tag.name) ? " is-active" : "") });
              row.style.setProperty("--chip-color", tag.color);
              row.createSpan({ text: "#" + tag.name, cls: "it-tag-picker-name" });
              row.addEventListener("mousedown", async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const next = current.has(tag.name) ? (task.data.tags || []).filter((x) => x !== tag.name) : [...(task.data.tags || []), tag.name];
                await this.patch((d) => ({ data: { ...d, tags: next } }));
              });
            }
            const raw = input.value.trim();
            if (raw && !current.has(raw) && !palette.some((p) => p.name.toLowerCase() === raw.toLowerCase())) {
              const row = results.createEl("button", { cls: "it-tag-picker-item it-tag-picker-add", text: t("task.tags.addNamed", { name: raw }) });
              row.addEventListener("mousedown", async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                await this.patch((d) => ({ data: { ...d, tags: [...(d.tags || []), raw] } }));
              });
            }
          };
          input.addEventListener("input", refresh);
          refresh();
          requestAnimationFrame(() => input.focus());
        });
      });
    };
    render();
  }

  private renderContextSection(parent: HTMLElement, chipStyles: any) {
    if (!this.task) return;
    const task = this.task;
    const sec = parent.createDiv({ cls: "it-section" });
    const head = sec.createDiv({ cls: "it-section-title-row" });
    const title = head.createDiv({ cls: "it-section-title" });
    renderFieldIcon(title, "context");
    title.createSpan({ text: this.flabel("context") });
    const list = sec.createDiv({ cls: "it-tags-list" });
    const labels = this.plugin.index.resolveContextLabels({ listPath: task.listPath });
    const selected = new Set(task.data.context || []);
    for (const label of labels) {
      const active = selected.has(label.name);
      const chip = list.createEl("button", { cls: "it-chip it-chip-tag" + (active ? " is-active" : "") });
      chip.style.setProperty("--chip-color", label.color);
      applyChipStyleByKind(chip, "context", chipStyles);
      chip.setText(label.name);
      chip.addEventListener("click", async () => {
        const next = active ? (task.data.context || []).filter((x) => x !== label.name) : [...(task.data.context || []), label.name];
        await this.patch((d) => ({ data: { ...d, context: next } }));
      });
    }
    for (const extra of task.data.context || []) {
      if (labels.some((label) => label.name === extra)) continue;
      const chip = list.createEl("button", { cls: "it-chip it-chip-tag is-active", text: extra });
      const remove = chip.createSpan({ text: "×", cls: "it-tag-remove" });
      remove.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await this.patch((d) => ({ data: { ...d, context: (d.context || []).filter((x: string) => x !== extra) } }));
      });
    }
  }

  private renderLinkedTypeIcon(parent: HTMLElement, linked: TaskFile | undefined) {
    if (!linked) return;
    const type = this.plugin.index.resolveTaskTypes({ listPath: linked.listPath }).find((tt) => tt.id === linked.data.type);
    const icon = renderIconish(parent, type?.icon || "check-square", { cls: "it-linked-type-icon" });
    if (icon && type?.color) icon.style.color = type.color;
  }

  private renderRelatedSection(parent: HTMLElement) {
    if (!this.task) return;
    const task = this.task;
    const related = getRelated(task, this.plugin.index);
    const sec = parent.createDiv({ cls: "it-section it-section-relationships" });
    sec.createDiv({ cls: "it-section-title", text: t("task.relationships.title") });
    const group = sec.createDiv({ cls: "it-rel-group" });
    const head = group.createDiv({ cls: "it-rel-header" });
    const label = head.createDiv({ cls: "it-rel-label" });
    label.createDiv({ cls: "it-rel-title", text: t("task.relationships.related") });
    label.createDiv({ cls: "it-rel-mirror-hint", text: t("task.relationships.mirrorRelated") });
    const add = head.createEl("button", { cls: "it-btn-ghost it-rel-add", text: t("task.relationships.addRelated") });
    add.addEventListener("click", () => {
      new TaskPickerModal(this.app, this.plugin, {
        title: t("task.relationships.linkPickerTitle", { label: t("task.relationships.related") }),
        multi: true,
        excludeIds: [task.data.id, ...related],
        source: { id: task.data.id, title: task.data.title || t("common.untitled"), icon: task.data.icon, color: task.data.color },
        contextLabel: t("task.relationships.linkContext", { label: t("task.relationships.related"), inverse: t("task.relationships.related") }),
        confirmLabel: t("task.picker.link"),
        onPick: async (picked) => {
          for (const id of picked) await addRelated(this.plugin.index, task.data.id, id);
        },
      }).open();
    });
    const items = group.createDiv({ cls: "it-rel-items" });
    if (related.length === 0) items.createSpan({ cls: "it-empty-inline", text: t("task.relationships.none") });
    for (const id of related) {
      const linked = this.plugin.index.tasksById.get(id);
      const chip = items.createEl("button", { cls: "it-chip it-chip-link" });
      this.renderLinkedTypeIcon(chip, linked);
      chip.createSpan({ cls: "it-chip-link-title", text: linked?.data.title || id });
      if (linked) {
        chip.addEventListener("click", () => {
          const systemKind = this.plugin.index.findList(linked.listPath || "")?.config.system_kind;
          if (systemKind) new SystemItemModal(this.app, this.plugin, systemKind, linked, this.onSaved).open();
          else new TaskModal(this.app, this.plugin, linked).open();
        });
      }
      const remove = chip.createSpan({ text: "×", cls: "it-tag-remove" });
      remove.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        new ConfirmModal(this.app, {
          title: t("modal.deleteConfirm"),
          message: t("task.relationships.related"),
          destructive: true,
          confirmLabel: t("common.remove"),
          onConfirm: () => removeRelated(this.plugin.index, task.data.id, id),
        }).open();
      });
    }
  }

  private renderDocumentsSection(parent: HTMLElement) {
    if (!this.task) return;
    const task = this.task;
    const ids: string[] = Array.isArray(task.data.documents) ? task.data.documents : [];
    const sec = parent.createDiv({ cls: "it-section it-section-documents" });
    const head = sec.createDiv({ cls: "it-section-title-row" });
    const title = head.createDiv({ cls: "it-section-title" });
    renderFieldIcon(title, "documents");
    title.createSpan({ text: " " + this.flabel("documents") });
    const add = head.createEl("button", { cls: "it-btn-ghost", text: t("task.documents.add") });
    add.addEventListener("click", () => {
      new DocPickerModal(this.app, this.plugin, {
        title: t("task.documents.pickerTitle"),
        multi: true,
        excludeIds: ids,
        source: { title: task.data.title || t("common.untitled"), icon: task.data.icon, color: task.data.color },
        contextLabel: t("task.documents.pickerContext"),
        confirmLabel: t("task.picker.link"),
        onPick: async (picked) => {
          await this.patch((d) => {
            const cur: string[] = Array.isArray(d.documents) ? d.documents : [];
            const next = [...cur];
            for (const id of picked) if (!next.includes(id)) next.push(id);
            return { data: { ...d, documents: next } };
          });
        },
      }).open();
    });
    const list = sec.createDiv({ cls: "it-subtasks-list" });
    if (ids.length === 0) list.createDiv({ cls: "it-empty-row", text: t("task.documents.empty") });
    for (const id of ids) {
      const doc = this.plugin.index.docById(id);
      const row = list.createDiv({ cls: "it-subtask-row" });
      const icon = renderIconish(row, doc?.icon || DOC_ICON, { cls: "it-linked-type-icon" });
      if (icon) icon.style.color = doc?.color || DOC_ACCENT;
      const title = row.createSpan({ text: doc?.name || id, cls: "it-subtask-title" });
      if (doc?.__path) title.addEventListener("click", () => this.openLinkedDoc(doc.__path!));
      const remove = row.createEl("button", { cls: "it-icon-btn it-icon-btn-mini it-subtask-remove", attr: { "aria-label": t("task.documents.remove") } });
      setIcon(remove, "x");
      remove.addEventListener("click", async () => {
        await this.patch((d) => {
          const next = ((d.documents || []) as string[]).filter((x) => x !== id);
          return { data: { ...d, documents: next.length ? next : undefined } };
        });
      });
    }
  }

  private openLinkedDoc(path: string) {
    const taskId = this.task?.data.id;
    this.close();
    const mv = this.plugin.getMainView();
    if (mv) mv.openDocLocation(path, undefined, taskId);
    else void this.plugin.activateView().then(() => this.plugin.getMainView()?.openDocLocation(path, undefined, taskId));
  }

  private renderMarkdownInto(parent: HTMLElement, markdown: string) {
    parent.empty();
    if (!markdown.trim()) {
      parent.createDiv({ cls: "it-empty-row", text: t("task.description.empty") });
      return;
    }
    void MarkdownRenderer.render(this.plugin.app, markdown, parent, this.task?.filePath || "", this.comp);
  }

  private descriptionBody(): string {
    return (this.task?.body || "").replace(/^[ \t]*\r?\n/, "");
  }

  private renderDescriptionSection(parent: HTMLElement) {
    if (!this.task) return;
    const sec = parent.createDiv({ cls: "it-section" });
    const head = sec.createDiv({ cls: "it-section-title-row" });
    head.createDiv({ cls: "it-section-title", text: t("task.description.title") });
    const toggle = head.createEl("button", { cls: "it-btn-ghost", text: this.descriptionEditing ? t("common.cancel") : t("task.description.edit") });
    if (this.descriptionEditing) {
      const area = sec.createEl("textarea", { cls: "it-task-body" });
      area.value = this.descriptionBody();
      area.rows = 12;
      area.placeholder = t("task.description.placeholder");
      const actions = sec.createDiv({ cls: "it-desc-actions" });
      actions.createEl("button", { cls: "it-btn-primary", text: t("common.save") }).addEventListener("click", async () => {
        const next = area.value;
        this.descriptionEditing = false;
        await this.patch(() => ({ data: {}, body: next }));
      });
      toggle.addEventListener("click", () => {
        this.descriptionEditing = false;
        this.render();
      });
    } else {
      const view = sec.createDiv({ cls: "it-task-body-rendered markdown-rendered" });
      this.renderMarkdownInto(view, this.descriptionBody());
      toggle.addEventListener("click", () => {
        this.descriptionEditing = true;
        this.render();
      });
    }
  }

  private renderCommentsSection(parent: HTMLElement) {
    if (!this.task) return;
    const taskId = this.task.data.id;
    const comments: CommentEntry[] = Array.isArray(this.task.data.comments) ? this.task.data.comments : [];
    const sec = parent.createDiv({ cls: "it-section it-comments-section" });
    const head = sec.createDiv({ cls: "it-section-title-row" });
    head.createDiv({ cls: "it-section-title", text: t("task.comments.title") });
    if (comments.length) head.createSpan({ cls: "it-checklist-progress", text: String(comments.length) });
    const list = sec.createDiv({ cls: "it-comments-list" });
    if (!comments.length) list.createDiv({ cls: "it-empty-row", text: t("task.comments.empty") });
    comments.forEach((comment, index) => {
      const row = list.createDiv({ cls: "it-comment-row" });
      const header = row.createDiv({ cls: "it-comment-header" });
      header.createSpan({ cls: "it-comment-ts", text: formatDate(comment.updated_at || comment.created_at, { withTime: true }) });
      const actions = header.createDiv({ cls: "it-comment-actions" });
      const editing = this.editingCommentId === comment.id;
      const up = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("task.comments.moveUp") } });
      setIcon(up, "chevron-up");
      up.disabled = index === 0 || editing;
      up.addEventListener("click", () => void moveComment(this.plugin.index, taskId, comment.id, "up"));
      const down = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("task.comments.moveDown") } });
      setIcon(down, "chevron-down");
      down.disabled = index === comments.length - 1 || editing;
      down.addEventListener("click", () => void moveComment(this.plugin.index, taskId, comment.id, "down"));
      const edit = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("task.comments.edit") } });
      setIcon(edit, editing ? "x" : "pencil");
      edit.addEventListener("click", () => {
        this.editingCommentId = editing ? null : comment.id;
        this.render();
      });
      const del = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini it-danger", attr: { "aria-label": t("task.comments.delete") } });
      setIcon(del, "trash");
      del.disabled = editing;
      del.addEventListener("click", () => {
        new ConfirmModal(this.app, {
          title: t("task.comments.deleteTitle"),
          message: t("task.comments.deleteMsg"),
          destructive: true,
          onConfirm: () => removeComment(this.plugin.index, taskId, comment.id),
        }).open();
      });
      if (editing) {
        const area = row.createEl("textarea", { cls: "it-input it-comment-input" });
        area.value = comment.text;
        area.rows = Math.max(3, Math.min(12, comment.text.split("\n").length + 1));
        const editActions = row.createDiv({ cls: "it-comment-actions" });
        editActions.createEl("button", { cls: "it-btn-primary", text: t("common.save") }).addEventListener("click", async () => {
          const text = area.value.trim();
          if (!text) return;
          this.editingCommentId = null;
          await editComment(this.plugin.index, taskId, comment.id, text);
        });
        editActions.createEl("button", { cls: "it-btn-ghost", text: t("common.cancel") }).addEventListener("click", () => {
          this.editingCommentId = null;
          this.render();
        });
      } else {
        const body = row.createDiv({ cls: "it-comment-body markdown-rendered" });
        this.renderMarkdownInto(body, comment.text);
      }
    });
    const addWrap = sec.createDiv({ cls: "it-comment-add" });
    const area = addWrap.createEl("textarea", { cls: "it-input it-comment-input" });
    area.rows = 3;
    area.placeholder = t("task.comments.placeholder");
    const addActions = addWrap.createDiv({ cls: "it-comment-actions" });
    const submit = addActions.createEl("button", { cls: "it-btn-primary it-add-comment-btn", text: t("task.comments.add") });
    submit.addEventListener("click", async () => {
      const text = area.value.trim();
      if (!text) return;
      await addComment(this.plugin.index, taskId, text);
      area.value = "";
    });
  }

}
