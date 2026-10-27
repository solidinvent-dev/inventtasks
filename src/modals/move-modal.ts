import { App, Modal, Notice } from "obsidian";
import type InventTasksPlugin from "../main";
import { hierarchyLabel, t } from "../i18n";
import { renderIconish } from "../ui/icons";
import { DOC_ICON } from "../constants";
import type { FolderNode, TaskFile } from "../types";
import { fireAndForget } from "../utils/async";

// ---------- Shared hierarchy picker ----------
// Renders a search box + grouped, selectable list of destinations
// (lists, folders, spaces). Used by every "pick a location" modal so the
// look & feel stays consistent.

export interface PickerSelectable {
  /** "list" | "folder" | "space" — used for the default icon and label */
  kind: "list" | "folder" | "space";
  path: string;
  name: string;
  icon?: string;
  color?: string;
  /** Secondary line (e.g. "in MyFolder" or "Directly in space") */
  detail?: string;
}

export interface HierarchyPickerOptions {
  /** Which kinds of targets are selectable. */
  kinds: Array<"list" | "folder" | "space">;
  /** Path that should be rendered as the current/source (greyed out, unclickable). */
  currentPath?: string;
  /** Paths that should be hidden entirely. */
  excludePaths?: string[];
  /** Restrict picker to lists/folders inside this space. */
  scopeSpacePath?: string;
  /** Restrict picker to lists inside this folder. */
  scopeFolderPath?: string;
  /** Placeholder for the search input. */
  searchPlaceholder?: string;
  /** Text shown when no entries are available at all. */
  emptyText?: string;
  /** Show a "directly in space" entry as a selectable space target. */
  spaceAsTarget?: boolean;
  /** Hide the search input. */
  hideSearch?: boolean;
  onSelect: (item: PickerSelectable | null) => void;
}

