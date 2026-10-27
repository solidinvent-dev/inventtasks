import { App, Modal, Notice, setIcon } from "obsidian";
import type InventTasksPlugin from "../main";
import type { TrashedItem } from "../data/workspace-index";
import { ConfirmModal } from "./confirm-modal";
import { formatDate } from "../utils/dates";
import { hierarchyLabel, t } from "../i18n";
import { renderHierarchyPicker } from "./move-modal";
import { fireAndForget } from "../utils/async";

const KIND_ICON: Record<TrashedItem["kind"], string> = {
  task: "check-square",
  space: "box",
  folder: "folder",
  list: "list",
};
const kindLabel = (kind: TrashedItem["kind"]): string => {
  if (kind === "task") return t("list.task");
  return hierarchyLabel(kind);
};

// Lists soft-deleted tasks and containers (Space / Folder / List) from the
// workspace _trash folder, with Restore and Delete-forever actions, plus
// Empty trash. Reads directly from disk — trashed items aren't in the index.
export class TrashModal extends Modal {
  private plugin: InventTasksPlugin;
  private entries: TrashedItem[] = [];

  constructor(app: App, plugin: InventTasksPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    this.modalEl.addClass("it-trash-modal");
    this.titleEl.setText(t("modal.trash"));
    await this.refresh();
  }

  onClose() {
    this.contentEl.empty();
  }

  private async refresh() {
    this.entries = await this.plugin.index.listTrashedItems();
    this.render();
  }

  private restore(e: TrashedItem, targetListPath?: string): Promise<void> {
    return e.kind === "task"
      ? this.plugin.index.restoreTask(e.path, targetListPath)
      : this.plugin.index.restoreContainer(e.path);
  }

  private needsRestorePicker(e: TrashedItem): boolean {
    return e.kind === "task" && (!e.from || !this.plugin.index.findList(e.from));
  }

  private openRestorePicker(e: TrashedItem) {
    new RestoreTaskListModal(this.app, this.plugin, e, async (listPath) => {
      await this.restore(e, listPath);
      new Notice(t("trash.restored", { name: e.name }));
      this.plugin.refreshViews();
      await this.refresh();
    }).open();
  }

  private purge(e: TrashedItem): Promise<void> {
    return e.kind === "task"
      ? this.plugin.index.purgeTask(e.path)
      : this.plugin.index.purgeContainer(e.path);
  }

  private render() {
    const c = this.contentEl;
    c.empty();
    c.addClass("it-modal-form");

    if (this.entries.length === 0) {
      c.createDiv({ cls: "it-empty-row", text: t("trash.empty") });
      c.createDiv({ cls: "setting-item-description", text: t("trash.autoPurgeNote") });
      return;
    }

    const head = c.createDiv({ cls: "it-trash-head" });
    head.createSpan({ cls: "setting-item-description", text: t("trash.count", { count: this.entries.length }) });
    c.createDiv({ cls: "setting-item-description", text: t("trash.autoPurgeNote") });
    const emptyBtn = head.createEl("button", { cls: "it-btn-ghost it-danger", text: t("trash.emptyBtn"), attr: { type: "button" } });
    emptyBtn.addEventListener("click", () => {
      new ConfirmModal(this.app, {
        title: t("trash.emptyTitle"),
        message: t("trash.emptyMsg", { count: this.entries.length }),
        destructive: true,
        confirmLabel: t("trash.deleteAll"),
        onConfirm: fireAndForget(async () => {
          for (const e of this.entries) {
            try { await this.purge(e); } catch (err) { new Notice(t("common.failed", { msg: (err as Error).message })); }
          }
          await this.refresh();
        }),
      }).open();
    });

    const list = c.createDiv({ cls: "it-trash-list" });
    for (const e of this.entries) {
      const row = list.createDiv({ cls: "it-trash-row" });

      const icon = row.createSpan({ cls: "it-trash-icon" });
      setIcon(icon, KIND_ICON[e.kind]);

      const info = row.createDiv({ cls: "it-trash-info" });
      info.createDiv({ cls: "it-trash-title", text: e.name || t("common.untitled") });
      const metaParts: string[] = [kindLabel(e.kind)];
      if (e.kind === "task" && e.id) metaParts.push(e.id);
      if (e.trashedAt) metaParts.push(t("trash.deletedAt", { date: formatDate(e.trashedAt, { withTime: true }) }));
      info.createDiv({ cls: "it-trash-meta it-search-sub", text: metaParts.join(" · ") });

      const actions = row.createDiv({ cls: "it-trash-actions" });

      const restore = actions.createEl("button", { cls: "it-btn-secondary", attr: { type: "button", "aria-label": t("trash.restore") } });
      setIcon(restore.createSpan(), "rotate-ccw");
      restore.appendChild(document.createTextNode(" " + t("trash.restore")));
      restore.addEventListener("click", fireAndForget(async () => {
        if (this.needsRestorePicker(e)) {
          this.openRestorePicker(e);
          return;
        }
        try {
          await this.restore(e);
          new Notice(t("trash.restored", { name: e.name }));
          this.plugin.refreshViews();
          await this.refresh();
        } catch (err) {
          new Notice(t("trash.restoreFailed", { msg: (err as Error).message }));
        }
      }));

      const del = actions.createEl("button", { cls: "it-btn-ghost it-danger", attr: { type: "button", "aria-label": t("trash.deleteForever") } });
      setIcon(del, "trash-2");
      del.addEventListener("click", () => {
        const extra = e.kind === "task" ? "" : t("trash.deleteForeverExtra");
        new ConfirmModal(this.app, {
          title: t("trash.deleteForeverTitle"),
          message: t("trash.deleteForeverMsg", { name: e.name, extra }),
          destructive: true,
          confirmLabel: t("trash.deleteForever"),
          onConfirm: fireAndForget(async () => {
            try { await this.purge(e); } catch (err) { new Notice(t("common.failed", { msg: (err as Error).message })); }
            await this.refresh();
          }),
        }).open();
      });
    }
  }
}

class RestoreTaskListModal extends Modal {
  private selectedListPath: string | null = null;

  constructor(
    app: App,
    private plugin: InventTasksPlugin,
    private item: TrashedItem,
    private onRestore: (listPath: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText(t("trash.pickRestoreListTitle"));
    const c = this.contentEl;
    c.empty();
    c.addClass("it-modal-form");
    c.createDiv({ cls: "setting-item-description", text: t("trash.pickRestoreListDesc", { name: this.item.name }) });

    const picker = c.createDiv();
    renderHierarchyPicker(picker, this.plugin, {
      kinds: ["list"],
      searchPlaceholder: t("create.searchLists"),
      emptyText: t("create.noListsMatch"),
      onSelect: (item) => { this.selectedListPath = item?.path ?? null; },
    });

    const actions = c.createDiv({ cls: "it-modal-actions" });
    actions.createEl("button", { text: t("common.cancel"), cls: "it-btn-ghost" }).addEventListener("click", () => this.close());
    const restore = actions.createEl("button", { text: t("trash.restoreHere"), cls: "it-btn-primary" });
    restore.addEventListener("click", fireAndForget(async () => {
      if (!this.selectedListPath) {
        new Notice(t("common.pickListFirst"));
        return;
      }
      try {
        await this.onRestore(this.selectedListPath);
        this.close();
      } catch (err) {
        new Notice(t("trash.restoreFailed", { msg: (err as Error).message }));
      }
    }));
  }
}
