import { App, Modal } from "obsidian";
import type InventTasksPlugin from "../main";
import { t } from "../i18n";
import { renderHierarchyPicker } from "./move-modal";

// Pick a list to add the task to (Multiple Lists). Reuses the shared hierarchy
// picker; the home list and already-added lists are excluded.
export class AddToListModal extends Modal {
  private plugin: InventTasksPlugin;
  private excludePaths: string[];
  private onPick: (listPath: string) => void;

  constructor(app: App, plugin: InventTasksPlugin, opts: { excludePaths: string[]; onPick: (listPath: string) => void }) {
    super(app);
    this.plugin = plugin;
    this.excludePaths = opts.excludePaths;
    this.onPick = opts.onPick;
  }

  onOpen() {
    this.titleEl.setText(t("modal.addTaskToList"));
    const c = this.contentEl;
    c.empty();
    c.addClass("it-modal-form");
    const wrap = c.createDiv({ cls: "it-move-modal" });
    renderHierarchyPicker(wrap, this.plugin, {
      kinds: ["list"],
      excludePaths: this.excludePaths,
      searchPlaceholder: t("addToList.search"),
      emptyText: t("picker.noOtherLists"),
      onSelect: (item) => {
        if (!item) return;
        this.onPick(item.path);
        this.close();
      },
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
