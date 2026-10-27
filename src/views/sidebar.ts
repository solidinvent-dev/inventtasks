import { setIcon, Notice, Platform } from "obsidian";
import type InventTasksPlugin from "../main";
import { ContextLocation, FolderNode, ListNode, SpaceNode, SidebarOrder, DocMeta, ViewConfig, FavLocation } from "../types";
import { CreateSpaceModal, CreateFolderModal, CreateListModal, CreateDocModal, QuickTaskModal } from "../modals/create-modals";
import { ConfirmModal } from "../modals/confirm-modal";
import { ConfigModal } from "../modals/config-modal";
import { ExportModal } from "../modals/export-modal";
import { ImportModal } from "../modals/import-modal";
import { SaveTemplateModal } from "../modals/template-modals";
import { MoveFolderModal, MoveListModal, MoveDocModal } from "../modals/move-modal";
import { DocsManagerModal } from "../modals/docs-manager-modal";
import { SearchModal } from "../modals/search-modal";
import { renderIconish } from "../ui/icons";
import { renderBuyLicenseLink } from "../ui/logo";
import { openIconPicker, openColorPicker } from "../ui/pickers";
import { showContextMenu } from "../ui/menu";
import { showPopover } from "../ui/components";
import { DOC_ICON, DOC_ACCENT, VIEW_TYPE_ICON, VIEW_COLOR_INDEX, resolveViewColorSet } from "../constants";
import { favoriteToggleItems, favoriteRelocateItems, resolveFavorite, favLocationLabel, FAV_LOCATION_META } from "./favorites";
import { notificationOverview } from "./notifications-view";
import { DEFAULT_GLOBAL_NAV } from "../settings";
import { menuLabel, navLabel, t } from "../i18n";
import { fireAndForget } from "../utils/async";

// Items in the explorer "Global" section (orderable + hideable).
const GLOBAL_NAV_ITEMS: Array<{ key: string; icon: string }> = [
  { key: "today", icon: "calendar-check" },
  { key: "everything", icon: "layers" },
  { key: "recents", icon: "history" },
  { key: "favorites", icon: "bookmark" },
  { key: "archived", icon: "archive" },
];
const BOOKMARKS_COLLAPSE_KEY = "__global_bookmarks";

// Saved order, filtered to known keys, with any new keys appended (forward-compat).
function effectiveGlobalOrder(plugin: InventTasksPlugin): string[] {
  const saved = (plugin.prefs.globalNavOrder || []).filter((k) => GLOBAL_NAV_ITEMS.some((i) => i.key === k));
  for (const k of DEFAULT_GLOBAL_NAV) if (!saved.includes(k)) saved.push(k);
  return saved;
}

export interface SidebarOptions {
  plugin: InventTasksPlugin;
  current: ContextLocation;
  onSelect: (loc: ContextLocation) => void;
  // Open a favorited saved view — navigates to the view's location and applies
  // it (not just a location change, so it needs its own channel).
  onOpenView: (v: ViewConfig) => void;
  // Open a favorited task (by id) — navigates to its list and opens the modal.
  onOpenTask: (taskId: string) => void;
  collapsedSet: Set<string>;
  notificationsAttention?: boolean;
  remindersAttention?: boolean;
  remindersSeverity?: "danger" | "warning" | "info" | "none";
}

// ---------- Module-level drag state ----------
interface DragState {
  path: string;
  parentPath: string | null;
  kind: "space" | "folder" | "list" | "favorite" | "doc";
  element: HTMLElement;
}
let activeDrag: DragState | null = null;

// ---------- Ordering helpers ----------

function sortByOrder<T>(items: T[], getPath: (item: T) => string, order?: string[], getFallback: (item: T) => string = getPath): T[] {
  return [...items].sort((a, b) => {
    const ia = order?.indexOf(getPath(a)) ?? -1;
    const ib = order?.indexOf(getPath(b)) ?? -1;
    if (ia === -1 && ib === -1) return getFallback(a).localeCompare(getFallback(b), undefined, { numeric: true, sensitivity: "base" });
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

type SpaceChild =
  | { kind: "folder"; node: FolderNode }
  | { kind: "list"; node: ListNode }
  | { kind: "doc"; node: DocMeta };

function childPath(c: SpaceChild): string {
  return c.kind === "doc" ? (c.node.__path || "") : c.node.path;
}

function getSpaceChildrenOrdered(space: SpaceNode, docs: DocMeta[], order?: string[]): SpaceChild[] {
  const all: SpaceChild[] = [
    ...space.folders.map((f) => ({ kind: "folder" as const, node: f })),
    ...space.lists.filter((l) => !l.config.hidden && !l.config.system_kind).map((l) => ({ kind: "list" as const, node: l })),
    ...docs.map((d) => ({ kind: "doc" as const, node: d })),
  ];
  return sortByOrder(all, childPath, order, (child) => child.kind === "doc" ? child.node.name : child.node.config.name);
}

// All reorderable sibling paths under a space/folder (folders + lists + docs),
// so dragging any of them computes the order against the full set.
function siblingPaths(plugin: InventTasksPlugin, parentPath: string): string[] {
  const folder = plugin.index.findFolder(parentPath);
  if (folder) {
    return [
      ...folder.lists.filter((l) => !l.config.hidden && !l.config.system_kind).map((l) => ({ path: l.path, name: l.config.name })),
      ...plugin.index.docsForLocationKey(`folder:${parentPath}`).map((d) => ({ path: d.__path || "", name: d.name })),
    ].filter((item) => !!item.path).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })).map((item) => item.path);
  }
  const space = plugin.index.findSpace(parentPath);
  if (space) {
    return [
      ...space.folders.map((f) => ({ path: f.path, name: f.config.name })),
      ...space.lists.filter((l) => !l.config.hidden && !l.config.system_kind).map((l) => ({ path: l.path, name: l.config.name })),
      ...plugin.index.docsForLocationKey(`space:${parentPath}`).map((d) => ({ path: d.__path || "", name: d.name })),
    ].filter((item) => !!item.path).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })).map((item) => item.path);
  }
  return [];
}

function reorderArray(arr: string[], fromPath: string, toPath: string, insertAfter: boolean): string[] {
  const result = arr.filter((p) => p !== fromPath);
  const idx = result.indexOf(toPath);
  if (idx === -1) {
    result.push(fromPath);
  } else {
    result.splice(insertAfter ? idx + 1 : idx, 0, fromPath);
  }
  return result;
}

// Build canonical ordered path array, keeping stored order and appending new items at end.
function canonicalOrder(items: string[], stored?: string[]): string[] {
  if (!stored || stored.length === 0) return [...items];
  const known = stored.filter((p) => items.includes(p));
  const extra = items.filter((p) => !stored.includes(p));
  return [...known, ...extra];
}

// ---------- Main render ----------