export function renderHierarchyPicker(
  parent: HTMLElement,
  plugin: InventTasksPlugin,
  opts: HierarchyPickerOptions,
): { setFilter: (q: string) => void } {
  parent.addClass("it-picker-host");
  const idx = plugin.index;

  let searchInput: HTMLInputElement | null = null;
  if (!opts.hideSearch) {
    const searchWrap = parent.createDiv({ cls: "it-move-modal-search-wrap" });
    searchInput = searchWrap.createEl("input", {
      type: "text",
      cls: "it-move-modal-search",
      attr: { placeholder: opts.searchPlaceholder || t("move.search") },
    });
  }

  const list = parent.createDiv({ cls: "it-move-modal-list" });

  const exclude = new Set(opts.excludePaths ?? []);
  const wantList = opts.kinds.includes("list");
  const wantFolder = opts.kinds.includes("folder");
  const wantSpace = opts.kinds.includes("space");

  const render = (filter: string) => {
    list.empty();
    const needle = filter.trim().toLowerCase();
    const match = (...parts: Array<string | undefined>): boolean => {
      if (!needle) return true;
      return parts.filter(Boolean).join(" ").toLowerCase().includes(needle);
    };

    let anyRendered = false;

    // Hidden, system-managed Spaces (the one hosting Reminders and Short notes)
    // are never a legal destination: the sidebar does not render them, so a List
    // or Folder moved there disappears from the UI with no way back — while
    // still counting against the List budget. Same rule as the bulk
    // add-to-list picker.
    for (const space of idx.userSpaces) {
      if (opts.scopeSpacePath && space.path !== opts.scopeSpacePath) continue;
      const sName = space.config.name;
      const sColor = space.config.color || "#0091FF";

      // Gather everything this space contributes
      const spaceItem: PickerSelectable | null =
        wantSpace && !exclude.has(space.path)
          ? {
              kind: "space",
              path: space.path,
              name: sName,
              icon: space.config.icon,
              color: sColor,
              detail: opts.spaceAsTarget ? t("move.directlyInSpace") : undefined,
            }
          : null;

      const directLists =
        wantList && !opts.scopeFolderPath
          ? space.lists.filter((l) => !l.config.system_kind && !exclude.has(l.path) && match(sName, l.config.name))
          : [];

      const folderGroups: Array<{ folder: FolderNode; lists: typeof space.lists }> = [];
      for (const folder of space.folders) {
        if (opts.scopeFolderPath && folder.path !== opts.scopeFolderPath) continue;
        const folderShown = wantFolder && !exclude.has(folder.path) && match(sName, folder.config.name);
        const lists = wantList
          ? folder.lists.filter((l) => !l.config.system_kind && !exclude.has(l.path) && match(sName, folder.config.name, l.config.name))
          : [];
        if (folderShown || lists.length > 0) {
          folderGroups.push({ folder, lists });
        }
      }

      const spaceMatchesAlone = wantSpace && (!needle || match(sName));
      const hasContent =
        directLists.length > 0 ||
        folderGroups.length > 0 ||
        (spaceItem && spaceMatchesAlone);
      if (!hasContent) continue;

      // Space group header
      const groupEl = list.createDiv({ cls: "it-move-modal-group" });
      const groupHeader = groupEl.createDiv({ cls: "it-move-modal-group-header" });
      const sIcon = renderIconish(groupHeader, space.config.icon || "🏷️", { cls: "it-move-modal-group-icon" });
      if (sIcon) sIcon.style.color = sColor;
      groupHeader.createSpan({ text: sName, cls: "it-move-modal-group-name" });

      // Space-as-target option
      if (spaceItem && spaceMatchesAlone) {
        renderOption(groupEl, spaceItem, opts, idx);
        anyRendered = true;
      }

      for (const l of directLists) {
        renderOption(groupEl, {
          kind: "list",
          path: l.path,
          name: l.config.name,
          icon: l.config.icon,
          color: l.config.color,
        }, opts, idx);
        anyRendered = true;
      }

      for (const g of folderGroups) {
        const folderItem: PickerSelectable = {
          kind: "folder",
          path: g.folder.path,
          name: g.folder.config.name,
          icon: g.folder.config.icon,
          color: g.folder.config.color,
          detail: t("move.inSpace", { name: sName }),
        };
        const folderSelectable = wantFolder && !exclude.has(g.folder.path);

        if (folderSelectable && g.lists.length === 0) {
          // Render as a flat folder option (no expand)
          renderOption(groupEl, folderItem, opts, idx);
          anyRendered = true;
          continue;
        }

        const sub = groupEl.createDiv({ cls: "it-move-modal-subgroup" });
        const subHeader = sub.createDiv({ cls: "it-move-modal-subgroup-header" });
        const fIcon = renderIconish(subHeader, g.folder.config.icon || "📁", { cls: "it-move-modal-subgroup-icon" });
        if (fIcon && g.folder.config.color) fIcon.style.color = g.folder.config.color;
        subHeader.createSpan({ text: g.folder.config.name, cls: "it-move-modal-subgroup-name" });

        if (folderSelectable) {
          renderOption(sub, { ...folderItem, detail: t("move.directlyInFolder") }, opts, idx);
          anyRendered = true;
        }
        for (const l of g.lists) {
          renderOption(sub, {
            kind: "list",
            path: l.path,
            name: l.config.name,
            icon: l.config.icon,
            color: l.config.color,
            detail: undefined,
          }, opts, idx);
          anyRendered = true;
        }
      }
    }

    if (!anyRendered) {
      list.createDiv({ cls: "it-move-modal-empty", text: opts.emptyText || t("move.nothingMatches") });
    }
  };

  function renderOption(
    parentEl: HTMLElement,
    item: PickerSelectable,
    o: HierarchyPickerOptions,
    _idx: typeof plugin.index,
  ) {
    const isCurrent = !!o.currentPath && o.currentPath === item.path;
    const accent = item.color || (item.kind === "list" ? "#E91E63" : item.kind === "folder" ? "#6647F0" : "#0091FF");
    const defaultIcon = item.kind === "list" ? "📋" : item.kind === "folder" ? "📁" : "🏷️";

    const el = parentEl.createDiv({
      cls: `it-move-modal-option it-move-modal-option-${item.kind}${isCurrent ? " is-current" : ""}`,
    });
    const bar = el.createDiv({ cls: "it-move-modal-option-bar" });
    bar.style.background = accent;

    const content = el.createDiv({ cls: "it-move-modal-option-content" });
    const header = content.createDiv({ cls: "it-move-modal-option-header" });
    const ico = renderIconish(header, item.icon || defaultIcon, { cls: "it-move-modal-option-icon" });
    if (ico) ico.style.color = accent;
    header.createSpan({ text: item.name, cls: "it-move-modal-option-name" });

    if (item.detail) {
      const meta = content.createDiv({ cls: "it-move-modal-option-meta" });
      meta.createSpan({ text: item.detail, cls: "it-move-modal-option-detail" });
    }

    if (isCurrent) {
      const cur = content.createDiv({ cls: "it-move-modal-option-meta" });
      cur.createSpan({ text: t("move.currentLocation"), cls: "it-move-modal-option-detail" });
      return;
    }

    el.addEventListener("click", () => {
      const root = el.closest(".it-picker-host") || el.parentElement;
      root?.querySelectorAll(".it-move-modal-option").forEach((x) => x.removeClass("is-selected"));
      el.addClass("is-selected");
      o.onSelect(item);
    });
  }

  render("");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      opts.onSelect(null);
      render(searchInput.value);
    });
  }
  return {
    setFilter: (q: string) => {
      if (searchInput) searchInput.value = q;
      render(q);
    },
  };
}

