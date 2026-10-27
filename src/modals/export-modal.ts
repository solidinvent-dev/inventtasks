import { App, Modal } from "obsidian";
import type InventTasksPlugin from "../main";
import { t } from "../i18n";
import { ContextLocation, TaskFile } from "../types";
import {
  ExportScope, ReadableFormat, ImageMode,
  exportBackup, exportReadable, gatherScopeTasks, listsInScope,
  buildScopeContext, defaultReadableColumns, ReadableExportContext,
} from "../data/export";

export interface ExportModalOpts {
  scope: ExportScope;
  path?: string;
  taskId?: string;
  // For a "view" export the caller supplies the already-filtered tasks/columns.
  viewName?: string;
  viewTasks?: TaskFile[];
  viewCols?: string[];
  viewCtx?: ReadableExportContext;
}

const READABLE_LABELS: Record<ReadableFormat, string> = {
  csv: "export.formatCsv",
  xlsx: "export.formatXlsx",
  markdown: "export.formatMarkdown",
  html: "export.formatHtml",
  json: "export.formatJson",
};

export class ExportModal extends Modal {
  plugin: InventTasksPlugin;
  opts: ExportModalOpts;
  private kind: "backup" | "readable";
  private format: ReadableFormat = "csv";
  private openPrint = false;
  private imageMode: ImageMode = "embed";

  constructor(app: App, plugin: InventTasksPlugin, opts: ExportModalOpts) {
    super(app);
    this.plugin = plugin;
    this.opts = opts;
    // A view is a filtered table → readable only. Everything else defaults to backup.
    this.kind = opts.scope === "view" ? "readable" : "backup";
  }

  private scopeLoc(): ContextLocation {
    const o = this.opts;
    if (o.scope === "space") return { kind: "space", path: o.path! };
    if (o.scope === "folder") return { kind: "folder", path: o.path! };
    if (o.scope === "list") return { kind: "list", path: o.path! };
    if (o.scope === "task") {
      const lp = this.plugin.index.tasksById.get(o.taskId!)?.listPath;
      return lp ? { kind: "list", path: lp } : { kind: "everything" };
    }
    return { kind: "everything" };
  }

  private scopeName(): string {
    const o = this.opts;
    if (o.viewName) return o.viewName;
    if (o.scope === "workspace") return this.plugin.index.workspace?.name || t("export.scopeWorkspace");
    if (o.scope === "space") return this.plugin.index.findSpace(o.path!)?.config.name || t("hierarchy.space");
    if (o.scope === "folder") return this.plugin.index.findFolder(o.path!)?.config.name || t("hierarchy.folder");
    if (o.scope === "list") return this.plugin.index.findList(o.path!)?.config.name || t("hierarchy.list");
    if (o.scope === "task") return this.plugin.index.tasksById.get(o.taskId!)?.data.title || t("export.scopeTask");
    return t("export.scopeExport");
  }

  private readablePayload() {
    const o = this.opts;
    const tasks = o.viewTasks ?? gatherScopeTasks(this.plugin, o.scope, { path: o.path, taskId: o.taskId });
    const ctx: ReadableExportContext = o.viewCtx ?? buildScopeContext(this.plugin, listsInScope(this.plugin, o.scope, { path: o.path, taskId: o.taskId }), this.scopeLoc());
    const cols = (o.viewCols && o.viewCols.length ? o.viewCols.slice() : defaultReadableColumns(ctx));
    if (!cols.includes("title")) cols.unshift("title");
    return { tasks, ctx, cols, name: this.scopeName() };
  }

  onOpen() {
    this.modalEl.addClass("it-export-modal");
    this.titleEl.setText(t("export.title", { name: this.scopeName() }));
    this.render();
  }