export function renderSidebar(parent: HTMLElement, opts: SidebarOptions) {
  // `parent` is the scroll container (.it-sidebar-wrap embedded / .it-sidebar-docked
  // docked). Re-rendering in place (e.g. expand/collapse) empties it and would
  // reset the scroll — capture and restore it after the synchronous rebuild.
  const prevScroll = parent.scrollTop;
  if (prevScroll > 0) window.requestAnimationFrame(() => { parent.scrollTop = prevScroll; });
  parent.empty();
  parent.addClass("it-sidebar");

  const sidebarOrder = opts.plugin.index.getSidebarOrder();

  // ---- Header ----
  const header = parent.createDiv({ cls: "it-sidebar-header" });
  const headerTop = header.createDiv({ cls: "it-sidebar-header-top" });
  const title = headerTop.createDiv({ cls: "it-sidebar-title it-sidebar-title-clickable" });
  const wsIcon = renderIconish(title, opts.plugin.index.workspace?.icon || "layout-dashboard", { cls: "it-sidebar-emoji" });
  const wsColor = opts.plugin.index.workspace?.color;
  if (wsIcon && wsColor) wsIcon.style.color = wsColor;
  title.createSpan({ text: opts.plugin.index.workspace?.name || t("common.workspace"), cls: "it-sidebar-name" });
  // The workspace (vault root) is itself a linkable element — click the title
  // for: open its root view, copy a deep link, or open settings.
  title.addEventListener("click", (e) => {
    showContextMenu(e, [
      { label: t("nav.openWorkspaceRoot"), icon: "layers", onClick: () => opts.onSelect({ kind: "everything" }) },
      { label: menuLabel("copyLink"), icon: "link", onClick: () => void opts.plugin.copyElementLink("workspace") },
      { label: menuLabel("copyId"), icon: "fingerprint", onClick: () => void opts.plugin.copyTextToClipboard(opts.plugin.index.workspace?.workspace_id ?? "") },
      "separator",
      { label: t("nav.workspaceSettings"), icon: "settings", onClick: () => new ConfigModal(opts.plugin.app, opts.plugin, "workspace").open() },
    ]);
  });

  const cogBtn = headerTop.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": t("nav.workspaceSettings"), title: t("nav.workspaceSettings") } });
  setIcon(cogBtn, "settings");
  cogBtn.addEventListener("click", () => new ConfigModal(opts.plugin.app, opts.plugin, "workspace").open());

  const headerShortcuts = header.createDiv({ cls: "it-sidebar-header-shortcuts" });
  const searchBtn = headerShortcuts.createEl("button", { cls: "it-icon-btn it-sidebar-shortcut-btn", attr: { "aria-label": navLabel("search"), title: navLabel("search") } });
  setIcon(searchBtn, "search");
  searchBtn.addEventListener("click", () => new SearchModal(opts.plugin.app, opts.plugin).open());

  const docsBtn = headerShortcuts.createEl("button", { cls: "it-icon-btn it-sidebar-shortcut-btn", attr: { "aria-label": t("nav.docsManager"), title: t("nav.docsManager") } });
  setIcon(docsBtn, "book-open");
  docsBtn.addEventListener("click", () => new DocsManagerModal(opts.plugin.app, opts.plugin).open());

  const overview = notificationOverview(opts.plugin);
  const notificationColor = overview.severity === "danger" ? "#E53935"
    : overview.severity === "warning" ? "#F59E0B"
    : overview.severity === "info" ? "#0091FF"
    : "";
  const notificationAttention = opts.notificationsAttention && overview.severity === "danger" ? "danger"
    : opts.notificationsAttention && overview.severity === "warning" ? "warning"
    : undefined;
  const notificationBtn = headerShortcuts.createEl("button", {
    cls: "it-icon-btn it-sidebar-shortcut-btn it-global-system-btn" + (opts.current.kind === "notifications" ? " is-active" : "") + (notificationAttention ? ` it-global-system-attention is-${notificationAttention}` : ""),
    attr: { "aria-label": navLabel("notifications"), title: navLabel("notifications") },
  });
  setIcon(notificationBtn, "bell");
  if (notificationColor) notificationBtn.style.color = notificationColor;
  notificationBtn.addEventListener("click", () => opts.onSelect({ kind: "notifications" }));

  const reminderColor = opts.remindersSeverity === "danger" ? "#E53935"
    : opts.remindersSeverity === "warning" ? "#F59E0B"
    : opts.remindersSeverity === "info" ? "#0091FF"
    : "";
  const reminderAttention = opts.remindersAttention && opts.remindersSeverity === "danger" ? "danger"
    : opts.remindersAttention && opts.remindersSeverity === "warning" ? "warning"
    : undefined;
  const remBtn = headerShortcuts.createEl("button", {
    cls: "it-icon-btn it-sidebar-shortcut-btn it-global-system-btn" + (opts.current.kind === "reminders" ? " is-active" : "") + (reminderAttention ? ` it-global-system-attention is-${reminderAttention}` : ""),
    attr: { "aria-label": t("nav.reminders"), title: t("nav.reminders") },
  });
  setIcon(remBtn, "alarm-clock");
  if (reminderColor) remBtn.style.color = reminderColor;
  remBtn.addEventListener("click", () => opts.onSelect({ kind: "reminders" }));

  const notesBtn = headerShortcuts.createEl("button", { cls: "it-icon-btn it-sidebar-shortcut-btn" + (opts.current.kind === "short_notes" ? " is-active" : ""), attr: { "aria-label": t("nav.shortNotes"), title: t("nav.shortNotes") } });
  setIcon(notesBtn, "sticky-note");
  notesBtn.addClass("it-shortcut-notes");
  notesBtn.addEventListener("click", () => opts.onSelect({ kind: "short_notes" }));

  const syncNowBtn = headerShortcuts.createEl("button", {
    cls: "it-icon-btn it-sidebar-shortcut-btn",
    attr: { "aria-label": t("calSync.syncNowBtn"), title: t("calSync.syncNowBtn") },
  });
  setIcon(syncNowBtn, "refresh-cw");
  syncNowBtn.addClass("it-shortcut-sync");
  syncNowBtn.addEventListener("click", fireAndForget(async () => {
    syncNowBtn.disabled = true;
    syncNowBtn.setAttribute("aria-label", t("calSync.syncing"));
    syncNowBtn.setAttribute("title", t("calSync.syncing"));
    try {
      await opts.plugin.syncNow();
      const warning = opts.plugin.syncWarningMessage();
      new Notice(warning ? t("calSync.syncDoneWithWarnings", { message: warning }) : t("calSync.syncDone"));
    } catch (e) {
      new Notice(`${t("calSync.syncFailed")}: ${(e as Error | undefined)?.message || (e as string)}`);
    }
    syncNowBtn.disabled = false;
    syncNowBtn.setAttribute("aria-label", t("calSync.syncNowBtn"));
    syncNowBtn.setAttribute("title", t("calSync.syncNowBtn"));
  }));

  // ---- Global section (orderable + hideable items) ----
  const global = parent.createDiv({ cls: "it-sidebar-section" });
  const ghead = global.createDiv({ cls: "it-sidebar-section-title-row" });
  ghead.createDiv({ cls: "it-sidebar-section-title", text: t("nav.global") });
  const gcustom = ghead.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("sidebar.customizeGlobal") } });
  setIcon(gcustom, "sliders-horizontal");
  gcustom.addEventListener("click", (e) => { e.stopPropagation(); openGlobalCustomizer(e.currentTarget as HTMLElement, opts, () => renderSidebar(parent, opts)); });

  const hidden = new Set(opts.plugin.prefs.globalNavHidden || []);
  for (const key of effectiveGlobalOrder(opts.plugin)) {
    if (hidden.has(key)) continue;
    renderGlobalItem(global, key, opts, parent);
  }

  // ---- Spaces section ----
  const spacesWrap = parent.createDiv({ cls: "it-sidebar-section" });
  const spacesHeader = spacesWrap.createDiv({ cls: "it-sidebar-section-title-row" });
  spacesHeader.createDiv({ cls: "it-sidebar-section-title", text: t("nav.spaces") });
  const spacesActions = spacesHeader.createDiv({ cls: "it-sidebar-section-actions" });
  const importSpaceBtn = spacesActions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": menuLabel("import") } });
  setIcon(importSpaceBtn, "upload");
  importSpaceBtn.addEventListener("click", () => new ImportModal(opts.plugin.app, opts.plugin, {
    destination: {},
    allowedScopes: ["space", "workspace"],
    label: opts.plugin.index.workspace?.name || t("nav.vaultRoot"),
  }).open());
  const newSpaceBtn = spacesActions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("sidebar.newSpace") } });
  setIcon(newSpaceBtn, "plus");
  newSpaceBtn.addEventListener("click", () => new CreateSpaceModal(opts.plugin.app, opts.plugin).open());

  const spacesList = spacesWrap.createDiv({ cls: "it-sidebar-tree" });

  const visibleSpaces = opts.plugin.index.spaces.filter((s) => !s.config.hidden);
  if (visibleSpaces.length === 0) {
    const empty = spacesList.createDiv({ cls: "it-sidebar-empty" });
    empty.createSpan({ text: t("nav.noSpaces") });
    const cta = empty.createEl("button", { cls: "it-btn-primary", text: t("nav.createFirstSpace") });
    cta.addEventListener("click", () => new CreateSpaceModal(opts.plugin.app, opts.plugin).open());
    return;
  }

  // Sort spaces by stored order
  const orderedSpaces = sortByOrder(visibleSpaces, (s) => s.path, sidebarOrder.spaces, (s) => s.config.name);

  for (const space of orderedSpaces) {
    renderSpaceRow(spacesList, space, sidebarOrder, opts, parent);
  }

  // Discreet purchase nudge at the very bottom of the navigator — renders
  // nothing once a license is active (renderBuyLicenseLink checks settled()).
  const buyWrap = parent.createDiv({ cls: "it-sidebar-buy" });
  if (!renderBuyLicenseLink(buyWrap, { compact: true })) buyWrap.remove();

}

