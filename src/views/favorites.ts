import { setIcon } from "obsidian";
import type InventTasksPlugin from "../main";
import { ContextLocation, FavLocation } from "../types";
import { renderIconish } from "../ui/icons";
import { MenuAction } from "../ui/menu";
import { t } from "../i18n";
import { DOC_ICON, DOC_ACCENT, VIEW_TYPE_ICON, VIEW_COLOR_INDEX, resolveViewColorSet } from "../constants";
import { ConfirmModal } from "../modals/confirm-modal";

// The three favorites surfaces, in canonical order, + their distinct identity
// (name via i18n, icon, accent color). Each surface has a different PURPOSE so
// it gets its own look:
//   left  → "Bookmarks"    (jump around structure)        bookmark / light orange
//   right → "Favorites"    (main list for current work)   star     / yellow
//   bar   → "Quick Access" (handful of always-handy items) zap     / red
export const FAV_LOCATIONS: FavLocation[] = ["left", "bar", "right"];
export const FAV_LOCATION_META: Record<FavLocation, { icon: string; color: string }> = {
  left:  { icon: "bookmark", color: "#ED9702" },
  bar:   { icon: "zap",      color: "#F71B1B" },
  right: { icon: "star",     color: "#F5B800" },
};
export function favLocationLabel(loc: FavLocation): string {
  return t(`favLoc.${loc}`);
}

// ---------- Shared favorite resolution ----------
//
// A favorite is stored as a path (list path, doc container path, or saved-view
// file path). Resolving turns it into uniform display data so every surface —
// left sidebar, right panel, bottom bar — shows the same icon, color and name.

export type FavoriteKind = "list" | "doc" | "view" | "task";

export interface ResolvedFavorite {
  path: string;
  kind: FavoriteKind;
  name: string;
  icon: string;          // emoji or Lucide id (render via renderIconish)
  color: string;
  count: number | null;  // task / page count; null when not meaningful (views)
}

// Resolve one favorite path to display data, or null if it no longer exists.
export function resolveFavorite(plugin: InventTasksPlugin, path: string): ResolvedFavorite | null {
  const idx = plugin.index;
  const list = idx.findList(path);
  if (list) {
    return {
      path, kind: "list",
      name: list.config.name,
      icon: list.config.icon || "📋",
      color: list.config.color || "#2196F3",
      count: list.taskFiles.filter((task) => !task.data?.archived).length,
    };
  }
  const doc = idx.docByPath(path);
  if (doc) {
    return {
      path, kind: "doc",
      name: doc.name,
      icon: doc.icon || DOC_ICON,
      color: doc.color || DOC_ACCENT,
      count: idx.pagesForDoc(doc.doc_id).length,
    };
  }
  const view = idx.viewByPath(path);
  if (view) {
    const colors = resolveViewColorSet(plugin.prefs.viewColorScheme, plugin.prefs.viewColors);
    return {
      path, kind: "view",
      name: view.name,
      icon: VIEW_TYPE_ICON[view.type] || "list",
      color: colors[VIEW_COLOR_INDEX[view.type]] || "#9E9E9E",
      count: null,
    };
  }
  // Tasks are stored by id, not path. Display uses the task's own icon/color
  // when set, otherwise its task type's (matching how the modal/badges show it).
  const task = idx.tasksById.get(path);
  if (task && !task.data.archived) {
    const types = idx.resolveTaskTypes({ listPath: task.listPath });
    const type = types.find((tt) => tt.id === (task.data.type || "task")) || types[0];
    return {
      path, kind: "task",
      name: task.data.title || task.data.id,
      icon: task.data.icon || type?.icon || "square-check",
      color: task.data.color || type?.color || "#9E9E9E",
      count: null,
    };
  }
  return null; // stale (item deleted)
}

// All favorites in a bucket's stored order, stale entries dropped.
export function resolveFavorites(plugin: InventTasksPlugin, loc: FavLocation = "left"): ResolvedFavorite[] {
  const out: ResolvedFavorite[] = [];
  for (const p of plugin.index.getFavorites(loc)) {
    const r = resolveFavorite(plugin, p);
    if (r) out.push(r);
  }
  return out;
}