  private render() {
    const c = this.contentEl;
    c.empty();

    const taskCount = this.opts.scope === "view"
      ? (this.opts.viewTasks?.length ?? 0)
      : gatherScopeTasks(this.plugin, this.opts.scope, { path: this.opts.path, taskId: this.opts.taskId }).length;
    c.createEl("p", { cls: "setting-item-description", text: t("export.tasksInScope", { count: taskCount }) });

    // Kind selector (hidden for view scope — readable only).
    if (this.opts.scope !== "view") {
      const seg = c.createDiv({ cls: "it-export-seg" });
      const mk = (k: "backup" | "readable", label: string, desc: string) => {
        const b = seg.createEl("button", { cls: "it-export-seg-btn" + (this.kind === k ? " is-active" : ""), attr: { type: "button" } });
        b.createDiv({ cls: "it-export-seg-title", text: label });
        b.createDiv({ cls: "it-export-seg-desc", text: desc });
        b.addEventListener("click", () => { this.kind = k; this.render(); });
      };
      mk("backup", t("export.backup"), t("export.backupDesc"));
      mk("readable", t("export.readable"), t("export.readableDesc"));
    }

    const body = c.createDiv({ cls: "it-export-body" });
    if (this.kind === "backup") {
      body.createEl("p", { cls: "setting-item-description", text: t("export.backupBody") });
    } else {
      const row = body.createDiv({ cls: "it-export-row" });
      row.createSpan({ cls: "it-export-label", text: t("common.format") });
      const sel = row.createEl("select", { cls: "it-input" });
      (Object.keys(READABLE_LABELS) as ReadableFormat[]).forEach((f) => {
        const o = sel.createEl("option", { value: f, text: t(READABLE_LABELS[f]) });
        if (f === this.format) o.selected = true;
      });
      sel.addEventListener("change", () => { this.format = sel.value as ReadableFormat; this.render(); });

      if (this.format === "html") {
        const pr = body.createDiv({ cls: "it-export-row" });
        const cb = pr.createEl("input", { type: "checkbox" });
        cb.checked = this.openPrint;
        cb.addEventListener("change", () => { this.openPrint = cb.checked; });
        pr.createSpan({ text: t("export.openPrint") });
      }

      // A single-task note (Markdown/HTML) can embed images or write a folder.
      if (this.opts.scope === "task" && (this.format === "markdown" || this.format === "html")) {
        const ir = body.createDiv({ cls: "it-export-row" });
        ir.createSpan({ cls: "it-export-label", text: t("export.images") });
        const isel = ir.createEl("select", { cls: "it-input" });
        isel.createEl("option", { value: "embed", text: this.format === "html" ? t("export.embedHtml") : t("export.keepRefs") });
        isel.createEl("option", { value: "folder", text: t("export.folderImages") });
        isel.value = this.imageMode;
        isel.addEventListener("change", () => { this.imageMode = isel.value as ImageMode; this.render(); });
        body.createEl("p", {
          cls: "setting-item-description",
          text: this.imageMode === "folder"
            ? t("export.folderDesc")
            : (this.format === "html" ? t("export.htmlEmbedDesc") : t("export.mdRefsDesc")),
        });
      }
    }

    const footer = c.createDiv({ cls: "it-modal-footer" });
    footer.createEl("button", { text: t("common.cancel"), cls: "it-btn-ghost" }).addEventListener("click", () => this.close());
    const go = footer.createEl("button", { cls: "it-btn-primary", text: this.kind === "backup" ? t("export.exportBackup") : t("common.export") });
    go.addEventListener("click", () => void this.doExport());
  }

  private async doExport() {
    try {
      if (this.kind === "backup") {
        await exportBackup(this.plugin, this.opts.scope, { path: this.opts.path, taskId: this.opts.taskId });
      } else {
        const p = this.readablePayload();
        const noteTask = this.opts.scope === "task" ? this.plugin.index.tasksById.get(this.opts.taskId!) : undefined;
        await exportReadable({ plugin: this.plugin, format: this.format, scopeName: p.name, tasks: p.tasks, cols: p.cols, ctx: p.ctx, openPrint: this.openPrint, noteTask, imageMode: this.imageMode });
      }
      this.close();
    } catch (e) {
      // Surface the error inline rather than closing.
      const c = this.contentEl;
      c.createEl("p", { cls: "it-export-error", text: t("export.failed", { msg: (e as Error | undefined)?.message ?? String(e) }) });
    }
  }
}