// ---------- Space row ----------

function renderSpaceRow(
  container: HTMLElement,
  space: SpaceNode,
  sidebarOrder: SidebarOrder,
  opts: SidebarOptions,
  sidebarRoot: HTMLElement,
) {
  const collapsed = opts.collapsedSet.has(space.path);
  const spaceColor = space.config.color || "#2196F3";

  const row = container.createDiv({
    cls: "it-tree-row it-tree-space",
    attr: { draggable: String(!Platform.isMobile), "data-path": space.path, "data-kind": "space" },
  });
  row.style.setProperty("--node-color", spaceColor);
  if (opts.current.kind === "space" && opts.current.path === space.path) row.addClass("is-active");

  // Drag handle
  const dragHandle = row.createDiv({ cls: "it-drag-handle" });
  setIcon(dragHandle, "grip-vertical");
  dragHandle.setAttribute("aria-hidden", "true");

  // Expand toggle
  const expander = row.createEl("button", { cls: "it-tree-expand", attr: { "aria-label": t("sidebar.toggleSpace") } });
  setIcon(expander, collapsed ? "chevron-right" : "chevron-down");
  expander.addEventListener("click", (e) => {
    e.stopPropagation();
    if (collapsed) opts.collapsedSet.delete(space.path);
    else opts.collapsedSet.add(space.path);
    renderSidebar(sidebarRoot, opts);
  });

  const namePart = row.createDiv({ cls: "it-tree-name" });
  const spaceIconEl = renderIconish(namePart, space.config.icon || "🏷️", { cls: "it-tree-emoji" });
  if (spaceIconEl) spaceIconEl.style.color = spaceColor;
  namePart.createSpan({ text: space.config.name, cls: "it-tree-label" });
  namePart.addEventListener("click", () => opts.onSelect({ kind: "space", path: space.path }));

  const actions = row.createDiv({ cls: "it-tree-actions" });
  const plusBtn = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("sidebar.add") } });
  setIcon(plusBtn, "plus");
  plusBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showContextMenu(e, [
      { label: menuLabel("newList"), icon: "list", onClick: () => new CreateListModal(opts.plugin.app, opts.plugin, space.path).open() },
      { label: menuLabel("newFolder"), icon: "folder", onClick: () => new CreateFolderModal(opts.plugin.app, opts.plugin, space.path).open() },
      { label: menuLabel("newDoc"), icon: DOC_ICON, onClick: () => new CreateDocModal(opts.plugin.app, opts.plugin, space.path).open() },
    ]);
  });

  const moreBtn = actions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("common.more") } });
  setIcon(moreBtn, "more-horizontal");
  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showContextMenu(e, [
      { label: menuLabel("editSettings"), icon: "settings", onClick: () => new ConfigModal(opts.plugin.app, opts.plugin, "space", space.path).open() },
      { label: menuLabel("export"), icon: "download", onClick: () => new ExportModal(opts.plugin.app, opts.plugin, { scope: "space", path: space.path }).open() },
      { label: menuLabel("import"), icon: "upload", onClick: () => new ImportModal(opts.plugin.app, opts.plugin, { destination: { spacePath: space.path }, allowedScopes: ["folder", "list"], label: space.config.name }).open() },
      { label: menuLabel("saveTemplate"), icon: "layout-template", onClick: () => new SaveTemplateModal(opts.plugin.app, opts.plugin, "space", { path: space.path }, { name: space.config.name, icon: space.config.icon }).open() },
      { label: menuLabel("copyLink"), icon: "link", onClick: () => void opts.plugin.copyElementLink("space", space.config.space_id) },
      { label: menuLabel("copyId"), icon: "fingerprint", onClick: () => void opts.plugin.copyTextToClipboard(space.config.space_id ?? "") },
      { label: menuLabel("copyPath"), icon: "folder-tree", onClick: () => void opts.plugin.copyTextToClipboard(space.path, "deepLink.pathCopied") },
      "separator",
      {
        label: menuLabel("deleteSpace"),
        icon: "trash",
        danger: true,
        onClick: () => new ConfirmModal(opts.plugin.app, {
          title: t("confirm.deleteSpace"),
          message: `This will move the entire folder "${space.config.name}" to trash.`,
          destructive: true,
          onConfirm: fireAndForget(async () => { await opts.plugin.index.deleteSpace(space.path); new Notice(t("sidebar.spaceDeleted")); }),
        }).open(),
      },
    ]);
  });

  // Drag events
  row.addEventListener("dragstart", (e) => {
    activeDrag = { path: space.path, parentPath: null, kind: "space", element: row };
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", space.path);
    window.requestAnimationFrame(() => row.addClass("is-dragging"));
  });
  row.addEventListener("dragend", () => { row.removeClass("is-dragging"); activeDrag = null; });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!activeDrag || activeDrag.kind !== "space" || activeDrag.path === space.path) return;
    e.dataTransfer!.dropEffect = "move";
    row.addClass("is-drag-over");
  });
  row.addEventListener("dragleave", () => row.removeClass("is-drag-over"));
  row.addEventListener("drop", fireAndForget(async (e) => {
    e.preventDefault();
    row.removeClass("is-drag-over");
    if (!activeDrag || activeDrag.kind !== "space" || activeDrag.path === space.path) return;
    const rect = row.getBoundingClientRect();
    const insertAfter = e.clientY > rect.top + rect.height / 2;
    const allSpacePaths = sortByOrder(opts.plugin.index.spaces.filter((s) => !s.config.hidden), (s) => s.path, undefined, (s) => s.config.name).map((s) => s.path);
    const current = canonicalOrder(allSpacePaths, opts.plugin.index.getSidebarOrder().spaces);
    const newOrder = reorderArray(current, activeDrag.path, space.path, insertAfter);
    activeDrag = null;
    await opts.plugin.index.updateSidebarOrder({ ...opts.plugin.index.getSidebarOrder(), spaces: newOrder });
  }));

  // Render children when expanded
  if (!collapsed) {
    const childrenOrder = sidebarOrder.children?.[space.path];
    const spaceDocs = opts.plugin.index.docsForLocationKey(`space:${space.path}`);
    const orderedChildren = getSpaceChildrenOrdered(space, spaceDocs, childrenOrder);
    for (const child of orderedChildren) {
      if (child.kind === "folder") {
        renderFolderRow(container, child.node, space.path, sidebarOrder, opts, sidebarRoot);
      } else if (child.kind === "doc") {
        renderDocRow(container, child.node, space.path, "", opts);
      } else {
        renderListRow(container, child.node, space.path, "", sidebarOrder, opts, sidebarRoot);
      }
    }
  }
}

