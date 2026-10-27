import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type InventTasksPlugin from "../main";
import { VIEW_TYPE_INVENTTASKS_FAVORITES } from "../constants";
import { ContextLocation } from "../types";
import { renderFavoriteChildren } from "./sidebar";
import { favLocationLabel, FAV_LOCATION_META } from "./favorites";
import { t } from "../i18n";
import { fireAndForget } from "../utils/async";

// Favorites docked in Obsidian's right sidebar (alongside Backlinks / Tags /
// Outline). Reuses the exact left-sidebar favorite rows so icons, colors, names,
// drag-reorder and the per-row menu are identical across both places.
export class InventTasksFavoritesView extends ItemView {
  plugin: InventTasksPlugin;
  unsubscribe: (() => void) | null = null;
  private renderScheduled = false;
  // Index change arrived while the panel was hidden — render once on reveal.
  private renderDirty = false;

  constructor(leaf: WorkspaceLeaf, plugin: InventTasksPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_INVENTTASKS_FAVORITES; }
  getDisplayText() { return favLocationLabel("right"); }
  getIcon() { return FAV_LOCATION_META.right.icon; }

  async onOpen() {
    this.contentEl.empty();
    this.containerEl.addClass("inventtasks-favorites-leaf");
    this.unsubscribe = this.plugin.index.onChange(() => this.scheduleRender());
    this.render();
  }

  async onClose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.containerEl.removeClass("inventtasks-favorites-leaf");
  }

  private isViewVisible(): boolean {
    return (this.containerEl as HTMLElement & { isShown?: () => boolean }).isShown?.() ?? true;
  }

  onResize() {
    if (this.renderDirty && this.isViewVisible()) {
      this.renderDirty = false;
      this.render();
    }
  }

  // Coalesce rapid index emits into one render.
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
      // Zero workspaces → a quiet note instead of the favorites panel.
      if (!this.plugin.hasWorkspaces) {
        container.empty();
        container.createDiv({ cls: "it-fav-panel" })
          .createDiv({ cls: "it-empty-note", text: t("main.noWorkspacesShort") });
        return;
      }
      const prevScroll = container.querySelector<HTMLElement>(".it-fav-panel-list")?.scrollTop ?? 0;
      container.empty();
      const wrap = container.createDiv({ cls: "it-fav-panel" });

      const header = wrap.createDiv({ cls: "it-fav-panel-header" });
      const hIcon = header.createSpan({ cls: "it-fav-panel-header-icon" });
      setIcon(hIcon, FAV_LOCATION_META.right.icon);
      hIcon.style.color = FAV_LOCATION_META.right.color;
      header.createSpan({ cls: "it-fav-panel-title", text: favLocationLabel("right") });

      const mainView = this.plugin.getMainView();
      const current: ContextLocation = mainView?.state.location || { kind: "everything" };

      // This panel shows its OWN bucket ("right"), independent of the left
      // sidebar and bottom bar.
      const favorites = this.plugin.index.getFavorites("right");
      if (favorites.length === 0) {
        wrap.createDiv({ cls: "it-fav-panel-empty", text: t("favorites.empty") });
        return;
      }

      const list = wrap.createDiv({ cls: "it-fav-panel-list it-favorites-children" });
      renderFavoriteChildren(list, {
        plugin: this.plugin,
        current,
        onSelect: fireAndForget(async (loc) => {
          await this.plugin.activateView();
          this.plugin.getMainView()?.selectLocation(loc);
        }),
        onOpenView: fireAndForget(async (v) => {
          await this.plugin.activateView();
          this.plugin.getMainView()?.openSavedView(v);
        }),
        onOpenTask: fireAndForget(async (id) => {
          await this.plugin.activateView();
          this.plugin.getMainView()?.openFavorite(id);
        }),
        collapsedSet: new Set<string>(),
      }, "right");

      if (prevScroll > 0) list.scrollTop = prevScroll;
    } catch (e) {
      console.error("InventTasks favorites panel render failed", e);
    }
  }
}