// Menu items for an ELEMENT (list/doc/view) — one toggle per surface, so the
// user picks where to file it (or unfiles from a surface it's already in).
export function favoriteToggleItems(plugin: InventTasksPlugin, path: string): MenuAction[] {
  return FAV_LOCATIONS.map((loc) => {
    const inIt = plugin.index.isFavorite(path, loc);
    const label = t(inIt ? "fav.removeFrom" : "fav.addTo", { loc: favLocationLabel(loc) });
    // The destination's own icon (bookmark / star / zap) so the three are
    // visually distinct; the label's verb conveys add vs. remove.
    return {
      label,
      icon: FAV_LOCATION_META[loc].icon,
      onClick: () => {
        if (!inIt) {
          void plugin.index.toggleFavorite(path, loc);
          return;
        }
        new ConfirmModal(plugin.app, {
          title: t("modal.deleteConfirm"),
          message: label,
          destructive: true,
          confirmLabel: t("common.remove"),
          onConfirm: () => void plugin.index.toggleFavorite(path, loc),
        }).open();
      },
    };
  });
}

// Menu items for a favorite already filed under `loc`: relocate to each OTHER
// surface (with that surface's icon), then remove from this one. (Reorder within
// a surface is provided separately — arrows in the panels, move left/right on the bar.)
export function favoriteRelocateItems(plugin: InventTasksPlugin, path: string, loc: FavLocation): MenuAction[] {
  const items: MenuAction[] = FAV_LOCATIONS.filter((l) => l !== loc).map((to) => ({
    label: t("fav.moveTo", { loc: favLocationLabel(to) }),
    icon: FAV_LOCATION_META[to].icon,
    onClick: () => void plugin.index.moveFavoriteBetween(path, loc, to),
  }));
  items.push({
    label: t("fav.removeFrom", { loc: favLocationLabel(loc) }),
    icon: "x",
    onClick: () => {
      new ConfirmModal(plugin.app, {
        title: t("modal.deleteConfirm"),
        message: t("fav.removeFrom", { loc: favLocationLabel(loc) }),
        destructive: true,
        confirmLabel: t("common.remove"),
        onConfirm: () => void plugin.index.removeFavorite(path, loc),
      }).open();
    },
  });
  return items;
}

// True when `current` is sitting on this favorite (list/doc only — a saved view
// shares its location with other items, so it can't be matched by location).
export function favoriteIsActive(fav: ResolvedFavorite, current: ContextLocation): boolean {
  if (fav.kind === "list") return current.kind === "list" && current.path === fav.path;
  if (fav.kind === "doc") return current.kind === "doc" && current.path === fav.path;
  return false;
}

// ---------- Horizontal chip (bottom favorites bar) ----------

export function renderFavoriteChip(
  container: HTMLElement,
  fav: ResolvedFavorite,
  opts: { active: boolean; onOpen: () => void; onMenu: (e: MouseEvent) => void },
): HTMLElement {
  const chip = container.createEl("button", {
    cls: "it-chip it-fav-chip" + (opts.active ? " is-active" : ""),
    attr: { type: "button", title: fav.name, "data-kind": fav.kind },
  });
  chip.style.setProperty("--chip-color", fav.color);
  const iconEl = renderIconish(chip, fav.icon, { cls: "it-fav-chip-icon" });
  if (iconEl) iconEl.style.color = fav.color;
  chip.createSpan({ cls: "it-fav-chip-name", text: fav.name });
  chip.addEventListener("click", opts.onOpen);
  // A caret toggles the options menu (reorder / relocate / remove); right-click
  // opens the same menu.
  const caret = chip.createSpan({ cls: "it-fav-chip-caret", attr: { role: "button", "aria-label": t("common.more") } });
  setIcon(caret, "chevron-down");
  caret.addEventListener("click", (e) => { e.stopPropagation(); opts.onMenu(e); });
  chip.addEventListener("contextmenu", (e) => { e.preventDefault(); opts.onMenu(e); });
  return chip;
}