// ---------- Folder row ----------

function renderFolderRow(
  container: HTMLElement,
  folder: FolderNode,
  parentSpacePath: string,
  sidebarOrder: SidebarOrder,
  opts: SidebarOptions,
  sidebarRoot: HTMLElement,
) {
  const fcoll = opts.collapsedSet.has(folder.path);
  const folderColor = folder.config.color || "#6647F0";

  const row = container.createDiv({
    cls: "it-tree-row it-tree-folder",
    attr: { draggable: String(!Platform.isMobile), "data-path": folder.path, "data-kind": "folder" },
  });
  row.style.setProperty("--node-color", folderColor);
  if (opts.current.kind === "folder" && opts.current.path === folder.path) row.addClass("is-active");

  const dragHandle = row.createDiv({ cls: "it-drag-handle" });
  setIcon(dragHandle, "grip-vertical");
  dragHandle.setAttribute("aria-hidden", "true");

  const fexp = row.createEl("button", { cls: "it-tree-expand", attr: { "aria-label": t("sidebar.toggleFolder") } });
  setIcon(fexp, fcoll ? "chevron-right" : "chevron-down");
  fexp.addEventListener("click", (e) => {
    e.stopPropagation();
    if (fcoll) opts.collapsedSet.delete(folder.path);
    else opts.collapsedSet.add(folder.path);
    renderSidebar(sidebarRoot, opts);
  });

  const namePart = row.createDiv({ cls: "it-tree-name it-tree-name-folder" });
  const folderIconEl = renderIconish(namePart, folder.config.icon || "📁", { cls: "it-tree-emoji" });
  if (folderIconEl) folderIconEl.style.color = folderColor;
  namePart.createSpan({ text: folder.config.name, cls: "it-tree-label" });
  namePart.addEventListener("click", () => opts.onSelect({ kind: "folder", path: folder.path }));

  const fact = row.createDiv({ cls: "it-tree-actions" });
  const fplus = fact.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("sidebar.add") } });
  setIcon(fplus, "plus");
  fplus.addEventListener("click", (e) => {
    e.stopPropagation();
    showContextMenu(e, [
      { label: menuLabel("newList"), icon: "list", onClick: () => new CreateListModal(opts.plugin.app, opts.plugin, folder.path).open() },
      { label: menuLabel("newDoc"), icon: DOC_ICON, onClick: () => new CreateDocModal(opts.plugin.app, opts.plugin, folder.path).open() },
    ]);
  });

  const fmore = fact.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("common.more") } });
  setIcon(fmore, "more-horizontal");
  fmore.addEventListener("click", (e) => {
    e.stopPropagation();
    showContextMenu(e, [
      { label: menuLabel("editSettings"), icon: "settings", onClick: () => new ConfigModal(opts.plugin.app, opts.plugin, "folder", folder.path).open() },
      { label: menuLabel("export"), icon: "download", onClick: () => new ExportModal(opts.plugin.app, opts.plugin, { scope: "folder", path: folder.path }).open() },
      { label: menuLabel("import"), icon: "upload", onClick: () => new ImportModal(opts.plugin.app, opts.plugin, { destination: { folderPath: folder.path }, allowedScopes: ["list"], label: folder.config.name }).open() },
      { label: menuLabel("saveTemplate"), icon: "layout-template", onClick: () => new SaveTemplateModal(opts.plugin.app, opts.plugin, "folder", { path: folder.path }, { name: folder.config.name, icon: folder.config.icon }).open() },
      { label: menuLabel("moveToSpace"), icon: "folder-input", onClick: () => new MoveFolderModal(opts.plugin.app, opts.plugin, folder.path).open() },
      { label: menuLabel("copyLink"), icon: "link", onClick: () => void opts.plugin.copyElementLink("folder", folder.config.folder_id) },
      { label: menuLabel("copyId"), icon: "fingerprint", onClick: () => void opts.plugin.copyTextToClipboard(folder.config.folder_id ?? "") },
      { label: menuLabel("copyPath"), icon: "folder-tree", onClick: () => void opts.plugin.copyTextToClipboard(folder.path, "deepLink.pathCopied") },
      "separator",
      {
        label: menuLabel("deleteFolder"),
        icon: "trash",
        danger: true,
        onClick: () => new ConfirmModal(opts.plugin.app, {
          title: t("confirm.deleteFolder"),
          message: `Move "${folder.config.name}" to trash?`,
          destructive: true,
          onConfirm: () => void opts.plugin.index.deleteFolder(folder.path),
        }).open(),
      },
    ]);
  });

  // Drag-and-drop within parent space (reorder among siblings: folders + lists)
  row.addEventListener("dragstart", (e) => {
    activeDrag = { path: folder.path, parentPath: parentSpacePath, kind: "folder", element: row };
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", folder.path);
    window.requestAnimationFrame(() => row.addClass("is-dragging"));
  });
  row.addEventListener("dragend", () => { row.removeClass("is-dragging"); activeDrag = null; });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!activeDrag || activeDrag.parentPath !== parentSpacePath || activeDrag.path === folder.path) return;
    e.dataTransfer!.dropEffect = "move";
    row.addClass("is-drag-over");
  });
  row.addEventListener("dragleave", () => row.removeClass("is-drag-over"));
  row.addEventListener("drop", fireAndForget(async (e) => {
    e.preventDefault();
    row.removeClass("is-drag-over");
    if (!activeDrag || activeDrag.parentPath !== parentSpacePath || activeDrag.path === folder.path) return;
    const rect = row.getBoundingClientRect();
    const insertAfter = e.clientY > rect.top + rect.height / 2;
    const space = opts.plugin.index.findSpace(parentSpacePath);
    if (!space) return;
    const allChildPaths = siblingPaths(opts.plugin, parentSpacePath);
    const stored = opts.plugin.index.getSidebarOrder();
    const current = canonicalOrder(allChildPaths, stored.children?.[parentSpacePath]);
    const newChildOrder = reorderArray(current, activeDrag.path, folder.path, insertAfter);
    activeDrag = null;
    await opts.plugin.index.updateSidebarOrder({ ...stored, children: { ...stored.children, [parentSpacePath]: newChildOrder } });
  }));

  // Render lists + docs within folder (expanded)
  if (!fcoll) {
    const childOrder = sidebarOrder.children?.[folder.path];
    const folderDocs = opts.plugin.index.docsForLocationKey(`folder:${folder.path}`);
    type FChild = { kind: "list"; node: ListNode } | { kind: "doc"; node: DocMeta };
    const all: FChild[] = [
      ...folder.lists.filter((l) => !l.config.hidden && !l.config.system_kind).map((l) => ({ kind: "list" as const, node: l })),
      ...folderDocs.map((d) => ({ kind: "doc" as const, node: d })),
    ];
    const ordered = sortByOrder(
      all,
      (c) => (c.kind === "doc" ? (c.node.__path || "") : c.node.path),
      childOrder,
      (c) => c.kind === "doc" ? c.node.name : c.node.config.name,
    );
    for (const child of ordered) {
      if (child.kind === "doc") renderDocRow(container, child.node, folder.path, "it-tree-list-in-folder", opts);
      else renderListRow(container, child.node, folder.path, "it-tree-list-in-folder", sidebarOrder, opts, sidebarRoot);
    }
  }
}

