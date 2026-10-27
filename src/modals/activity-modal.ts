import { App, Modal, Component, setIcon } from "obsidian";
import type InventTasksPlugin from "../main";
import type { ActivityEntry, TaskFile } from "../types";
import { formatDate } from "../utils/dates";
import { t } from "../i18n";

// Standalone read-only viewer for a task's activity log. Subscribes to the
// index so entries that get appended while the modal is open (e.g. when
// the user edits the task in the parent task modal) appear immediately.
export class ActivityModal extends Modal {
  private plugin: InventTasksPlugin;
  private task: TaskFile;
  private comp: Component;

  constructor(app: App, plugin: InventTasksPlugin, task: TaskFile) {
    super(app);
    this.plugin = plugin;
    this.task = task;
    this.comp = new Component();
  }

  onOpen() {
    this.modalEl.addClass("it-activity-modal");
    this.titleEl.setText(t("activity.title", { title: this.task.data.title || t("common.untitled") }));
    this.comp.load();
    this.render();
    const unsub = this.plugin.index.onChange(() => {
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

  private render() {
    const c = this.contentEl;
    c.empty();

    const entries: ActivityEntry[] = Array.isArray(this.task.data.activity) ? this.task.data.activity : [];

    if (entries.length === 0) {
      c.createDiv({ cls: "it-empty-row", text: t("activity.empty") });
      return;
    }
    const listEl = c.createDiv({ cls: "it-activity-list it-activity-modal-list" });
    // Newest first — easier to scan recent changes.
    for (const e of [...entries].reverse()) {
      const row = listEl.createDiv({ cls: "it-activity-row" });
      const iconWrap = row.createSpan({ cls: "it-activity-icon" });
      const { icon, text } = this.formatEntry(e);
      setIcon(iconWrap, icon);
      const body = row.createDiv({ cls: "it-activity-body" });
      body.createDiv({ cls: "it-activity-text", text });
      body.createDiv({ cls: "it-activity-ts", text: formatDate(e.ts, { withTime: true }) });
    }
  }

  // Same label catalog as the task modal used to render inline. Kept here
  // so the activity-only view is fully self-contained.
  private formatEntry(e: ActivityEntry): { icon: string; text: string } {
    const idx = this.plugin.index;
    const titleOf = (id?: string) => {
      if (!id) return "?";
      const tf = idx.tasksById.get(id);
      return tf ? (tf.data.title || id) : id;
    };
    const stat = (s?: string | number | null) => {
      if (s === null || s === undefined || s === "") return "—";
      const set = idx.resolveStatusSet(this.task.listPath || "").statuses;
      const so = set.find((x) => x.id === s);
      return so ? so.name : String(s);
    };
    const customFieldName = (id?: string) => {
      if (!id) return t("task.customFields.title");
      return idx.resolveCustomFields(this.task.listPath || "").find((field) => field.id === id)?.name || id;
    };
    const listName = (path?: string) => path ? (idx.findList(path)?.config.name || path) : "?";
    switch (e.kind) {
      case "created":                return { icon: "sparkles", text: t("activity.created") };
      case "archived":               return { icon: "archive", text: t("activity.archived") };
      case "unarchived":             return { icon: "archive-restore", text: t("activity.unarchived") };
      case "merged":                 return { icon: "git-merge", text: t("activity.merged", { title: e.text || titleOf(e.id) }) };
      case "status":                 return { icon: "circle-dot", text: t("activity.status", { from: stat(e.from), to: stat(e.to) }) };
      case "priority":               return { icon: "flag", text: t("activity.priority", { from: e.from ?? "—", to: e.to ?? "—" }) };
      case "due_date":               return { icon: "calendar", text: t("activity.due", { from: e.from ?? "—", to: e.to ?? "—" }) };
      case "start_date":             return { icon: "calendar-range", text: t("activity.start", { from: e.from ?? "—", to: e.to ?? "—" }) };
      case "title":                  return { icon: "text-cursor-input", text: t("activity.renamed", { from: e.from ?? "—", to: e.to ?? "—" }) };
      case "tags":                   return { icon: "tags", text: t("activity.tags", { from: e.from ?? "—", to: e.to ?? "—" }) };
      case "custom_field":           return { icon: "list-restart", text: t("activity.customField", { field: customFieldName(e.id), from: e.from ?? "—", to: e.to ?? "—" }) };
      case "list_added":             return { icon: "list-plus", text: t("activity.listAdded", { list: listName(e.id) }) };
      case "list_removed":           return { icon: "list-minus", text: t("activity.listRemoved", { list: listName(e.id) }) };
      case "parent_added":           return { icon: "corner-left-up", text: t("activity.parentAdded", { title: titleOf(e.id) }) };
      case "parent_removed":         return { icon: "corner-left-up", text: t("activity.parentRemoved", { title: titleOf(e.id) }) };
      case "subtask_added":          return { icon: "corner-down-right", text: t("activity.subtaskAdded", { title: titleOf(e.id) }) };
      case "subtask_removed":        return { icon: "corner-down-right", text: t("activity.subtaskRemoved", { title: titleOf(e.id) }) };
      case "blocks_added":           return { icon: "shield", text: t("activity.blocksAdded", { title: titleOf(e.id) }) };
      case "blocks_removed":         return { icon: "shield-off", text: t("activity.blocksRemoved", { title: titleOf(e.id) }) };
      case "waiting_added":          return { icon: "hourglass", text: t("activity.waitingAdded", { title: titleOf(e.id) }) };
      case "waiting_removed":        return { icon: "hourglass", text: t("activity.waitingRemoved", { title: titleOf(e.id) }) };
      case "related_added":          return { icon: "link", text: t("activity.relatedAdded", { title: titleOf(e.id) }) };
      case "related_removed":        return { icon: "link", text: t("activity.relatedRemoved", { title: titleOf(e.id) }) };
      case "checklist_added":        return { icon: "list-checks", text: t("activity.checklistAdded", { text: e.text ?? "" }) };
      case "checklist_checked":      return { icon: "check", text: t("activity.checklistChecked", { text: e.text ?? "" }) };
      case "checklist_unchecked":    return { icon: "square", text: t("activity.checklistUnchecked", { text: e.text ?? "" }) };
      case "checklist_text_changed": return { icon: "edit-3", text: t("activity.checklistRenamed", { from: e.from ?? "—", to: e.to ?? "—" }) };
      case "checklist_removed":      return { icon: "trash-2", text: t("activity.checklistRemoved", { text: e.text ?? "" }) };
      case "comment_added":          return { icon: "message-square", text: t("activity.commentAdded", { text: e.text ?? "" }) };
      case "comment_edited":         return { icon: "message-square", text: t("activity.commentEdited", { text: e.text ?? "" }) };
      case "comment_removed":        return { icon: "message-square", text: t("activity.commentRemoved", { text: e.text ?? "" }) };
      case "attachment_renamed":     return { icon: "file-edit", text: t("activity.attachmentRenamed", { from: e.from ?? "—", to: e.to ?? "—" }) };
      default:                       return { icon: "circle", text: String(e.kind) };
    }
  }
}