// Build a source banner (icon · name · arrow · breadcrumb). Reused by all
// move modals so the source representation is identical.
export function renderSourceBanner(
  parent: HTMLElement,
  source: { icon?: string; name: string; color?: string },
  breadcrumb?: Array<{ label: string; color?: string; icon?: string }>,
): HTMLElement {
  const banner = parent.createDiv({ cls: "it-move-modal-banner" });
  const ico = renderIconish(banner, source.icon || "🏷️", { cls: "it-move-modal-banner-icon" });
  if (ico && source.color) ico.style.color = source.color;
  banner.createSpan({ text: source.name, cls: "it-move-modal-banner-name" });

  if (breadcrumb && breadcrumb.length) {
    banner.createSpan({ cls: "it-move-modal-arrow", text: "→" });
    const fromSpan = banner.createSpan({ cls: "it-move-modal-from" });
    breadcrumb.forEach((p, i) => {
      if (i > 0) fromSpan.createSpan({ text: " / ", cls: "it-move-modal-from-sep" });
      const bIco = renderIconish(fromSpan, p.icon || "🏷️", { cls: "it-move-modal-banner-icon" });
      if (bIco && p.color) bIco.style.color = p.color;
      fromSpan.createSpan({ text: p.label, cls: "it-move-modal-from-name" });
    });
  }
  return banner;
}

// ---------- Move Folder Modal ----------

export class MoveFolderModal extends Modal {
  private plugin: InventTasksPlugin;
  private folderPath: string;
  private selectedSpacePath: string | null = null;

  constructor(app: App, plugin: InventTasksPlugin, folderPath: string) {
    super(app);
    this.plugin = plugin;
    this.folderPath = folderPath;
  }