// ---------- List row ----------

function renderListRow(
  container: HTMLElement,
  list: ListNode,
  parentPath: string,
  extraCls: string,
  sidebarOrder: SidebarOrder,
  opts: SidebarOptions,
  sidebarRoot: HTMLElement,
) {
  const listColor = list.config.color || "#2196F3";

  const row = container.createDiv({
    cls: `it-tree-row it-tree-list ${extraCls}`.trim(),
    attr: { draggable: String(!Platform.isMobile), "data-path": list.path, "data-kind": "list" },
  });
  row.style.setProperty("--node-color", listColor);
  if (opts.current.kind === "list" && opts.current.path === list.path) row.addClass("is-active");

  const dragHandle = row.createDiv({ cls: "it-drag-handle" });
  setIcon(dragHandle, "grip-vertical");
  dragHandle.setAttribute("aria-hidden", "true");

  const dot = row.createSpan({ cls: "it-tree-dot" });
  dot.style.background = listColor;

  const namePart = row.createDiv({ cls: "it-tree-name it-tree-name-list" });
  const listIconEl = renderIconish(namePart, list.config.icon || "📋", { cls: "it-tree-emoji" });
  if (listIconEl) listIconEl.style.color = listColor;
  namePart.createSpan({ text: list.config.name, cls: "it-tree-label" });
  namePart.addEventListener("click", () => opts.onSelect({ kind: "list", path: list.path }));

  row.createSpan({ cls: "it-tree-count", text: String(opts.plugin.index.listItemCount(list.path)) });

  const act = row.createDiv({ cls: "it-tree-actions" });
  const moreBtn = act.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("common.more") } });
  setIcon(moreBtn, "more-horizontal");
  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showContextMenu(e, [
      { label: menuLabel("newTask"), icon: "plus", onClick: () => new QuickTaskModal(opts.plugin.app, opts.plugin, list.path).open() },
      "separator",
      { label: menuLabel("editSettings"), icon: "settings", onClick: () => new ConfigModal(opts.plugin.app, opts.plugin, "list", list.path).open() },
      { label: menuLabel("export"), icon: "download", onClick: () => new ExportModal(opts.plugin.app, opts.plugin, { scope: "list", path: list.path }).open() },
      { label: t("action.importTask"), icon: "upload", onClick: () => new ImportModal(opts.plugin.app, opts.plugin, { destination: { listPath: list.path }, allowedScopes: ["task"], label: list.config.name }).open() },
      { label: menuLabel("saveTemplate"), icon: "layout-template", onClick: () => new SaveTemplateModal(opts.plugin.app, opts.plugin, "list", { path: list.path }, { name: list.config.name, icon: list.config.icon }).open() },
      { label: menuLabel("move"), icon: "folder-input", onClick: () => new MoveListModal(opts.plugin.app, opts.plugin, list.path).open() },
      { label: menuLabel("copyLink"), icon: "link", onClick: () => void opts.plugin.copyElementLink("list", list.config.list_id) },
      { label: menuLabel("copyId"), icon: "fingerprint", onClick: () => void opts.plugin.copyTextToClipboard(list.config.list_id ?? "") },
      { label: menuLabel("copyPath"), icon: "folder-tree", onClick: () => void opts.plugin.copyTextToClipboard(list.path, "deepLink.pathCopied") },
      "separator",
      ...favoriteToggleItems(opts.plugin, list.path),
      "separator",
      {
        label: menuLabel("deleteList"),
        icon: "trash",
        danger: true,
        onClick: () => new ConfirmModal(opts.plugin.app, {
          title: t("confirm.deleteList"),
          message: `Move "${list.config.name}" to trash?`,
          destructive: true,
          onConfirm: () => void opts.plugin.index.deleteList(list.path),
        }).open(),
      },
    ]);
  });

  // Drag-and-drop reordering within same parent
  row.addEventListener("dragstart", (e) => {
    activeDrag = { path: list.path, parentPath, kind: "list", element: row };
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", list.path);
    window.requestAnimationFrame(() => row.addClass("is-dragging"));
  });
  row.addEventListener("dragend", () => { row.removeClass("is-dragging"); activeDrag = null; });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!activeDrag || activeDrag.parentPath !== parentPath || activeDrag.path === list.path) return;
    e.dataTransfer!.dropEffect = "move";
    row.addClass("is-drag-over");
  });
  row.addEventListener("dragleave", () => row.removeClass("is-drag-over"));
  row.addEventListener("drop", fireAndForget(async (e) => {
    e.preventDefault();
    row.removeClass("is-drag-over");
    if (!activeDrag || activeDrag.parentPath !== parentPath || activeDrag.path === list.path) return;
    const rect = row.getBoundingClientRect();
    const insertAfter = e.clientY > rect.top + rect.height / 2;
    const stored = opts.plugin.index.getSidebarOrder();

    const allSiblingPaths = siblingPaths(opts.plugin, parentPath);
    if (allSiblingPaths.length === 0) return;

    const current = canonicalOrder(allSiblingPaths, stored.children?.[parentPath]);
    const newChildOrder = reorderArray(current, activeDrag.path, list.path, insertAfter);
    activeDrag = null;
    await opts.plugin.index.updateSidebarOrder({ ...stored, children: { ...stored.children, [parentPath]: newChildOrder } });
  }));
}

// ---------- Doc row ----------
// A Doc rendered as a sidebar item (like a List). Identified by its container
// file path. Reuses the list row look; clicking opens the Doc view.

function promptRename(anchor: HTMLElement, initial: string, placeholder: string, onName: (v: string) => void) {
  showPopover(anchor, (root) => {
    const wrap = root.createDiv({ cls: "it-view-name-popover" });
    const input = wrap.createEl("input", { type: "text", cls: "it-input" });
    input.placeholder = placeholder;
    input.value = initial;
    const close = () => document.querySelectorAll(".it-popover").forEach((el) => el.remove());
    const submit = () => { const v = input.value.trim(); if (!v) return; close(); onName(v); };
    wrap.createEl("button", { cls: "it-btn-primary", text: t("common.save") }).addEventListener("click", submit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); submit(); }
      else if (ev.key === "Escape") { ev.preventDefault(); close(); }
    });
    window.requestAnimationFrame(() => input.focus());
  });
}

