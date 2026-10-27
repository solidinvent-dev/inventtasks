import { ItemView, WorkspaceLeaf } from "obsidian";
import type InventTasksPlugin from "../main";
import { VIEW_TYPE_INVENTTASKS_SIDEBAR } from "../constants";
import { ContextLocation } from "../types";
import { renderSidebar } from "./sidebar";
import { t } from "../i18n";

export class InventTasksSidebarView extends ItemView {
  plugin: InventTasksPlugin;
  unsubscribe: (() => void) | null = null;
  collapsedSet = new Set<string>();
  private renderScheduled = false;
  // Index change arrived while the dock was hidden — render once on reveal.
  private renderDirty = false;

  constructor(leaf: WorkspaceLeaf, plugin: InventTasksPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_INVENTTASKS_SIDEBAR; }
  getDisplayText() { return "InventTasks navigator"; }
  getIcon() { return "check-square"; }

  async onOpen() {
    this.contentEl.empty();
    this.containerEl.addClass("inventtasks-sidebar-leaf");
    this.unsubscribe = this.plugin.index.onChange(() => this.scheduleRender());
    this.render();
  }

  async onClose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.containerEl.removeClass("inventtasks-sidebar-leaf");
  }

  private isViewVisible(): boolean {
    return (this.containerEl as any).isShown?.() ?? true;
  }

  // Hidden docks defer to the next reveal (Obsidian calls onResize then).
  onResize() {
    if (this.renderDirty && this.isViewVisible()) {
      this.renderDirty = false;
      this.render();
    }
  }

  // Coalesce rapid emits (e.g., during scan→emit bursts) into one render
  private scheduleRender() {
    if (!this.isViewVisible()) {
      this.renderDirty = true;
      return;
    }
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    window.requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.render();
    });
  }

  render() {
    try {
      const container = this.contentEl;
      if (!container || !container.isConnected) return;
      // Zero workspaces → a quiet note instead of the navigator tree.
      if (!this.plugin.hasWorkspaces) {
        container.empty();
        container.createDiv({ cls: "it-sidebar-docked" })
          .createDiv({ cls: "it-empty-note", text: t("main.noWorkspacesShort") });
        return;
      }
      // Preserve scroll so selecting / toggling deep in the tree doesn't jump
      // the docked navigator back to the top.
      const prevWrapScroll = (container.querySelector(".it-sidebar-docked") as HTMLElement | null)?.scrollTop ?? 0;
      const prevContScroll = container.scrollTop;
      container.empty();
      const wrap = container.createDiv({ cls: "it-sidebar-docked" });

      const mainView = this.plugin.getMainView();
      const current: ContextLocation = mainView?.state.location || { kind: "everything" };
      const collapsed = mainView?.sidebarCollapsed || this.collapsedSet;

      renderSidebar(wrap, {
        plugin: this.plugin,
        current,
        onSelect: async (loc) => {
          await this.plugin.activateView();
          const mv = this.plugin.getMainView();
          if (mv) {
            mv.selectLocation(loc);
          } else {
            this.render();
          }
        },
        onOpenView: async (v) => {
          await this.plugin.activateView();
          const mv = this.plugin.getMainView();
          if (mv) mv.openSavedView(v);
          else this.render();
        },
        onOpenTask: async (id) => {
          await this.plugin.activateView();
          this.plugin.getMainView()?.openFavorite(id);
        },
        collapsedSet: collapsed,
        notificationsAttention: mainView?.notificationNeedsAttention() ?? false,
        remindersAttention: mainView?.remindersNeedAttention() ?? false,
        remindersSeverity: mainView?.reminderNotificationSeverity() ?? "none",
      });

      // Restore scroll after the tree is populated.
      const restore = () => {
        if (prevWrapScroll > 0) wrap.scrollTop = prevWrapScroll;
        if (prevContScroll > 0) container.scrollTop = prevContScroll;
      };
      restore();
      window.requestAnimationFrame(restore);
    } catch (e) {
      console.error("InventTasks sidebar render failed", e);
    }
  }
}
