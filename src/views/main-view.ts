import { ItemView, WorkspaceLeaf, setIcon, Platform, Notice, MarkdownRenderer, TFile } from "obsidian";
import type InventTasksPlugin from "../main";
import { VIEW_TYPE_INVENTTASKS, filterFieldsByFeatures, availableFieldsFor, CALENDAR_COLOR_SOURCES_BUILTIN, CALENDAR_COLOR_SOURCE_DEFAULT, DATE_SOURCES_BUILTIN, DATE_SOURCE_DUE, DATE_SOURCE_START, resolveViewColorSet, VIEW_COLOR_INDEX, VIEW_TYPE_ICON, fieldIconMeta, DOC_ACCENT, DOC_ICON, DOC_PAGE_ICON } from "../constants";
import { dateBearingCustomFields } from "../data/date-source";
import { isSecretCustomFieldType } from "../data/custom-fields";
import { renderIconish, renderFieldIcon } from "../ui/icons";
import { renderLogo } from "../ui/logo";
import { openIconPicker, openColorPicker } from "../ui/pickers";
import { resolveStartupLocation } from "../settings";
import { ContextLocation, ViewType, TaskFile, FilterGroup, SortRule, ViewConfig, ViewDefaults, TimeZoom, DocMeta, DocPage, parentTaskIds } from "../types";
import { showPopover } from "../ui/components";
import { showContextMenu } from "../ui/menu";
import { ConfirmModal } from "../modals/confirm-modal";
import { MoveDocModal } from "../modals/move-modal";
import { DocPickerModal } from "../modals/doc-picker-modal";
import { renderSidebar } from "./sidebar";
import { resolveFavorites, renderFavoriteChip, favoriteIsActive, favoriteToggleItems, favoriteRelocateItems, favLocationLabel, FAV_LOCATION_META } from "./favorites";
import { renderListView } from "./list-view";
import { renderBoardView } from "./board-view";
import { renderCalendarView } from "./calendar-view";
import { renderTableView } from "./table-view";
import { renderGanttView } from "./gantt-view";
import { renderTimelineView } from "./timeline-view";
import { notificationOverview, renderNotificationsView } from "./notifications-view";
import { renderSystemListView } from "./system-list-view";
import { applyAppearance, pickAppearance } from "../view-state";
import { GANTT_RAIL_DEFAULT_W, TIMELINE_RAIL_DEFAULT_W, ZOOM_ORDER, ZOOMS, normalizeTimeRailWidth, shiftKey } from "./time-grid";
import { ExportModal } from "../modals/export-modal";
import { TimeExportModal } from "../modals/time-export-modal";
import type { ExportScope } from "../data/export";
import { TimeExportFormat, TimeExportInput } from "../data/timeline-export";
import { CreateSpaceModal, CreateListModal, QuickTaskModal } from "../modals/create-modals";
import { TaskModal } from "../modals/task-modal";
import { FilterModal, FilterFieldDef, FilterFieldType } from "../modals/filter-modal";
import { SearchModal } from "../modals/search-modal";
import { applyFilters, sortTasks, GroupBucket } from "../data/filters";
import { normalizeSubtaskMode, includeSubtasks, SubtaskMode } from "../data/subtasks";
import { calendarColorSourceLabel, fieldLabel, fieldLabelFrom, getSubtaskModes, hierarchyLabel, menuLabel, navLabel, t, viewLabel, zoomLabel } from "../i18n";
import { todayKey } from "../utils/dates";
import { PersistedViewState, groupCollapseKey, locationKey, locationFromKey, toggleCollapsedGroup } from "../view-state";
import { DeepLinkParams } from "../data/deep-link";

// One chip in the Views bar — a saved view or a Doc. They share a single manual
// order, so reordering and rendering treat them uniformly.
type ViewsBarItem = { kind: "view"; v: ViewConfig } | { kind: "doc"; d: DocMeta };

// A restorable navigation position for Back/Forward.
interface NavSnapshot {
  location: ContextLocation;
  activeDocId?: string;
  activeDocPageId?: string;
  // When this position had a task modal open (e.g. you clicked a doc link inside
  // it), re-open that task on return.
  reopenTaskId?: string;
}

export interface ViewState {
  location: ContextLocation;
  viewType: ViewType;
  groupBy: string;
  groupDirection: "asc" | "desc";
  subGroupBy?: string;
  sortBy: SortRule[];
  filters?: FilterGroup;
  search: string;
  showClosed: boolean;
  subtaskMode: SubtaskMode;
  // Transient per-current-view override of visible fields (+ order). Set when a
  // saved view is applied or edited via the Fields customizer; reset on view-type
  // switch and on location change. `undefined` → fall back to resolved
  // view_defaults (inherited config). Persistence is explicit (Save view / Set
  // as default for scope).
  visibleFields?: string[];
  // Table column widths (px) by column key. Persisted per-location.
  tableColWidths?: Record<string, number>;
  // Column calculations (List + Table footer / per-group summaries). Per-view:
  // keyed by view type, then field key. Persisted per-location.
  columnCalcs?: Partial<Record<ViewType, Record<string, import("../types").ColumnCalc>>>;
  collapsedGroups?: Partial<Record<"list" | "table", string[]>>;
  // Transient per-current-view overrides (same lifecycle as visibleFields):
  // calendar pill color source, and the board/calendar CF-chip toggles.
  calendarColorBy?: string;
  // Date sources for the date-driven views (same lifecycle as calendarColorBy):
  // dateField = calendar pill date / gantt+timeline bar END; startField = bar
  // START. `undefined` → resolved view_defaults → due_date/start_date.
  dateField?: string;
  startField?: string;
  cfShowName?: boolean;
  cfShowWhenEmpty?: boolean;
  // Field-type icons in headers/chips (List/Table/Board/Calendar).
  cfShowTypeIcon?: boolean;
  // Timeline "Unscheduled" tray toggle. undefined = inherit view-default.
  timelineShowUnscheduled?: boolean;
  // Calendar specific
  // "monthCompact" is the fit-to-width month overview (Overview tab).
  calendarPeriod: "month" | "week" | "day" | "monthCompact";
  calendarRefDate: string; // ISO yyyy-mm-dd of the visible anchor
  // When true, virtual future occurrences of recurring tasks are projected
  // into the calendar with dashed styling. They are read-only and clicking
  // them opens the parent (the real task) rather than acting in place.
  showRecurringFuture: boolean;
  // ----- Time-based views (Gantt + Timeline) -----
  // Horizontal zoom per view (pixels-per-day + header granularity), and a
  // shared scroll anchor the toolbar prev/next/today nudge. Persisted per
  // location like the other filter dimensions.
  ganttZoom: TimeZoom;
  timelineZoom: TimeZoom;
  ganttRailWidth: number;
  timelineRailWidth: number;
  timeRefDate: string; // ISO yyyy-mm-dd
  // Gantt-only toggles. `calendarColorBy` doubles as the generic bar tint
  // source for Timeline (it's transient + reset on view switch, so it never
  // leaks across view types).
  ganttShowDependencies: boolean;
  ganttShowProgress: boolean;
}

export class InventTasksMainView extends ItemView {
  plugin: InventTasksPlugin;
  state: ViewState;
  sidebarCollapsed = new Set<string>();
  sidebarOpenMobile = false;
  unsubscribe: (() => void) | null = null;
  // Which saved view is currently applied (for the "active" highlight). Cleared
  // whenever the user manually changes the view config; set when a view (or the
  // location's default view) is applied. `applyingView` guards the clear so the
  // persist call inside applyView() doesn't immediately wipe it.
  private activeViewId?: string;
  private applyingView = false;

  // ---------- Docs ----------
  // When set, the body shows the Doc view (explorer + page preview) instead of
  // task views. Cleared when a saved view / view type is chosen or the location
  // changes. The explorer rail can be collapsed; collapsed page nodes are
  // tracked per session.
  private activeDocId?: string;
  private activeDocPageId?: string;
  private docExplorerHidden = false;
  private docCollapsed = new Set<string>();
  // Mobile Calendar Overview: chrome starts collapsed; pull-down (or scroll-up)
  // sets this so re-renders keep the header visible until the user hides it again.
  private overviewChromeRevealed = false;
  private overviewGestureAbort?: AbortController;
  private notificationsRefreshTimer?: number;
  private notificationsSeenActiveSignature = "";
  private remindersSeenActiveSignature = "";
  private notificationsAttention = false;
  private remindersAttention = false;
  private remindersSeverity: "danger" | "warning" | "info" | "none" = "none";
  private lastNotificationChromeRefresh = 0;
  // Set when an index change arrived while the view was hidden; the deferred
  // render runs once on the next reveal (active-leaf-change / layout / resize).
  private renderDirty = false;

  // ---------- Navigation history (browser-like Back/Forward) ----------
  // Each entry is a restorable position (location + open doc/page, plus an
  // optional task to re-open — e.g. when you opened a doc from a task modal).
  private navBack: NavSnapshot[] = [];
  private navFwd: NavSnapshot[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: InventTasksPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = {
      location: resolveStartupLocation(plugin, plugin.prefs.defaultStartupLocation),
      viewType: plugin.prefs.defaultStartupView,
      groupBy: "status",
      groupDirection: "asc",
      sortBy: [{ field: "priority", direction: "asc" }, { field: "due_date", direction: "asc" }],
      search: "",
      showClosed: plugin.prefs.showClosedByDefault,
      subtaskMode: "nested",
      calendarPeriod: "month",
      calendarRefDate: todayKey(),
      showRecurringFuture: false,
      ganttZoom: "week",
      timelineZoom: "month",
      ganttRailWidth: GANTT_RAIL_DEFAULT_W,
      timelineRailWidth: TIMELINE_RAIL_DEFAULT_W,
      timeRefDate: todayKey(),
      ganttShowDependencies: true,
      ganttShowProgress: true,
    };
    this.applyPersistedFiltersForLocation();
  }

  // ---------- Per-location filter persistence ----------
  // Saved snapshot lives in plugin.prefs.viewStateByLocation keyed by
  // `locationKey(state.location)`. Filters (Group/Sort/Show-closed/…) are
  // location-scoped; switching to a list/folder/space — or Today/Everything/
  // Favorites — restores whatever the user had set there last.

  applyPersistedFiltersForLocation() {
    const saved = this.plugin.prefs.viewStateByLocation?.[locationKey(this.state.location)];
    if (saved) {
      if (saved.groupBy !== undefined) this.state.groupBy = saved.groupBy;
      if (saved.groupDirection !== undefined) this.state.groupDirection = saved.groupDirection;
      if (saved.subGroupBy !== undefined) this.state.subGroupBy = saved.subGroupBy;
      if (saved.sortBy !== undefined) this.state.sortBy = saved.sortBy;
      if (saved.showClosed !== undefined) this.state.showClosed = saved.showClosed;
      if (saved.subtaskMode !== undefined) this.state.subtaskMode = normalizeSubtaskMode(saved.subtaskMode);
      if (saved.ganttZoom) this.state.ganttZoom = saved.ganttZoom;
      if (saved.timelineZoom) this.state.timelineZoom = saved.timelineZoom;
      if (saved.timeRefDate) this.state.timeRefDate = saved.timeRefDate;
      if (saved.ganttShowDependencies !== undefined) this.state.ganttShowDependencies = saved.ganttShowDependencies;
      if (saved.ganttShowProgress !== undefined) this.state.ganttShowProgress = saved.ganttShowProgress;
    }
    // Filters are strictly per-location: unlike Group/Sort (which carry over as
    // sensible defaults), a stray hidden filter could make a list look empty.
    // So always mirror the saved value — clearing filters when none is stored.
    this.state.filters = saved?.filters;
    this.state.tableColWidths = !Platform.isMobile && saved?.tableColWidths ? { ...saved.tableColWidths } : {};
    this.state.columnCalcs = saved?.columnCalcs ? { ...saved.columnCalcs } : {};
    this.state.collapsedGroups = saved?.collapsedGroups ? { ...saved.collapsedGroups } : {};
    this.state.ganttRailWidth = normalizeTimeRailWidth(saved?.ganttRailWidth, GANTT_RAIL_DEFAULT_W);
    this.state.timelineRailWidth = normalizeTimeRailWidth(saved?.timelineRailWidth, TIMELINE_RAIL_DEFAULT_W);
    // Field/appearance overrides live in this same per-location layer: what a
    // location has stored wins, and anything unset falls back to the inherited
    // config defaults. A default saved view (below) still overrides both.
    applyAppearance(saved, this.state);
    this.applyResolvedViewTypeForLocation();
    // A saved view marked "default" for this location always opens it —
    // overriding both the persisted per-location state and the Settings
    // startup view. (Use the view's "Update to current view" to bake in
    // changes; only one view per location can be the default.)
    // New location → no active saved view until one is applied (or the default
    // below sets it).
    this.activeViewId = undefined;
    const key = locationKey(this.state.location);
    const def = this.plugin.index.viewsForLocationKey(key).find((v) => v.default);
    if (def) {
      this.applyViewToState(def);
      this.activeViewId = def.view_id;
    } else {
      // A Doc marked default opens on entry too (mutually exclusive with a
      // default view — only one default per location).
      const defDoc = this.plugin.index.docsForLocationKey(key).find((d) => d.default);
      if (defDoc) {
        this.activeDocId = defDoc.doc_id;
        this.activeDocPageId = this.docOrderedSiblings(this.plugin.index.pagesForDoc(defDoc.doc_id), null)[0]?.page_id;
      }
    }
  }

  // Decides which view (List/Board/Calendar/Table) to show on entry, based
  // on the location's `default_view` config plus any persisted last-selected
  // view. Pure mutation of state.viewType — caller renders.
  private applyResolvedViewTypeForLocation() {
    const dv = this.configuredDefaultView(this.state.location);
    if (dv && ["list", "board", "calendar", "table", "gantt", "timeline"].includes(dv)) {
      // Explicit pin to a specific view — overrides any persisted choice.
      this.state.viewType = dv as ViewType;
      return;
    }
    // dv === "last_selected", dv === undefined, or this is a global location
    // (Today/Everything/Favorites). All three route through persisted lookup.
    const persisted = this.persistedViewTypeFor(this.state.location);
    if (persisted) this.state.viewType = persisted;
  }

  private persistFiltersForCurrentLocation() {
    // Any manual control change (which calls this) means we've diverged from the
    // applied saved view — drop the active highlight. applyView() sets the guard
    // so its own persist call doesn't clear it.
    if (!this.applyingView) this.activeViewId = undefined;
    // The list/table lazy-render extent is meaningless once group/sort/filter
    // changes the contents — start fresh from the top, and clear table selection.
    (this.state as any).__listRenderedCount = 0;
    (this.state as any).__tableRenderedCount = 0;
    (this.state as any).__tableSelected = undefined;
    const snapshot: PersistedViewState = {
      viewType: this.state.viewType,
      groupBy: this.state.groupBy,
      groupDirection: this.state.groupDirection,
      subGroupBy: this.state.subGroupBy,
      sortBy: this.state.sortBy,
      filters: this.state.filters,
      showClosed: this.state.showClosed,
      subtaskMode: this.state.subtaskMode,
      columnCalcs: this.state.columnCalcs,
      collapsedGroups: this.state.collapsedGroups,
      ganttZoom: this.state.ganttZoom,
      timelineZoom: this.state.timelineZoom,
      ganttRailWidth: this.state.ganttRailWidth,
      timelineRailWidth: this.state.timelineRailWidth,
      timeRefDate: this.state.timeRefDate,
      ganttShowDependencies: this.state.ganttShowDependencies,
      ganttShowProgress: this.state.ganttShowProgress,
      ...pickAppearance(this.state),
    };
    const map = this.plugin.prefs.viewStateByLocation || {};
    const key = locationKey(this.state.location);
    const existingWidths = map[key]?.tableColWidths;
    if (Platform.isMobile) {
      if (existingWidths) snapshot.tableColWidths = { ...existingWidths };
    } else {
      snapshot.tableColWidths = this.state.tableColWidths;
    }
    map[key] = snapshot;
    this.plugin.prefs.viewStateByLocation = map;
    // Fire-and-forget — data.json is tiny and writes are infrequent (only on
    // user-visible filter changes). Awaiting would needlessly block UI.
    void this.plugin.saveSettings();
  }

  // Returns the location's configured default_view (Space/Folder/List), or
  // undefined for global views (Today/Everything/Favorites) which have no
  // config. Used to decide whether to force a specific view on entry, restore
  // the last-selected one, or leave the current view in place.
  private configuredDefaultView(loc: ContextLocation): string | undefined {
    if (loc.kind === "list") return this.plugin.index.findList(loc.path)?.config.default_view;
    if (loc.kind === "folder") return this.plugin.index.findFolder(loc.path)?.config.default_view;
    if (loc.kind === "space") return this.plugin.index.findSpace(loc.path)?.config.default_view;
    return undefined;
  }

  private toggleViewGroup(viewType: "list" | "table", bucketKey: string) {
    const key = groupCollapseKey(this.state.groupBy, bucketKey);
    this.state.collapsedGroups = toggleCollapsedGroup(this.state.collapsedGroups, viewType, key);
    this.persistFiltersForCurrentLocation();
    this.refreshContent();
  }

  private persistedViewTypeFor(loc: ContextLocation): ViewType | undefined {
    return this.plugin.prefs.viewStateByLocation?.[locationKey(loc)]?.viewType;
  }

  getViewType() { return VIEW_TYPE_INVENTTASKS; }
  getDisplayText() { return "InventTasks"; }
  getIcon() { return "check-square"; }