  onOpen() {
    const folder = this.plugin.index.findFolder(this.folderPath);
    const currentSpacePath = folder?.spacePath ?? "";
    const currentSpace = this.plugin.index.findSpace(currentSpacePath);

    this.containerEl.addClass("it-move-modal-container");
    this.titleEl.setText(t("modal.moveFolder"));

    const c = this.contentEl;
    c.empty();
    c.addClass("it-move-modal");

    renderSourceBanner(
      c,
      { name: folder?.config.name || hierarchyLabel("folder"), icon: folder?.config.icon || "📁", color: folder?.config.color },
      currentSpace
        ? [{ label: currentSpace.config.name, color: currentSpace.config.color, icon: currentSpace.config.icon }]
        : undefined,
    );

    // Hidden system Spaces are not legal destinations — see renderHierarchyPicker.
    const targetSpaces = this.plugin.index.userSpaces.filter((s) => s.path !== currentSpacePath);

    if (targetSpaces.length === 0) {
      c.createDiv({ cls: "it-move-modal-empty", text: t("move.noOtherSpaces") });
      const footer = c.createDiv({ cls: "it-move-modal-footer" });
      const cancelBtn = footer.createEl("button", { cls: "it-secondary-btn", text: t("common.close") });
      cancelBtn.addEventListener("click", () => this.close());
      return;
    }

    c.createDiv({ cls: "it-move-modal-section-label", text: t("move.chooseDestSpace") });

    let moveBtn: HTMLButtonElement;
    const pickerWrap = c.createDiv();
    renderHierarchyPicker(pickerWrap, this.plugin, {
      kinds: ["space"],
      excludePaths: [currentSpacePath],
      searchPlaceholder: t("move.searchSpaces"),
      emptyText: t("move.noSpacesMatch"),
      onSelect: (item) => {
        this.selectedSpacePath = item?.path ?? null;
        if (moveBtn) moveBtn.disabled = !item;
      },
    });

    const footer = c.createDiv({ cls: "it-move-modal-footer" });
    const cancelBtn = footer.createEl("button", { cls: "it-secondary-btn", text: t("common.cancel") });
    cancelBtn.addEventListener("click", () => this.close());

    moveBtn = footer.createEl("button", { cls: "it-btn-primary", text: t("move.moveFolder") });
    moveBtn.disabled = true;
    moveBtn.addEventListener("click", fireAndForget(async () => {
      if (!this.selectedSpacePath) return;
      moveBtn.disabled = true;
      moveBtn.textContent = t("common.moving");
      try {
        await this.plugin.index.moveFolder(this.folderPath, this.selectedSpacePath);
        this.plugin.refreshViews();
        new Notice(t("move.folderMoved"));
        this.close();
      } catch (err) {
        new Notice(t("common.failed", { msg: (err as Error).message }));
        moveBtn.disabled = false;
        moveBtn.textContent = t("move.moveFolder");
      }
    }));
  }
}

// ---------- Move List Modal ----------

export class MoveListModal extends Modal {
  private plugin: InventTasksPlugin;
  private listPath: string;
  private selectedTargetPath: string | null = null;

  constructor(app: App, plugin: InventTasksPlugin, listPath: string) {
    super(app);
    this.plugin = plugin;
    this.listPath = listPath;
  }

  onOpen() {
    const idx = this.plugin.index;
    const listNode = idx.findList(this.listPath);
    const currentParentPath = listNode?.folderPath ?? listNode?.spacePath ?? "";
    const currentSpace = listNode?.spacePath ? idx.findSpace(listNode.spacePath) : undefined;
    const currentFolder = listNode?.folderPath ? idx.findFolder(listNode.folderPath) : undefined;

    this.containerEl.addClass("it-move-modal-container");
    this.titleEl.setText(t("modal.moveList"));

    const c = this.contentEl;
    c.empty();
    c.addClass("it-move-modal");

    const breadcrumb: Array<{ label: string; color?: string; icon?: string }> = [];
    if (currentSpace) breadcrumb.push({ label: currentSpace.config.name, color: currentSpace.config.color, icon: currentSpace.config.icon });
    if (currentFolder) breadcrumb.push({ label: currentFolder.config.name, color: currentFolder.config.color, icon: currentFolder.config.icon });

    renderSourceBanner(
      c,
      { name: listNode?.config.name || hierarchyLabel("list"), icon: listNode?.config.icon || "📋", color: listNode?.config.color },
      breadcrumb.length ? breadcrumb : undefined,
    );

    c.createDiv({ cls: "it-move-modal-section-label", text: t("move.chooseDestParent") });

    let moveBtn: HTMLButtonElement;
    const pickerWrap = c.createDiv();
    renderHierarchyPicker(pickerWrap, this.plugin, {
      kinds: ["space", "folder"],
      currentPath: currentParentPath,
      searchPlaceholder: t("move.searchSpacesFolders"),
      emptyText: t("move.noDestinationsMatch"),
      spaceAsTarget: true,
      onSelect: (item) => {
        this.selectedTargetPath = item?.path ?? null;
        if (moveBtn) moveBtn.disabled = !item;
      },
    });

    const footer = c.createDiv({ cls: "it-move-modal-footer" });
    const cancelBtn = footer.createEl("button", { cls: "it-secondary-btn", text: t("common.cancel") });
    cancelBtn.addEventListener("click", () => this.close());

    moveBtn = footer.createEl("button", { cls: "it-btn-primary", text: t("move.moveList") });
    moveBtn.disabled = true;
    moveBtn.addEventListener("click", fireAndForget(async () => {
      if (!this.selectedTargetPath) return;
      moveBtn.disabled = true;
      moveBtn.textContent = t("common.moving");
      try {
        await this.plugin.index.moveList(this.listPath, this.selectedTargetPath);
        this.plugin.refreshViews();
        new Notice(t("move.listMoved"));
        this.close();
      } catch (err) {
        new Notice(t("common.failed", { msg: (err as Error).message }));
        moveBtn.disabled = false;
        moveBtn.textContent = t("move.moveList");
      }
    }));
  }
}