function renderDocRow(
  container: HTMLElement,
  doc: DocMeta,
  parentPath: string,
  extraCls: string,
  opts: SidebarOptions,
) {
  const docColor = doc.color || DOC_ACCENT;
  const docPath = doc.__path || "";

  const row = container.createDiv({
    cls: `it-tree-row it-tree-list it-tree-doc ${extraCls}`.trim(),
    attr: { draggable: String(!Platform.isMobile), "data-path": docPath, "data-kind": "doc" },
  });
  row.style.setProperty("--node-color", docColor);
  if (opts.current.kind === "doc" && opts.current.path === docPath) row.addClass("is-active");

  const dragHandle = row.createDiv({ cls: "it-drag-handle" });
  setIcon(dragHandle, "grip-vertical");
  dragHandle.setAttribute("aria-hidden", "true");

  const dot = row.createSpan({ cls: "it-tree-dot" });
  dot.style.background = docColor;

  const namePart = row.createDiv({ cls: "it-tree-name it-tree-name-list" });
  const docIconEl = renderIconish(namePart, doc.icon || DOC_ICON, { cls: "it-tree-emoji" });
  if (docIconEl) docIconEl.style.color = docColor;
  namePart.createSpan({ text: doc.name, cls: "it-tree-label" });
  namePart.addEventListener("click", () => opts.onSelect({ kind: "doc", path: docPath }));

  row.createSpan({ cls: "it-tree-count", text: String(opts.plugin.index.pagesForDoc(doc.doc_id).length) });

  const act = row.createDiv({ cls: "it-tree-actions" });
  const moreBtn = act.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("common.more") } });
  setIcon(moreBtn, "more-horizontal");
  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showContextMenu(e, [
      { label: t("docsMgr.openDoc"), icon: "book-open", onClick: () => opts.onSelect({ kind: "doc", path: docPath }) },
      "separator",
      { label: menuLabel("rename"), icon: "pencil", onClick: () => promptRename(moreBtn, doc.name, t("sidebar.docNamePrompt"), (name) => void opts.plugin.index.updateDoc(doc.doc_id, { name })) },
      { label: t("action.changeIcon"), icon: "image", onClick: () => openIconPicker(moreBtn, doc.icon, (v) => void opts.plugin.index.updateDoc(doc.doc_id, { icon: v })) },
      { label: t("action.changeColor"), icon: "palette", onClick: () => openColorPicker(moreBtn, doc.color, (v) => void opts.plugin.index.updateDoc(doc.doc_id, { color: v })) },
      { label: menuLabel("move"), icon: "folder-input", onClick: () => new MoveDocModal(opts.plugin.app, opts.plugin, doc.doc_id).open() },
      { label: menuLabel("copyLink"), icon: "link", onClick: () => void opts.plugin.copyElementLink("doc", doc.doc_id) },
      { label: menuLabel("copyId"), icon: "fingerprint", onClick: () => void opts.plugin.copyTextToClipboard(doc.doc_id) },
      "separator",
      ...favoriteToggleItems(opts.plugin, docPath),
      "separator",
      { label: t("action.deleteDoc"), icon: "trash", danger: true, onClick: () => new ConfirmModal(opts.plugin.app, {
          title: t("docsMgr.deleteTitle"),
          message: t("docsMgr.deleteMsg", { name: doc.name }),
          destructive: true,
          onConfirm: () => void opts.plugin.index.deleteDoc(doc.doc_id),
        }).open() },
    ]);
  });

  // Drag reorder within the same parent (shares the order array with lists/folders).
  row.addEventListener("dragstart", (e) => {
    activeDrag = { path: docPath, parentPath, kind: "doc", element: row };
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", docPath);
    window.requestAnimationFrame(() => row.addClass("is-dragging"));
  });
  row.addEventListener("dragend", () => { row.removeClass("is-dragging"); activeDrag = null; });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!activeDrag || activeDrag.parentPath !== parentPath || activeDrag.path === docPath) return;
    e.dataTransfer!.dropEffect = "move";
    row.addClass("is-drag-over");
  });
  row.addEventListener("dragleave", () => row.removeClass("is-drag-over"));
  row.addEventListener("drop", fireAndForget(async (e) => {
    e.preventDefault();
    row.removeClass("is-drag-over");
    if (!activeDrag || activeDrag.parentPath !== parentPath || activeDrag.path === docPath) return;
    const rect = row.getBoundingClientRect();
    const insertAfter = e.clientY > rect.top + rect.height / 2;
    const stored = opts.plugin.index.getSidebarOrder();
    const all = siblingPaths(opts.plugin, parentPath);
    if (!all.length) return;
    const current = canonicalOrder(all, stored.children?.[parentPath]);
    const newOrder = reorderArray(current, activeDrag.path, docPath, insertAfter);
    activeDrag = null;
    await opts.plugin.index.updateSidebarOrder({ ...stored, children: { ...stored.children, [parentPath]: newOrder } });
  }));
}

// ---------- Favorites ----------

function renderFavoritesGroup(
  parent: HTMLElement,
  opts: SidebarOptions,
  sidebarRoot: HTMLElement,
) {
  const isActiveHeader = opts.current.kind === "favorites";
  const favorites = opts.plugin.index.getFavorites("left");
  if (opts.plugin.prefs.bookmarksCollapsed) opts.collapsedSet.add(BOOKMARKS_COLLAPSE_KEY);
  else opts.collapsedSet.delete(BOOKMARKS_COLLAPSE_KEY);
  const collapsed = opts.collapsedSet.has(BOOKMARKS_COLLAPSE_KEY);
  const hasChildren = favorites.length > 0;

  // Header row — entry to the aggregate "Bookmarks" view (= the left bucket)
  const header = parent.createDiv({
    cls: "it-tree-row it-tree-nav it-tree-favorites-header" + (isActiveHeader ? " is-active" : ""),
  });
  const ico = header.createSpan({ cls: "it-tree-emoji" });
  setIcon(ico, hasChildren && collapsed ? "bookmark-minus" : FAV_LOCATION_META.left.icon);
  ico.style.color = FAV_LOCATION_META.left.color;
  if (hasChildren) {
    ico.addClass("it-tree-favorites-toggle");
    ico.setAttribute("role", "button");
    ico.setAttribute("aria-label", favLocationLabel("left"));
    ico.addEventListener("click", (e) => {
      e.stopPropagation();
      const nextCollapsed = !collapsed;
      if (nextCollapsed) opts.collapsedSet.add(BOOKMARKS_COLLAPSE_KEY);
      else opts.collapsedSet.delete(BOOKMARKS_COLLAPSE_KEY);
      opts.plugin.prefs.bookmarksCollapsed = nextCollapsed;
      void opts.plugin.saveSettings();
      renderSidebar(sidebarRoot, opts);
    });
  }
  header.createSpan({ text: favLocationLabel("left"), cls: "it-tree-label" });
  header.addEventListener("click", () => opts.onSelect({ kind: "favorites" }));

  // Children — favorite lists + docs + saved views (the LEFT bucket)
  if (!hasChildren || collapsed) return;
  const wrap = parent.createDiv({ cls: "it-favorites-children" });
  renderFavoriteChildren(wrap, opts, "left");
}

// Renders the favorite rows (list/doc/view) of one bucket into `wrap`, in stored
// order. Shared by the left-sidebar Favorites group AND the right-sidebar
// Favorites panel so both look and behave identically (icons, colors, names,
// drag-reorder within the bucket, relocate/remove menu). `loc` is the bucket.
export function renderFavoriteChildren(wrap: HTMLElement, opts: SidebarOptions, loc: FavLocation) {
  const favorites = opts.plugin.index.getFavorites(loc);
  favorites.forEach((favPath, idx) => {
    if (opts.plugin.index.findList(favPath)) renderFavoriteListRow(wrap, favPath, idx, favorites.length, opts, loc);
    else if (opts.plugin.index.docByPath(favPath)) renderFavoriteDocRow(wrap, favPath, idx, favorites.length, opts, loc);
    else if (opts.plugin.index.viewByPath(favPath)) renderFavoriteViewRow(wrap, favPath, idx, favorites.length, opts, loc);
    else if (opts.plugin.index.tasksById.has(favPath)) renderFavoriteTaskRow(wrap, favPath, idx, favorites.length, opts, loc);
    // else: stale favorite (item was deleted) → skip silently.
  });
}