  async onOpen() {
    this.contentEl.empty();
    this.containerEl.addClass("inventtasks-root");
    this.syncNotificationAttention({ acknowledge: this.state.location.kind === "notifications" });
    this.lastNotificationChromeRefresh = Date.now();
    // Cmd/Ctrl+K opens global search while the InventTasks view is focused
    // (also available as a command + sidebar entry).
    this.registerDomEvent(this.containerEl, "keydown", (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        new SearchModal(this.app, this.plugin).open();
      }
    });
    // Data-driven re-renders preserve scroll position so a task edit
    // somewhere in the workspace doesn't yank the viewport to the top.
    // When the view is hidden (background tab / collapsed split), skip the
    // work and mark dirty — the render runs once on the next reveal instead
    // of on every background index change.
    this.unsubscribe = this.plugin.index.onChange(() => {
      if (!this.isViewVisible()) {
        this.renderDirty = true;
        return;
      }
      if (this.deferRenderWhileNativePickerOpen()) return;
      this.withScrollPreserved(() => this.fullRender());
    });
    const flushDirtyRender = () => {
      if (this.renderDirty && this.isViewVisible()) {
        this.renderDirty = false;
        this.withScrollPreserved(() => this.fullRender());
      }
    };
    this.registerEvent(this.app.workspace.on("active-leaf-change", flushDirtyRender));
    this.registerEvent(this.app.workspace.on("layout-change", flushDirtyRender));
    this.notificationsRefreshTimer = window.setInterval(() => {
      if (!this.isViewVisible()) return;
      if (this.state.location.kind === "notifications") {
        this.syncNotificationAttention();
        // Refresh only the inbox body — fullRender() rebuilds the whole shell and
        // resets .it-main-body scroll, which is jarring on a 30s poll.
        this.refreshContent();
        this.refreshNotificationChrome();
        this.plugin.refreshDockedSidebar();
        this.lastNotificationChromeRefresh = Date.now();
      } else if (Date.now() - this.lastNotificationChromeRefresh >= 60000) {
        this.syncNotificationAttention();
        this.refreshNotificationChrome();
        this.lastNotificationChromeRefresh = Date.now();
      }
    }, 30000);
    this.fullRender();
  }

  async onClose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.notificationsRefreshTimer !== undefined) {
      window.clearInterval(this.notificationsRefreshTimer);
      this.notificationsRefreshTimer = undefined;
    }
    this.disconnectRowObservers();
    this.teardownOverviewGesture();
  }

  setViewType(v: ViewType) {
    this.state.viewType = v;
    // Switching to a task view closes any open Doc.
    this.activeDocId = undefined;
    this.activeDocPageId = undefined;
    // Different view type → different available fields, so drop any current-view
    // overrides (falls back to that type's resolved view_defaults).
    this.state.visibleFields = undefined;
    this.state.calendarColorBy = undefined;
    this.state.dateField = undefined;
    this.state.startField = undefined;
    this.state.cfShowName = undefined;
    this.state.cfShowWhenEmpty = undefined;
    this.state.cfShowTypeIcon = undefined;
    this.state.timelineShowUnscheduled = undefined;
    // Fresh view type → re-center the time grid + reset the calendar scroll.
    (this.state as any).__tgScrollLeft = undefined;
    (this.state as any).__tgScrollTop = undefined;
    (this.state as any).__calScrollTop = undefined;
    (this.state as any).__calScrollLeft = undefined;
    // Remember per-location so "Last selected" default_view restores it next
    // time we come back. Today/Everything/Favorites also persist — they read
    // it back through the same path.
    this.persistFiltersForCurrentLocation();
    this.fullRender();
  }

  selectLocation(loc: ContextLocation, opts: { history?: boolean; reopenTaskId?: string } = {}) {
    // Browser-like nav history: snapshot the current position before moving.
    if (opts.history !== false) this.pushHistory(opts.reopenTaskId);
    this.state.location = loc;
    if (loc.kind === "notifications") this.syncNotificationAttention({ acknowledge: true });
    else if (loc.kind === "reminders") this.acknowledgeReminderNotifications();
    // Leaving any open Doc — docs are scoped to a location.
    this.activeDocId = undefined;
    this.activeDocPageId = undefined;
    // New location → list/table lazy-render extent starts from the top, and
    // table row-selection clears.
    (this.state as any).__listRenderedCount = 0;
    (this.state as any).__tableRenderedCount = 0;
    (this.state as any).__tableSelected = undefined;
    (this.state as any).__tgScrollLeft = undefined;
    (this.state as any).__tgScrollTop = undefined;
    (this.state as any).__calScrollTop = undefined;
    (this.state as any).__calScrollLeft = undefined;
    // Restore the filters (Group/Sort/Show-closed/…) the user last set on
    // this location AND resolve the appropriate view (default_view ⊕
    // last-selected). Falls through silently if none — current state stays as-is.
    this.applyPersistedFiltersForLocation();
    // Board renders columns for any group axis (groupTasks supports status /
    // priority / tags / context / type / due_date / list / custom_field), and
    // falls back to status when groupBy is empty — so we no longer force the
    // axis to status here and the user's chosen grouping is preserved.
    this.sidebarOpenMobile = false;
    this.fullRender();
    this.plugin.refreshDockedSidebar();
  }

  // ---------- Navigation history ----------

  private captureSnapshot(): NavSnapshot {
    return { location: this.state.location, activeDocId: this.activeDocId, activeDocPageId: this.activeDocPageId };
  }

  private sameSnap(a: NavSnapshot, b: NavSnapshot): boolean {
    return locationKey(a.location) === locationKey(b.location)
      && a.activeDocId === b.activeDocId
      && a.activeDocPageId === b.activeDocPageId;
  }

  // Snapshot the CURRENT position onto the back stack (before navigating away).
  // `reopenTaskId` records a task modal that was open at this position.
  private pushHistory(reopenTaskId?: string) {
    const snap = this.captureSnapshot();
    snap.reopenTaskId = reopenTaskId;
    const top = this.navBack[this.navBack.length - 1];
    if (!(top && this.sameSnap(top, snap) && !reopenTaskId)) {
      this.navBack.push(snap);
      if (this.navBack.length > 50) this.navBack.shift();
    }
    this.navFwd = [];
  }

  goBack() {
    if (!this.navBack.length) return;
    this.navFwd.push(this.captureSnapshot());
    this.restoreSnapshot(this.navBack.pop()!);
  }

  goForward() {
    if (!this.navFwd.length) return;
    this.navBack.push(this.captureSnapshot());
    this.restoreSnapshot(this.navFwd.pop()!);
  }

  private restoreSnapshot(snap: NavSnapshot) {
    // Reuse the normal location flow (filters/default resolution) without
    // touching history, then overlay the exact doc/page that was open.
    this.selectLocation(snap.location, { history: false });
    this.activeDocId = snap.activeDocId;
    this.activeDocPageId = snap.activeDocPageId;
    this.refreshContent();
    if (snap.reopenTaskId) {
      const tf = this.plugin.index.tasksById.get(snap.reopenTaskId);
      if (tf) new TaskModal(this.app, this.plugin, tf).open();
    }
  }

  // Public toggle used by the keyboard-shortcut manager.
  toggleShowClosed() {
    this.state.showClosed = !this.state.showClosed;
    this.persistFiltersForCurrentLocation();
    this.fullRender();
  }

  quickCreateTask(extra: { preset?: any } = {}) {
    const loc = this.state.location;
    const opts: any = { preset: extra.preset };
    if (loc.kind === "list") opts.listPath = loc.path;
    else if (loc.kind === "folder") opts.scopeFolderPath = loc.path;
    else if (loc.kind === "space") opts.scopeSpacePath = loc.path;
    new QuickTaskModal(this.app, this.plugin, opts).open();
  }

  currentListPath(): string | null {
    if (this.state.location.kind === "list") return this.state.location.path;
    return null;
  }

  notificationNeedsAttention(): boolean {
    return this.notificationsAttention;
  }

  remindersNeedAttention(): boolean {
    return this.remindersAttention;
  }

  reminderNotificationSeverity(): "danger" | "warning" | "info" | "none" {
    return this.remindersSeverity;
  }

  private syncNotificationAttention(opts: { acknowledge?: boolean } = {}) {
    const overview = notificationOverview(this.plugin);
    const shouldSignal = overview.severity === "danger" || overview.severity === "warning";
    const shouldSignalReminder = overview.reminderSeverity === "danger" || overview.reminderSeverity === "warning";
    this.remindersSeverity = overview.reminderSeverity;
    if (opts.acknowledge) {
      this.notificationsSeenActiveSignature = overview.activeSignature;
      this.remindersSeenActiveSignature = overview.reminderActiveSignature;
      this.notificationsAttention = false;
      this.remindersAttention = false;
      return overview;
    }
    if (!overview.activeSignature || !shouldSignal) {
      this.notificationsAttention = false;
      this.remindersAttention = false;
      if (!overview.activeSignature) this.notificationsSeenActiveSignature = "";
      if (!overview.reminderActiveSignature) this.remindersSeenActiveSignature = "";
      return overview;
    }
    if (overview.activeSignature !== this.notificationsSeenActiveSignature) {
      this.notificationsAttention = true;
    }
    this.remindersAttention = !!overview.reminderActiveSignature
      && shouldSignalReminder
      && overview.reminderActiveSignature !== this.remindersSeenActiveSignature;
    return overview;
  }

  private acknowledgeReminderNotifications() {
    const overview = notificationOverview(this.plugin);
    this.remindersSeenActiveSignature = overview.reminderActiveSignature;
    this.remindersSeverity = overview.reminderSeverity;
    this.remindersAttention = false;
  }

  private renderEmbeddedSidebar(sidebar: HTMLElement) {
    renderSidebar(sidebar, {
      plugin: this.plugin,
      current: this.state.location,
      onSelect: (loc) => this.selectLocation(loc),
      onOpenView: (v) => this.openSavedView(v),
      onOpenTask: (id) => this.openFavorite(id),
      collapsedSet: this.sidebarCollapsed,
      notificationsAttention: this.notificationsAttention,
      remindersAttention: this.remindersAttention,
      remindersSeverity: this.remindersSeverity,
    });
  }

  private refreshNotificationChrome() {
    const sidebar = this.contentEl.querySelector(".it-sidebar-wrap") as HTMLElement | null;
    if (sidebar) {
      const prevScroll = sidebar.scrollTop;
      sidebar.empty();
      this.renderEmbeddedSidebar(sidebar);
      sidebar.scrollTop = prevScroll;
      requestAnimationFrame(() => { sidebar.scrollTop = prevScroll; });
    }
    this.plugin.refreshDockedSidebar();
  }

  /** After a manual sync: refresh attention badges and any live inbox views. */
  refreshAfterSync(): void {
    this.syncNotificationAttention();
    const loc = this.state.location.kind;
    if (loc === "notifications" || loc === "reminders" || loc === "short_notes") {
      this.refreshContent();
    }
    this.refreshNotificationChrome();
  }

  fullRender() {
    // Obsidian (and the webapp shim) can restore/mount this view before the
    // plugin's layout-ready callback finishes its first index scan. Until that
    // explicit boundary is crossed, an empty index means "not loaded", not
    // "there are no workspaces/spaces".
    if (!this.plugin.isInitialLoadComplete) {
      this.disconnectRowObservers();
      this.renderInitialLoadingState();
      return;
    }
    // ZERO workspaces: the task manager is off (Vault sync may still run in
    // the background). Show a welcome/empty state instead of the app shell.
    if (!this.plugin.hasWorkspaces) {
      this.disconnectRowObservers();
      this.renderNoWorkspaceState();
      return;
    }
    this.syncNotificationAttention();
    const container = this.contentEl;
    // Tear down the previous render's row-compaction observers — renderTopbar /
    // renderViewsBar below register fresh ones on the rebuilt elements.
    this.disconnectRowObservers();
    // The explorer (sidebar) is rebuilt on every fullRender — preserve its
    // scroll so clicking a list/space deep in the tree doesn't jump to the top.
    const prevSidebarScroll = (container.querySelector(".it-sidebar-wrap") as HTMLElement | null)?.scrollTop ?? 0;
    container.empty();
    container.addClass("inventtasks-content");

    const sidebarDocked = this.plugin.prefs.sidebarPlacement !== "embedded";
    const layout = container.createDiv({ cls: "it-layout" });
    if (Platform.isMobile) layout.addClass("is-mobile");
    if (this.sidebarOpenMobile) layout.addClass("sidebar-open");
    if (sidebarDocked) layout.addClass("sidebar-docked");

    // Embedded sidebar (only when not docked in an Obsidian side panel)
    if (!sidebarDocked) {
      const sidebar = layout.createDiv({ cls: "it-sidebar-wrap" });
      this.renderEmbeddedSidebar(sidebar);
      if (prevSidebarScroll > 0) {
        sidebar.scrollTop = prevSidebarScroll;
        requestAnimationFrame(() => { sidebar.scrollTop = prevSidebarScroll; });
      }
    }

    // Main area
    const main = layout.createDiv({ cls: "it-main" });
    this.renderTopbar(main);
    this.renderViewsBar(main);
    const body = main.createDiv({ cls: "it-main-body" });
    // Bottom clearance for Obsidian's mobile navbar / OS gesture bar is handled
    // in CSS (`.is-mobile .it-main-body` → --it-mobile-safe-bottom), which also
    // accounts for safe-area insets. Avoid an inline style here so it can't win
    // over the computed value.
    this.renderContent(body);

    // Bottom favorites bar — narrow quick-access strip, toggleable. Sits below
    // the body as the last child of .it-main so it pins to the bottom.
    this.renderFavoritesBar(main);

    // Mobile: hide the topbar + views bar while scrolling down so the content
    // gets the full screen height; reveal them on scroll up.
    if (Platform.isMobile) this.setupChromeAutohide(main);

    // Mobile overlay
    if (!sidebarDocked && Platform.isMobile && this.sidebarOpenMobile) {
      const overlay = layout.createDiv({ cls: "it-mobile-overlay" });
      overlay.addEventListener("click", () => { this.sidebarOpenMobile = false; this.fullRender(); });
    }
  }

  // Bottom favorites bar — a narrow, horizontally-scrolling strip of favorite
  // chips pinned to the bottom of the main window. Toggleable (prefs +
  // command + the × on the bar) and only shown when there are favorites.
  private renderFavoritesBar(main: HTMLElement) {
    if (!this.plugin.prefs.favoritesBarVisible) return;
    // The bar shows its OWN bucket ("bar") — independent of the left sidebar and
    // right panel buckets.
    const favs = resolveFavorites(this.plugin, "bar");
    if (favs.length === 0) return;
    // Tells the layout the bar is present (mobile drops the body's navbar
    // reservation since the bar now provides that clearance).
    main.addClass("has-fav-bar");

    const bar = main.createDiv({ cls: "it-favorites-bar" });
    const label = bar.createDiv({ cls: "it-favorites-bar-label" });
    label.setAttribute("title", favLocationLabel("bar"));
    const labelIcon = label.createSpan({ cls: "it-favorites-bar-star", attr: { title: favLocationLabel("bar") } });
    setIcon(labelIcon, FAV_LOCATION_META.bar.icon);
    labelIcon.style.color = FAV_LOCATION_META.bar.color;

    const chips = bar.createDiv({ cls: "it-favorites-bar-chips" });
    const chipEls: HTMLElement[] = [];
    favs.forEach((fav, idx) => {
      const chip = renderFavoriteChip(chips, fav, {
        active: favoriteIsActive(fav, this.state.location),
        onOpen: () => this.openFavorite(fav.path),
        onMenu: (e) => this.showFavoriteChipMenu(e, fav.path, idx, favs.length),
      });
      chipEls.push(chip);
    });

    const overflowBtn = bar.createEl("button", {
      cls: "it-icon-btn it-icon-btn-mini it-favorites-bar-overflow",
      attr: { "aria-label": t("common.more"), title: t("common.more") },
    });
    setIcon(overflowBtn, "ellipsis");
    let hiddenFavs: typeof favs = [];
    overflowBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (hiddenFavs.length === 0) return;
      this.showFavoriteOverflowMenu(overflowBtn, hiddenFavs, favs);
    });

    const hide = bar.createEl("button", { cls: "it-icon-btn it-icon-btn-mini it-favorites-bar-hide", attr: { "aria-label": t("favorites.hideBar"), title: t("favorites.hideBar") } });
    setIcon(hide, "x");
    hide.addEventListener("click", () => void this.plugin.setFavoritesBarVisible(false));

    const applyOverflow = () => {
      chipEls.forEach((chip) => chip.removeClass("is-overflow-hidden"));
      overflowBtn.removeClass("is-visible");
      hiddenFavs = [];
      const fits = () => chips.scrollWidth <= chips.clientWidth + 1;
      if (fits()) return;
      overflowBtn.addClass("is-visible");
      for (let i = chipEls.length - 1; i >= 0 && !fits(); i--) {
        chipEls[i].addClass("is-overflow-hidden");
      }
      hiddenFavs = favs.filter((_, i) => chipEls[i].hasClass("is-overflow-hidden"));
      if (hiddenFavs.length === 0) overflowBtn.removeClass("is-visible");
    };
    requestAnimationFrame(applyOverflow);
    const ro = new ResizeObserver(() => applyOverflow());
    ro.observe(bar);
    ro.observe(chips);
    this.rowROs.push(ro);
  }

  private showFavoriteOverflowMenu(anchor: HTMLElement, hiddenFavs: ReturnType<typeof resolveFavorites>, allFavs: ReturnType<typeof resolveFavorites>) {
    showPopover(anchor, (root) => {
      const menu = root.createDiv({ cls: "it-popover-menu it-favorites-overflow-menu" });
      for (const fav of hiddenFavs) {
        const idx = allFavs.findIndex((x) => x.path === fav.path);
        const row = menu.createEl("button", { cls: "it-popover-item it-favorites-overflow-item", attr: { title: fav.name } });
        const icon = renderIconish(row, fav.icon, { cls: "it-favorites-overflow-icon" });
        if (icon) icon.style.color = fav.color;
        row.createSpan({ cls: "it-favorites-overflow-name", text: fav.name });
        row.addEventListener("click", (e) => {
          e.preventDefault();
          document.querySelectorAll(".it-popover").forEach((el) => el.remove());
          this.openFavorite(fav.path);
        });
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.showFavoriteChipMenu(e, fav.path, Math.max(0, idx), allFavs.length);
        });
      }
    });
  }

  // Bottom-bar chip menu: reorder within the bar (left/right), relocate to the
  // other surfaces, and remove. (Reorder is here rather than as hover arrows
  // because the bar is horizontal + scrolls; menu works on mobile too.)
  private showFavoriteChipMenu(e: MouseEvent, path: string, index: number, total: number) {
    const items: any[] = [];
    if (index > 0) items.push({ label: t("action.moveLeft"), icon: "arrow-left", onClick: () => void this.plugin.index.moveFavorite(path, "bar", -1) });
    if (index < total - 1) items.push({ label: t("action.moveRight"), icon: "arrow-right", onClick: () => void this.plugin.index.moveFavorite(path, "bar", 1) });
    if (items.length) items.push("separator");
    items.push(...favoriteRelocateItems(this.plugin, path, "bar"));
    showContextMenu(e, items);
  }

  private renderTopbar(parent: HTMLElement) {
    const top = parent.createDiv({ cls: "it-topbar" });

    // Mobile sidebar toggle (only when embedded)
    if (Platform.isMobile && this.plugin.prefs.sidebarPlacement === "embedded") {
      const tog = top.createEl("button", { cls: "it-icon-btn", attr: { "aria-label": t("toolbar.toggleSidebar") } });
      setIcon(tog, "menu");
      tog.addEventListener("click", () => { this.sidebarOpenMobile = !this.sidebarOpenMobile; this.fullRender(); });
    }

    // Back / Forward — browser-like history across all navigation (lists, docs,
    // links from tasks). Disabled when there's nowhere to go.
    const nav = top.createDiv({ cls: "it-topbar-nav" });
    const back = nav.createEl("button", { cls: "it-icon-btn", attr: { title: t("toolbar.back"), "aria-label": t("toolbar.back") } });
    setIcon(back, "arrow-left");
    back.disabled = this.navBack.length === 0;
    back.addEventListener("click", () => this.goBack());
    const fwd = nav.createEl("button", { cls: "it-icon-btn", attr: { title: t("toolbar.forward"), "aria-label": t("toolbar.forward") } });
    setIcon(fwd, "arrow-right");
    fwd.disabled = this.navFwd.length === 0;
    fwd.addEventListener("click", () => this.goForward());

    // Breadcrumb — icon (renderIconish so Lucide names render as SVG, not text) + name
    const bc = top.createDiv({ cls: "it-topbar-breadcrumb" });
    const loc = this.state.location;
    const addCrumb = (icon: string, name: string, color?: string) => {
      const iconEl = renderIconish(bc, icon, { cls: "it-breadcrumb-icon" });
      if (iconEl && color) iconEl.style.color = color;
      bc.createSpan({ text: " " + name });
    };
    if (loc.kind === "everything") addCrumb("layers", navLabel("everything"));
    else if (loc.kind === "archived") addCrumb("archive", navLabel("archived"));
    else if (loc.kind === "notifications") addCrumb("bell", navLabel("notifications"));
    else if (loc.kind === "reminders") addCrumb("alarm-clock", navLabel("reminders"));
    else if (loc.kind === "short_notes") addCrumb("sticky-note", navLabel("shortNotes"));
    else if (loc.kind === "today") addCrumb("calendar-check", navLabel("today"));
    else if (loc.kind === "favorites") addCrumb(FAV_LOCATION_META.left.icon, favLocationLabel("left"), FAV_LOCATION_META.left.color);
    else if (loc.kind === "recents") addCrumb("history", navLabel("recents"));
    else if (loc.kind === "space") {
      const s = this.plugin.index.findSpace(loc.path);
      addCrumb(s?.config.icon || "🏷️", s?.config.name || hierarchyLabel("space"), s?.config.color);
    } else if (loc.kind === "folder") {
      const f = this.plugin.index.findFolder(loc.path);
      addCrumb(f?.config.icon || "📁", f?.config.name || hierarchyLabel("folder"), f?.config.color);
    } else if (loc.kind === "list") {
      const l = this.plugin.index.findList(loc.path);
      addCrumb(l?.config.icon || "📋", l?.config.name || hierarchyLabel("list"), l?.config.color);
    } else if (loc.kind === "doc") {
      const d = this.plugin.index.docByPath(loc.path);
      addCrumb(d?.icon || DOC_ICON, d?.name || hierarchyLabel("doc"), d?.color || DOC_ACCENT);
    }

    // Workspace-wide visibility lock. The same button is available in the task
    // modal's custom-fields header; keeping it in the app chrome makes it
    // possible to lock secrets immediately without opening an item first.
    if (this.plugin.index.resolveCustomFieldsForLocation(loc).some((field) => isSecretCustomFieldType(field.type))) {
      const unlocked = this.plugin.isSecretWorkspaceUnlocked();
      const secretBtn = top.createEl("button", {
        cls: "it-icon-btn it-secret-topbar-btn" + (unlocked ? " is-unlocked" : ""),
        attr: {
          title: t(unlocked ? "secret.lockWorkspace" : "secret.unlockWorkspace"),
          "aria-label": t(unlocked ? "secret.lockWorkspace" : "secret.unlockWorkspace"),
        },
      });
      setIcon(secretBtn, unlocked ? "lock-keyhole" : "key-round");
      secretBtn.addEventListener("click", () => {
        if (this.plugin.isSecretWorkspaceUnlocked()) this.plugin.lockSecretWorkspace();
        else void this.plugin.unlockSecretWorkspace();
      });
    }

    // A Doc location has no task-view switcher / group-sort-filter controls — its
    // own toolbar (explorer toggle, breadcrumb, Edit) lives in the Doc view body.
    if (loc.kind === "doc" || loc.kind === "notifications" || loc.kind === "reminders" || loc.kind === "short_notes") return;

    // View switcher — a single compact dropdown (the 6 view types as a row of
    // tabs took too much width). Shows the current view (colored icon + name),
    // and opens a picker on click.
    const tabs = top.createDiv({ cls: "it-view-tabs" });
    const viewColors = resolveViewColorSet(this.plugin.prefs.viewColorScheme, this.plugin.prefs.viewColors);
    const tabsDef: Array<{ id: ViewType; label: string; icon: string; color: string }> = [
      { id: "list", label: viewLabel("list"), icon: "list", color: viewColors[0] },
      { id: "board", label: viewLabel("board"), icon: "trello", color: viewColors[1] },
      { id: "calendar", label: viewLabel("calendar"), icon: "calendar", color: viewColors[2] },
      { id: "table", label: viewLabel("table"), icon: "table", color: viewColors[3] },
      { id: "gantt", label: viewLabel("gantt"), icon: "bar-chart-horizontal-big", color: viewColors[4] },
      { id: "timeline", label: viewLabel("timeline"), icon: "git-commit-horizontal", color: viewColors[5] },
    ];
    const current = tabsDef.find((t) => t.id === this.state.viewType) || tabsDef[0];
    const trigger = tabs.createEl("button", { cls: "it-view-tab-trigger", attr: { "aria-label": `View: ${current.label}`, title: t("toolbar.switchView") } });
    trigger.style.setProperty("--chip-color", current.color);
    const triggerIc = trigger.createSpan({ cls: "it-view-tab-icon" });
    setIcon(triggerIc, current.icon);
    triggerIc.style.color = current.color;
    trigger.createSpan({ cls: "it-view-tab-name", text: current.label });
    setIcon(trigger.createSpan({ cls: "it-view-tab-caret" }), "chevron-down");
    trigger.addEventListener("click", (e) => {
      showPopover(e.currentTarget as HTMLElement, (root) => {
        const menu = root.createDiv({ cls: "it-popover-menu" });
        for (const t of tabsDef) {
          const row = menu.createEl("button", { cls: "it-popover-item" + (this.state.viewType === t.id ? " is-active" : "") });
          const ic = row.createSpan({ cls: "it-view-pick-icon" });
          setIcon(ic, t.icon);
          ic.style.color = t.color;
          row.createSpan({ text: t.label });
          row.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            document.querySelectorAll(".it-popover").forEach((el) => el.remove());
            if (t.id !== this.state.viewType) this.setViewType(t.id);
          });
        }
      });
    });

    // Spacer
    top.createDiv({ cls: "it-flex-grow" });

    // Controls
    const ctl = top.createDiv({ cls: "it-topbar-controls" });

    // Discreet sync indicator (only when sync is active for this workspace
    // and/or Vault Sync is on). Click = sync now (both scopes). State is
    // driven by refreshSyncIndicator().
    const syncInd = ctl.createSpan({ cls: "it-sync-indicator it-icon-btn" });
    syncInd.addEventListener("click", () => {
      // Surface the status as a Notice too — the tooltip is invisible on mobile.
      const info = this.syncStatusSummary();
      if (info) new Notice(info.title, info.state === "error" ? 8000 : 4000);
      void this.plugin.syncManager?.syncNow(this.plugin.prefs.id);
      void this.plugin.vaultSyncManager?.syncNow();
    });
    this.refreshSyncIndicator();

    // Search — pill field with a leading glyph, consistent with the chips.
    const searchWrap = ctl.createDiv({ cls: "it-search-wrap" });
    setIcon(searchWrap.createSpan({ cls: "it-search-ic" }), "search");
    const search = searchWrap.createEl("input", { type: "text", cls: "it-search" });
    search.placeholder = t("toolbar.search");
    search.value = this.state.search;
    let st: number | null = null;
    search.addEventListener("input", () => {
      if (st !== null) window.clearTimeout(st);
      st = window.setTimeout(() => {
        if (this.state.search === search.value) return;
        this.state.search = search.value;
        // A new query means different content, so the remembered scroll offset
        // describes a list that no longer exists. On a phone it is worse than
        // useless: opening the soft keyboard scrolls the focused field into
        // view, that offset gets remembered, and re-applying it after every
        // keystroke parks the fresh results outside the visible area — the list
        // looks empty until the keyboard is dismissed, which is exactly what it
        // was reported as. Results start at the top, where they were typed for.
        const st2 = this.state as any;
        st2.__listScrollTop = 0;
        st2.__tableScrollTop = 0;
        st2.__listRenderedCount = 0;
        st2.__tableRenderedCount = 0;
        const body = this.contentEl.querySelector(".it-main-body") as HTMLElement | null;
        if (body) body.scrollTop = 0;
        this.refreshContent();
      }, 200);
    });

    // Group / Sort buttons — irrelevant for Calendar (where tasks are placed by date),
    // so they're hidden in that view. List/Board/Table all keep them.
    if (this.state.viewType !== "calendar") {
      const customFields = this.plugin.index.resolveCustomFieldsForLocation(this.state.location);
      const labelForField = (key: string): string => {
        if (!key) return "—";
        if (key.startsWith("custom_field:")) {
          const id = key.slice(13);
          const f = customFields.find((x) => x.id === id);
          return f?.name || id;
        }
        return this.fieldLabel(key);
      };
      // Group / Sort labels are split into a prefix word ("Group:") and the
      // value ("Status ↑"). When the topbar is compact the prefix is hidden but
      // the value (what we group/sort by) stays. (.it-ctl-value is the marker.)
      const groupArrow = this.state.groupBy ? (this.state.groupDirection === "asc" ? " ↑" : " ↓") : "";
      const groupBtn = ctl.createEl("button", { cls: "it-secondary-btn", attr: { title: t("toolbar.groupBy") } });
      setIcon(groupBtn.createSpan({ cls: "it-btn-ic" }), "group");
      const swimSuffix = (this.state.viewType === "board" && this.state.subGroupBy)
        ? ` ⤲ ${labelForField(this.state.subGroupBy)}` : "";
      groupBtn.createSpan({ text: t("toolbar.groupColon") });
      groupBtn.createSpan({ cls: "it-ctl-value", text: `${labelForField(this.state.groupBy)}${groupArrow}${swimSuffix}` });
      groupBtn.addEventListener("click", (e) => this.showGroupMenu(e));
      const sortRule = this.state.sortBy[0];
      const sortArrow = sortRule ? (sortRule.direction === "asc" ? " ↑" : " ↓") : "";
      const sortBtn = ctl.createEl("button", { cls: "it-secondary-btn", attr: { title: t("toolbar.sortBy") } });
      setIcon(sortBtn.createSpan({ cls: "it-btn-ic" }), "arrow-up-down");
      sortBtn.createSpan({ text: t("toolbar.sortColon") });
      sortBtn.createSpan({ cls: "it-ctl-value", text: `${labelForField(sortRule?.field || "")}${sortArrow}` });
      sortBtn.addEventListener("click", (e) => this.showSortMenu(e));
    }
    // Filter builder — available in every view (filters apply in collectTasks
    // regardless of view type). Badge shows the active condition count.
    const condCount = this.state.filters?.conditions?.filter((c) => (c as any).field).length ?? 0;
    const filterLabel = condCount > 0 ? t("toolbar.filterActive", { count: condCount }) : t("toolbar.filter");
    const filterBtn = ctl.createEl("button", { cls: "it-secondary-btn" + (condCount > 0 ? " is-active" : ""), attr: { title: filterLabel } });
    setIcon(filterBtn.createSpan({ cls: "it-btn-ic" }), "filter");
    filterBtn.createSpan({ text: filterLabel });
    filterBtn.addEventListener("click", () => this.openFilterModal());

    if (this.state.location.kind !== "archived") {
      const closedLabel = this.state.showClosed ? t("toolbar.hideClosed") : t("toolbar.showClosed");
      const showClosedBtn = ctl.createEl("button", { cls: "it-secondary-btn" + (this.state.showClosed ? " is-active" : ""), attr: { title: closedLabel } });
      setIcon(showClosedBtn.createSpan({ cls: "it-btn-ic" }), this.state.showClosed ? "eye-off" : "eye");
      showClosedBtn.createSpan({ text: closedLabel });
      showClosedBtn.addEventListener("click", () => {
        this.state.showClosed = !this.state.showClosed;
        this.persistFiltersForCurrentLocation();
        this.fullRender();
      });
    }

    // Subtasks — how subtasks are presented (parents only / nested / flat).
    // Available in every view; the non-active modes are marked is-active when
    // anything other than the default ("nested") is chosen.
    // No is-active glow: this is a 3-way selector (like Group/Sort), not an
    // on/off toggle — the chosen mode is shown in the label, and highlighting
    // only some values reads as a bug.
    const subMode = getSubtaskModes().find((m) => m.value === this.state.subtaskMode);
    // Show just the selected option (icon + label) — the "Subtasks:" prefix took
    // too much room. The tooltip keeps the meaning discoverable.
    const subBtn = ctl.createEl("button", { cls: "it-secondary-btn", attr: { title: t("toolbar.subtasksDisplay") } });
    setIcon(subBtn.createSpan({ cls: "it-btn-ic" }), subMode?.icon || "list-tree");
    subBtn.createSpan({ text: subMode?.label || "Nested" });
    subBtn.addEventListener("click", (e) => this.showSubtaskMenu(e));

    // New task
    const newTaskBtn = ctl.createEl("button", { cls: "it-btn-primary it-new-task-btn", text: t("list.addTask") });
    newTaskBtn.addEventListener("click", () => this.quickCreateTask());

    // Collapse control labels to icons when the row can't fit them (the value
    // of Group/Sort is preserved). Driven by actual width, not a breakpoint.
    this.observeRowCompaction(top);
  }

  // Active row-compaction observers (topbar + views bar). Re-created each
  // fullRender, so they're all torn down up front (see fullRender / onClose).
  private rowROs: ResizeObserver[] = [];
  private disconnectRowObservers() {
    for (const ro of this.rowROs) ro.disconnect();
    this.rowROs = [];
  }

  // Toggles `.is-compact` on a wrapping toolbar row when its content can't fit
  // on one line, so labels can collapse to icons. The trigger is the element's
  // own width (= the content area), NOT a CSS @media breakpoint — Obsidian's
  // viewport width includes its side panels and the pane split, so a media
  // query mis-fires. These rows use `flex-wrap: wrap` and never report
  // horizontal overflow (they wrap), so we measure the natural one-line width of
  // the children and compare it to the available width.
  private observeRowCompaction(el: HTMLElement) {
    // Measured once, with full labels visible (the row is freshly built and not
    // yet compact), then just compared on resize — so toggling the class can't
    // feed back into the measurement and oscillate.
    let needed = 0;
    const measure = (): number => {
      // A child group that can wrap internally (the controls) would report a
      // shrunken scrollWidth if it's already wrapped — force it to one line for
      // the measurement so `needed` is the true natural one-line width.
      const wrappers = Array.from(el.querySelectorAll(".it-topbar-controls")) as HTMLElement[];
      for (const w of wrappers) w.addClass("it-measure-nowrap");
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const kids = Array.from(el.children) as HTMLElement[];
      let sum = gap * Math.max(0, kids.length - 1);
      for (const k of kids) {
        if (k.classList.contains("it-flex-grow")) continue; // the elastic spacer
        sum += k.scrollWidth; // natural content width (ignores visual shrink/wrap)
      }
      wrappers.forEach((w) => w.removeClass("it-measure-nowrap"));
      return sum;
    };
    // Buffer (~one button's worth) so we compact a touch BEFORE the exact wrap
    // point — otherwise there's a ~few-dozen-px band where full-label items have
    // already wrapped to a second line before the threshold trips.
    const WRAP_BUFFER = 48;
    const apply = () => {
      // clientWidth INCLUDES horizontal padding, but children live inside it —
      // compare against the actual content width or compaction fires too late.
      const cs = getComputedStyle(el);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const avail = el.clientWidth - padX;
      el.classList.toggle("is-compact", needed + WRAP_BUFFER > avail);
    };
    requestAnimationFrame(() => { needed = measure(); apply(); });
    const ro = new ResizeObserver(() => apply());
    ro.observe(el);
    this.rowROs.push(ro);
  }

  // Mobile only: auto-hide the topbar + views bar on scroll-down to maximise the
  // content area, and reveal them on scroll-up. The header is collapsed by a
  // negative margin-top on the topbar (set in CSS) equal to the live header
  // height we publish here as --it-chrome-h; main-body (flex:1) then grows from
  // the top. We listen in the capture phase on .it-main so it also catches the
  // views with their OWN inner scrollers (board column, calendar, table, gantt)
  // — not just the list view, whose content scrolls .it-main-body directly.
  private setupChromeAutohide(main: HTMLElement) {
    const topbar = main.querySelector(".it-topbar") as HTMLElement | null;
    if (!topbar) return;
    const viewsBar = main.querySelector(".it-views-bar") as HTMLElement | null;

    let chromeH = 0;
    const setChromeHeight = () => {
      chromeH = topbar.offsetHeight + (viewsBar?.offsetHeight ?? 0);
      main.style.setProperty("--it-chrome-h", `${chromeH}px`);
    };
    setChromeHeight();
    // Keep the collapse distance correct as the header reflows (compact toggle,
    // controls wrapping, rotation). offsetHeight ignores the negative margin, so
    // remeasuring while hidden stays stable (no feedback loop).
    const ro = new ResizeObserver(() => setChromeHeight());
    ro.observe(topbar);
    if (viewsBar) ro.observe(viewsBar);
    this.rowROs.push(ro);

    const TOP_ZONE = 48;   // always show when near the top of the active scroller
    const DELTA = 4;       // ignore sub-pixel / momentum jitter
    const BUFFER = 24;     // require this much spare scroll room beyond the header
    // Hysteresis: a quick fling rubber-bands (down→up→down within a few frames),
    // which a naive "any dy>0 hides / any dy<0 shows" toggles on, so the chrome
    // flickers. We anchor a `pivot` at each direction reversal and only toggle
    // once travel past that pivot exceeds a slop.
    const HIDE_SLOP = 32;  // sustained downward travel past the pivot before hiding
    const SHOW_SLOP = 24;  // sustained upward travel past the pivot before showing
    // Toggling the chrome changes the header height, which resizes the scroller
    // and can clamp scrollTop — producing a phantom delta in the OPPOSITE
    // direction one frame later. That's the "hides then snaps back" flicker. So
    // after ANY toggle we enter a short settle window: keep the baseline fresh
    // but refuse to toggle again, absorbing the layout-shift rebound either way.
    const SETTLE_MS = 320;
    let settleUntil = 0;
    // Track baseline / pivot / direction PER element. Gantt/Timeline mirror their
    // scroll to a second (hidden) rail scroller, so scroll events alternate
    // between two elements — a single shared baseline would rebase on every
    // alternation and never detect a direction there.
    const lastY = new WeakMap<Element, number>();
    const pivotY = new WeakMap<Element, number>();
    const dirOf = new WeakMap<Element, number>();
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (!el || el.nodeType !== 1 || !main.contains(el)) return;
      const maxScroll = el.scrollHeight - el.clientHeight;
      if (maxScroll <= DELTA) return; // not a vertical scroller (e.g. board's horizontal rail)
      const isOverview = this.state.viewType === "calendar" && this.state.calendarPeriod === "monthCompact";
      const y = el.scrollTop;
      const prev = lastY.get(el);
      if (prev === undefined) { lastY.set(el, y); pivotY.set(el, y); dirOf.set(el, 0); return; }
      const dy = y - prev;
      const now = Date.now();

      if (y <= TOP_ZONE) {
        // Non-overview: at the top always reveal. Overview: stay collapsed on
        // entry (it auto-hides on purpose) — only an explicit upward scroll
        // reveals; the pull-down gesture handles the rest.
        if (!isOverview) {
          if (main.hasClass("it-chrome-hidden")) { main.removeClass("it-chrome-hidden"); settleUntil = now + SETTLE_MS; }
        } else if (dy < -DELTA && main.hasClass("it-chrome-hidden")) {
          main.removeClass("it-chrome-hidden");
          this.overviewChromeRevealed = true;
          settleUntil = now + SETTLE_MS;
        }
        lastY.set(el, y); pivotY.set(el, y); dirOf.set(el, dy < 0 ? -1 : 1);
        return;
      }

      // Inside the settle window: track position so the next real move measures
      // from here, but don't toggle (this is where the rebound would fire).
      if (now < settleUntil) { lastY.set(el, y); pivotY.set(el, y); dirOf.set(el, dy > 0 ? 1 : -1); return; }

      if (Math.abs(dy) < DELTA) return;  // sub-threshold: let small moves accumulate
      const dir = dy > 0 ? 1 : -1;
      if (dir !== (dirOf.get(el) ?? 0)) { dirOf.set(el, dir); pivotY.set(el, prev); } // reversal → new pivot
      const pivot = pivotY.get(el) ?? y;

      if (dir > 0) {
        // Hide only after sustained downward travel, with spare room below so
        // collapsing the header (which grows the scroller) can't clamp scrollTop.
        if (!main.hasClass("it-chrome-hidden") && (y - pivot) > HIDE_SLOP && (maxScroll - y > chromeH + BUFFER)) {
          main.addClass("it-chrome-hidden");
          if (isOverview) this.overviewChromeRevealed = false;
          settleUntil = now + SETTLE_MS;
          lastY.set(el, y); pivotY.set(el, y);
          return;
        }
      } else if (main.hasClass("it-chrome-hidden") && (pivot - y) > SHOW_SLOP) {
        main.removeClass("it-chrome-hidden");
        if (isOverview) this.overviewChromeRevealed = true;
        settleUntil = now + SETTLE_MS;
        lastY.set(el, y); pivotY.set(el, y);
        return;
      }
      lastY.set(el, y);
    };
    // Capture phase: scroll doesn't bubble, but a capturing ancestor listener
    // still receives scrolls from descendant scrollers (the list view scrolls
    // .it-main-body; board/calendar/table/gantt scroll their own inner element).
    // Bound to .it-main, so popovers/menus/modals (on document.body) never fire it.
    main.addEventListener("scroll", onScroll, true);
  }

  // Directly collapse/reveal the mobile chrome (topbar + views bar). Used to
  // auto-hide it for the compact calendar "Overview" so the month gets the full
  // screen on entry (and to reveal it again when switching to another period).
  // The scroll-driven autohide above still applies afterwards. --it-chrome-h is
  // published by setupChromeAutohide (runs in the same fullRender), so the
  // collapse distance is correct by first paint.
  private setChromeHidden(hidden: boolean) {
    const main = this.contentEl.querySelector(".it-main") as HTMLElement | null;
    if (!main) return;
    if (hidden) main.addClass("it-chrome-hidden");
    else main.removeClass("it-chrome-hidden");
  }

  private teardownOverviewGesture() {
    this.overviewGestureAbort?.abort();
    this.overviewGestureAbort = undefined;
  }

  // Mobile Calendar "Overview": pull-down at the top reveals the collapsed chrome
  // (filters / Save view / Customize / …). The tricky part is that Obsidian's own
  // mobile pull-down menu also reacts to a downward overscroll at the top. We win
  // by listening on `window` in the CAPTURE phase — the very first stop in the
  // event flow — and, once the gesture is unmistakably ours (touch began inside
  // the overview grid while it was scrolled to the top, finger moving down), we
  // swallow the touchmove (preventDefault + stopImmediatePropagation) so Obsidian
  // never sees it. Only active while the chrome is hidden; once revealed we step
  // aside so normal scrolling/taps work. Torn down whenever the view re-renders.
  private setupOverviewGesture() {
    this.teardownOverviewGesture();
    const main = this.contentEl.querySelector(".it-main") as HTMLElement | null;
    const scroll = this.contentEl.querySelector(".it-cal-scroll.is-compact-scroll") as HTMLElement | null;
    if (!main || !scroll) return;

    const ac = new AbortController();
    this.overviewGestureAbort = ac;
    const { signal } = ac;

    const REVEAL_AT = 18; // px of downward pull before the chrome slides in
    let startY = 0;
    let startX = 0;
    let tracking = false;
    let revealed = false;

    const onStart = (e: TouchEvent) => {
      tracking = false; revealed = false;
      if (e.touches.length !== 1) return;
      const t = e.target as Node | null;
      if (!t || !scroll.contains(t)) return;          // gesture must start in the grid
      if (scroll.scrollTop > 0) return;               // only when already at the top
      if (!main.classList.contains("it-chrome-hidden")) return; // chrome already up → nothing to do
      tracking = true;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;
      if (dy <= 0 || Math.abs(dx) > dy) return;       // not a downward, vertical pull
      if (scroll.scrollTop > 0) { tracking = false; return; }
      // Committed: this is our reveal gesture — block the native overscroll AND
      // Obsidian's pull-down menu by stopping the event before it propagates.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!revealed && dy >= REVEAL_AT) {
        revealed = true;
        this.overviewChromeRevealed = true;
        this.setChromeHidden(false);
      }
    };

    const onEnd = () => { tracking = false; };

    window.addEventListener("touchstart", onStart, { capture: true, passive: true, signal });
    window.addEventListener("touchmove", onMove, { capture: true, passive: false, signal });
    window.addEventListener("touchend", onEnd, { capture: true, passive: true, signal });
    window.addEventListener("touchcancel", onEnd, { capture: true, passive: true, signal });
  }

  // Capture & restore the main scroll position around a render so editing
  // a task (status flip, checkbox tick, drag-drop, etc.) doesn't bounce the
  // viewport back to the top of a long list / board / calendar.
  // The body element is destroyed and recreated by render functions, so we
  // re-query after the render and reapply scrollTop on both the sync path
  // and the next animation frame (covers cases where the new node's
  // scrollHeight isn't fully computed yet).
  // Obsidian augments Node with isShown(); guard the call so a runtime
  // without it (tests) treats the view as visible.
  private isViewVisible(): boolean {
    return (this.containerEl as any).isShown?.() ?? true;
  }

  // Obsidian calls onResize when the view container changes size — including
  // when a hidden leaf is revealed, which is exactly when a deferred render
  // must flush.
  onResize() {
    if (this.renderDirty && this.isViewVisible()) {
      this.renderDirty = false;
      this.withScrollPreserved(() => this.fullRender());
    }
  }

  // Update the topbar's discreet sync indicator from the active workspace's
  // sync state AND the Vault Sync state (worst of the two wins the icon; the
  // tooltip breaks them down). Cheap (one element) — safe to call on every
  // status change. Hidden entirely when neither scope is active.
  /** Combined sync status (task + vault, worst wins) or null when no sync is
   *  active. Shared by the topbar indicator, its tooltip and its tap Notice. */
  syncStatusSummary(): { state: string; title: string } | null {
    const taskStatus = this.plugin.syncManager?.statusFor(this.plugin.prefs.id) ?? null;
    const vaultStatus = this.plugin.vaultSyncManager?.isActive() ? this.plugin.vaultSyncManager.status : null;
    if (!taskStatus && !vaultStatus) return null;

    const describe = (status: NonNullable<typeof taskStatus>): { state: string; title: string } => {
      if (status.phase === "syncing") return { state: "syncing", title: t("sync.syncing") };
      if (status.phase === "error") return { state: "error", title: t("sync.statusError", { msg: status.lastError || "?" }) };
      if (status.phase === "blocked") return { state: "blocked", title: t("sync.blockedMassDelete") };
      if (status.pending > 0) return { state: "pending", title: t("sync.statusPending", { count: status.pending }) };
      return {
        state: "idle",
        title: status.lastSyncAt ? t("sync.statusLast", { value: new Date(status.lastSyncAt).toLocaleString() }) : t("sync.statusNever"),
      };
    };

    const RANK: Record<string, number> = { idle: 0, pending: 1, syncing: 2, blocked: 3, error: 4 };
    const parts: Array<{ scope: string; state: string; title: string }> = [];
    if (taskStatus) parts.push({ scope: this.plugin.prefs.name, ...describe(taskStatus) });
    if (vaultStatus) parts.push({ scope: t("vaultSync.scopeName"), ...describe(vaultStatus) });
    const worst = parts.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a));
    const title = parts.length === 1 ? parts[0].title : parts.map((p) => `${p.scope}: ${p.title}`).join("\n");
    return { state: worst.state, title };
  }

  refreshSyncIndicator() {
    const el = this.contentEl.querySelector(".it-sync-indicator") as HTMLElement | null;
    if (!el) return;
    const info = this.syncStatusSummary();
    if (!info) { el.hide(); el.removeClass("is-shown"); return; }
    el.show(); el.addClass("is-shown");

    const ICON: Record<string, string> = {
      idle: "check", pending: "refresh-cw", syncing: "refresh-cw", blocked: "alert-triangle", error: "cloud-off",
    };
    el.className = `it-sync-indicator it-icon-btn is-shown is-${info.state}`;
    setIcon(el, ICON[info.state]);
    el.setAttr("aria-label", info.title);
    el.title = info.title;
  }

  /**
   * Hold back a re-render while a native date/time picker is open.
   *
   * Inline date and time cells are editable in List, Table and the system lists,
   * and saving one redraws the whole view. On iOS that is fatal to the edit in
   * progress: tapping an EMPTY date input opens the picker, the webview reports
   * today as a change straight away, we save, the redraw replaces the element the
   * picker was anchored to, and the picker closes leaving a date nobody chose.
   * Same reasoning and same fix as in the Item modal: redraw once the field is
   * finished with, which is when it loses focus.
   */
  private pendingRenderWhileEditing = false;
  private deferRenderWhileNativePickerOpen(): boolean {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement)) return false;
    if (active.type !== "date" && active.type !== "time") return false;
    if (!this.contentEl.contains(active)) return false;
    if (this.pendingRenderWhileEditing) return true;
    this.pendingRenderWhileEditing = true;
    active.addEventListener("blur", () => {
      this.pendingRenderWhileEditing = false;
      if (this.isViewVisible()) this.withScrollPreserved(() => this.fullRender());
      else this.renderDirty = true;
    }, { once: true });
    return true;
  }

  private withScrollPreserved(fn: () => void) {
    const before = (this.contentEl.querySelector(".it-main-body") as HTMLElement | null)?.scrollTop ?? 0;
    fn();
    if (before > 0) {
      const after = this.contentEl.querySelector(".it-main-body") as HTMLElement | null;
      if (after) {
        after.scrollTop = before;
        requestAnimationFrame(() => { after.scrollTop = before; });
      }
    }
  }

  private refreshContent() {
    const main = this.contentEl.querySelector(".it-main-body");
    if (!main) return this.fullRender();
    this.withScrollPreserved(() => {
      (main as HTMLElement).empty();
      this.renderContent(main as HTMLElement);
    });
  }

  private renderContent(parent: HTMLElement) {
    // The overview pull-down gesture binds to elements recreated on every render,
    // so always drop the old binding; the calendar branch re-arms it if needed.
    this.teardownOverviewGesture();

    // Doc-as-location (opened from the sidebar) — the location itself is a Doc.
    if (this.state.location.kind === "doc") {
      const doc = this.plugin.index.docByPath(this.state.location.path);
      if (doc) {
        this.activeDocId = doc.doc_id;
        this.renderDocView(parent, doc);
        return;
      }
      this.renderEmptyState(parent);
      return;
    }

    // Doc mode — a Doc is open for the current location (Views-bar chip).
    if (this.activeDocId) {
      const doc = this.plugin.index.docById(this.activeDocId);
      if (doc && doc.location === locationKey(this.state.location)) {
        this.renderDocView(parent, doc);
        return;
      }
      this.activeDocId = undefined;
      this.activeDocPageId = undefined;
    }

    if (this.state.location.kind === "notifications") {
      renderNotificationsView({
        parent,
        plugin: this.plugin,
        onTaskClick: (t) => this.openTask(t),
        onHistoryClick: async (entry) => {
          // History is cross-workspace: switch to the entry's workspace (if it
          // isn't already active) before opening the task there.
          if (!entry.taskId) return;
          if (entry.workspaceId !== this.plugin.settings.activeWorkspaceId) {
            await this.plugin.switchWorkspace(entry.workspaceId);
          }
          const task = this.plugin.index.tasksById.get(entry.taskId);
          if (task) this.openTask(task);
          else new Notice(t("notifications.historyTaskGone"));
        },
        rerender: () => {
          // User-driven actions inside Notifications (Read/Clear/Snooze/Restore
          // and tab changes) should not re-trigger the sidebar attention state.
          // Automatic transitions are handled by the timer path above.
          this.syncNotificationAttention({ acknowledge: true });
          this.refreshContent();
          this.refreshNotificationChrome();
        },
      });
      return;
    }

    if (this.state.location.kind === "reminders" || this.state.location.kind === "short_notes") {
      renderSystemListView({
        parent,
        plugin: this.plugin,
        kind: this.state.location.kind === "reminders" ? "reminders" : "short_notes",
        onTaskClick: (t) => this.openTask(t),
        rerender: () => {
          this.refreshContent();
          this.plugin.refreshDockedSidebar();
        },
      });
      return;
    }

    const ctx = this.tasksContext();
    const tasks = this.collectTasks(ctx);
    if (this.state.location.kind === "list" && this.plugin.index.userSpaces.length === 0) {
      this.renderEmptyState(parent);
      return;
    }
    if (this.plugin.index.userSpaces.length === 0) {
      this.renderEmptyState(parent);
      return;
    }

    // Recents keeps its recency order (most-recent first); every other location
    // honors the active Sort control.
    const sorted = this.state.location.kind === "recents"
      ? tasks
      : sortTasks(tasks, this.state.sortBy, {
          statuses: ctx.statuses,
          contextOrder: (ctx as any).contextOrder,
          tagsOrder: (ctx as any).tagsOrder,
          customFields: ctx.customFields,
          subtaskStats: ctx.subtaskStats,
          taskTitles: ctx.taskTitles,
        });

    switch (this.state.viewType) {
      case "list":
        renderListView({
          parent, tasks: sorted, state: this.state, plugin: this.plugin,
          onTaskClick: (t) => this.openTask(t),
          context: ctx,
          rerender: () => this.refreshContent(),
          onToggleGroup: (key) => this.toggleViewGroup("list", key),
        });
        break;
      case "board":
        renderBoardView({
          parent, tasks: sorted, state: this.state, plugin: this.plugin,
          onTaskClick: (t) => this.openTask(t),
          context: ctx,
        });
        break;
      case "calendar":
        renderCalendarView({
          parent, tasks: sorted, state: this.state, plugin: this.plugin,
          onTaskClick: (t) => this.openTask(t),
          context: ctx,
          onShift: (n) => {
            const d = new Date(this.state.calendarRefDate || todayKey());
            if (this.state.calendarPeriod === "month" || this.state.calendarPeriod === "monthCompact") d.setMonth(d.getMonth() + n);
            else if (this.state.calendarPeriod === "week") d.setDate(d.getDate() + 7 * n);
            else d.setDate(d.getDate() + n);
            this.state.calendarRefDate = d.toISOString().slice(0, 10);
            this.refreshContent();
          },
          onPeriodChange: (p) => {
            this.overviewChromeRevealed = false;
            this.state.calendarPeriod = p;
            this.refreshContent();
          },
          onToday: () => {
            this.state.calendarRefDate = todayKey();
            this.refreshContent();
          },
        });
        // Mobile Overview: collapse chrome on entry; stay collapsed until the user
        // pull-downs (setupOverviewGesture) or scrolls up to reveal. Other periods
        // always show chrome. The calendar toolbar (Today / period tabs) lives in
        // the body and is never part of the collapsed chrome.
        if (Platform.isMobile) {
          if (this.state.calendarPeriod === "monthCompact") {
            this.setChromeHidden(!this.overviewChromeRevealed);
            this.setupOverviewGesture();
          } else {
            this.setChromeHidden(false);
          }
        }
        break;
      case "table":
        renderTableView({
          parent, tasks: sorted, state: this.state, plugin: this.plugin,
          onTaskClick: (t) => this.openTask(t),
          context: ctx,
          rerender: () => this.refreshContent(),
          onToggleGroup: (key) => this.toggleViewGroup("table", key),
        });
        break;
      case "gantt":
        renderGanttView({
          parent, tasks: sorted, state: this.state, plugin: this.plugin,
          onTaskClick: (t) => this.openTask(t),
          context: ctx as any,
          nav: {
            // Nav clears the saved scroll offset so the view re-centers on the
            // (possibly new) anchor; toggles below leave it to preserve scroll.
            onZoom: (z) => { this.state.ganttZoom = z; (this.state as any).__tgScrollLeft = undefined; this.persistFiltersForCurrentLocation(); this.refreshContent(); },
            onShift: (dir) => { this.state.timeRefDate = shiftKey(this.state.timeRefDate, this.state.ganttZoom, dir); (this.state as any).__tgScrollLeft = undefined; this.refreshContent(); },
            onToday: () => { this.state.timeRefDate = todayKey(); (this.state as any).__tgScrollLeft = undefined; this.refreshContent(); },
          },
          onToggleDeps: () => { this.state.ganttShowDependencies = !this.state.ganttShowDependencies; this.persistFiltersForCurrentLocation(); this.refreshContent(); },
          onToggleProgress: () => { this.state.ganttShowProgress = !this.state.ganttShowProgress; this.persistFiltersForCurrentLocation(); this.refreshContent(); },
          onRailWidthChange: (width) => { this.state.ganttRailWidth = width; this.persistFiltersForCurrentLocation(); },
        });
        break;
      case "timeline":
        renderTimelineView({
          parent, tasks: sorted, state: this.state, plugin: this.plugin,
          onTaskClick: (t) => this.openTask(t),
          context: ctx as any,
          nav: {
            onZoom: (z) => { this.state.timelineZoom = z; (this.state as any).__tgScrollLeft = undefined; this.persistFiltersForCurrentLocation(); this.refreshContent(); },
            onShift: (dir) => { this.state.timeRefDate = shiftKey(this.state.timeRefDate, this.state.timelineZoom, dir); (this.state as any).__tgScrollLeft = undefined; this.refreshContent(); },
            onToday: () => { this.state.timeRefDate = todayKey(); (this.state as any).__tgScrollLeft = undefined; this.refreshContent(); },
          },
          onRailWidthChange: (width) => { this.state.timelineRailWidth = width; this.persistFiltersForCurrentLocation(); },
        });
        break;
    }
  }

  private collectTasks(context = this.tasksContext()): TaskFile[] {
    let tasks: TaskFile[];
    if (this.state.location.kind === "recents") {
      // Resolve recent ids → tasks in recency order (most recent first),
      // dropping any that no longer exist.
      tasks = this.plugin.prefs.recentTaskIds
        .map((id) => this.plugin.index.tasksById.get(id))
        .filter((t): t is TaskFile => !!t && !this.plugin.index.isSystemTask(t) && !t.data.archived);
    } else {
      tasks = this.plugin.index.tasksFor(this.state.location);
    }
    if (this.state.location.kind !== "archived" && !this.state.showClosed) {
      tasks = tasks.filter((t) => !this.isClosed(t));
    }
    if (this.state.search.trim()) {
      const q = this.state.search.toLowerCase();
      tasks = tasks.filter((t) =>
        (t.data.title || "").toLowerCase().includes(q) ||
        (t.data.id || "").toLowerCase().includes(q) ||
        (t.data.custom_id || "").toLowerCase().includes(q) ||
        (t.data.tags || []).some((tg) => tg.toLowerCase().includes(q)) ||
        (t.data.context || []).some((cl) => cl.toLowerCase().includes(q))
      );
    }
    if (this.state.filters) tasks = applyFilters(tasks, this.state.filters, {
      customFields: context.customFields,
      subtaskStats: context.subtaskStats,
      taskTitles: context.taskTitles,
    });
    // Subtask presentation (parents / nested / flat). Inclusion is decided
    // centrally per view type: "parents" hides subtasks everywhere; "flat" shows
    // them everywhere; "nested" shows them only in views that can indent
    // (List/Table/Gantt) — the flat views treat it like "parents". The actual
    // indentation is a per-view render concern (see data/subtasks.ts).
    if (!includeSubtasks(this.state.subtaskMode, this.state.viewType)) {
      // A task whose only parent is across the archive boundary is a root in
      // this scope; otherwise "parents only" would make it disappear entirely.
      const hierarchyIds = new Set(
        (this.state.location.kind === "archived" ? this.plugin.index.archivedTasks() : this.plugin.index.normalTasks())
          .map((task) => task.data.id),
      );
      tasks = tasks.filter((task) => !parentTaskIds(task.data).some((parentId) => hierarchyIds.has(parentId)));
    }
    return tasks;
  }

  // Resolve closed status dynamically (don't rely solely on frontmatter status_group)
  private isClosed(t: TaskFile): boolean {
    if (t.data.status_group === "closed") return true;
    if (!t.data.status || !t.listPath) return false;
    const set = this.plugin.index.resolveStatusSet(t.listPath).statuses;
    const so = set.find((s) => s.id === t.data.status);
    return so?.group === "closed";
  }

  tasksContext() {
    // Scope-aware: a List resolves its own effective set; Everything/Space/
    // Folder (and global virtual views) get the union of in-scope Lists'
    // effective sets, so per-List statuses render and group correctly there.
    const set = this.plugin.index.resolveStatusSetForLocation(this.state.location);
    const priorities = this.plugin.index.resolvePrioritiesForLocation(this.state.location);
    const priorityLabels: Record<number, string> = {};
    priorities.forEach((p) => (priorityLabels[p.id] = p.label));
    const features = this.plugin.index.resolveFeaturesForLocation(this.state.location);
    const resolvedDefaults = this.plugin.index
      .resolveViewDefaultsForLocation(this.state.viewType, this.state.location);
    // Current-view override (Fields customizer / applied saved view) wins over
    // the inherited config defaults. Either way, features still gate fields out.
    const rawVisible = this.state.visibleFields ?? (resolvedDefaults.visible_fields || []);
    const visibleFields = filterFieldsByFeatures(rawVisible, features);
    // Calendar pill color source + board/calendar CF-chip toggles: transient
    // override (Fields customizer / applied view) wins over resolved config.
    // Defaults differ by view: board shows name+empty by default, calendar hides both.
    const isBoardView = this.state.viewType === "board";
    const cfShowName = this.state.cfShowName ?? this.plugin.index.resolveViewDefaultBool(this.state.viewType, "cf_show_name", this.state.location, isBoardView);
    const cfShowWhenEmpty = this.state.cfShowWhenEmpty ?? this.plugin.index.resolveViewDefaultBool(this.state.viewType, "cf_show_when_empty", this.state.location, isBoardView);
    // Field-type icons default ON (headers/chips); turn off per view if desired.
    const cfShowTypeIcon = this.state.cfShowTypeIcon ?? this.plugin.index.resolveViewDefaultBool(this.state.viewType, "cf_show_type_icon", this.state.location, true);
    // Timeline "Unscheduled" tray — default ON, inherited down the config chain.
    const timelineShowUnscheduled = this.state.timelineShowUnscheduled ?? this.plugin.index.resolveViewDefaultBool("timeline", "show_unscheduled", this.state.location, true);
    const calendarColorBy = this.state.calendarColorBy ?? resolvedDefaults.color_by;
    // Date sources (calendar pill date / time-view bar start+end). Transient
    // override wins over inherited config; `undefined` = built-in default
    // (due_date / start_date) so "no override" stays distinguishable for the
    // Save-view / Set-default paths. Feature-disabled dates fall back to the
    // built-in default resolution inside the views.
    const dateField = this.state.dateField ?? resolvedDefaults.date_field;
    const startField = this.state.startField ?? resolvedDefaults.start_date_field;
    // Ordered config palettes — drive group bucket ordering so groups follow
    // the user's defined sequence (not alphabetical or insertion order).
    const tagsPalette = this.plugin.index.resolveTagsPaletteForLocation(this.state.location);
    const contextLabels = this.plugin.index.resolveContextLabelsForLocation(this.state.location);
    const taskTypes = this.plugin.index.resolveTaskTypesForLocation(this.state.location);
    const customFields = this.plugin.index.resolveCustomFieldsForLocation(this.state.location);
    const emptyPositions = {
      status: this.plugin.index.resolveEmptyPosition("status", this.state.location),
      priority: this.plugin.index.resolveEmptyPosition("priority", this.state.location),
      tags: this.plugin.index.resolveEmptyPosition("tags", this.state.location),
      context: this.plugin.index.resolveEmptyPosition("context", this.state.location),
      type: this.plugin.index.resolveEmptyPosition("type", this.state.location),
    };
    const chipStyles = this.plugin.index.resolveChipStylesForLocation(this.state.location);
    // Custom display names for built-in fields (per-scope, inherited). Views
    // read these via fieldLabelFrom(context.fieldLabels, key). Display-only.
    const fieldLabels = this.plugin.index.resolveFieldLabelsForLocation(this.state.location);
    // Built once per render — avoids each row scanning allTasks() (O(n²)).
    const renderStats = this.plugin.index.buildRenderStats(
      this.state.location.kind === "archived" ? this.plugin.index.archivedTasks() : this.plugin.index.normalTasks(),
    );
    const taskTitles = new Map(Array.from(this.plugin.index.tasksById.values()).map((task) => [task.data.id, task.data.title || task.data.id]));
    // List name → icon/color so "Group by: List" headers can show the list icon
    // (groupTasks keys buckets by list name and has no index access of its own).
    const listMeta = new Map<string, { icon?: string; color?: string }>();
    for (const sp of this.plugin.index.spaces) {
      const addList = (l: { config: { name: string; icon?: string; color?: string } }) => {
        if (!listMeta.has(l.config.name)) listMeta.set(l.config.name, { icon: l.config.icon, color: l.config.color });
      };
      for (const l of sp.lists) addList(l);
      for (const f of sp.folders) for (const l of f.lists) addList(l);
    }
    return {
      statuses: set.statuses,
      priorities,
      priorityLabels,
      visibleFields,
      features,
      tagsOrder: tagsPalette.map((t) => t.name),
      contextOrder: contextLabels.map((c) => c.name),
      taskTypesOrder: taskTypes.map((t) => ({ id: t.id, name: t.name, color: t.color, icon: t.icon })),
      customFields,
      listMeta,
      emptyPositions,
      tagsPalette,
      contextLabels,
      chipStyles,
      fieldLabels,
      calendarColorBy,
      // Generic bar-tint source for the time views (Gantt/Timeline). Same value
      // as calendarColorBy — kept under a neutral name the engine reads.
      colorBy: calendarColorBy,
      // Date sources: calendar pill date / time-view bar END, and bar START.
      dateField,
      startField,
      cfShowName,
      cfShowWhenEmpty,
      cfShowTypeIcon,
      showUnscheduled: timelineShowUnscheduled,
      // Generic flag the views read to decide whether to draw field-type icons.
      showFieldIcons: cfShowTypeIcon,
      subtaskStats: renderStats.subtasks,
      relationshipCounts: renderStats.relationships,
      taskTitles,
      // Subtask presentation mode — row/tree views (List/Table) read this to
      // decide whether to indent subtasks under their parent.
      subtaskMode: this.state.subtaskMode,
    };
  }

  // Location-aware built-in field label for the CURRENT view's scope. Used by
  // this view's menus/filters/customizer so a renamed field reads consistently.
  private fieldLabel(key: string): string {
    return fieldLabelFrom(this.plugin.index.resolveFieldLabelsForLocation(this.state.location), key);
  }

  openTask(t: TaskFile) {
    this.plugin.pushRecentTask(t.data.id);
    if (this.plugin.prefs.openTaskMode === "editor") {
      void this.plugin.index.openTaskInEditor(t.data.id);
    } else {
      new TaskModal(this.app, this.plugin, t).open();
    }
  }

  private openFilterModal() {
    new FilterModal(this.app, {
      current: this.state.filters,
      fields: this.buildFilterFields(),
      onApply: (group) => {
        this.state.filters = group;
        this.persistFiltersForCurrentLocation();
        this.fullRender();
      },
    }).open();
  }

  // Build the filterable field list for the current location, honoring feature
  // toggles (e.g. don't offer Tags when the tags feature is off) and mapping
  // each custom field's type to a coarse filter type the builder understands.
  private buildFilterFields(): FilterFieldDef[] {
    const ctx = this.tasksContext();
    const f = ctx.features;
    const out: FilterFieldDef[] = [];
    out.push({ key: "title", label: this.fieldLabel("title"), type: "text" });
    out.push({ key: "status", label: this.fieldLabel("status"), type: "dropdown", options: ctx.statuses.map((s) => ({ value: s.id, label: s.name, color: s.color })) });
    if (f.priorities !== false) out.push({ key: "priority", label: this.fieldLabel("priority"), type: "dropdown", options: ctx.priorities.map((p) => ({ value: p.id, label: p.label, color: p.color })) });
    out.push({ key: "type", label: this.fieldLabel("type"), type: "dropdown", options: ctx.taskTypesOrder.map((tt) => ({ value: tt.id, label: tt.name || tt.id, color: tt.color })) });
    if (f.tags !== false) out.push({ key: "tags", label: this.fieldLabel("tags"), type: "multi", options: ctx.tagsPalette.map((tg) => ({ value: tg.name, label: tg.name, color: tg.color })) });
    if (f.context !== false) out.push({ key: "context", label: this.fieldLabel("context"), type: "multi", options: ctx.contextLabels.map((c) => ({ value: c.name, label: c.name, color: c.color })) });
    out.push({ key: "due_date", label: this.fieldLabel("due_date"), type: "date" });
    out.push({ key: "start_date", label: this.fieldLabel("start_date"), type: "date" });
    out.push({ key: "created_at", label: this.fieldLabel("created_at"), type: "date" });
    out.push({ key: "updated_at", label: this.fieldLabel("updated_at"), type: "date" });
    if (f.time_estimate !== false) out.push({ key: "time_estimate", label: `${this.fieldLabel("time_estimate")} (min)`, type: "number" });
    if (f.time_tracking !== false) out.push({ key: "time_tracked", label: `${this.fieldLabel("time_tracked")} (min)`, type: "number" });
    if (f.sprint_points !== false) out.push({ key: "sprint_points", label: this.fieldLabel("sprint_points"), type: "number" });
    for (const cf of ctx.customFields) {
      const ft = cfFilterType(cf.type);
      if (!ft) continue; // relationship / attachment — not filterable in v1
      const def: FilterFieldDef = { key: `custom_field:${cf.id}`, label: cf.name, type: ft };
      if (ft === "dropdown" || ft === "multi") {
        def.options = (cf.options || []).map((o) => ({ value: o.value ?? o.label, label: o.label, color: o.color }));
      }
      out.push(def);
    }
    // Attach the colored field-type icon to every entry so the filter picker
    // matches the rest of the app.
    for (const def of out) {
      const m = fieldIconMeta(def.key, ctx.customFields as any);
      def.icon = m.icon;
      def.color = m.color;
    }
    return out;
  }

  // ---------- Saved views (Views bar) ----------

  private renderViewsBar(parent: HTMLElement) {
    // Doc and Notifications are not task-table containers — no saved views /
    // Customize / Export bar.
    if (this.state.location.kind === "doc" || this.state.location.kind === "notifications" || this.state.location.kind === "reminders" || this.state.location.kind === "short_notes") return;
    const key = locationKey(this.state.location);
    const docsAllowed = this.state.location.kind === "space" || this.state.location.kind === "folder" || this.state.location.kind === "list";

    // Saved views + Docs share one manual left→right order (item `order` field).
    // A default view always floats to the front; the rest follow the user's
    // manual order, with name as a stable fallback. Docs are never default.
    const items = this.viewsBarItems(key, docsAllowed);
    const firstMovable = items.length && this.barItemIsDefault(items[0]) ? 1 : 0;

    const bar = parent.createDiv({ cls: "it-views-bar" });
    const typeIcon = VIEW_TYPE_ICON;
    // Per-view-type accent comes from the configured color scheme (7 colors:
    // the 6 view types + Docs) so chips match the topbar view switcher exactly.
    const viewColors = resolveViewColorSet(this.plugin.prefs.viewColorScheme, this.plugin.prefs.viewColors);
    const docColor = viewColors[VIEW_COLOR_INDEX.doc];

    items.forEach((it, idx) => {
      const movable = !this.barItemIsDefault(it);
      const canLeft = movable && idx > firstMovable;
      const canRight = movable && idx < items.length - 1;
      if (it.kind === "view") {
        const v = it.v;
        // A single .it-chip (same family as task/status/tag chips), themed in the
        // view-type color: [type icon] name [optional ★] [delicate chevron].
        const chip = bar.createEl("button", { cls: "it-chip it-view-chip" + (v.default ? " is-default" : "") + (this.activeViewId === v.view_id && !this.activeDocId ? " is-active" : ""), attr: { type: "button", title: t("main.applyView", { name: v.name }) } });
        chip.style.setProperty("--chip-color", viewColors[VIEW_COLOR_INDEX[v.type]] || "#9E9E9E");
        setIcon(chip.createSpan({ cls: "it-view-chip-type" }), typeIcon[v.type] || "list");
        chip.createSpan({ cls: "it-view-chip-name", text: v.name });
        if (v.default) setIcon(chip.createSpan({ cls: "it-view-chip-mark" }), "star");
        const caret = chip.createSpan({ cls: "it-view-chip-caret", attr: { role: "button", "aria-label": t("main.viewOptions") } });
        setIcon(caret, "chevron-down");
        caret.addEventListener("click", (e) => { e.stopPropagation(); this.showViewMenu(e, v, canLeft, canRight); });
        chip.addEventListener("click", () => this.applyView(v));
      } else {
        const d = it.d;
        const chip = bar.createEl("button", { cls: "it-chip it-view-chip it-doc-chip" + (d.default ? " is-default" : "") + (this.activeDocId === d.doc_id ? " is-active" : ""), attr: { type: "button", title: t("main.openDoc", { name: d.name }) } });
        chip.style.setProperty("--chip-color", d.color || docColor);
        setIcon(chip.createSpan({ cls: "it-view-chip-type" }), d.icon || DOC_ICON);
        chip.createSpan({ cls: "it-view-chip-name", text: d.name });
        if (d.default) setIcon(chip.createSpan({ cls: "it-view-chip-mark" }), "star");
        const caret = chip.createSpan({ cls: "it-view-chip-caret", attr: { role: "button", "aria-label": t("main.docOptions") } });
        setIcon(caret, "chevron-down");
        caret.addEventListener("click", (e) => { e.stopPropagation(); this.showDocMenu(e, d, canLeft, canRight); });
        chip.addEventListener("click", () => this.openDoc(d.doc_id));
      }
    });

    // Utility chips — the dashed "add" affordance (same as "+ Tag"), so they're
    // clearly utilities rather than saved views.
    const save = bar.createEl("button", { cls: "it-chip it-chip-add it-views-bar-action", attr: { type: "button", title: t("toolbar.saveView"), "aria-label": t("toolbar.saveView") } });
    setIcon(save.createSpan({ cls: "it-view-chip-type" }), "plus");
    save.createSpan({ text: t("toolbar.saveView") });
    save.addEventListener("click", (e) => this.showSaveViewPopover(e));

    // Add Doc — sits next to Save view (same place), available at Space/Folder/List.
    if (docsAllowed) {
      const addDoc = bar.createEl("button", { cls: "it-chip it-chip-add it-views-bar-action it-add-doc", attr: { type: "button", title: t("toolbar.addDocBtn"), "aria-label": t("toolbar.addDocBtn") } });
      const addDocIc = addDoc.createSpan({ cls: "it-view-chip-type" });
      setIcon(addDocIc, DOC_ICON);
      addDocIc.style.color = docColor;
      addDoc.createSpan({ text: t("toolbar.addDocBtn") });
      addDoc.addEventListener("click", (e) => this.showAddDocPopover(e));
    }

    const customize = bar.createEl("button", { cls: "it-chip it-chip-add it-views-bar-action", attr: { type: "button", title: t("toolbar.customize"), "aria-label": t("toolbar.customize") } });
    setIcon(customize.createSpan({ cls: "it-view-chip-type" }), "settings-2");
    customize.createSpan({ text: t("toolbar.customize") });
    customize.addEventListener("click", (e) => this.showFieldsCustomizer(e));

    // Export — next to Customize, all views. Opens a small menu: export the
    // current (filtered) view, or the whole scope (backup/readable).
    const exp = bar.createEl("button", { cls: "it-chip it-chip-add it-views-bar-action", attr: { type: "button", title: t("common.export"), "aria-label": t("common.export") } });
    setIcon(exp.createSpan({ cls: "it-view-chip-type" }), "download");
    exp.createSpan({ text: t("common.export") });
    exp.addEventListener("click", (e) => this.openExportMenu(e));

    // Collapse the Save view / Customize / Export labels to icons when the row
    // can't fit them — buys space before the chips wrap to a new line.
    this.observeRowCompaction(bar);
  }

  // Saved views + Docs at a location, in their display order (default view
  // first, then the manual `order`, then name).
  private viewsBarItems(key: string, docsAllowed: boolean): ViewsBarItem[] {
    const items: ViewsBarItem[] = [
      ...this.plugin.index.viewsForLocationKey(key).map((v) => ({ kind: "view" as const, v })),
      ...(docsAllowed ? this.plugin.index.docsForLocationKey(key).map((d) => ({ kind: "doc" as const, d })) : []),
    ];
    const orderOf = (it: ViewsBarItem) => (it.kind === "view" ? it.v.order : it.d.order) ?? Number.MAX_SAFE_INTEGER;
    const nameOf = (it: ViewsBarItem) => (it.kind === "view" ? it.v.name : it.d.name);
    items.sort((a, b) =>
      (Number(this.barItemIsDefault(b)) - Number(this.barItemIsDefault(a))) ||
      (orderOf(a) - orderOf(b)) ||
      nameOf(a).localeCompare(nameOf(b)),
    );
    return items;
  }

  private barItemIsDefault(it: ViewsBarItem): boolean {
    return it.kind === "view" ? !!it.v.default : !!it.d.default;
  }

  // Move a Views-bar chip one slot left/right and persist the new order. The
  // default view stays pinned to the front (it's excluded from the movable range).
  private async moveBarItem(kind: "view" | "doc", id: string, dir: -1 | 1) {
    const key = locationKey(this.state.location);
    const docsAllowed = this.state.location.kind === "space" || this.state.location.kind === "folder" || this.state.location.kind === "list";
    const items = this.viewsBarItems(key, docsAllowed);
    const firstMovable = items.length && this.barItemIsDefault(items[0]) ? 1 : 0;
    const idx = items.findIndex((it) => (it.kind === "view" ? it.v.view_id : it.d.doc_id) === id && it.kind === kind);
    if (idx < 0) return;
    const j = idx + dir;
    if (j < firstMovable || j >= items.length) return;
    const seq = items.slice();
    [seq[idx], seq[j]] = [seq[j], seq[idx]];
    await this.plugin.index.reorderViewsBar(seq.map((it) => it.kind === "view"
      ? { kind: "view" as const, id: it.v.view_id }
      : { kind: "doc" as const, id: it.d.doc_id }));
  }

  private openExportMenu(e: MouseEvent) {
    const sc = this.locationExportScope();
    const items: any[] = [];
    // Gantt/Timeline get a graphical snapshot export (PNG/PDF) in addition to
    // the standard tabular exports every view offers.
    if (this.state.viewType === "gantt" || this.state.viewType === "timeline") {
      items.push({ label: t("export.graphicPng"), icon: "image", onClick: () => this.exportTimeGraphic("png") });
      items.push({ label: t("export.graphicPdf"), icon: "file-text", onClick: () => this.exportTimeGraphic("pdf") });
      items.push("separator");
    }
    items.push({
      label: t("export.thisView"),
      icon: "table",
      onClick: () => {
        const p = this.currentViewExportPayload();
        new ExportModal(this.app, this.plugin, { scope: "view", viewName: p.name, viewTasks: p.tasks, viewCols: p.cols, viewCtx: p.ctx }).open();
      },
    });
    items.push({
      label: t("export.thisScope", { scope: sc.label }),
      icon: "package",
      onClick: () => new ExportModal(this.app, this.plugin, { scope: sc.scope, path: sc.path }).open(),
    });
    showContextMenu(e, items);
  }

  // Builds the time-view export input from current state and hands it to the
  // canvas renderer. Mirrors currentViewExportPayload's filter+sort pipeline so
  // the image matches exactly what's on screen.
  private exportTimeGraphic(fmt: TimeExportFormat) {
    const ctx = this.tasksContext() as any;
    let tasks = this.collectTasks(ctx);
    if (this.state.location.kind !== "recents") {
      tasks = sortTasks(tasks, this.state.sortBy, {
        statuses: ctx.statuses, contextOrder: ctx.contextOrder, tagsOrder: ctx.tagsOrder,
        customFields: ctx.customFields, subtaskStats: ctx.subtaskStats, taskTitles: ctx.taskTitles,
      });
    }
    const isGantt = this.state.viewType === "gantt";
    const input: TimeExportInput = {
      viewType: isGantt ? "gantt" : "timeline",
      tasks,
      context: ctx,
      zoom: isGantt ? this.state.ganttZoom : this.state.timelineZoom,
      groupBy: isGantt ? this.state.groupBy : (this.state.groupBy || "status"),
      groupDirection: this.state.groupDirection,
      showDependencies: this.state.ganttShowDependencies,
      showProgress: this.state.ganttShowProgress,
      title: this.currentViewExportPayload().name,
    };
    new TimeExportModal(this.app, this.plugin, fmt, input).open();
  }

  // Maps the current location to an exportable backup scope.
  private locationExportScope(): { scope: ExportScope; path?: string; label: string } {
    const loc = this.state.location;
    if (loc.kind === "list") return { scope: "list", path: loc.path, label: hierarchyLabel("list") };
    if (loc.kind === "folder") return { scope: "folder", path: loc.path, label: hierarchyLabel("folder") };
    if (loc.kind === "space") return { scope: "space", path: loc.path, label: hierarchyLabel("space") };
    return { scope: "workspace", label: hierarchyLabel("workspace") };
  }

  // Current view's filtered+sorted tasks, title-first columns, context, and a name.
  private currentViewExportPayload() {
    const ctx = this.tasksContext();
    let tasks = this.collectTasks(ctx);
    if (this.state.location.kind !== "recents") {
      tasks = sortTasks(tasks, this.state.sortBy, {
        statuses: ctx.statuses,
        contextOrder: (ctx as any).contextOrder,
        tagsOrder: (ctx as any).tagsOrder,
        customFields: ctx.customFields,
        subtaskStats: ctx.subtaskStats,
        taskTitles: ctx.taskTitles,
      });
    }
    const visible = (ctx.visibleFields || []).slice();
    if (!visible.includes("title")) visible.unshift("title");
    else { visible.splice(visible.indexOf("title"), 1); visible.unshift("title"); }
    const loc = this.state.location;
    let base = loc.kind as string;
    if (loc.kind === "list") base = this.plugin.index.findList(loc.path)?.config.name || "list";
    else if (loc.kind === "folder") base = this.plugin.index.findFolder(loc.path)?.config.name || "folder";
    else if (loc.kind === "space") base = this.plugin.index.findSpace(loc.path)?.config.name || "space";
    return { tasks, cols: visible, ctx, name: `${base} · ${this.state.viewType}` };
  }

  // Levels the current location can write a view_defaults override to
  // (narrowest → widest). Used by the Fields customizer's "Set as default for".
  private applicableScopeLevels(): Array<{ level: "workspace" | "space" | "folder" | "list"; path?: string; label: string }> {
    const loc = this.state.location;
    const out: Array<{ level: "workspace" | "space" | "folder" | "list"; path?: string; label: string }> = [];
    if (loc.kind === "list") {
      const l = this.plugin.index.findList(loc.path);
      out.push({ level: "list", path: loc.path, label: hierarchyLabel("list") });
      if (l?.folderPath) out.push({ level: "folder", path: l.folderPath, label: hierarchyLabel("folder") });
      if (l?.spacePath) out.push({ level: "space", path: l.spacePath, label: hierarchyLabel("space") });
    } else if (loc.kind === "folder") {
      const f = this.plugin.index.findFolder(loc.path);
      out.push({ level: "folder", path: loc.path, label: hierarchyLabel("folder") });
      if (f?.spacePath) out.push({ level: "space", path: f.spacePath, label: hierarchyLabel("space") });
    } else if (loc.kind === "space") {
      out.push({ level: "space", path: loc.path, label: hierarchyLabel("space") });
    }
    out.push({ level: "workspace", label: hierarchyLabel("workspace") });
    return out;
  }

  private showFieldsCustomizer(e: MouseEvent) {
    const view = this.state.viewType;
    const isCalendar = view === "calendar";
    const isChipView = isCalendar || view === "board"; // views that render CF as chips
    const isTimeView = view === "gantt" || view === "timeline"; // Gantt + Timeline
    const isFieldIconView = ["list", "table", "board", "calendar"].includes(view); // show field-type icons
    const cfs = this.plugin.index.resolveCustomFieldsForLocation(this.state.location);
    // Honor feature toggles — a disabled feature's fields are not offered here
    // (matching the config modal's View-defaults picker).
    const scopeFeatures = this.plugin.index.resolveFeaturesForLocation(this.state.location);
    const available = [...filterFieldsByFeatures(availableFieldsFor(view as any), scopeFeatures), ...cfs.map((cf) => `custom_field:${cf.id}`)];
    const labelFor = (f: string): string => {
      if (f.startsWith("custom_field:")) return cfs.find((c) => c.id === f.slice(13))?.name || f;
      return this.fieldLabel(f);
    };
    // Start from the effective set, keep only fields valid for this view type.
    let visible = this.effectiveVisibleFields().filter((f) => available.includes(f));

    showPopover(e.currentTarget as HTMLElement, (root) => {
      const wrap = root.createDiv({ cls: "it-fields-customizer" });
      const commit = () => { this.state.visibleFields = visible.slice(); this.persistFiltersForCurrentLocation(); this.refreshContent(); };

      const render = () => {
        // Preserve popover scroll across the rebuild each toggle triggers.
        const rootScroll = root.scrollTop;
        const wrapScroll = wrap.scrollTop;
        // Blur any focused element inside the popover BEFORE emptying the DOM.
        // When a focused node is removed, browsers may scroll the page to find
        // the new focus target — blurring first prevents that jump.
        if (wrap.contains(document.activeElement)) {
          (document.activeElement as HTMLElement | null)?.blur();
        }
        wrap.empty();
        // Restore popover scroll unconditionally (even if it was 0, the rebuild
        // may temporarily move it and a rAF nudge keeps it stable).
        requestAnimationFrame(() => { root.scrollTop = rootScroll; wrap.scrollTop = wrapScroll; });
        wrap.createDiv({ cls: "it-fields-customizer-title", text: t("customize.title", { view: viewLabel(view) }) });

        // One "pick a date source" select row — shared by the calendar's Date
        // field and the time views' Start/Due field knobs below.
        const dateSelectRow = (optsEl: HTMLElement, label: string, current: string, onPick: (v: string) => void) => {
          const row = optsEl.createDiv({ cls: "it-fields-opt-row" });
          row.createSpan({ cls: "it-field-label", text: label });
          const sel = row.createEl("select", { cls: "it-input" });
          for (const b of DATE_SOURCES_BUILTIN) {
            const el = sel.createEl("option", { value: b, text: this.fieldLabel(b) });
            if (b === current) el.selected = true;
          }
          for (const cf of dateBearingCustomFields(cfs)) {
            const key = `custom_field:${cf.id}`;
            const el = sel.createEl("option", { value: key, text: t("common.customSuffix", { name: cf.name }) });
            if (key === current) el.selected = true;
          }
          sel.addEventListener("change", () => onPick(sel.value));
        };

        // ----- View options: calendar period + color; chip name/empty toggles -----
        if (isChipView) {
          const ctx = this.tasksContext() as any;
          const opts = wrap.createDiv({ cls: "it-fields-options" });

          if (isCalendar) {
            const perRow = opts.createDiv({ cls: "it-fields-opt-row" });
            perRow.createSpan({ cls: "it-field-label", text: t("customize.period") });
            const seg = perRow.createDiv({ cls: "it-tri-state" });
            const periodOpts: Array<{ id: ViewState["calendarPeriod"]; label: string }> = [
              { id: "month", label: viewLabel("month") },
              { id: "week", label: viewLabel("week") },
              { id: "day", label: viewLabel("day") },
            ];
            periodOpts.push({ id: "monthCompact", label: viewLabel("overview") });
            for (const p of periodOpts) {
              const b = seg.createEl("button", { cls: "it-tri-state-btn" + (this.state.calendarPeriod === p.id ? " is-active" : ""), text: p.label, attr: { type: "button" } });
              b.addEventListener("click", () => { this.state.calendarPeriod = p.id; this.refreshContent(); render(); });
            }

            const colRow = opts.createDiv({ cls: "it-fields-opt-row" });
            colRow.createSpan({ cls: "it-field-label", text: t("customize.colorBy") });
            const sel = colRow.createEl("select", { cls: "it-input" });
            const current = (ctx.calendarColorBy as string) ?? CALENDAR_COLOR_SOURCE_DEFAULT;
            for (const o of CALENDAR_COLOR_SOURCES_BUILTIN) {
              const el = sel.createEl("option", { value: o.value, text: calendarColorSourceLabel(o.value) });
              if (o.value === current) el.selected = true;
            }
            for (const cf of cfs) {
              if (cf.type === "dropdown" || cf.type === "labels") {
                const key = `custom_field:${cf.id}`;
                const el = sel.createEl("option", { value: key, text: t("common.customSuffix", { name: cf.name }) });
                if (key === current) el.selected = true;
              }
            }
            sel.addEventListener("change", () => { this.state.calendarColorBy = sel.value; this.persistFiltersForCurrentLocation(); this.refreshContent(); });

            dateSelectRow(opts, t("customize.dateField"), (ctx.dateField as string) ?? DATE_SOURCE_DUE, (v) => {
              this.state.dateField = v;
              this.persistFiltersForCurrentLocation();
              this.refreshContent();
            });
          }

          const toggle = (label: string, key: "cfShowName" | "cfShowWhenEmpty", cur: boolean) => {
            const row = opts.createDiv({ cls: "it-fields-opt-row" });
            row.createSpan({ cls: "it-field-label", text: label });
            const cb = row.createEl("input", { type: "checkbox" });
            cb.checked = cur;
            cb.addEventListener("change", () => { this.state[key] = cb.checked; this.persistFiltersForCurrentLocation(); this.refreshContent(); });
          };
          toggle(t("customize.showFieldName"), "cfShowName", !!ctx.cfShowName);
          toggle(t("customize.showEmptyFields"), "cfShowWhenEmpty", !!ctx.cfShowWhenEmpty);

          wrap.createDiv({ cls: "it-popover-sep" });
        }

        // ----- Field-type icons toggle (List/Table headers + Board/Calendar chips) -----
        if (isFieldIconView) {
          const ictx = this.tasksContext() as any;
          const opts = wrap.createDiv({ cls: "it-fields-options" });
          const row = opts.createDiv({ cls: "it-fields-opt-row" });
          row.createSpan({ cls: "it-field-label", text: t("customize.fieldIcons") });
          const cb = row.createEl("input", { type: "checkbox" });
          cb.checked = !!ictx.cfShowTypeIcon;
          cb.addEventListener("change", () => { this.state.cfShowTypeIcon = cb.checked; this.persistFiltersForCurrentLocation(); this.refreshContent(); });
          wrap.createDiv({ cls: "it-popover-sep" });
        }

        // ----- View options: Gantt/Timeline zoom + bar color source -----
        if (isTimeView) {
          const tctx = this.tasksContext() as any;
          const opts = wrap.createDiv({ cls: "it-fields-options" });

          const zoomRow = opts.createDiv({ cls: "it-fields-opt-row" });
          zoomRow.createSpan({ cls: "it-field-label", text: t("customize.zoom") });
          const seg = zoomRow.createDiv({ cls: "it-tri-state" });
          const curZoom = view === "gantt" ? this.state.ganttZoom : this.state.timelineZoom;
          for (const z of ZOOM_ORDER) {
            const b = seg.createEl("button", { cls: "it-tri-state-btn" + (curZoom === z ? " is-active" : ""), text: zoomLabel(z), attr: { type: "button" } });
            b.addEventListener("click", () => {
              if (view === "gantt") this.state.ganttZoom = z; else this.state.timelineZoom = z;
              this.persistFiltersForCurrentLocation(); this.refreshContent(); render();
            });
          }

          const colRow = opts.createDiv({ cls: "it-fields-opt-row" });
          colRow.createSpan({ cls: "it-field-label", text: t("customize.colorBy") });
          const sel = colRow.createEl("select", { cls: "it-input" });
          const current = (tctx.colorBy as string) ?? CALENDAR_COLOR_SOURCE_DEFAULT;
          for (const o of CALENDAR_COLOR_SOURCES_BUILTIN) {
            const el = sel.createEl("option", { value: o.value, text: calendarColorSourceLabel(o.value) });
            if (o.value === current) el.selected = true;
          }
          for (const cf of cfs) {
            if (cf.type === "dropdown" || cf.type === "labels") {
              const key = `custom_field:${cf.id}`;
              const el = sel.createEl("option", { value: key, text: t("common.customSuffix", { name: cf.name }) });
              if (key === current) el.selected = true;
            }
          }
          sel.addEventListener("change", () => { this.state.calendarColorBy = sel.value; this.persistFiltersForCurrentLocation(); this.refreshContent(); });

          dateSelectRow(opts, t("customize.startDateField"), (tctx.startField as string) ?? DATE_SOURCE_START, (v) => {
            this.state.startField = v;
            this.persistFiltersForCurrentLocation();
            this.refreshContent();
          });
          dateSelectRow(opts, t("customize.dueDateField"), (tctx.dateField as string) ?? DATE_SOURCE_DUE, (v) => {
            this.state.dateField = v;
            this.persistFiltersForCurrentLocation();
            this.refreshContent();
          });

          if (view === "gantt") {
            const depRow = opts.createDiv({ cls: "it-fields-opt-row" });
            depRow.createSpan({ cls: "it-field-label", text: t("customize.dependencies") });
            const cb = depRow.createEl("input", { type: "checkbox" });
            cb.checked = this.state.ganttShowDependencies;
            cb.addEventListener("change", () => { this.state.ganttShowDependencies = cb.checked; this.persistFiltersForCurrentLocation(); this.refreshContent(); });
            const prRow = opts.createDiv({ cls: "it-fields-opt-row" });
            prRow.createSpan({ cls: "it-field-label", text: t("customize.progress") });
            const pcb = prRow.createEl("input", { type: "checkbox" });
            pcb.checked = this.state.ganttShowProgress;
            pcb.addEventListener("change", () => { this.state.ganttShowProgress = pcb.checked; this.persistFiltersForCurrentLocation(); this.refreshContent(); });
          }

          if (view === "timeline") {
            const usRow = opts.createDiv({ cls: "it-fields-opt-row" });
            usRow.createSpan({ cls: "it-field-label", text: t("customize.showUnscheduled") });
            const cb = usRow.createEl("input", { type: "checkbox" });
            cb.checked = !!tctx.showUnscheduled;
            cb.addEventListener("change", () => { this.state.timelineShowUnscheduled = cb.checked; this.persistFiltersForCurrentLocation(); this.refreshContent(); });
          }

          wrap.createDiv({ cls: "it-popover-sep" });
        }

        const listEl = wrap.createDiv({ cls: "it-fields-customizer-list" });

        const hidden = available.filter((f) => !visible.includes(f));

        const addRow = (f: string, shown: boolean, i: number) => {
          const row = listEl.createDiv({ cls: "it-fields-row" });
          const cb = row.createEl("input", { type: "checkbox" });
          cb.checked = shown;
          cb.addEventListener("change", () => {
            if (cb.checked) { if (!visible.includes(f)) visible.push(f); }
            else visible = visible.filter((x) => x !== f);
            commit(); render();
          });
          renderFieldIcon(row, f, cfs); // colored field-type icon (built-in or custom)
          row.createSpan({ cls: "it-fields-label", text: labelFor(f) });
          if (shown) {
            const up = row.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { type: "button", "aria-label": t("customize.moveUp") } });
            setIcon(up, "chevron-up");
            up.toggleClass("is-disabled", i === 0);
            up.addEventListener("click", () => { if (i > 0) { [visible[i - 1], visible[i]] = [visible[i], visible[i - 1]]; commit(); render(); } });
            const down = row.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { type: "button", "aria-label": t("customize.moveDown") } });
            setIcon(down, "chevron-down");
            down.toggleClass("is-disabled", i === visible.length - 1);
            down.addEventListener("click", () => { if (i < visible.length - 1) { [visible[i + 1], visible[i]] = [visible[i], visible[i + 1]]; commit(); render(); } });
          }
        };

        visible.forEach((f, i) => addRow(f, true, i));
        if (hidden.length) {
          listEl.createDiv({ cls: "it-popover-sep" });
          hidden.forEach((f) => addRow(f, false, -1));
        }

        // Persistence footer
        const footer = wrap.createDiv({ cls: "it-fields-customizer-footer" });
        footer.createDiv({ cls: "setting-item-description", text: t("customize.footer") });
        const row = footer.createDiv({ cls: "it-fields-default-row" });
        row.createSpan({ text: t("customize.setDefaultFor"), cls: "it-field-label" });
        for (const lvl of this.applicableScopeLevels()) {
          const b = row.createEl("button", { cls: "it-btn-secondary it-btn-mini", text: lvl.label, attr: { type: "button" } });
          b.addEventListener("click", async () => {
            const eff = this.tasksContext() as any;
            const patch: ViewDefaults = { visible_fields: visible.slice() };
            if ((isCalendar || isTimeView) && typeof eff.calendarColorBy === "string") patch.color_by = eff.calendarColorBy;
            if ((isCalendar || isTimeView) && typeof eff.dateField === "string") patch.date_field = eff.dateField;
            if (isTimeView && typeof eff.startField === "string") patch.start_date_field = eff.startField;
            if (view === "timeline") patch.show_unscheduled = !!eff.showUnscheduled;
            if (isChipView) { patch.cf_show_name = !!eff.cfShowName; patch.cf_show_when_empty = !!eff.cfShowWhenEmpty; }
            if (isFieldIconView) patch.cf_show_type_icon = !!eff.cfShowTypeIcon;
            try {
              await this.plugin.index.setScopeViewDefaults(lvl.level, lvl.path, view, patch);
              new Notice(t("main.defaultSet", { label: lvl.label }));
            } catch (err: any) {
              new Notice(t("common.failed", { msg: err.message }));
            }
          });
        }
      };
      render();
    });
  }

  private applyView(v: ViewConfig) {
    this.activeDocId = undefined;
    this.activeDocPageId = undefined;
    this.applyViewToState(v);
    this.activeViewId = v.view_id;
    this.applyingView = true;
    this.persistFiltersForCurrentLocation();
    this.applyingView = false;
    this.fullRender();
  }

  // Open a favorited saved view from the sidebar: navigate to the view's own
  // location first (it may live elsewhere than the current one), then apply it.
  // `selectLocation` already pushes history + applies persisted filters, so we
  // only navigate when actually changing location to avoid a redundant render.
  openSavedView(v: ViewConfig) {
    const targetKey = v.location || "everything";
    if (locationKey(this.state.location) !== targetKey) {
      this.selectLocation(locationFromKey(targetKey));
    }
    this.applyView(v);
  }

  // Open a favorite by its stored path — dispatches by kind (list/doc → location,
  // saved view → apply). Shared by the bottom favorites bar and the right panel.
  openFavorite(path: string) {
    const idx = this.plugin.index;
    if (idx.findList(path)) this.selectLocation({ kind: "list", path });
    else if (idx.docByPath(path)) this.selectLocation({ kind: "doc", path });
    else if (idx.tasksById.has(path)) {
      // Land on the task's home list for context, then open the task modal.
      const tf = idx.tasksById.get(path)!;
      if (tf.listPath) this.selectLocation({ kind: "list", path: tf.listPath });
      new TaskModal(this.app, this.plugin, tf).open();
    } else {
      const v = idx.viewByPath(path);
      if (v) this.openSavedView(v);
    }
  }

  // Resolve a deep link's element (by stable id) and navigate to it. Assumes the
  // correct vault + plugin workspace are already active (the protocol handler
  // switches those first). Returns false when the id no longer resolves so the
  // caller can surface a "not found" notice.
  navigateToElement(link: DeepLinkParams): boolean {
    const idx = this.plugin.index;
    switch (link.kind) {
      case "workspace":
        this.selectLocation({ kind: "everything" });
        return true;
      case "space": {
        const s = link.id ? idx.spaceById(link.id) : undefined;
        if (!s) return false;
        this.selectLocation({ kind: "space", path: s.path });
        return true;
      }
      case "folder": {
        const f = link.id ? idx.folderById(link.id) : undefined;
        if (!f) return false;
        this.selectLocation({ kind: "folder", path: f.path });
        return true;
      }
      case "list": {
        const l = link.id ? idx.listById(link.id) : undefined;
        if (!l) return false;
        this.selectLocation({ kind: "list", path: l.path });
        return true;
      }
      case "view": {
        const v = link.id ? idx.viewById(link.id) : undefined;
        if (!v) return false;
        this.openSavedView(v);
        return true;
      }
      case "doc": {
        const d = link.id ? idx.docById(link.id) : undefined;
        if (!d || !d.__path) return false;
        this.openDocLocation(d.__path, link.page);
        return true;
      }
      case "task": {
        const tf = link.id ? idx.tasksById.get(link.id) : undefined;
        if (!tf) return false;
        // Land on the task's home list for context, then open the task modal.
        if (tf.listPath) this.selectLocation({ kind: "list", path: tf.listPath });
        new TaskModal(this.app, this.plugin, tf).open();
        return true;
      }
    }
    return false;
  }

  // Mutates state from a saved view (no persist/render — caller decides).
  private applyViewToState(v: ViewConfig) {
    if (v.type) this.state.viewType = v.type;
    if (v.group_by && v.group_by.field) {
      this.state.groupBy = v.group_by.field;
      this.state.groupDirection = v.group_by.direction || "asc";
    } else {
      this.state.groupBy = "";
    }
    this.state.subGroupBy = v.sub_group_by?.field || undefined;
    if (Array.isArray(v.sort_by)) this.state.sortBy = v.sort_by;
    this.state.filters = v.filters;
    // Restore the view's field set (+ order), or fall back to config defaults.
    this.state.visibleFields = Array.isArray(v.visible_fields) ? v.visible_fields.slice() : undefined;
    // Each saved view carries its own footer/summary calculations — apply them
    // to this view's type, replacing whatever was active (clearing if the view
    // defines none, so the footer reflects exactly the saved view).
    if (v.type === "list" || v.type === "table") {
      const next = { ...(this.state.columnCalcs || {}) };
      if (v.column_calcs && Object.keys(v.column_calcs).length) next[v.type] = { ...v.column_calcs };
      else delete next[v.type];
      this.state.columnCalcs = next;
      const collapsed = { ...(this.state.collapsedGroups || {}) };
      if (v.collapsed_groups?.length) collapsed[v.type] = v.collapsed_groups.slice();
      else delete collapsed[v.type];
      this.state.collapsedGroups = collapsed;
    }
    // Table column widths (resize) — replace with the saved view's, or reset to
    // defaults when the view defines none. Column order rides along in
    // visible_fields above.
    if (v.type === "table") {
      this.state.tableColWidths = !Platform.isMobile && v.table_col_widths && Object.keys(v.table_col_widths).length ? { ...v.table_col_widths } : {};
    }
    // Calendar + board/calendar chip appearance overrides. `calendarColorBy`
    // doubles as the Timeline bar tint, so honor either field when present.
    this.state.calendarColorBy = typeof v.calendar_color_by === "string" ? v.calendar_color_by
      : (typeof v.timeline_color_by === "string" ? v.timeline_color_by : undefined);
    // Date sources — each view type saves under its own key; the transient
    // state slot is shared (reset on view-type switch, so no cross-leak).
    this.state.dateField = typeof v.calendar_date_field === "string" ? v.calendar_date_field
      : (typeof v.timeline_date_field === "string" ? v.timeline_date_field
      : (typeof v.gantt_date_field === "string" ? v.gantt_date_field : undefined));
    this.state.startField = typeof v.timeline_start_field === "string" ? v.timeline_start_field
      : (typeof v.gantt_start_field === "string" ? v.gantt_start_field : undefined);
    if (v.calendar_default_period) {
      // The compact overview is mobile-only; never restore it on desktop (it has
      // no tab there and the renderer would draw nothing).
      const p = v.calendar_default_period;
      this.state.calendarPeriod = p;
    }
    this.state.cfShowName = typeof v.cf_show_name === "boolean" ? v.cf_show_name : undefined;
    this.state.cfShowWhenEmpty = typeof v.cf_show_when_empty === "boolean" ? v.cf_show_when_empty : undefined;
    this.state.cfShowTypeIcon = typeof v.cf_show_type_icon === "boolean" ? v.cf_show_type_icon : undefined;
    // Time-based views: zoom + Gantt toggles. ("flexible" maps onto month.)
    if (v.gantt_time_period) this.state.ganttZoom = (v.gantt_time_period === "flexible" ? "month" : v.gantt_time_period) as TimeZoom;
    if (typeof v.gantt_show_dependencies === "boolean") this.state.ganttShowDependencies = v.gantt_show_dependencies;
    if (typeof v.gantt_show_progress === "boolean") this.state.ganttShowProgress = v.gantt_show_progress;
    if (v.type === "gantt") this.state.ganttRailWidth = normalizeTimeRailWidth(v.gantt_rail_width, GANTT_RAIL_DEFAULT_W);
    if (v.timeline_zoom) this.state.timelineZoom = v.timeline_zoom as TimeZoom;
    if (v.type === "timeline") this.state.timelineRailWidth = normalizeTimeRailWidth(v.timeline_rail_width, TIMELINE_RAIL_DEFAULT_W);
    this.state.timelineShowUnscheduled = typeof v.timeline_show_unscheduled === "boolean" ? v.timeline_show_unscheduled : undefined;
    const lo = v.layout_options;
    if (lo) {
      if (typeof lo.show_closed === "boolean") this.state.showClosed = lo.show_closed;
      if (lo.subtask_mode) this.state.subtaskMode = normalizeSubtaskMode(lo.subtask_mode);
    }
  }

  // The fields currently driving the view: the active override if set,
  // otherwise the resolved (inherited) view_defaults for this location+type.
  private effectiveVisibleFields(): string[] {
    if (this.state.visibleFields) return this.state.visibleFields.slice();
    const resolved = this.plugin.index.resolveViewDefaultsForLocation(this.state.viewType, this.state.location);
    return (resolved.visible_fields || []).slice();
  }

  // Column calculations for the current view type — captured into a saved view
  // so each view carries its own. Returns undefined when none are set (so the
  // frontmatter stays clean and applying the view shows an empty footer).
  private currentViewCalcs(): Record<string, import("../types").ColumnCalc> | undefined {
    const cur = this.state.columnCalcs?.[this.state.viewType];
    return cur && Object.keys(cur).length ? { ...cur } : undefined;
  }

  // Table column widths captured into a saved view. Table-only; undefined when
  // none set so the frontmatter stays clean and applying uses default widths.
  private currentViewColWidths(): Record<string, number> | undefined {
    if (Platform.isMobile) return undefined;
    if (this.state.viewType !== "table") return undefined;
    const w = this.state.tableColWidths;
    return w && Object.keys(w).length ? { ...w } : undefined;
  }

  private currentViewConfig(name: string): ViewConfig {
    const isCal = this.state.viewType === "calendar";
    const isChipView = isCal || this.state.viewType === "board";
    const isFieldIconView = ["list", "table", "board", "calendar"].includes(this.state.viewType);
    const ctx = this.tasksContext() as any;
    const view: ViewConfig = {
      view_id: "VW-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      name,
      type: this.state.viewType,
      location: locationKey(this.state.location),
      group_by: this.state.groupBy ? { field: this.state.groupBy, direction: this.state.groupDirection } : undefined,
      sub_group_by: this.state.subGroupBy ? { field: this.state.subGroupBy } : undefined,
      sort_by: this.state.sortBy,
      filters: this.state.filters,
      visible_fields: this.effectiveVisibleFields(),
      // Footer/summary calculations for this view's own type (List/Table).
      column_calcs: this.currentViewCalcs(),
      collapsed_groups: (this.state.viewType === "list" || this.state.viewType === "table")
        ? this.state.collapsedGroups?.[this.state.viewType]?.slice()
        : undefined,
      layout_options: { show_closed: this.state.showClosed, subtask_mode: this.state.subtaskMode },
      // Calendar pill color + period; chip name/empty toggles (board + calendar).
      calendar_color_by: isCal ? (ctx.calendarColorBy ?? undefined) : undefined,
      calendar_date_field: isCal ? (ctx.dateField ?? undefined) : undefined,
      calendar_default_period: isCal ? this.state.calendarPeriod : undefined,
      cf_show_name: isChipView ? !!ctx.cfShowName : undefined,
      cf_show_when_empty: isChipView ? !!ctx.cfShowWhenEmpty : undefined,
      cf_show_type_icon: isFieldIconView ? !!ctx.cfShowTypeIcon : undefined,
      // Gantt + Timeline specifics — only emitted for the matching view type.
      gantt_time_period: this.state.viewType === "gantt" ? this.state.ganttZoom : undefined,
      gantt_show_dependencies: this.state.viewType === "gantt" ? this.state.ganttShowDependencies : undefined,
      gantt_show_progress: this.state.viewType === "gantt" ? this.state.ganttShowProgress : undefined,
      gantt_rail_width: this.state.viewType === "gantt" ? this.state.ganttRailWidth : undefined,
      gantt_date_field: this.state.viewType === "gantt" ? (ctx.dateField ?? undefined) : undefined,
      gantt_start_field: this.state.viewType === "gantt" ? (ctx.startField ?? undefined) : undefined,
      timeline_zoom: this.state.viewType === "timeline" ? this.state.timelineZoom : undefined,
      timeline_rail_width: this.state.viewType === "timeline" ? this.state.timelineRailWidth : undefined,
      timeline_color_by: this.state.viewType === "timeline" ? (ctx.colorBy ?? undefined) : undefined,
      timeline_date_field: this.state.viewType === "timeline" ? (ctx.dateField ?? undefined) : undefined,
      timeline_start_field: this.state.viewType === "timeline" ? (ctx.startField ?? undefined) : undefined,
      timeline_group_by: this.state.viewType === "timeline" ? (this.state.groupBy || "status") : undefined,
      timeline_show_unscheduled: this.state.viewType === "timeline" ? !!ctx.showUnscheduled : undefined,
    };
    const tableColWidths = this.currentViewColWidths();
    if (tableColWidths) view.table_col_widths = tableColWidths;
    return view;
  }

  private saveLocationArg(): { listPath?: string; folderPath?: string; spacePath?: string; rootPath?: string } {
    const loc = this.state.location;
    if (loc.kind === "list") return { listPath: loc.path };
    if (loc.kind === "folder") return { folderPath: loc.path };
    if (loc.kind === "space") return { spacePath: loc.path };
    return { rootPath: this.plugin.index.rootPath };
  }

  private showSaveViewPopover(e: MouseEvent) {
    this.promptViewName(e.currentTarget as HTMLElement, "", async (name) => {
      try {
        await this.plugin.index.saveView(this.currentViewConfig(name), this.saveLocationArg());
        new Notice(t("main.viewSaved", { name }));
      } catch (err: any) {
        new Notice(t("main.viewSaveFailed", { msg: err.message }));
      }
    });
  }

  private showViewMenu(e: MouseEvent, v: ViewConfig, canLeft: boolean, canRight: boolean) {
    const anchor = e.target as HTMLElement;
    const items: any[] = [];
    if (canLeft) items.push({ label: t("action.moveLeft"), icon: "arrow-left", onClick: () => this.moveBarItem("view", v.view_id, -1) });
    if (canRight) items.push({ label: t("action.moveRight"), icon: "arrow-right", onClick: () => this.moveBarItem("view", v.view_id, 1) });
    if (canLeft || canRight) items.push("separator");
    items.push({ label: v.default ? t("action.unsetDefault") : t("action.setDefault"), icon: "star",
      onClick: () => v.default
        ? this.plugin.index.updateView(v.view_id, { default: false })
        : this.plugin.index.setViewsBarDefault(v.location || locationKey(this.state.location), "view", v.view_id) });
    items.push({ label: t("action.updateView"), icon: "save", onClick: async () => {
        const patch = this.currentViewConfig(v.name);
        delete (patch as any).view_id;
        await this.plugin.index.updateView(v.view_id, patch);
        new Notice(t("main.viewUpdated", { name: v.name }));
      } });
    items.push({ label: menuLabel("rename"), icon: "pencil", onClick: () => {
        this.promptViewName(anchor, v.name, (name) => this.plugin.index.updateView(v.view_id, { name }));
      } });
    items.push({ label: menuLabel("copyLink"), icon: "link", onClick: () => this.plugin.copyElementLink("view", v.view_id) });
    if (v.__path) {
      items.push("separator");
      items.push(...favoriteToggleItems(this.plugin, v.__path));
    }
    items.push("separator");
    items.push({ label: t("action.deleteView"), icon: "trash", danger: true, onClick: () => this.plugin.index.deleteView(v.view_id) });
    showContextMenu(e, items);
  }

  // ---------- Docs ----------

  private docDragPageId?: string;

  private openDoc(docId: string, pageId?: string) {
    this.pushHistory();
    this.activeDocId = docId;
    this.activeViewId = undefined;
    const pages = this.plugin.index.pagesForDoc(docId);
    if (pageId && pages.some((p) => p.page_id === pageId)) this.activeDocPageId = pageId;
    else this.activeDocPageId = this.docOrderedSiblings(pages, null)[0]?.page_id;
    this.fullRender();
  }

  // Open a Doc as a location (from search / a task's doc link), optionally on a
  // specific page. `reopenTaskId` lets Back return to the task you came from.
  openDocLocation(docPath: string, pageId?: string, reopenTaskId?: string) {
    this.pushHistory(reopenTaskId);
    this.selectLocation({ kind: "doc", path: docPath }, { history: false });
    if (pageId) { this.activeDocPageId = pageId; this.refreshContent(); }
  }

  private showAddDocPopover(e: MouseEvent) {
    const docColor = resolveViewColorSet(this.plugin.prefs.viewColorScheme, this.plugin.prefs.viewColors)[VIEW_COLOR_INDEX.doc];
    this.promptViewName(e.currentTarget as HTMLElement, "", async (name) => {
      try {
        const id = await this.plugin.index.createDoc(name, this.saveLocationArg(), locationKey(this.state.location), { color: docColor });
        new Notice(t("main.docCreated", { name }));
        this.openDoc(id);
      } catch (err: any) {
        new Notice(t("main.docCreateFailed", { msg: err.message }));
      }
    }, t("main.docName"));
  }

  private showDocMenu(e: MouseEvent, d: DocMeta, canLeft: boolean, canRight: boolean) {
    const anchor = e.target as HTMLElement;
    const items: any[] = [];
    items.push({ label: t("action.open"), icon: "book-open", onClick: () => this.openDoc(d.doc_id) });
    if (canLeft || canRight) items.push("separator");
    if (canLeft) items.push({ label: t("action.moveLeft"), icon: "arrow-left", onClick: () => this.moveBarItem("doc", d.doc_id, -1) });
    if (canRight) items.push({ label: t("action.moveRight"), icon: "arrow-right", onClick: () => this.moveBarItem("doc", d.doc_id, 1) });
    items.push("separator");
    items.push({ label: d.default ? t("action.unsetDefault") : t("action.setDefault"), icon: "star",
      onClick: () => d.default
        ? this.plugin.index.updateDoc(d.doc_id, { default: false })
        : this.plugin.index.setViewsBarDefault(d.location || locationKey(this.state.location), "doc", d.doc_id) });
    items.push({ label: menuLabel("rename"), icon: "pencil", onClick: () => this.promptViewName(anchor, d.name, (name) => this.plugin.index.updateDoc(d.doc_id, { name }), t("main.docName")) });
    items.push({ label: menuLabel("move"), icon: "folder-input", onClick: () => new MoveDocModal(this.app, this.plugin, d.doc_id).open() });
    items.push({ label: menuLabel("copyLink"), icon: "link", onClick: () => this.plugin.copyElementLink("doc", d.doc_id) });
    items.push({ label: menuLabel("copyId"), icon: "fingerprint", onClick: () => this.plugin.copyTextToClipboard(d.doc_id) });
    if (d.__path) {
      items.push("separator");
      items.push(...favoriteToggleItems(this.plugin, d.__path));
    }
    items.push("separator");
    items.push({ label: t("action.deleteDoc"), icon: "trash", danger: true, onClick: () => {
          new ConfirmModal(this.app, {
            title: t("docsMgr.deleteTitle"),
            message: t("main.deleteDocMsg", { name: d.name }),
            destructive: true,
            onConfirm: async () => {
              if (this.activeDocId === d.doc_id) { this.activeDocId = undefined; this.activeDocPageId = undefined; }
              await this.plugin.index.deleteDoc(d.doc_id);
              new Notice(t("docsMgr.deleted", { name: d.name }));
            },
          }).open();
        } });
    showContextMenu(e, items);
  }

  // Siblings of a parent (null = top level), in display order.
  private docOrderedSiblings(pages: DocPage[], parent: string | null): DocPage[] {
    return pages
      .filter((p) => (p.parent_page ?? null) === parent)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
  }

  // Ancestor chain (root → page) for the breadcrumb.
  private docPagePath(pages: DocPage[], page: DocPage): DocPage[] {
    const chain: DocPage[] = [];
    let cur: DocPage | undefined = page;
    const seen = new Set<string>();
    while (cur) {
      chain.unshift(cur);
      const parentId: string | null | undefined = cur.parent_page;
      if (!parentId || seen.has(parentId)) break;
      seen.add(parentId);
      cur = pages.find((p) => p.page_id === parentId);
    }
    return chain;
  }

  // Would moving `childId` under `candidateParentId` create a cycle?
  private docWouldCycle(pages: DocPage[], childId: string, candidateParentId: string): boolean {
    if (childId === candidateParentId) return true;
    let cur: DocPage | undefined = pages.find((p) => p.page_id === candidateParentId);
    const seen = new Set<string>();
    while (cur && cur.parent_page) {
      if (cur.parent_page === childId) return true;
      if (seen.has(cur.parent_page)) break;
      seen.add(cur.parent_page);
      cur = pages.find((p) => p.page_id === cur!.parent_page);
    }
    return false;
  }

  private renderDocView(parent: HTMLElement, doc: DocMeta) {
    const pages = this.plugin.index.pagesForDoc(doc.doc_id);
    if (!this.activeDocPageId || !pages.some((p) => p.page_id === this.activeDocPageId)) {
      this.activeDocPageId = this.docOrderedSiblings(pages, null)[0]?.page_id;
    }
    const wrap = parent.createDiv({ cls: "it-doc-wrap" + (this.docExplorerHidden ? " explorer-hidden" : "") });

    // ---- Explorer rail ----
    if (!this.docExplorerHidden) {
      const rail = wrap.createDiv({ cls: "it-doc-explorer" });
      const head = rail.createDiv({ cls: "it-doc-explorer-head" });
      const dic = head.createSpan({ cls: "it-doc-explorer-icon" });
      setIcon(dic, doc.icon || DOC_ICON);
      dic.style.color = doc.color || DOC_ACCENT;
      head.createSpan({ cls: "it-doc-explorer-name", text: doc.name });
      head.createDiv({ cls: "it-flex-grow" });
      const addTop = head.createEl("button", { cls: "it-icon-btn", attr: { type: "button", title: t("doc.addPage"), "aria-label": t("doc.addPage") } });
      setIcon(addTop, "file-plus");
      addTop.addEventListener("click", async () => {
        const id = await this.plugin.index.createPage(doc.doc_id, { title: t("common.untitled") });
        if (id) { this.activeDocPageId = id; this.refreshContent(); }
      });
      const hide = head.createEl("button", { cls: "it-icon-btn", attr: { type: "button", title: t("doc.hideExplorer"), "aria-label": t("doc.hideExplorer") } });
      setIcon(hide, "panel-left-close");
      hide.addEventListener("click", () => { this.docExplorerHidden = true; this.refreshContent(); });

      const tree = rail.createDiv({ cls: "it-doc-tree" });
      const top = this.docOrderedSiblings(pages, null);
      if (top.length === 0) tree.createDiv({ cls: "it-empty-row", text: t("doc.noPages") });
      for (const p of top) this.renderDocPageRow(tree, doc, pages, p, 0);
      // Dropping on empty tree space → move dragged page to the top level.
      tree.addEventListener("dragover", (ev) => { if (this.docDragPageId && ev.target === tree) { ev.preventDefault(); tree.addClass("it-doc-drop-root"); } });
      tree.addEventListener("dragleave", () => tree.removeClass("it-doc-drop-root"));
      tree.addEventListener("drop", (ev) => {
        tree.removeClass("it-doc-drop-root");
        if (ev.target !== tree) return;
        const src = this.docDragPageId; this.docDragPageId = undefined;
        if (src) void this.reparentDocPage(doc, src, null);
      });
    }

    // ---- Page pane ----
    const docMain = wrap.createDiv({ cls: "it-doc-main" });
    const toolbar = docMain.createDiv({ cls: "it-doc-toolbar" });
    if (this.docExplorerHidden) {
      const show = toolbar.createEl("button", { cls: "it-icon-btn", attr: { type: "button", title: t("doc.showExplorer"), "aria-label": t("doc.showExplorer") } });
      setIcon(show, "panel-left-open");
      show.addEventListener("click", () => { this.docExplorerHidden = false; this.refreshContent(); });
    }
    const page = this.activeDocPageId ? this.plugin.index.pageById(this.activeDocPageId) : undefined;
    const crumb = toolbar.createDiv({ cls: "it-doc-crumb" });
    if (page) {
      const path = this.docPagePath(pages, page);
      path.forEach((node, i) => {
        if (i > 0) crumb.createSpan({ cls: "it-doc-crumb-sep", text: "/" });
        const seg = crumb.createSpan({ cls: "it-doc-crumb-seg" + (node.page_id === page.page_id ? " is-current" : "") });
        setIcon(seg.createSpan({ cls: "it-doc-crumb-ic" }), node.icon || DOC_PAGE_ICON);
        seg.createSpan({ text: node.title });
        if (node.page_id !== page.page_id) seg.addEventListener("click", () => this.selectDocPage(node.page_id));
      });
    }
    toolbar.createDiv({ cls: "it-flex-grow" });
    if (page) {
      const addSub = toolbar.createEl("button", {
        cls: "it-doc-tool-btn",
        attr: { type: "button", title: t("common.addSubpage"), "aria-label": t("common.addSubpage") },
      });
      setIcon(addSub.createSpan({ cls: "it-doc-tool-ic" }), "file-plus");
      addSub.createSpan({ cls: "it-doc-tool-label", text: t("doc.subpage") });
      addSub.addEventListener("click", async () => {
        const id = await this.plugin.index.createPage(doc.doc_id, { title: t("common.untitled"), parent_page: page.page_id });
        if (id) { this.docCollapsed.delete(page.page_id); this.activeDocPageId = id; this.refreshContent(); }
      });
      const edit = toolbar.createEl("button", {
        cls: "it-doc-tool-btn",
        attr: { type: "button", title: t("doc.editObsidian"), "aria-label": t("doc.editObsidian") },
      });
      setIcon(edit.createSpan({ cls: "it-doc-tool-ic" }), "pencil");
      edit.createSpan({ cls: "it-doc-tool-label", text: t("common.edit") });
      edit.addEventListener("click", () => this.openPageInObsidian(page));
    }

    // ---- Content (preview) ----
    const content = docMain.createDiv({ cls: "it-doc-content markdown-rendered" });
    if (!page) {
      content.createDiv({ cls: "it-empty-row", text: t("doc.selectPage") });
      return;
    }
    const body = (page.__body || "").trim();
    if (!body) {
      content.createDiv({ cls: "it-empty-row", text: t("doc.emptyPage") });
      return;
    }
    void MarkdownRenderer.render(this.app, body, content, page.__path || "", this);
  }

  private renderDocPageRow(parent: HTMLElement, doc: DocMeta, pages: DocPage[], page: DocPage, depth: number) {
    const children = this.docOrderedSiblings(pages, page.page_id);
    const hasChildren = children.length > 0;
    const collapsed = this.docCollapsed.has(page.page_id);

    const row = parent.createDiv({ cls: "it-doc-page-row" + (this.activeDocPageId === page.page_id ? " is-active" : "") });
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.style.setProperty("--node-color", page.color || doc.color || DOC_ACCENT);
    row.setAttr("draggable", "true");

    const tw = row.createSpan({ cls: "it-doc-twisty" });
    if (hasChildren) {
      setIcon(tw, collapsed ? "chevron-right" : "chevron-down");
      tw.addEventListener("click", (e) => {
        e.stopPropagation();
        if (collapsed) this.docCollapsed.delete(page.page_id); else this.docCollapsed.add(page.page_id);
        this.refreshContent();
      });
    }
    const ic = row.createSpan({ cls: "it-doc-page-icon it-doc-page-icon-btn", attr: { role: "button", title: t("doc.changeIconColor"), "aria-label": t("doc.changeIconColor") } });
    setIcon(ic, page.icon || DOC_PAGE_ICON);
    if (page.color) ic.style.color = page.color;
    ic.addEventListener("click", (e) => {
      e.stopPropagation();
      showContextMenu(e, [
        { label: t("action.changeIcon"), icon: "image", onClick: () => openIconPicker(ic, page.icon, (v) => this.plugin.index.updatePage(page.page_id, { icon: v })) },
        { label: t("action.changeColor"), icon: "palette", onClick: () => openColorPicker(ic, page.color, (v) => this.plugin.index.updatePage(page.page_id, { color: v })) },
      ]);
    });
    row.createSpan({ cls: "it-doc-page-title", text: page.title });
    const more = row.createSpan({ cls: "it-doc-page-more", attr: { role: "button", "aria-label": t("doc.pageOptions") } });
    setIcon(more, "more-horizontal");
    more.addEventListener("click", (e) => { e.stopPropagation(); this.showPageMenu(e, doc, page); });

    row.addEventListener("click", () => this.selectDocPage(page.page_id));

    // Drag to re-parent (drop a page onto another → becomes its child).
    row.addEventListener("dragstart", (e) => { this.docDragPageId = page.page_id; e.dataTransfer?.setData("text/plain", page.page_id); row.addClass("is-dragging"); });
    row.addEventListener("dragend", () => { this.docDragPageId = undefined; row.removeClass("is-dragging"); });
    row.addEventListener("dragover", (e) => {
      if (this.docDragPageId && this.docDragPageId !== page.page_id && !this.docWouldCycle(pages, this.docDragPageId, page.page_id)) {
        e.preventDefault();
        row.addClass("it-doc-drop-target");
      }
    });
    row.addEventListener("dragleave", () => row.removeClass("it-doc-drop-target"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.removeClass("it-doc-drop-target");
      const src = this.docDragPageId; this.docDragPageId = undefined;
      if (src && src !== page.page_id) void this.reparentDocPage(doc, src, page.page_id);
    });

    if (hasChildren && !collapsed) for (const ch of children) this.renderDocPageRow(parent, doc, pages, ch, depth + 1);
  }

  private selectDocPage(pageId: string) {
    this.activeDocPageId = pageId;
    this.refreshContent();
  }

  private showPageMenu(e: MouseEvent, doc: DocMeta, page: DocPage) {
    const anchor = e.target as HTMLElement;
    showContextMenu(e, [
      { label: t("common.addSubpage"), icon: "file-plus", onClick: async () => {
          const id = await this.plugin.index.createPage(doc.doc_id, { title: t("common.untitled"), parent_page: page.page_id });
          if (id) { this.docCollapsed.delete(page.page_id); this.activeDocPageId = id; this.refreshContent(); }
        } },
      { label: menuLabel("rename"), icon: "pencil", onClick: () => this.promptViewName(anchor, page.title, (title) => this.plugin.index.updatePage(page.page_id, { title }), t("main.pageTitle")) },
      { label: t("action.changeIcon"), icon: "image", onClick: () => openIconPicker(anchor, page.icon, (v) => this.plugin.index.updatePage(page.page_id, { icon: v })) },
      { label: t("action.changeColor"), icon: "palette", onClick: () => openColorPicker(anchor, page.color, (v) => this.plugin.index.updatePage(page.page_id, { color: v })) },
      { label: t("action.openEditor"), icon: "external-link", onClick: () => this.openPageInObsidian(page) },
      { label: menuLabel("copyLink"), icon: "link", onClick: () => this.plugin.copyElementLink("doc", doc.doc_id, page.page_id) },
      { label: menuLabel("copyId"), icon: "fingerprint", onClick: () => this.plugin.copyTextToClipboard(page.page_id) },
      "separator",
      { label: t("action.moveUp"), icon: "arrow-up", onClick: () => this.moveDocPage(doc, page, -1) },
      { label: t("action.moveDown"), icon: "arrow-down", onClick: () => this.moveDocPage(doc, page, 1) },
      { label: t("action.movePageToDoc"), icon: "folder-input", onClick: () => {
          new DocPickerModal(this.app, this.plugin, {
            title: t("main.movePageTitle", { title: page.title }),
            multi: false,
            excludeIds: [doc.doc_id],
            confirmLabel: menuLabel("move"),
            onPick: async (picked) => {
              const target = picked[0];
              if (!target) return;
              try {
                if (this.activeDocPageId === page.page_id) this.activeDocPageId = undefined;
                await this.plugin.index.movePageToDoc(page.page_id, target);
                new Notice(t("main.pageMoved"));
              } catch (err: any) { new Notice(t("common.failed", { msg: err.message })); }
            },
          }).open();
        } },
      "separator",
      { label: t("action.deletePage"), icon: "trash", danger: true, onClick: () => {
          new ConfirmModal(this.app, {
            title: t("main.deletePageTitle"),
            message: t("main.deletePageMsg", { title: page.title }),
            destructive: true,
            onConfirm: async () => {
              if (this.activeDocPageId === page.page_id) this.activeDocPageId = undefined;
              await this.plugin.index.deletePage(page.page_id);
            },
          }).open();
        } },
    ]);
  }

  private async moveDocPage(doc: DocMeta, page: DocPage, dir: -1 | 1) {
    const pages = this.plugin.index.pagesForDoc(doc.doc_id);
    const sibs = this.docOrderedSiblings(pages, page.parent_page ?? null);
    const idx = sibs.findIndex((p) => p.page_id === page.page_id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= sibs.length) return;
    const order = sibs.map((p) => p.page_id);
    [order[idx], order[swap]] = [order[swap], order[idx]];
    await this.plugin.index.reorderSiblings(order);
  }

  private async reparentDocPage(doc: DocMeta, srcId: string, newParent: string | null) {
    const pages = this.plugin.index.pagesForDoc(doc.doc_id);
    if (newParent && this.docWouldCycle(pages, srcId, newParent)) return;
    if (newParent) this.docCollapsed.delete(newParent);
    await this.plugin.index.updatePage(srcId, { parent_page: newParent });
  }

  private openPageInObsidian(page: DocPage) {
    if (!page.__path) return;
    const f = this.app.vault.getAbstractFileByPath(page.__path);
    if (f instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(f);
  }

  private promptViewName(anchor: HTMLElement, initial: string, onName: (name: string) => void, placeholder = t("main.viewName")) {
    showPopover(anchor, (root) => {
      const wrap = root.createDiv({ cls: "it-view-name-popover" });
      const input = wrap.createEl("input", { type: "text", cls: "it-input" });
      input.placeholder = placeholder;
      input.value = initial;
      const close = () => document.querySelectorAll(".it-popover").forEach((el) => el.remove());
      const submit = () => {
        const name = input.value.trim();
        if (!name) return;
        close();
        onName(name);
      };
      const btn = wrap.createEl("button", { cls: "it-btn-primary", text: t("common.save") });
      btn.addEventListener("click", submit);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); submit(); }
        else if (ev.key === "Escape") { ev.preventDefault(); close(); }
      });
      requestAnimationFrame(() => input.focus());
    });
  }

  private showSubtaskMenu(e: MouseEvent) {
    showPopover(e.currentTarget as HTMLElement, (root) => {
      const wrap = root.createDiv({ cls: "it-popover-menu" });
      wrap.createDiv({ cls: "it-popover-heading", text: t("main.showSubtasksAs") });
      for (const m of getSubtaskModes()) {
        const row = wrap.createEl("button", { cls: "it-popover-item it-subtask-opt" + (this.state.subtaskMode === m.value ? " is-active" : "") });
        setIcon(row.createSpan({ cls: "it-popover-item-ic" }), m.icon);
        const txt = row.createDiv({ cls: "it-subtask-opt-text" });
        txt.createDiv({ cls: "it-subtask-opt-label", text: m.label });
        txt.createDiv({ cls: "it-subtask-opt-desc", text: m.desc });
        row.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.state.subtaskMode = m.value;
          this.persistFiltersForCurrentLocation();
          this.fullRender();
          document.querySelectorAll(".it-popover").forEach((el) => el.remove());
        });
      }
    });
  }

  private showGroupMenu(e: MouseEvent) {
    // `MouseEvent.currentTarget` is cleared as soon as the listener returns.
    // Keep this path synchronous (showPopover is already imported above), or a
    // deferred import will receive `null` and the toolbar button appears dead.
    const customFields = this.plugin.index.resolveCustomFieldsForLocation(this.state.location);
    const groupableCustomFields = customFields.filter((field) => !isSecretCustomFieldType(field.type));
    showPopover(e.currentTarget as HTMLElement, (root) => {
      const wrap = root.createDiv({ cls: "it-popover-menu" });
      if (this.state.groupBy) {
        this.renderDirectionRow(wrap, t("common.order"), this.state.groupDirection, (d) => {
          this.state.groupDirection = d;
          this.persistFiltersForCurrentLocation();
          this.fullRender();
          document.querySelectorAll(".it-popover").forEach((el) => el.remove());
        });
        wrap.createDiv({ cls: "it-popover-sep" });
      }
      const items = [
        { value: "status", label: this.fieldLabel("status") },
        { value: "priority", label: this.fieldLabel("priority") },
        { value: "tags", label: this.fieldLabel("tags") },
        { value: "context", label: this.fieldLabel("context") },
        { value: "due_date", label: this.fieldLabel("due_date") },
        { value: "start_date", label: this.fieldLabel("start_date") },
        { value: "type", label: this.fieldLabel("type") },
        { value: "list", label: this.fieldLabel("list") },
      ];
      for (const f of groupableCustomFields) {
        items.push({ value: `custom_field:${f.id}`, label: t("common.customSuffix", { name: f.name }) });
      }
      items.push({ value: "__none", label: t("action.noGrouping") });
      for (const it of items) {
        const row = wrap.createEl("button", { cls: "it-popover-item" + (this.state.groupBy === it.value ? " is-active" : "") });
        renderPickerItemLabel(row, it.value, it.label, customFields);
        row.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.state.groupBy = it.value === "__none" ? "" : it.value;
          this.persistFiltersForCurrentLocation();
          this.fullRender();
          document.querySelectorAll(".it-popover").forEach((el) => el.remove());
        });
      }

      // Swimlanes (Board only) — a second axis splitting columns into rows.
      if (this.state.viewType === "board") {
        const primary = this.state.groupBy || "status";
        wrap.createDiv({ cls: "it-popover-sep" });
        wrap.createDiv({ cls: "it-popover-heading", text: t("main.swimlanes") });
        const subItems = [
          { value: "", label: t("action.swimlanesNone") },
          { value: "status", label: this.fieldLabel("status") },
          { value: "priority", label: this.fieldLabel("priority") },
          { value: "tags", label: this.fieldLabel("tags") },
          { value: "context", label: this.fieldLabel("context") },
          { value: "type", label: this.fieldLabel("type") },
          ...groupableCustomFields.map((f) => ({ value: `custom_field:${f.id}`, label: t("common.customSuffix", { name: f.name }) })),
        ].filter((it) => it.value !== primary); // can't swimlane by the column axis
        const currentSub = this.state.subGroupBy || "";
        for (const it of subItems) {
          const row = wrap.createEl("button", { cls: "it-popover-item" + (currentSub === it.value ? " is-active" : "") });
          renderPickerItemLabel(row, it.value, it.label, customFields);
          row.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this.state.subGroupBy = it.value || undefined;
            this.persistFiltersForCurrentLocation();
            this.fullRender();
            document.querySelectorAll(".it-popover").forEach((el) => el.remove());
          });
        }
      }
    });
  }

  private showSortMenu(e: MouseEvent) {
    // See showGroupMenu: currentTarget must be consumed during the click.
    const primary = this.state.sortBy[0];
    const customFields = this.plugin.index.resolveCustomFieldsForLocation(this.state.location);
    const sortableCustomFields = customFields.filter((field) => !isSecretCustomFieldType(field.type));
    showPopover(e.currentTarget as HTMLElement, (root) => {
      const wrap = root.createDiv({ cls: "it-popover-menu" });
      this.renderDirectionRow(wrap, t("common.order"), primary?.direction || "asc", (d) => {
        const field = this.state.sortBy[0]?.field || "priority";
        this.state.sortBy = [{ field, direction: d }];
        this.persistFiltersForCurrentLocation();
        this.fullRender();
        document.querySelectorAll(".it-popover").forEach((el) => el.remove());
      });
      wrap.createDiv({ cls: "it-popover-sep" });
      const items = [
        { value: "priority", label: this.fieldLabel("priority") },
        { value: "start_date", label: this.fieldLabel("start_date") },
        { value: "due_date", label: this.fieldLabel("due_date") },
        { value: "title", label: this.fieldLabel("title") },
        { value: "created_at", label: this.fieldLabel("created_at") },
        { value: "updated_at", label: this.fieldLabel("updated_at") },
        { value: "status", label: this.fieldLabel("status") },
        { value: "context", label: this.fieldLabel("context") },
        { value: "tags", label: this.fieldLabel("tags") },
      ];
      for (const f of sortableCustomFields) {
        items.push({ value: `custom_field:${f.id}`, label: t("common.customSuffix", { name: f.name }) });
      }
      for (const it of items) {
        const row = wrap.createEl("button", { cls: "it-popover-item" + (primary?.field === it.value ? " is-active" : "") });
        renderPickerItemLabel(row, it.value, it.label, customFields);
        row.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const dir = this.state.sortBy[0]?.direction || "asc";
          this.state.sortBy = [{ field: it.value, direction: dir }];
          this.persistFiltersForCurrentLocation();
          this.fullRender();
          document.querySelectorAll(".it-popover").forEach((el) => el.remove());
        });
      }
    });
  }

  private renderDirectionRow(parent: HTMLElement, label: string, current: "asc" | "desc", onPick: (d: "asc" | "desc") => void) {
    const row = parent.createDiv({ cls: "it-popover-dir-row" });
    row.createSpan({ text: label, cls: "it-popover-dir-label" });
    const seg = row.createDiv({ cls: "it-tri-state" });
    for (const d of ["asc", "desc"] as const) {
      const btn = seg.createEl("button", {
        cls: "it-tri-state-btn" + (current === d ? " is-active" : ""),
        text: d === "asc" ? t("common.asc") : t("common.desc"),
        attr: { type: "button" },
      });
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onPick(d);
      });
    }
  }

  private renderEmptyState(parent: HTMLElement) {
    const e = parent.createDiv({ cls: "it-empty-state" });
    renderLogo(e, { size: 52, wordmark: true, cls: "it-empty-state-logo" });
    e.createEl("h2", { text: t("main.welcomeTitle") });
    e.createEl("p", { text: t("main.welcomeDesc") });
    const ctaRow = e.createDiv({ cls: "it-empty-state-cta" });
    const createBtn = ctaRow.createEl("button", { cls: "it-btn-primary", text: t("main.createFirstSpace") });
    createBtn.addEventListener("click", () => new CreateSpaceModal(this.app, this.plugin).open());
    const demoBtn = ctaRow.createEl("button", { cls: "it-btn-secondary", text: t("main.loadDemo") });
    demoBtn.addEventListener("click", () => void this.plugin.generateStartData());
  }

  private renderInitialLoadingState() {
    const container = this.contentEl;
    container.empty();
    container.addClass("inventtasks-content");
    const layout = container.createDiv({ cls: "it-layout" });
    if (Platform.isMobile) layout.addClass("is-mobile");
    const main = layout.createDiv({ cls: "it-main" });
    const body = main.createDiv({ cls: "it-main-body" });
    const loading = body.createDiv({
      cls: "it-initial-loading-state",
      attr: { role: "status", "aria-live": "polite", "aria-busy": "true" },
    });
    renderLogo(loading, { size: 52, wordmark: true, cls: "it-empty-state-logo" });
    loading.createDiv({ cls: "it-initial-loading-label", text: t("common.loading") });
    const track = loading.createDiv({ cls: "it-initial-loading-track", attr: { "aria-hidden": "true" } });
    track.createDiv({ cls: "it-initial-loading-bar" });
  }

  /** Welcome screen for the ZERO-workspaces state — same look as the regular
   *  empty state, but its CTA creates the first workspace (and the copy notes
   *  that Vault sync keeps working without one). */
  private renderNoWorkspaceState() {
    const container = this.contentEl;
    container.empty();
    container.addClass("inventtasks-content");
    const layout = container.createDiv({ cls: "it-layout" });
    if (Platform.isMobile) layout.addClass("is-mobile");
    const main = layout.createDiv({ cls: "it-main" });
    const body = main.createDiv({ cls: "it-main-body" });
    const e = body.createDiv({ cls: "it-empty-state" });
    renderLogo(e, { size: 52, wordmark: true, cls: "it-empty-state-logo" });
    e.createEl("h2", { text: t("main.noWorkspacesTitle") });
    e.createEl("p", { text: t("main.noWorkspacesDesc") });
    const ctaRow = e.createDiv({ cls: "it-empty-state-cta" });
    const createBtn = ctaRow.createEl("button", { cls: "it-btn-primary", text: t("main.noWorkspacesCreate") });
    createBtn.addEventListener("click", () => void this.plugin.createFirstWorkspace());
    const settingsBtn = ctaRow.createEl("button", { cls: "it-btn-secondary", text: t("main.noWorkspacesSettings") });
    settingsBtn.addEventListener("click", () => {
      const setting = (this.app as any).setting;
      setting?.open?.();
      setting?.openTabById?.(this.plugin.manifest.id);
    });
  }
}

// Map a custom-field type to the coarse filter type used by the FilterModal.
// Returns null for types we don't expose to the filter builder yet
// (relationship, attachment).
// Picker row content: a colored type icon for custom-field entries, then the
// label. Keeps Group/Sort/Swimlane menus consistent with the rest of the UI.
function renderPickerItemLabel(row: HTMLElement, value: string, label: string, customFields: { id: string; type: string }[]) {
  // Skip synthetic entries (No grouping / None) — they aren't real fields.
  if (value && value !== "__none") renderFieldIcon(row, value, customFields);
  row.createSpan({ text: label });
}

function cfFilterType(type: string): FilterFieldType | null {
  switch (type) {
    case "text": case "textarea": case "markdown": case "url": case "email": case "phone": case "location":
      return "text";
    case "number": case "money": case "rating": case "progress_manual": case "progress_auto":
      return "number";
    case "date": case "datetime":
      return "date";
    case "time":
      return "time";
    case "checkbox":
      return "checkbox";
    case "dropdown":
      return "dropdown";
    case "labels":
      return "multi";
    default:
      return null;
  }
}