// ---------- Move Task Modal ----------

export class MoveTaskModal extends Modal {
  private plugin: InventTasksPlugin;
  private taskId: string;
  private selectedListPath: string | null = null;
  private onMoved?: () => void;

  constructor(app: App, plugin: InventTasksPlugin, taskId: string, onMoved?: () => void) {
    super(app);
    this.plugin = plugin;
    this.taskId = taskId;
    this.onMoved = onMoved;
  }

  onOpen() {
    const idx = this.plugin.index;
    const task: TaskFile | undefined = idx.tasksById.get(this.taskId);
    const currentListPath = task?.listPath ?? "";
    const currentList = currentListPath ? idx.findList(currentListPath) : undefined;
    const currentSpace = currentList?.spacePath ? idx.findSpace(currentList.spacePath) : undefined;
    const currentFolder = currentList?.folderPath ? idx.findFolder(currentList.folderPath) : undefined;

    this.containerEl.addClass("it-move-modal-container");
    this.titleEl.setText(t("modal.moveTask"));

    const c = this.contentEl;
    c.empty();
    c.addClass("it-move-modal");

    const breadcrumb: Array<{ label: string; color?: string; icon?: string }> = [];
    if (currentSpace) breadcrumb.push({ label: currentSpace.config.name, color: currentSpace.config.color, icon: currentSpace.config.icon });
    if (currentFolder) breadcrumb.push({ label: currentFolder.config.name, color: currentFolder.config.color, icon: currentFolder.config.icon });
    if (currentList) breadcrumb.push({ label: currentList.config.name, color: currentList.config.color, icon: currentList.config.icon || "📋" });

    renderSourceBanner(
      c,
      { name: task?.data.title || t("list.task"), icon: task?.data.icon || "✓", color: task?.data.color },
      breadcrumb.length ? breadcrumb : undefined,
    );

    c.createDiv({ cls: "it-move-modal-section-label", text: t("move.chooseDestList") });

    let moveBtn: HTMLButtonElement;
    const pickerWrap = c.createDiv();
    renderHierarchyPicker(pickerWrap, this.plugin, {
      kinds: ["list"],
      currentPath: currentListPath,
      searchPlaceholder: t("move.searchLists"),
      emptyText: t("move.noOtherLists"),
      onSelect: (item) => {
        this.selectedListPath = item?.path ?? null;
        if (moveBtn) moveBtn.disabled = !item;
      },
    });

    const footer = c.createDiv({ cls: "it-move-modal-footer" });
    const cancelBtn = footer.createEl("button", { cls: "it-secondary-btn", text: t("common.cancel") });
    cancelBtn.addEventListener("click", () => this.close());

    moveBtn = footer.createEl("button", { cls: "it-btn-primary", text: t("move.moveTask") });
    moveBtn.disabled = true;
    moveBtn.addEventListener("click", fireAndForget(async () => {
      if (!this.selectedListPath) return;
      moveBtn.disabled = true;
      moveBtn.textContent = t("common.moving");
      try {
        await this.plugin.index.moveTask(this.taskId, this.selectedListPath);
        this.plugin.refreshViews();
        new Notice(t("move.taskMoved"));
        this.onMoved?.();
        this.close();
      } catch (err) {
        new Notice(t("common.failed", { msg: (err as Error).message }));
        moveBtn.disabled = false;
        moveBtn.textContent = t("move.moveTask");
      }
    }));
  }
}

// ---------- Move Doc Modal ----------