// ----- Shared favorite-row pieces (used by all three kinds + both buckets) -----

// Up/down reorder buttons (hover-revealed). Rendered AFTER the count span so the
// arrows are anchored to the right (just left of "more") and stay vertically
// aligned whether or not the row shows a count (views don't).
function renderFavReorder(row: HTMLElement, path: string, index: number, total: number, opts: SidebarOptions, loc: FavLocation) {
  const reorderActions = row.createDiv({ cls: "it-tree-actions it-tree-actions-reorder" });
  const upBtn = reorderActions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("sidebar.moveFavUp") } });
  setIcon(upBtn, "chevron-up");
  if (index === 0) upBtn.addClass("is-disabled");
  upBtn.addEventListener("click", fireAndForget(async (e) => { e.stopPropagation(); if (index === 0) return; await opts.plugin.index.moveFavorite(path, loc, -1); }));
  const downBtn = reorderActions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("sidebar.moveFavDown") } });
  setIcon(downBtn, "chevron-down");
  if (index === total - 1) downBtn.addClass("is-disabled");
  downBtn.addEventListener("click", fireAndForget(async (e) => { e.stopPropagation(); if (index === total - 1) return; await opts.plugin.index.moveFavorite(path, loc, 1); }));
}

function renderFavMore(row: HTMLElement, items: import("../ui/menu").MenuItem[]) {
  const moreActions = row.createDiv({ cls: "it-tree-actions" });
  const moreBtn = moreActions.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("common.more") } });
  setIcon(moreBtn, "more-horizontal");
  moreBtn.addEventListener("click", (e) => { e.stopPropagation(); showContextMenu(e, items); });
}

// Drag-reorder within ONE bucket. `parentPath` is tagged with the bucket so a
// drag started in one surface can't reorder another (both can be on screen at
// once); cross-bucket relocation is done via the menu, not drag.
function attachFavDrag(row: HTMLElement, path: string, opts: SidebarOptions, loc: FavLocation) {
  const tag = "__fav_" + loc;
  row.addEventListener("dragstart", (e) => {
    activeDrag = { path, parentPath: tag, kind: "favorite", element: row };
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", path);
    window.requestAnimationFrame(() => row.addClass("is-dragging"));
  });
  row.addEventListener("dragend", () => { row.removeClass("is-dragging"); activeDrag = null; });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!activeDrag || activeDrag.kind !== "favorite" || activeDrag.parentPath !== tag || activeDrag.path === path) return;
    e.dataTransfer!.dropEffect = "move";
    row.addClass("is-drag-over");
  });
  row.addEventListener("dragleave", () => row.removeClass("is-drag-over"));
  row.addEventListener("drop", fireAndForget(async (e) => {
    e.preventDefault();
    row.removeClass("is-drag-over");
    if (!activeDrag || activeDrag.kind !== "favorite" || activeDrag.parentPath !== tag || activeDrag.path === path) return;
    const rect = row.getBoundingClientRect();
    const insertAfter = e.clientY > rect.top + rect.height / 2;
    const draggedPath = activeDrag.path;
    activeDrag = null;
    await opts.plugin.index.reorderFavorites(draggedPath, path, insertAfter, loc);
  }));
}

function renderFavoriteViewRow(
  container: HTMLElement,
  viewPath: string,
  index: number,
  total: number,
  opts: SidebarOptions,
  loc: FavLocation,
) {
  const view = opts.plugin.index.viewByPath(viewPath);
  if (!view) return;
  const colors = resolveViewColorSet(opts.plugin.prefs.viewColorScheme, opts.plugin.prefs.viewColors);
  const viewColor = colors[VIEW_COLOR_INDEX[view.type]] || "#9E9E9E";

  const row = container.createDiv({
    cls: "it-tree-row it-tree-list it-tree-favorite-row",
    attr: { draggable: String(!Platform.isMobile), "data-path": viewPath, "data-kind": "favorite" },
  });
  row.style.setProperty("--node-color", viewColor);

  const dragHandle = row.createDiv({ cls: "it-drag-handle" });
  setIcon(dragHandle, "grip-vertical");
  dragHandle.setAttribute("aria-hidden", "true");

  const dot = row.createSpan({ cls: "it-tree-dot" });
  dot.style.background = viewColor;

  const namePart = row.createDiv({ cls: "it-tree-name it-tree-name-list" });
  const viewIconEl = namePart.createSpan({ cls: "it-tree-emoji" });
  setIcon(viewIconEl, VIEW_TYPE_ICON[view.type] || "list");
  viewIconEl.style.color = viewColor;
  namePart.createSpan({ text: view.name, cls: "it-tree-label" });
  namePart.addEventListener("click", () => opts.onOpenView(view));

  // No count for views — arrows still align because they're anchored to the
  // right (immediately left of "more"), independent of the count slot.
  renderFavReorder(row, viewPath, index, total, opts, loc);
  renderFavMore(row, [
    { label: t("action.open"), icon: "external-link", onClick: () => opts.onOpenView(view) },
    "separator",
    ...favoriteRelocateItems(opts.plugin, viewPath, loc),
  ]);
  attachFavDrag(row, viewPath, opts, loc);
}

function renderFavoriteTaskRow(
  container: HTMLElement,
  taskId: string,
  index: number,
  total: number,
  opts: SidebarOptions,
  loc: FavLocation,
) {
  const fav = resolveFavorite(opts.plugin, taskId);
  if (!fav || fav.kind !== "task") return;

  const row = container.createDiv({
    cls: "it-tree-row it-tree-list it-tree-favorite-row",
    attr: { draggable: String(!Platform.isMobile), "data-path": taskId, "data-kind": "favorite" },
  });
  row.style.setProperty("--node-color", fav.color);

  const dragHandle = row.createDiv({ cls: "it-drag-handle" });
  setIcon(dragHandle, "grip-vertical");
  dragHandle.setAttribute("aria-hidden", "true");

  const dot = row.createSpan({ cls: "it-tree-dot" });
  dot.style.background = fav.color;

  const namePart = row.createDiv({ cls: "it-tree-name it-tree-name-list" });
  const iconEl = renderIconish(namePart, fav.icon, { cls: "it-tree-emoji" });
  if (iconEl) iconEl.style.color = fav.color;
  namePart.createSpan({ text: fav.name, cls: "it-tree-label" });
  namePart.addEventListener("click", () => opts.onOpenTask(taskId));

  // No count — arrows stay right-anchored (next to "more"), like view rows.
  renderFavReorder(row, taskId, index, total, opts, loc);
  renderFavMore(row, [
    { label: t("action.openModal"), icon: "expand", onClick: () => opts.onOpenTask(taskId) },
    "separator",
    ...favoriteRelocateItems(opts.plugin, taskId, loc),
  ]);
  attachFavDrag(row, taskId, opts, loc);
}

function renderFavoriteDocRow(
  container: HTMLElement,
  docPath: string,
  index: number,
  total: number,
  opts: SidebarOptions,
  loc: FavLocation,
) {
  const doc = opts.plugin.index.docByPath(docPath);
  if (!doc) return;
  const docColor = doc.color || DOC_ACCENT;

  const row = container.createDiv({
    cls: "it-tree-row it-tree-list it-tree-doc it-tree-favorite-row",
    attr: { draggable: String(!Platform.isMobile), "data-path": docPath, "data-kind": "favorite" },
  });
  row.style.setProperty("--node-color", docColor);
  if (opts.current.kind === "doc" && opts.current.path === docPath) row.addClass("is-active");

  const dragHandle = row.createDiv({ cls: "it-drag-handle" });
  setIcon(dragHandle, "grip-vertical");
  dragHandle.setAttribute("aria-hidden", "true");

  const dot = row.createSpan({ cls: "it-tree-dot" });
  dot.style.background = docColor;

  const namePart = row.createDiv({ cls: "it-tree-name it-tree-name-list" });
  const docIconEl = renderIconish(namePart, doc.icon || DOC_ICON, { cls: "it-tree-emoji" });
  if (docIconEl) docIconEl.style.color = docColor;
  namePart.createSpan({ text: doc.name, cls: "it-tree-label" });
  namePart.addEventListener("click", () => opts.onSelect({ kind: "doc", path: docPath }));

  // Count BEFORE the reorder arrows so the arrows stay right-anchored.
  row.createSpan({ cls: "it-tree-count", text: String(opts.plugin.index.pagesForDoc(doc.doc_id).length) });
  renderFavReorder(row, docPath, index, total, opts, loc);
  renderFavMore(row, [
    { label: t("docsMgr.openDoc"), icon: "book-open", onClick: () => opts.onSelect({ kind: "doc", path: docPath }) },
    "separator",
    ...favoriteRelocateItems(opts.plugin, docPath, loc),
  ]);
  attachFavDrag(row, docPath, opts, loc);
}

function renderFavoriteListRow(
  container: HTMLElement,
  listPath: string,
  index: number,
  total: number,
  opts: SidebarOptions,
  loc: FavLocation,
) {
  const list = opts.plugin.index.findList(listPath);
  if (!list) return;
  const listColor = list.config.color || "#2196F3";

  const row = container.createDiv({
    cls: "it-tree-row it-tree-list it-tree-favorite-row",
    attr: { draggable: String(!Platform.isMobile), "data-path": list.path, "data-kind": "favorite" },
  });
  row.style.setProperty("--node-color", listColor);
  if (opts.current.kind === "list" && opts.current.path === list.path) row.addClass("is-active");

  const dragHandle = row.createDiv({ cls: "it-drag-handle" });
  setIcon(dragHandle, "grip-vertical");
  dragHandle.setAttribute("aria-hidden", "true");

  const dot = row.createSpan({ cls: "it-tree-dot" });
  dot.style.background = listColor;

  const namePart = row.createDiv({ cls: "it-tree-name it-tree-name-list" });
  const listIconEl = renderIconish(namePart, list.config.icon || "📋", { cls: "it-tree-emoji" });
  if (listIconEl) listIconEl.style.color = listColor;
  namePart.createSpan({ text: list.config.name, cls: "it-tree-label" });
  namePart.addEventListener("click", () => opts.onSelect({ kind: "list", path: list.path }));

  // Count BEFORE the reorder arrows so the arrows stay right-anchored
  // (consistent with doc rows and aligned with view rows, which have no count).
  row.createSpan({ cls: "it-tree-count", text: String(opts.plugin.index.listItemCount(list.path)) });
  renderFavReorder(row, list.path, index, total, opts, loc);
  renderFavMore(row, [
    { label: t("sidebar.openList"), icon: "external-link", onClick: () => opts.onSelect({ kind: "list", path: list.path }) },
    { label: menuLabel("editSettings"), icon: "settings", onClick: () => new ConfigModal(opts.plugin.app, opts.plugin, "list", list.path).open() },
    "separator",
    ...favoriteRelocateItems(opts.plugin, list.path, loc),
  ]);
  attachFavDrag(row, list.path, opts, loc);
}

// ---------- Global nav item ----------

function navItem(
  parent: HTMLElement,
  icon: string,
  label: string,
  active: boolean,
  onClick: () => void,
  opts: { iconColor?: string; attention?: "danger" | "warning" } = {},
) {
  const row = parent.createDiv({
    cls: "it-tree-row it-tree-nav"
      + (active ? " is-active" : "")
      + (opts.attention ? ` it-tree-nav-attention is-${opts.attention}` : ""),
  });
  const ico = row.createSpan({ cls: "it-tree-emoji" });
  setIcon(ico, icon);
  if (opts.iconColor) ico.style.color = opts.iconColor;
  row.createSpan({ text: label, cls: "it-tree-label" });
  row.addEventListener("click", onClick);
}

// Renders one Global-section item by key.
function renderGlobalItem(host: HTMLElement, key: string, opts: SidebarOptions, parent: HTMLElement) {
  const cur = opts.current.kind;
  switch (key) {
    case "today": navItem(host, "calendar-check", navLabel("today"), cur === "today", () => opts.onSelect({ kind: "today" })); break;
    case "everything": navItem(host, "layers", navLabel("everything"), cur === "everything", () => opts.onSelect({ kind: "everything" })); break;
    case "recents": navItem(host, "history", navLabel("recents"), cur === "recents", () => opts.onSelect({ kind: "recents" })); break;
    case "favorites": renderFavoritesGroup(host, opts, parent); break;
    case "archived": navItem(host, "archive", navLabel("archived"), cur === "archived", () => opts.onSelect({ kind: "archived" })); break;
  }
}

// Popover to show/hide and reorder the Global-section items.
function openGlobalCustomizer(anchor: HTMLElement, opts: SidebarOptions, rerender: () => void) {
  const plugin = opts.plugin;
  showPopover(anchor, (root) => {
    const build = () => {
      root.empty();
      root.addClass("it-global-customizer");
      root.createDiv({ cls: "it-global-customizer-title", text: t("sidebar.globalSection") });
      const order = effectiveGlobalOrder(plugin);
      const hidden = new Set(plugin.prefs.globalNavHidden || []);
      const persist = () => {
        plugin.prefs.globalNavOrder = order.slice();
        plugin.prefs.globalNavHidden = [...hidden];
        void plugin.saveSettings();
        rerender();
      };
      order.forEach((key, i) => {
        const meta = GLOBAL_NAV_ITEMS.find((m) => m.key === key);
        if (!meta) return;
        const row = root.createDiv({ cls: "it-global-customizer-row" });
        const navText = navLabel(meta.key);
        const cb = row.createEl("input", { type: "checkbox", attr: { "aria-label": t("sidebar.show", { label: navText }) } });
        cb.checked = !hidden.has(key);
        cb.addEventListener("change", () => { if (cb.checked) hidden.delete(key); else hidden.add(key); persist(); build(); });
        setIcon(row.createSpan({ cls: "it-global-customizer-ic" }), meta.icon);
        row.createSpan({ cls: "it-global-customizer-label", text: navText });
        const moves = row.createDiv({ cls: "it-global-customizer-moves" });
        const up = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("customize.moveUp"), type: "button" } });
        setIcon(up, "chevron-up");
        up.disabled = i === 0;
        up.addEventListener("click", () => { if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; persist(); build(); } });
        const down = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("customize.moveDown"), type: "button" } });
        setIcon(down, "chevron-down");
        down.disabled = i === order.length - 1;
        down.addEventListener("click", () => { if (i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; persist(); build(); } });
      });
    };
    build();
  });
}