export class MoveDocModal extends Modal {
  private plugin: InventTasksPlugin;
  private docId: string;
  private onMoved?: () => void;
  private selected: { kind: string; path: string } | null = null;

  constructor(app: App, plugin: InventTasksPlugin, docId: string, onMoved?: () => void) {
    super(app);
    this.plugin = plugin;
    this.docId = docId;
    this.onMoved = onMoved;
  }

  onOpen() {
    const idx = this.plugin.index;
    const doc = idx.docById(this.docId);
    const loc = doc?.location || "";
    let currentParentPath = "";
    const breadcrumb: Array<{ label: string; color?: string; icon?: string }> = [];
    if (loc.startsWith("folder:")) {
      currentParentPath = loc.slice("folder:".length);
      const f = idx.findFolder(currentParentPath);
      const s = f ? idx.findSpace(f.spacePath) : undefined;
      if (s) breadcrumb.push({ label: s.config.name, color: s.config.color, icon: s.config.icon });
      if (f) breadcrumb.push({ label: f.config.name, color: f.config.color, icon: f.config.icon });
    } else if (loc.startsWith("space:")) {
      currentParentPath = loc.slice("space:".length);
      const s = idx.findSpace(currentParentPath);
      if (s) breadcrumb.push({ label: s.config.name, color: s.config.color, icon: s.config.icon });
    } else if (loc.startsWith("list:")) {
      currentParentPath = loc.slice("list:".length);
      const l = idx.findList(currentParentPath);
      const s = l?.spacePath ? idx.findSpace(l.spacePath) : undefined;
      const f = l?.folderPath ? idx.findFolder(l.folderPath) : undefined;
      if (s) breadcrumb.push({ label: s.config.name, color: s.config.color, icon: s.config.icon });
      if (f) breadcrumb.push({ label: f.config.name, color: f.config.color, icon: f.config.icon });
      if (l) breadcrumb.push({ label: l.config.name, color: l.config.color, icon: l.config.icon });
    }

    this.containerEl.addClass("it-move-modal-container");
    this.titleEl.setText(t("modal.moveDoc"));

    const c = this.contentEl;
    c.empty();
    c.addClass("it-move-modal");

    renderSourceBanner(
      c,
      { name: doc?.name || hierarchyLabel("doc"), icon: doc?.icon || DOC_ICON, color: doc?.color },
      breadcrumb.length ? breadcrumb : undefined,
    );

    c.createDiv({ cls: "it-move-modal-section-label", text: t("move.chooseDocDest") });

    let moveBtn: HTMLButtonElement;
    const pickerWrap = c.createDiv();
    renderHierarchyPicker(pickerWrap, this.plugin, {
      kinds: ["space", "folder", "list"],
      currentPath: currentParentPath,
      searchPlaceholder: t("move.searchAll"),
      emptyText: t("move.noDestinationsMatch"),
      spaceAsTarget: true,
      onSelect: (item) => {
        this.selected = item ? { kind: item.kind, path: item.path } : null;
        if (moveBtn) moveBtn.disabled = !item;
      },
    });

    const footer = c.createDiv({ cls: "it-move-modal-footer" });
    footer.createEl("button", { cls: "it-secondary-btn", text: t("common.cancel") }).addEventListener("click", () => this.close());

    moveBtn = footer.createEl("button", { cls: "it-btn-primary", text: t("move.moveDoc") });
    moveBtn.disabled = true;
    moveBtn.addEventListener("click", fireAndForget(async () => {
      if (!this.selected) return;
      const targetKey = this.selected.kind === "folder" ? `folder:${this.selected.path}`
        : this.selected.kind === "list" ? `list:${this.selected.path}`
        : `space:${this.selected.path}`;
      moveBtn.disabled = true;
      moveBtn.textContent = t("common.moving");
      try {
        await this.plugin.index.moveDoc(this.docId, this.selected.path, targetKey);
        this.plugin.refreshViews();
        new Notice(t("move.docMoved"));
        this.onMoved?.();
        this.close();
      } catch (err) {
        new Notice(t("common.failed", { msg: (err as Error).message }));
        moveBtn.disabled = false;
        moveBtn.textContent = t("move.moveDoc");
      }
    }));
  }
}
