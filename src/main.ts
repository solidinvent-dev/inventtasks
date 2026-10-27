import { Plugin, WorkspaceLeaf, Notice, normalizePath, Platform, TFile } from "obsidian";
import { PluginSettings, WorkspaceEntry, DEFAULT_SETTINGS, InventTasksSettingTab, resolveStartupLocation, RECENTS_CAP, loadPluginSettings, makeWorkspaceEntry } from "./settings";
import { WorkspaceIndex } from "./data/workspace-index";
import { configureActivity } from "./data/activity";
import { setLicense } from "./data/license";
import { applyLocalLicenseState, startLicenseCheck } from "./data/license-check";
import { configureTimezone, configureDateTimeFormats, uses24HourTime } from "./utils/dates";
import { bootstrapDemo, bootstrapRichDemo } from "./data/demo-data";
import { VIEW_TYPE_INVENTTASKS, VIEW_TYPE_INVENTTASKS_SIDEBAR, VIEW_TYPE_INVENTTASKS_FAVORITES } from "./constants";
import { InventTasksMainView } from "./views/main-view";
import { InventTasksSidebarView } from "./views/sidebar-leaf-view";
import { InventTasksFavoritesView } from "./views/favorites-leaf-view";
import { SearchModal } from "./modals/search-modal";
import { TrashModal } from "./modals/trash-modal";
import { looksLucide } from "./ui/pickers";
import { ExportModal } from "./modals/export-modal";
import { ImportModal } from "./modals/import-modal";
import { loadTemplates } from "./data/templates";
import { TemplateManagerModal } from "./modals/template-modals";
import { HOTKEY_ACTIONS, comboFromEvent, resolveHotkeys } from "./hotkeys";
import { ConfirmModal } from "./modals/confirm-modal";
import { buildDeepLink, parseDeepLink, DeepLinkKind, DeepLinkParams, DEEP_LINK_ACTION } from "./data/deep-link";
import { setLocale, t } from "./i18n";
import { NotificationCenter, type NotifFeed } from "./notifications/center";
import { defaultNtfyAccount, type NtfyAccount } from "./notifications/types";
import { CalendarSyncManager } from "./calendar-sync/sync";
import { defaultCalendarSyncPrefs, type CalendarSyncPrefs } from "./calendar-sync/types";
import { BackgroundServices } from "./data/background-services";
import { applyWorkspaceSharedState, ensureNotifState, persistWorkspaceSharedState, workspaceStatePath, type WorkspaceSharedStateIssue } from "./data/workspace-state";
import { configureSecretStorage, protectSecret, revealSecret, secretId, takeLegacySecretsDropped } from "./secure-storage";
import { IncrementalBackupService } from "./data/incremental-backup";
import { IncrementalBackupRestoreModal } from "./modals/incremental-backup-modal";
import { SyncManager } from "./sync/manager";
import { VaultSyncManager } from "./vault-sync/manager";
import { SyncHistoryModal, type SyncHistoryProvider } from "./modals/sync-history-modal";
import { SyncPathPickerModal } from "./modals/sync-path-picker-modal";
import { SecretFieldSession, isEncryptedSecretValue } from "./data/secret-fields";
import { requestSecretPassword } from "./modals/secret-password-modal";
import type { SecretFieldValue } from "./types";

const PLUGIN_COMMAND_IDS = [
  "open-inventtasks",
  "check-notifications",
  "new-task",
  "search",
  "open-trash",
  "export-workspace",
  "import-backup",
  "restore-incremental-backup",
  "manage-templates",
  "switch-list",
  "switch-board",
  "switch-calendar",
  "switch-table",
  "switch-gantt",
  "switch-timeline",
  "open-favorites-panel",
  "toggle-favorites-bar",
  "sync-files",
  "sync-history",
  "vault-sync-now",
  "vault-sync-history",
] as const;

/** Notice keys accepted by copyTextToClipboard. Each maps to a one-line toast
 *  that confirms what was just copied (id / path / storage path / ancestry /
 *  source path). Kept as a union so callers stay type-safe as new copy
 *  targets are added. */
type CopyNoticeKey =
  | "deepLink.idCopied"
  | "deepLink.pathCopied"
  | "deepLink.storagePathCopied"
  | "deepLink.ancestryCopied"
  | "deepLink.sourcePathCopied";

export default class InventTasksPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  index!: WorkspaceIndex;
  notificationCenter?: NotificationCenter;
  calendarSyncManager?: CalendarSyncManager;
  backgroundServices?: BackgroundServices;
  incrementalBackupService!: IncrementalBackupService;
  syncManager?: SyncManager;
  vaultSyncManager?: VaultSyncManager;
  workspaceStateIssues: Array<WorkspaceSharedStateIssue & { workspaceId: string; workspaceName: string }> = [];
  // Ribbon icon elements (one per workspace) — tracked so we can rebuild them
  // when workspaces are added/removed/renamed/re-iconed in settings.
  private ribbonEls: HTMLElement[] = [];

  // Readiness gate for deep links. A deep link can arrive before the index has
  // finished loading (cold start / launched BY the link) — Obsidian dispatches
  // the URI as soon as the workspace is ready, racing our async index.load() in
  // the onLayoutReady callback. Handlers await this so navigation runs against a
  // populated index instead of silently resolving to nothing. Field order
  // matters: `resolveReady` is declared first so the `readyPromise` initializer
  // (which runs its executor synchronously) can capture the real resolver.
  private resolveReady: () => void = () => {};
  private readyPromise: Promise<void> = new Promise<void>((res) => { this.resolveReady = res; });
  // Views can be restored before the layout-ready callback has finished the
  // first index scan. Keep that state explicit so they never mistake a
  // not-yet-populated index for a genuinely empty workspace.
  private initialLoadComplete = false;

  get isInitialLoadComplete(): boolean {
    return this.initialLoadComplete;
  }

  // The active workspace's settings bundle. All per-workspace settings are read
  // through here so the rest of the plugin is workspace-agnostic.
  //
  // ZERO workspaces is a valid state (the task manager is simply off — e.g.
  // Vault Sync only). Deep call sites still read prefs incidentally, so they
  // get a PHANTOM entry: inert defaults, everything disabled, never persisted
  // (saveSettings only writes settings.workspaces). UI entry points gate on
  // hasWorkspaces and render empty states instead of using the phantom.
  get prefs(): WorkspaceEntry {
    const s = this.settings;
    const found = s.workspaces.find((w) => w.id === s.activeWorkspaceId) || s.workspaces[0];
    if (found) return found;
    if (!this.phantomPrefs) {
      // A sentinel root (never ""): if some ungated path ever consulted it,
      // the failure mode is an inert folder name — not a whole-vault scan.
      this.phantomPrefs = makeWorkspaceEntry({ id: "__no-workspace__", name: "—", workspaceRoot: "__inventtasks-none__" });
      this.phantomPrefs.sync.enabled = false;
      this.phantomPrefs.backup.enabled = false;
    }
    return this.phantomPrefs;
  }
  private phantomPrefs?: WorkspaceEntry;
  private secretFieldSession = new SecretFieldSession();
  private secretWorkspaceLockVersion = 0;

  get secretWorkspaceLockGeneration(): number {
    return this.secretWorkspaceLockVersion;
  }

  /** False = the task manager is off (no workspaces); Vault Sync still runs. */
  get hasWorkspaces(): boolean {
    return this.settings.workspaces.length > 0;
  }

  async onload() {
    // Register the deep-link handler FIRST — before any await — so a URI that
    // launched Obsidian (cold start) isn't missed during settings/index load.
    // handleDeepLink awaits the readiness gate, so it's safe to register this
    // early: it won't actually navigate until everything has loaded.
    this.registerObsidianProtocolHandler(DEEP_LINK_ACTION, (params) => {
      void this.handleDeepLink(params as Record<string, string>);
    });
    // A pending cross-vault link is consumed once the target vault is focused
    // (desktop multi-window) — layout-ready covers the open-from-cold case.
    this.registerDomEvent(window, "focus", () => void this.consumePendingDeepLink());
    // Mobile suspends the app (and its JS timers) while backgrounded, and usually
    // resumes WITHOUT reloading the plugin — so the interval doesn't catch up and
    // start()'s immediate tick never re-runs. Run a notification/calendar check
    // whenever the app becomes visible/focused so anything that came due while
    // away fires promptly. (`?.` — services may not exist yet during cold start.)
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.onAppResume();
      // Backgrounded — push any pending edits before the OS suspends our timers.
      else { this.syncManager?.flushPending(); this.vaultSyncManager?.flushPending(); }
    });
    this.registerDomEvent(window, "focus", () => this.onAppResume());
    // Losing focus (switching window/app) — same best-effort flush as hiding.
    this.registerDomEvent(window, "blur", () => { this.syncManager?.flushPending(); this.vaultSyncManager?.flushPending(); });

    await this.loadSettings();
    this.incrementalBackupService = new IncrementalBackupService(this);
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultFileModified(file)));
    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultFileModified(file)));

    this.index = new WorkspaceIndex(this.app, this.normalizedRoot());
    this.index.secretFieldPlaintext = (value) => this.workspaceSecretFieldPlaintext(value);
    // wait for vault layout — index uses files
    this.app.workspace.onLayoutReady(async () => {
      try {
        // The whole task-manager boot (root folder, index, system lists,
        // startup location, workspace config) only makes sense when at least
        // one workspace exists. With ZERO workspaces the plugin still loads —
        // views show an empty state and Vault Sync below runs regardless.
        if (this.hasWorkspaces) {
          await this.ensureRootFolder();
          await this.loadAllWorkspaceSharedState();
          await this.index.load();
          await loadTemplates(this);
          if (await this.index.ensureSystemLists()) await this.index.scan();
          this.applyMobileOffset();
          this.applyActiveColor();
          // Per-device: when "restore" is chosen, ensure our views EXIST but
          // never steal focus from whatever Obsidian restored (e.g. the file
          // explorer). "inventtasks" (default) reveals as before.
          const revealOnStartup = this.getStartupReveal() === "inventtasks";
          await this.applySidebarPlacement(revealOnStartup);
          // Open the right-sidebar Favorites panel when the user opted in, or
          // once on first run so its sidebar icon is discoverable (then remember
          // we did, so we don't force it open on later launches). Suppressed when
          // the device is set to restore the last-used view.
          if (revealOnStartup && (this.prefs.favoritesPanelOnStart || !this.prefs.favoritesPanelBootstrapped)) {
            void this.openFavoritesPanel();
            if (!this.prefs.favoritesPanelBootstrapped) {
              this.prefs.favoritesPanelBootstrapped = true;
              void this.saveSettings();
            }
          }
          // Re-apply the active color on any workspace-config change so picking a
          // new color in settings reflects immediately (no reload required).
          this.register(this.index.onChange(() => this.applyActiveColor()));
          // Trash retention: permanently drop items trashed more than 30 days
          // ago. Fire-and-forget — the view doesn't depend on it.
          void this.index.purgeExpiredTrash();
          // Now that the index is populated, apply the user's startup location.
          // The MainView constructor ran with an empty index, so any list/folder/
          // space-scoped startup target couldn't be resolved at that moment.
          this.applyStartupLocation();
        }
        // Force re-render: sidebar/main views may have rendered before
        // index.load() completed (Obsidian restores layout before plugin's
        // layout-ready callback runs), and scan() itself doesn't emit.
        this.initialLoadComplete = true;
        this.refreshViews();
        // Start external notification scheduler + calendar sync manager
        // (both iterate settings.workspaces — natural no-ops when empty).
        this.initExternalServices();
        this.incrementalBackupService.start();
        // File sync (self-hosted server) — no-op for workspaces with sync off.
        this.syncManager = new SyncManager(this);
        // Keep the main view's discreet sync indicator in step with sync state.
        this.syncManager.onStatusChange(() => { this.getMainView()?.refreshSyncIndicator(); this.updateSyncHealth(); });
        this.syncManager.start();
        // Vault Sync (whole vault, independent module) — no-op when disabled.
        // Deliberately OUTSIDE the hasWorkspaces gate: syncing the Obsidian
        // vault without a single task workspace is a supported setup.
        this.vaultSyncManager = new VaultSyncManager(this);
        this.vaultSyncManager.onStatusChange(() => { this.getMainView()?.refreshSyncIndicator(); this.updateSyncHealth(); });
        this.vaultSyncManager.start();
        this.register(() => { if (this.syncDownTimer !== null) window.clearTimeout(this.syncDownTimer); });
        // Daily license-standing check (see data/license-check.ts) — offline
        // or unreachable endpoint changes nothing.
        void applyLocalLicenseState(this);
        this.register(startLicenseCheck(this));
        if (this.hasWorkspaces) void this.ensureWorkspaceConfig();
      } finally {
        // An initialization error must not leave an already-restored view on an
        // endless loading screen. Render whatever state was recovered before
        // releasing the shared readiness gate.
        if (!this.initialLoadComplete) {
          this.initialLoadComplete = true;
          this.refreshViews();
        }
        // Always release deep links waiting on the readiness gate — even if load
        // partially failed — so a cold-start link never hangs forever (it just
        // resolves against whatever managed to load). Resolved AFTER
        // applyStartupLocation so a deep link wins the view over the startup one.
        this.resolveReady();
      }
      // A deep link from another vault parks its target here (shared localStorage)
      // before switching; now that the index is ready, follow through on it.
      void this.consumePendingDeepLink();
    });

    this.registerView(VIEW_TYPE_INVENTTASKS, (leaf) => new InventTasksMainView(leaf, this));
    this.registerView(VIEW_TYPE_INVENTTASKS_SIDEBAR, (leaf) => new InventTasksSidebarView(leaf, this));
    this.registerView(VIEW_TYPE_INVENTTASKS_FAVORITES, (leaf) => new InventTasksFavoritesView(leaf, this));

    this.rebuildRibbons();

    this.registerCommands();

    this.addSettingTab(new InventTasksSettingTab(this.app, this));

    // Plugin keyboard shortcuts — scoped to the InventTasks view so they never
    // override Obsidian / other plugins elsewhere. Capture phase + stopPropagation
    // means they also can't double-fire with an Obsidian hotkey on the same combo.
    // Desktop only.
    if (!Platform.isMobile) {
      const handler = (e: KeyboardEvent) => this.handleHotkey(e);
      document.addEventListener("keydown", handler, { capture: true });
      this.register(() => document.removeEventListener("keydown", handler, { capture: true } as any));
    }
  }

  /** Command guard: most palette actions need at least one workspace. */
  private requireWorkspace(): boolean {
    if (this.hasWorkspaces) return true;
    new Notice(t("notice.noWorkspaces"));
    return false;
  }

  /** Re-register palette commands (e.g. after language change). */
  registerCommands() {
    for (const id of PLUGIN_COMMAND_IDS) {
      (this.app as any).commands?.removeCommand(`${this.manifest.id}:${id}`);
    }
    this.addCommand({
      id: "open",
      name: t("cmd.open"),
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "check-notifications",
      name: t("cmd.checkNotifications"),
      callback: async () => {
        if (!this.notificationCenter) { new Notice("InventTasks: not ready"); return; }
        new Notice(`InventTasks — ${await this.notificationCenter.checkNow()}`, 12000);
      },
    });
    this.addCommand({
      id: "sync-files",
      name: t("cmd.syncFiles"),
      callback: async () => {
        const ws = this.prefs;
        if (!this.syncManager || !ws.sync?.enabled) { new Notice(t("sync.notConfigured")); return; }
        new Notice(t("sync.syncing"));
        const sum = await this.syncManager.syncNow(ws.id);
        if (!sum) {
          const status = this.syncManager.statusFor(ws.id);
          new Notice(t("sync.syncFailed", { msg: status?.lastError || "?" }), 8000);
        } else if (sum.blocked) {
          new Notice(t("sync.blockedMassDelete"), 8000);
        } else {
          new Notice(t("sync.syncDone", { pulled: sum.pulled, pushed: sum.pushed + sum.deletedRemote, conflicts: sum.conflicts }));
        }
      },
    });
    this.addCommand({
      id: "sync-history",
      name: t("cmd.syncHistory"),
      callback: () => {
        const ws = this.prefs;
        if (!this.syncManager?.isActive(ws.id)) { new Notice(t("sync.notConfigured")); return; }
        const paths = this.syncManager.syncedPaths(ws.id);
        if (paths.length === 0) { new Notice(t("syncHistory.empty")); return; }
        new SyncPathPickerModal(this.app, paths, (path) => {
          new SyncHistoryModal(this.app, this.taskSyncHistoryProvider(ws.id), path).open();
        }).open();
      },
    });
    this.addCommand({
      id: "vault-sync-now",
      name: t("cmd.vaultSyncNow"),
      callback: async () => {
        if (!this.vaultSyncManager?.isActive()) { new Notice(t("sync.notConfigured")); return; }
        new Notice(t("sync.syncing"));
        const sum = await this.vaultSyncManager.syncNow();
        if (!sum) {
          new Notice(t("sync.syncFailed", { msg: this.vaultSyncManager.status.lastError || "?" }), 8000);
        } else if (sum.blocked) {
          new Notice(t("sync.blockedMassDelete"), 8000);
        } else {
          new Notice(t("sync.syncDone", { pulled: sum.pulled, pushed: sum.pushed + sum.deletedRemote, conflicts: sum.conflicts }));
        }
      },
    });
    this.addCommand({
      id: "vault-sync-history",
      name: t("cmd.vaultSyncHistory"),
      callback: () => {
        const mgr = this.vaultSyncManager;
        if (!mgr?.isActive()) { new Notice(t("sync.notConfigured")); return; }
        const paths = mgr.syncedPaths();
        if (paths.length === 0) { new Notice(t("syncHistory.empty")); return; }
        new SyncPathPickerModal(this.app, paths, (path) => {
          new SyncHistoryModal(this.app, this.vaultSyncHistoryProvider(), path).open();
        }).open();
      },
    });
    this.addCommand({
      id: "new-task",
      name: t("cmd.newTask"),
      callback: () => {
        if (!this.requireWorkspace()) return;
        const v = this.getMainView();
        v?.quickCreateTask();
      },
    });
    this.addCommand({
      id: "search",
      name: t("cmd.search"),
      callback: () => { if (this.requireWorkspace()) new SearchModal(this.app, this).open(); },
    });
    this.addCommand({
      id: "open-trash",
      name: t("cmd.trash"),
      callback: () => { if (this.requireWorkspace()) new TrashModal(this.app, this).open(); },
    });
    this.addCommand({
      id: "export-workspace",
      name: t("cmd.export"),
      callback: () => { if (this.requireWorkspace()) new ExportModal(this.app, this, { scope: "workspace" }).open(); },
    });
    this.addCommand({
      id: "import-backup",
      name: t("cmd.import"),
      callback: () => { if (this.requireWorkspace()) new ImportModal(this.app, this).open(); },
    });
    this.addCommand({
      id: "restore-incremental-backup",
      name: t("cmd.restoreIncrementalBackup"),
      callback: () => new IncrementalBackupRestoreModal(this.app, this).open(),
    });
    this.addCommand({
      id: "manage-templates",
      name: t("cmd.templates"),
      callback: () => new TemplateManagerModal(this.app, this).open(),
    });
    this.addCommand({
      id: "switch-list",
      name: t("cmd.viewList"),
      callback: () => this.getMainView()?.setViewType("list"),
    });
    this.addCommand({
      id: "switch-board",
      name: t("cmd.viewBoard"),
      callback: () => this.getMainView()?.setViewType("board"),
    });
    this.addCommand({
      id: "switch-calendar",
      name: t("cmd.viewCalendar"),
      callback: () => this.getMainView()?.setViewType("calendar"),
    });
    this.addCommand({
      id: "switch-table",
      name: t("cmd.viewTable"),
      callback: () => this.getMainView()?.setViewType("table"),
    });
    this.addCommand({
      id: "switch-gantt",
      name: t("cmd.viewGantt"),
      callback: () => this.getMainView()?.setViewType("gantt"),
    });
    this.addCommand({
      id: "switch-timeline",
      name: t("cmd.viewTimeline"),
      callback: () => this.getMainView()?.setViewType("timeline"),
    });
    this.addCommand({
      id: "open-favorites-panel",
      name: t("cmd.favoritesPanel"),
      callback: () => this.openFavoritesPanel(),
    });
    this.addCommand({
      id: "toggle-favorites-bar",
      name: t("cmd.toggleFavoritesBar"),
      callback: () => void this.setFavoritesBarVisible(!this.prefs.favoritesBarVisible),
    });
  }

  private handleHotkey(e: KeyboardEvent) {
    // Only when an InventTasks view is active (main view OR the docked explorer
    // sidebar) — so we never grab keys elsewhere, but the explorer counts too.
    const active = this.app.workspace.getActiveViewOfType(InventTasksMainView)
      || this.app.workspace.getActiveViewOfType(InventTasksSidebarView);
    if (!active) return;
    // Don't hijack while a modal/menu is open or while typing in a field.
    if (document.querySelector(".modal-bg, .menu")) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const combo = comboFromEvent(e);
    if (!combo) return;
    const resolved = resolveHotkeys(this);
    const action = HOTKEY_ACTIONS.find((a) => resolved[a.id] && resolved[a.id] === combo);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action.run(this);
  }

  /** Version-history source for the task-sync scope of one workspace. */
  taskSyncHistoryProvider(wsId: string): SyncHistoryProvider {
    return {
      listVersions: (path) => this.syncManager!.listVersions(wsId, path),
      versionContent: (id) => this.syncManager!.versionContent(wsId, id),
      restoreVersion: (path, id) => this.syncManager!.restoreVersion(wsId, path, id),
    };
  }

  /** Version-history source for the Vault Sync scope. */
  vaultSyncHistoryProvider(): SyncHistoryProvider {
    return {
      listVersions: (path) => this.vaultSyncManager!.listVersions(path),
      versionContent: (id) => this.vaultSyncManager!.versionContent(id),
      restoreVersion: (path, id) => this.vaultSyncManager!.restoreVersion(path, id),
    };
  }

  async onunload() {
    this.notificationCenter?.stop();
    this.calendarSyncManager?.stop();
    this.backgroundServices?.stopAll();
    this.incrementalBackupService?.stop();
    this.syncManager?.stop();
    this.vaultSyncManager?.stop();
    this.index?.unload();
    this.secretFieldSession.lockAll();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_INVENTTASKS_SIDEBAR);
    document.body.removeClass("it-bg-white", "it-bg-black");
  }

  refreshIncrementalBackupService(): void {
    this.incrementalBackupService?.reconfigure();
  }

  private initExternalServices(): void {
    this.globalCalendarSync(); // ensure the global calendar prefs object exists

    const saveSettings = () => this.saveSettings();

    // ONE NotificationCenter drives every workspace: it pulls a fresh feed
    // list each tick (active + background indexes), funnels all sends through
    // a shared outbox (simultaneous notifications merge into one summary per
    // channel) and records every dispatch attempt in the per-workspace
    // history. Mobile uses a near-zero quiet window: the OS suspends timers
    // when the app leaves the foreground, and a deferred push would be lost.
    this.notificationCenter = new NotificationCenter({
      getFeeds: () => this.notificationFeeds(),
      getAccounts: () => ({ ntfy: this.settings.ntfy }),
      save: saveSettings,
      onAfterDeliver: () => this.getMainView()?.refreshAfterSync(),
    });
    this.notificationCenter.start();

    // Background indexes for every OTHER workspace (desktop). Created before
    // the calendar manager so its getIndexes() can include them; onIndexChange
    // re-syncs the (global) calendar when a background workspace's files change.
    this.backgroundServices = new BackgroundServices(
      this.app,
      () => this.settings,
      () => this.calendarSyncManager?.scheduleSync(),
      () => this.globalCalendarSync(),
    );
    this.refreshBackgroundServices();

    // ONE global calendar sync, pulling tasks from EVERY workspace's index.
    this.calendarSyncManager = new CalendarSyncManager(
      this.app,
      () => [this.index, ...(this.backgroundServices?.indexes() ?? [])],
      () => this.globalCalendarSync(),
      saveSettings,
    );
    // Calendar sync is desktop-only: it reconciles the shared global calendar
    // against ALL workspaces, but mobile loads only the active index — syncing
    // there would delete other workspaces' events. Mobile relies on desktop.
    if (!Platform.isMobile) {
      this.calendarSyncManager.start(); // arms interval + one catch-up sync
      this.register(this.index.onChange(() => this.calendarSyncManager?.scheduleSync()));
    }
  }

  /** The single, plugin-wide calendar sync config (lazy-created). */
  globalCalendarSync(): CalendarSyncPrefs {
    if (!this.settings.calendarSync) this.settings.calendarSync = defaultCalendarSyncPrefs();
    return this.settings.calendarSync;
  }

  /** The single, plugin-wide ntfy push account (lazy-created). The per-workspace
   *  ntfy channel only toggles whether to use it. */
  globalNtfy(): NtfyAccount {
    if (!this.settings.ntfy) this.settings.ntfy = defaultNtfyAccount();
    return this.settings.ntfy;
  }

  /** One notification feed per workspace the center can currently see: the
   *  active one on the shared UI index, the rest on their background indexes
   *  (desktop only — BackgroundServices is a no-op on mobile). Rebuilt every
   *  tick, so workspace switches/add/remove need no extra wiring. */
  private notificationFeeds(): NotifFeed[] {
    const feeds: NotifFeed[] = [];
    const activeId = this.settings.activeWorkspaceId;
    for (const ws of this.settings.workspaces) {
      const active = ws.id === activeId;
      const index = active ? this.index : this.backgroundServices?.indexFor(ws.id);
      if (!index) continue;
      feeds.push({
        wsId: ws.id,
        wsName: ws.name,
        active,
        config: ws.notifConfig,
        state: ensureNotifState(ws),
        tasks: () => index.allTasks().filter((task) => !task.data.archived),
        // Location-level gates: a list/folder/space with notifications off is
        // silent on every channel; otherwise the per-channel location toggles
        // (notify_system / notify_ntfy) decide.
        resolveAllow: (task) => index.resolveNotificationsEnabledForTask(task)
          ? index.resolveExternalNotifyChannelsForTask(task)
          : { system: false, ntfy: false },
        isReminderItem: (task) => index.findList(task.listPath || "")?.config.system_kind === "reminders",
        linkBuilder: (task) => task.data.id
          ? buildDeepLink({ vault: this.app.vault.getName(), ws: ws.id, kind: "task", id: task.data.id })
          : undefined,
      });
    }
    return feeds;
  }

  private workspaceRootOf(ws: WorkspaceEntry): string {
    const v = (ws.workspaceRoot || "").trim();
    if (!v || v === "/") return "/";
    return normalizePath(v);
  }

  private indexForWorkspace(ws: WorkspaceEntry): WorkspaceIndex | undefined {
    const root = this.workspaceRootOf(ws);
    if (this.index && this.workspaceRootOf(this.prefs) === root) return this.index;
    return this.backgroundServices?.indexes().find((idx) => idx.rootPath === root);
  }

  private async loadAllWorkspaceSharedState(): Promise<void> {
    const calendar = this.globalCalendarSync();
    this.workspaceStateIssues = [];
    for (const ws of this.settings.workspaces) {
      try {
        const issue = await applyWorkspaceSharedState(this.app, ws, calendar);
        if (issue) this.workspaceStateIssues.push({ ...issue, workspaceId: ws.id, workspaceName: ws.name });
      } catch (e) {
        console.warn("[InventTasks] Failed to load workspace shared state", ws.name, e);
      }
    }
    const p = this.prefs;
    configureActivity(p.activityConfig);
  }

  async reloadWorkspaceSharedState(): Promise<void> {
    await this.loadAllWorkspaceSharedState();
    this.refreshViews();
  }

  private onVaultFileModified(file: unknown): void {
    if (!(file instanceof TFile)) return;
    const changed = normalizePath(file.path);
    if (!this.settings.workspaces.some((ws) => normalizePath(workspaceStatePath(ws.workspaceRoot)) === changed)) return;
    void this.reloadWorkspaceSharedState();
  }

  async persistAllWorkspaceSharedState(): Promise<void> {
    const calendar = this.settings.calendarSync;
    for (const ws of this.settings.workspaces) {
      try {
        await persistWorkspaceSharedState(this.app, ws, calendar, this.indexForWorkspace(ws));
      } catch (e) {
        console.warn("[InventTasks] Failed to save workspace shared state", ws.name, e);
      }
    }
  }

  private localSettingsSnapshot(): PluginSettings {
    return {
      ...this.settings,
      ntfy: this.settings.ntfy
        ? { ...this.settings.ntfy, authToken: protectSecret(secretId("ntfy-token"), this.settings.ntfy.authToken) }
        : this.settings.ntfy,
      calendarSync: this.settings.calendarSync
        ? this.protectedCalendarSyncSnapshot(this.settings.calendarSync)
        : this.settings.calendarSync,
      vaultSync: this.settings.vaultSync
        ? { ...this.settings.vaultSync, token: protectSecret(secretId("vault-sync-token"), this.settings.vaultSync.token) || "" }
        : this.settings.vaultSync,
      // Per-workspace: keep plain config (notifConfig etc.); strip everything
      // that lives in the vault-synced workspace state file instead.
      workspaces: this.settings.workspaces.map((ws) => ({
        ...ws,
        activityConfig: undefined as any,
        notifications: undefined as any,
        notifState: undefined,
        calendarSync: undefined,
        sync: ws.sync ? { ...ws.sync, token: protectSecret(secretId(`sync-token-${ws.id}`), ws.sync.token) || "" } : ws.sync,
      })),
    };
  }

  private protectedCalendarSyncSnapshot(calendar: CalendarSyncPrefs): CalendarSyncPrefs {
    return {
      ...calendar,
      caldav: {
        ...calendar.caldav,
        password: protectSecret(secretId("caldav-password"), calendar.caldav.password) || "",
      },
      syncedEvents: {},
    };
  }

  private revealStoredSecrets(): void {
    if (this.settings.ntfy?.authToken) {
      this.settings.ntfy.authToken = revealSecret(this.settings.ntfy.authToken);
    }
    const calendar = this.settings.calendarSync;
    if (calendar) {
      calendar.caldav.password = revealSecret(calendar.caldav.password) || "";
    }
    for (const ws of this.settings.workspaces) {
      if (ws.sync?.token) ws.sync.token = revealSecret(ws.sync.token) || "";
    }
    if (this.settings.vaultSync?.token) {
      this.settings.vaultSync.token = revealSecret(this.settings.vaultSync.token) || "";
    }
  }

  /** Notification + calendar catch-up when the app regains focus/visibility.
   *  Essential on mobile (suspended timers; no reload on resume). */
  private lastResumeAt = 0;

  private onAppResume(): void {
    // Android fires visibilitychange and focus within milliseconds of each
    // other, so a single return to the app ran the whole catch-up twice —
    // measured on the emulator: two feed runs and two outbox flushes per
    // resume. Idempotent, but paid for twice on the device least able to
    // afford it.
    const now = Date.now();
    if (now - this.lastResumeAt < 1500) return;
    this.lastResumeAt = now;
    void (async () => {
      await this.reloadWorkspaceSharedState();
      await this.notificationCenter?.runNow();
      // Deliver now: on mobile the app may be suspended again before the
      // outbox's quiet window would otherwise elapse (which would silently
      // drop the resumed ntfy push).
      await this.notificationCenter?.flushNow();
      this.calendarSyncManager?.scheduleSync(); // desktop-only (guarded inside)
      this.syncManager?.onAppResume();
      this.vaultSyncManager?.onAppResume();
    })();
  }

  /** Reconcile background (non-active) workspace services after the workspace
   *  list / roots / active selection change. Idempotent and safe to call often. */
  refreshBackgroundServices(): void {
    void this.backgroundServices?.reconcile(this.settings.activeWorkspaceId);
  }

  /** Manual catch-up: notifications (all workspaces) + calendar sync (desktop).
   *  Refreshes sidebar badges and the open notifications/reminders view. */
  async syncNow(): Promise<void> {
    await this.reloadWorkspaceSharedState();
    await this.backgroundServices?.reconcile(this.settings.activeWorkspaceId);
    await this.notificationCenter?.runNow();
    // Manual sync: deliver everything now (merged), instead of waiting out the
    // outbox quiet window.
    await this.notificationCenter?.flushNow();
    if (!Platform.isMobile) {
      await this.calendarSyncManager?.sync();
    }
    this.getMainView()?.refreshAfterSync();
  }

  syncWarningMessage(): string | undefined {
    const messages: string[] = [];
    const calErr = this.settings.calendarSync?.lastSyncError;
    const calWarn = this.settings.calendarSync?.lastSyncWarning;
    if (calErr) messages.push(`Calendar: ${calErr.message}`);
    if (calWarn) messages.push(`Calendar warning: ${calWarn.message}`);
    for (const ws of this.settings.workspaces) {
      const err = ws.notifState?.lastError;
      if (err) messages.push(`${ws.name} ${err.channel}: ${err.message}`);
    }
    return messages.length ? messages.join("; ") : undefined;
  }

  /** Calendar-only sync (ICS generate, etc.). Desktop-only (see init). */
  async syncAllCalendars(): Promise<void> {
    if (Platform.isMobile) return;
    await this.calendarSyncManager?.sync();
  }

  async loadSettings() {
    this.settings = loadPluginSettings(await this.loadData());
    configureSecretStorage(this.app);
    this.revealStoredSecrets();
    const dropped = takeLegacySecretsDropped();
    if (dropped) new Notice(t("secrets.reenter", { count: dropped }), 0);
    setLicense(this.settings.account?.id, this.settings.account?.token);
    // Newest vendor-signed standing statement (if any) drives the runtime
    // hold; stamps synced in via workspace state re-apply through the observer.
    void applyLocalLicenseState(this);
    setLocale(this.settings.language);
    const p = this.prefs;
    configureActivity(p.activityConfig);
    configureTimezone(p.timezone);
    this.applyDateTimePrefs();
    this.applyBackgroundTheme();
  }

  // Save coalescing: every save persists the CURRENT settings object, so when
  // calls pile up (open task → recents, notification marks, view-state writes)
  // only the run that started AFTER the last mutation matters. One save runs
  // at a time; any number of calls arriving meanwhile collapse into a single
  // trailing run. Each caller's promise resolves with a save that began after
  // its own mutation — same guarantee as the old unbounded chain, with a
  // bounded number of disk round-trips.
  private saveInFlight: Promise<void> | null = null;
  private saveTrailing: Promise<void> | null = null;
  async saveSettings(): Promise<void> {
    if (this.saveInFlight) {
      if (!this.saveTrailing) {
        this.saveTrailing = this.saveInFlight
          .catch(() => { /* prior failure must not cancel the trailing save */ })
          .then(() => {
            this.saveTrailing = null;
            return this.saveSettings();
          });
      }
      return this.saveTrailing;
    }
    this.saveInFlight = this.runSave().finally(() => { this.saveInFlight = null; });
    return this.saveInFlight;
  }

  private async runSave() {
    await this.persistAllWorkspaceSharedState();
    await this.saveData(this.localSettingsSnapshot());
    // Sync engines follow settings (enable/server/token/root). Idempotent and
    // cheap when nothing relevant changed (fingerprint check inside). Vault
    // sync must follow too — its exclusions include every workspaceRoot.
    void this.syncManager?.reconfigure();
    void this.vaultSyncManager?.reconfigure();
    // Re-apply the active workspace's activity/timezone/format config (these are
    // process-global singletons driven by the active workspace).
    const p = this.prefs;
    configureActivity(p.activityConfig);
    configureTimezone(p.timezone);
    this.applyDateTimePrefs();
  }

  // Push the active workspace's date/time/week prefs into the date engine (the
  // single source of truth for how dates render everywhere) and reflect the
  // 12-hour choice as a body class so native time controls can be widened.
  applyDateTimePrefs() {
    const p = this.prefs;
    configureDateTimeFormats({
      dateFormat: p.dateFormat ?? "YYYY-MM-DD",
      timeFormat: p.timeFormat ?? "HH:mm",
      weekStart: p.weekStart ?? "monday",
    });
    document.body.toggleClass("it-time-12h", !uses24HourTime());
  }

  // (Re)builds one ribbon icon per workspace. Called on load and whenever the
  // workspace list / names / icons change in settings.
  rebuildRibbons() {
    // 1) Remove the buttons we previously created (DOM).
    for (const el of this.ribbonEls) { try { el.remove(); } catch { /* already detached */ } }
    this.ribbonEls = [];
    // 2) Belt-and-braces: sweep any of our ribbon buttons still in the DOM
    //    (e.g. one Obsidian re-rendered from its internal registry after a
    //    sidebar/layout change).
    document.querySelectorAll("[data-it-vault-ribbon]").forEach((e) => e.remove());
    // 3) Drop our entries from the ribbon's internal registry so a future
    //    re-render can't resurrect a removed vault's icon. Internal API —
    //    guarded so it no-ops if the shape changes across Obsidian versions.
    try {
      const ribbon: any = (this.app.workspace as any).leftRibbon;
      if (ribbon && Array.isArray(ribbon.items)) {
        ribbon.items = ribbon.items.filter((it: any) => !(typeof it?.title === "string" && it.title.startsWith("InventTasks — ")));
      }
    } catch { /* internal API unavailable — DOM cleanup above still applies */ }
    // 4) Zero workspaces → one generic button so the plugin stays reachable
    //    (opens the main view's empty state with "Add workspace").
    if (!this.hasWorkspaces) {
      const el = this.addRibbonIcon("check-square", "InventTasks — InventTasks", () => void this.activateView());
      el.dataset.itVaultRibbon = "__none__";
      this.ribbonEls.push(el);
      return;
    }
    //    Otherwise re-create one button per vault.
    for (const ws of this.settings.workspaces) {
      const icon = ws.icon || "check-square";
      // addRibbonIcon needs a Lucide id; for an emoji we add a placeholder then
      // swap its contents for the glyph as text.
      const el = this.addRibbonIcon(looksLucide(icon) ? icon : "check-square", `InventTasks — ${ws.name}`, () => this.openWorkspace(ws.id));
      el.dataset.itVaultRibbon = ws.id;
      if (!looksLucide(icon)) {
        el.empty();
        el.createSpan({ cls: "it-ribbon-emoji", text: icon });
      }
      this.ribbonEls.push(el);
    }
  }

  /** Turn the task manager back on from the zero-workspaces state: create a
   *  default workspace and run the boot steps that layout-ready skipped. */
  async createFirstWorkspace(): Promise<void> {
    if (this.hasWorkspaces) return;
    const ws = makeWorkspaceEntry({ name: t("common.vault"), workspaceRoot: "Tasks", sidebarPlacement: "left" });
    this.settings.workspaces.push(ws);
    this.settings.activeWorkspaceId = ws.id;
    await this.saveSettings();
    this.rebuildRibbons();
    await this.switchWorkspace(ws.id);
    // Boot with zero workspaces skipped index.load() — attach the vault
    // watchers now (load() is idempotent about double-attaching).
    await this.index.load();
    await loadTemplates(this);
    await this.ensureWorkspaceConfig();
    this.refreshViews();
  }

  // Ribbon click: make the workspace active (if not already) and reveal its view.
  async openWorkspace(id: string) {
    if (id !== this.settings.activeWorkspaceId) await this.switchWorkspace(id);
    await this.activateView();
  }

  // A freshly enabled plugin / newly created workspace starts EMPTY: silently
  // materialize the workspace config (folder + defaults) once, so the workspace
  // is ready to use. Starter / demo content is opt-in from settings or the
  // empty-state view — never auto-seeded.
  async ensureWorkspaceConfig(): Promise<void> {
    if (!this.index || this.index.workspace) return;
    try {
      await this.index.createWorkspaceConfig(this.prefs.name || t("demo.workspaceName"));
      await this.index.scan();
      if (await this.index.ensureSystemLists()) await this.index.scan();
      this.refreshViews();
    } catch (e: any) {
      console.error("InventTasks workspace init failed", e);
    }
  }

  /** Opt-in starter content: one space, one list, a handful of tasks. */
  async generateStartData(): Promise<void> {
    await this.seedDemo(() => bootstrapDemo(this.index), "notice.demoCreated");
  }

  /** Opt-in rich tester content: exercises most features within free limits. */
  async generateRichDemo(): Promise<void> {
    await this.seedDemo(() => bootstrapRichDemo(this.index), "notice.richDemoCreated");
  }

  private async seedDemo(seed: () => Promise<void>, successKey: string): Promise<void> {
    try {
      await seed();
      new Notice(t(successKey));
      if (await this.index.ensureSystemLists()) await this.index.scan();
      this.applyStartupLocation();
      this.refreshViews();
      this.refreshBackgroundServices();
    } catch (e: any) {
      console.error("InventTasks demo setup failed", e);
      new Notice(t("notice.richDemoFailed", { msg: e?.message ?? String(e) }));
    }
  }

  // Switches the active workspace: re-roots the index to the new folder, applies
  // that workspace's per-device prefs (timezone/activity/sidebar/etc.) and
  // refreshes the views. One index instance is reused (lighter than keeping all
  // workspaces loaded at once).
  async switchWorkspace(id: string) {
    if (!this.settings.workspaces.some((w) => w.id === id)) return;
    this.settings.activeWorkspaceId = id;
    await this.saveSettings();
    await this.ensureRootFolder();
    await applyWorkspaceSharedState(this.app, this.prefs, this.globalCalendarSync());
    configureActivity(this.prefs.activityConfig);
    await this.index.setRoot(this.normalizedRoot());
    await loadTemplates(this);
    void this.index.purgeExpiredTrash();
    this.applyMobileOffset();
    this.applyActiveColor();
    await this.applySidebarPlacement();
    this.applyStartupLocation();
    this.refreshViews();
    // The notification center pulls feeds fresh each tick, so it follows the
    // switch automatically — just run a check right away for the new layout.
    void this.notificationCenter?.runNow();
    this.calendarSyncManager?.restart();
    // Re-scope background services to the new non-active set: the previously
    // active workspace joins it, the newly active one leaves it.
    this.refreshBackgroundServices();
    void this.ensureWorkspaceConfig();
  }

  // ---------- Deep links ----------
  // Shared-origin key for parking a cross-vault link while the target vault
  // opens. Obsidian desktop runs every vault under the same `app://obsidian.md`
  // origin, so raw window.localStorage is shared across vault windows; on mobile
  // it simply persists across the vault switch. (NOT app.saveLocalStorage — that
  // is vault-scoped and wouldn't survive the hop.)
  private static PENDING_DEEPLINK_KEY = "inventtasks:pending-deeplink";
  // Per-DEVICE (localStorage, never synced): what the plugin does with focus on
  // startup. "inventtasks" (default) reveals the InventTasks navigator/panel as
  // before; "restore" leaves whatever Obsidian restored (e.g. the file explorer)
  // active. Kept out of data.json on purpose — it's a per-machine preference.
  private static STARTUP_REVEAL_KEY = "inventtasks:startup-reveal";

  getStartupReveal(): "inventtasks" | "restore" {
    try {
      return window.localStorage.getItem(InventTasksPlugin.STARTUP_REVEAL_KEY) === "restore"
        ? "restore" : "inventtasks";
    } catch { return "inventtasks"; }
  }

  setStartupReveal(value: "inventtasks" | "restore"): void {
    try { window.localStorage.setItem(InventTasksPlugin.STARTUP_REVEAL_KEY, value); } catch { /* ignore */ }
  }

  // Copy a shareable link to the given element. Vault + active workspace are
  // filled in from the current context so the link round-trips back here.
  async copyElementLink(kind: DeepLinkKind, id?: string, page?: string) {
    // Everything but the workspace needs a stable id to address. Parsers default
    // a missing space/folder/list id to "" — guard so we never copy a link that
    // would silently resolve to nothing (rather, tell the user why).
    if (kind !== "workspace" && !id) {
      new Notice(t("deepLink.noId"));
      return;
    }
    const link = buildDeepLink({
      vault: this.app.vault.getName(),
      ws: this.settings.activeWorkspaceId,
      kind,
      id,
      page,
    });
    try {
      await navigator.clipboard.writeText(link);
      new Notice(t("deepLink.copied"));
    } catch {
      // Clipboard can be unavailable (e.g. some mobile webviews) — show the link
      // so the user can copy it by hand rather than failing silently.
      new Notice(link);
    }
  }

  // Copy a raw stable id (space_id, folder_id, list_id, doc_id, page_id, item
  // id) or a storage path to the clipboard. Used by the "Copy id" / "Copy path"
  // menu entries added next to "Copy link" on every sidebar and doc resource.
  // Centralizing it here keeps the clipboard-fallback and Notice consistent
  // with copyElementLink, and gives the webapp the same behaviour for free
  // because it boots the real plugin on its in-memory vault.
  async copyTextToClipboard(value: string, noticeKey: CopyNoticeKey = "deepLink.idCopied") {
    if (!value) { new Notice(t("deepLink.noId")); return; }
    try {
      await navigator.clipboard.writeText(value);
      new Notice(t(noticeKey));
    } catch {
      // Clipboard can be unavailable (e.g. some mobile webviews) — show the
      // value so the user can copy it by hand rather than failing silently.
      new Notice(value);
    }
  }

  // Protocol-handler entry. Decides whether we're in the right vault first
  // (prompting to switch if not), then hands off to navigation.
  async handleDeepLink(params: Record<string, string>) {
    const link = parseDeepLink(params);
    if (!link) {
      // The protocol handler only fires for OUR action, so a link we cannot read
      // was meant for us and arrived damaged — truncated by a chat client, hand
      // edited, or built by an older version. Saying so beats doing nothing at
      // all, which is indistinguishable from the plugin being broken.
      new Notice(t("deepLink.invalid"));
      return;
    }
    // Cold start: the URI can land before index.load() finishes. Wait for the
    // readiness gate so navigation resolves against a populated index instead of
    // doing nothing ("app opens but goes nowhere" on the first click).
    await this.readyPromise;
    const currentVault = this.app.vault.getName();
    if (link.vault && link.vault !== currentVault) {
      // We were handed the link in the wrong vault — ask before disrupting.
      new ConfirmModal(this.app, {
        title: t("deepLink.switchVaultTitle"),
        message: t("deepLink.switchVaultMsg", { vault: link.vault }),
        confirmLabel: t("deepLink.switchVaultConfirm"),
        onConfirm: () => {
          // Park the target, then switch vaults. The target vault picks it up on
          // focus / layout-ready and completes the navigation there.
          this.stashPendingDeepLink(link);
          window.open(`obsidian://open?vault=${encodeURIComponent(link.vault)}`);
        },
      }).open();
      return;
    }
    await this.navigateDeepLink(link);
  }

  // If the link targets a different plugin workspace (the ribbon "Vaults") that
  // exists in this Obsidian vault, ask before switching; otherwise go straight to
  // the element. (A `ws` from another Obsidian vault won't be found here, so we
  // just resolve in the active workspace — best effort.)
  private async navigateDeepLink(link: DeepLinkParams) {
    const target = link.ws ? this.settings.workspaces.find((w) => w.id === link.ws) : undefined;
    if (target && target.id !== this.settings.activeWorkspaceId) {
      new ConfirmModal(this.app, {
        title: t("deepLink.switchWorkspaceTitle"),
        message: t("deepLink.switchWorkspaceMsg", { name: target.name }),
        confirmLabel: t("deepLink.switchVaultConfirm"),
        onConfirm: async () => {
          await this.switchWorkspace(target.id);
          await this.revealAndNavigate(link);
        },
      }).open();
      return;
    }
    await this.revealAndNavigate(link);
  }

  private async revealAndNavigate(link: DeepLinkParams) {
    await this.activateView();
    const mv = this.getMainView();
    if (!mv) return;
    if (!mv.navigateToElement(link)) new Notice(t("deepLink.notFound"));
  }

  private stashPendingDeepLink(link: DeepLinkParams) {
    try {
      window.localStorage.setItem(
        InventTasksPlugin.PENDING_DEEPLINK_KEY,
        JSON.stringify({ link, ts: Date.now() }),
      );
    } catch { /* storage may be unavailable — cross-vault hop just won't auto-continue */ }
  }

  // Pick up a link parked by another vault. Only acts once we're actually in the
  // target vault; ignores stale entries (>2 min) so an old hop can't hijack a
  // later launch. Async because the target vault may still be cold-starting when
  // this fires (layout-ready / window focus) — wait for the readiness gate.
  private async consumePendingDeepLink() {
    let raw: string | null = null;
    try { raw = window.localStorage.getItem(InventTasksPlugin.PENDING_DEEPLINK_KEY); } catch { return; }
    if (!raw) return;
    let parsed: { link?: DeepLinkParams; ts?: number };
    try { parsed = JSON.parse(raw); } catch { this.clearPendingDeepLink(); return; }
    const link = parsed.link;
    if (!link || !parsed.ts || Date.now() - parsed.ts > 120000) { this.clearPendingDeepLink(); return; }
    // Not our vault yet — leave it for the right one to claim.
    if (link.vault && link.vault !== this.app.vault.getName()) return;
    // Claim it now (clear before awaiting) so a second focus event can't double-fire.
    this.clearPendingDeepLink();
    await this.readyPromise;
    void this.navigateDeepLink(link);
  }

  private clearPendingDeepLink() {
    try { window.localStorage.removeItem(InventTasksPlugin.PENDING_DEEPLINK_KEY); } catch { /* ignore */ }
  }

  // Record a task as recently-opened (most-recent first, deduped, capped).
  // Persisted per-device and surfaced by the "Recent" sidebar view.
  pushRecentTask(id: string) {
    if (!id) return;
    const cur = this.prefs.recentTaskIds || [];
    const next = [id, ...cur.filter((x) => x !== id)].slice(0, RECENTS_CAP);
    this.prefs.recentTaskIds = next;
    void this.saveSettings();
    this.refreshDockedSidebar();
  }

  normalizedRoot(): string {
    const v = (this.prefs.workspaceRoot || "").trim();
    if (!v || v === "/") return "/";
    return normalizePath(v);
  }

  async ensureRootFolder() {
    const r = this.normalizedRoot();
    if (r === "/" || r === "") return;
    if (!this.app.vault.getAbstractFileByPath(r)) {
      await this.app.vault.createFolder(r);
    }
  }

  async onRootChanged() {
    await this.ensureRootFolder();
    await applyWorkspaceSharedState(this.app, this.prefs, this.globalCalendarSync());
    configureActivity(this.prefs.activityConfig);
    await this.index.setRoot(this.normalizedRoot());
    this.refreshViews();
    void this.ensureWorkspaceConfig();
  }

  refreshViews() {
    this.getMainView()?.fullRender();
    this.refreshDockedSidebar();
  }

  private activeSecretWorkspace() {
    const workspace = this.index?.workspace;
    if (!workspace) return null;
    return { workspace, id: workspace.workspace_id };
  }

  private encryptedSecretValues(): unknown[] {
    const values: unknown[] = [];
    for (const task of this.index.allTasks()) {
      for (const value of Object.values(task.data.custom_fields || {})) {
        if (isEncryptedSecretValue(value)) values.push(value);
      }
    }
    return values;
  }

  isSecretFieldsUnlocked(): boolean {
    const active = this.activeSecretWorkspace();
    return !!active && this.secretFieldSession.isUnlocked(active.id, active.workspace.secret_fields);
  }

  isSecretWorkspaceUnlocked(): boolean {
    const active = this.activeSecretWorkspace();
    return !!active && this.secretFieldSession.isWorkspaceVisible(active.id, active.workspace.secret_fields);
  }

  /** Unlock (or initialize) the active workspace's one session password. */
  async unlockSecretFields(): Promise<boolean> {
    const active = this.activeSecretWorkspace();
    if (!active) return false;
    if (this.secretFieldSession.isUnlocked(active.id, active.workspace.secret_fields)) return true;
    const setup = !active.workspace.secret_fields;
    let error: string | undefined;
    while (true) {
      const password = await requestSecretPassword(this.app, { setup, error });
      if (password === null) return false;
      try {
        if (setup) {
          const config = await this.secretFieldSession.createConfig(active.id, password);
          await this.index.updateWorkspaceConfig({ secret_fields: config });
          // updateWorkspaceConfig writes a merged copy; keep the live object in
          // step immediately instead of waiting for the vault modify event.
          active.workspace.secret_fields = config;
        } else {
          // Password availability and visibility are separate. A single-field
          // reveal loads only that field below; do not eagerly decrypt the
          // whole workspace merely because the password was entered.
          await this.secretFieldSession.unlock(active.id, active.workspace.secret_fields!, password);
        }
        this.index.emit();
        return true;
      } catch (cause: any) {
        error = cause?.message === "INVALID_PASSWORD" ? t("secret.invalidPassword") : t("secret.cryptoError", { msg: cause?.message || String(cause) });
      }
    }
  }

  async unlockSecretWorkspace(): Promise<boolean> {
    const initial = this.activeSecretWorkspace();
    if (!initial) return false;
    if (!(await this.unlockSecretFields())) return false;
    const active = this.activeSecretWorkspace();
    if (!active || active.id !== initial.id) {
      this.secretFieldSession.lock(initial.id);
      return false;
    }
    if (active.workspace.secret_fields) {
      await Promise.all(this.encryptedSecretValues().map((value) =>
        this.secretFieldSession.decrypt(active.id, active.workspace.secret_fields!, value)
      ));
    }
    this.secretFieldSession.revealWorkspace(active.id);
    this.index.emit();
    return true;
  }

  lockSecretWorkspace(): void {
    const active = this.activeSecretWorkspace();
    if (!active) return;
    // Workspace lock is the hard boundary: hide everything AND forget the
    // password-derived key/cache. Open task modals observe the generation bump
    // and discard their local one-field / all-fields reveals too.
    this.secretFieldSession.lock(active.id);
    this.secretWorkspaceLockVersion++;
    this.index.emit();
  }

  /** Decrypt values for one TaskModal. If no session password exists, acquire
   * it only for this operation and forget the key immediately afterwards. */
  async decryptSecretFieldValuesForModal(values: unknown[]): Promise<Array<string | null> | null> {
    const initial = this.activeSecretWorkspace();
    if (!initial) return null;
    const hadSession = this.isSecretFieldsUnlocked();
    if (!hadSession && !(await this.unlockSecretFields())) return null;
    const active = this.activeSecretWorkspace();
    try {
      if (!active || active.id !== initial.id || !active.workspace.secret_fields) return null;
      return await Promise.all(values.map((value) =>
        this.secretFieldSession.decrypt(active.id, active.workspace.secret_fields!, value)
      ));
    } finally {
      if (!hadSession) this.secretFieldSession.lock(initial.id);
    }
  }

  secretFieldPlaintext(value: unknown): string | null {
    const active = this.activeSecretWorkspace();
    if (!active) return null;
    return this.secretFieldSession.plaintext(active.id, active.workspace.secret_fields, value);
  }

  workspaceSecretFieldPlaintext(value: unknown): string | null {
    const active = this.activeSecretWorkspace();
    if (!active) return null;
    return this.secretFieldSession.workspacePlaintext(active.id, active.workspace.secret_fields, value);
  }

  async encryptSecretFieldValue(plaintext: string): Promise<SecretFieldValue | null> {
    const initial = this.activeSecretWorkspace();
    if (!initial) return null;
    const hadSession = this.isSecretFieldsUnlocked();
    if (!hadSession && !(await this.unlockSecretFields())) return null;
    const active = this.activeSecretWorkspace();
    try {
      if (!active || active.id !== initial.id || !active.workspace.secret_fields) throw new Error(t("secret.locked"));
      return await this.secretFieldSession.encrypt(active.id, active.workspace.secret_fields, plaintext);
    } finally {
      if (!hadSession) this.secretFieldSession.lock(initial.id);
    }
  }

  async authorizeSecretFieldChange(): Promise<boolean> {
    if (this.isSecretFieldsUnlocked()) return true;
    const initial = this.activeSecretWorkspace();
    if (!initial) return false;
    if (!(await this.unlockSecretFields())) return false;
    this.secretFieldSession.lock(initial.id);
    return true;
  }

  refreshDockedSidebar() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INVENTTASKS_SIDEBAR)) {
      const v = leaf.view;
      if (v instanceof InventTasksSidebarView) v.render();
    }
    // The right-sidebar favorites panel tracks the active location too, so keep
    // it in sync whenever the docked nav is refreshed (e.g. on selectLocation).
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INVENTTASKS_FAVORITES)) {
      const v = leaf.view;
      if (v instanceof InventTasksFavoritesView) v.render();
    }
  }

  // Reveal the Favorites panel in Obsidian's right sidebar (reusing an existing
  // instance if there is one), alongside Backlinks / Tags / Outline.
  async openFavoritesPanel() {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(VIEW_TYPE_INVENTTASKS_FAVORITES)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE_INVENTTASKS_FAVORITES, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  // Show/hide the bottom favorites bar (persisted per workspace) + re-render.
  async setFavoritesBarVisible(visible: boolean) {
    this.prefs.favoritesBarVisible = visible;
    await this.saveSettings();
    this.getMainView()?.fullRender();
  }

  getMainView(): InventTasksMainView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_INVENTTASKS);
    if (leaves.length === 0) return null;
    const v = leaves[0].view;
    return v instanceof InventTasksMainView ? v : null;
  }

  // Proactive sync-down notification (desktop + mobile). The topbar indicator
  // is passive and its tooltip is invisible on touch, so a one-shot Notice
  // tells the user sync stopped reaching the server — edits made now may
  // conflict when it reconnects. Debounced so a brief blip never nags: only
  // fire if the error is still present after a short grace, and emit exactly
  // one "reconnected" Notice on recovery. Global (not per-workspace) so an
  // offline device that fails several scopes at once alerts just once.
  private syncDownNotified = false;
  private syncDownTimer: number | null = null;
  private static SYNC_DOWN_GRACE_MS = 12_000;

  private anySyncError(): boolean {
    for (const ws of this.settings.workspaces) {
      if (this.syncManager?.statusFor(ws.id)?.phase === "error") return true;
    }
    return this.vaultSyncManager?.isActive() === true && this.vaultSyncManager.status.phase === "error";
  }

  updateSyncHealth(): void {
    if (this.anySyncError()) {
      if (!this.syncDownNotified && this.syncDownTimer === null) {
        this.syncDownTimer = window.setTimeout(() => {
          this.syncDownTimer = null;
          if (this.anySyncError()) {
            this.syncDownNotified = true;
            new Notice(t("sync.offlineNotice"), 12000);
          }
        }, InventTasksPlugin.SYNC_DOWN_GRACE_MS);
      }
      return;
    }
    // Healthy again: cancel a pending alert and, if we alerted, confirm recovery.
    if (this.syncDownTimer !== null) { window.clearTimeout(this.syncDownTimer); this.syncDownTimer = null; }
    if (this.syncDownNotified) {
      this.syncDownNotified = false;
      new Notice(t("sync.reconnectedNotice"), 5000);
    }
  }

  async applySidebarPlacement(reveal = true) {
    const placement = this.prefs.sidebarPlacement;

    if (placement === "embedded") {
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_INVENTTASKS_SIDEBAR);
      return;
    }

    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_INVENTTASKS_SIDEBAR);
    const expectedRoot = placement === "left"
      ? this.app.workspace.leftSplit
      : this.app.workspace.rightSplit;
    const correct = existing.find((leaf) => leaf.getRoot() === expectedRoot);

    for (const leaf of existing) {
      if (leaf !== correct) leaf.detach();
    }

    let leaf: WorkspaceLeaf | null = correct ?? null;
    if (!leaf) {
      leaf = placement === "left"
        ? this.app.workspace.getLeftLeaf(false)
        : this.app.workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE_INVENTTASKS_SIDEBAR, active: false });
    }
    // reveal=false (startup with "restore last view") keeps the navigator
    // available as a tab without pulling focus off Obsidian's restored view.
    if (reveal) this.app.workspace.revealLeaf(leaf);
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_INVENTTASKS);
    let leaf: WorkspaceLeaf;
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_INVENTTASKS, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    // Make it the active leaf, not just "revealed". On mobile, revealLeaf alone
    // doesn't bring a background main-area leaf to the front — so a deep link to
    // a list/space/doc/view stayed hidden behind whatever leaf was on top, while
    // task links only seemed to work because their modal overlays everything.
    // No-op when the view is already active (the common in-app navigation case).
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  applyMobileOffset() {
    const root = document.body;
    root.style.setProperty("--inventtasks-mobile-bottom", `${this.prefs.mobileBottomOffset || 0}px`);
  }

  // Reflect the pure-background override as <body> classes. Both may be on at
  // once — the CSS gates `it-bg-white` behind `.theme-light` and `it-bg-black`
  // behind `.theme-dark`, so only the one matching Obsidian's current mode
  // actually paints, and the override follows Obsidian when the user flips mode.
  // Scoped in styles.css to the plugin's own surfaces only. See settings.ts.
  applyBackgroundTheme() {
    document.body.toggleClass("it-bg-white", this.settings.lightBackground === "white");
    document.body.toggleClass("it-bg-black", this.settings.darkBackground === "black");
  }

  applyStartupLocation() {
    const mv = this.getMainView();
    if (!mv) return;
    mv.state.location = resolveStartupLocation(this, this.prefs.defaultStartupLocation);
    // The view was constructed before the index loaded, so it loaded
    // persisted state for whatever default location it had at the time.
    // Now that the real startup location is set, re-apply persisted filters
    // (Group/Sort/Show-closed) AND resolve view (default_view / last-selected).
    mv.applyPersistedFiltersForLocation();
  }

  applyActiveColor() {
    const root = document.body;
    const color = this.index?.workspace?.active_color;
    if (color && /^#[0-9a-fA-F]{3,8}$/.test(color.trim())) {
      root.style.setProperty("--inventtasks-active-color", color);
    } else {
      root.style.removeProperty("--inventtasks-active-color");
    }
    // Text color override:
    //   undefined → fall back to the accent (no var set; CSS uses fallback)
    //   "inherit" → tag body with a class so CSS applies a literal
    //               `color: inherit` (the `inherit` keyword does NOT work when
    //               passed through a custom property — it gets treated as the
    //               CSS-wide keyword on the variable itself, leaving the
    //               substituted value empty and falling back to the accent).
    //   "node"    → tag body with a class so CSS reads var(--node-color),
    //               which each tree row sets to its own list/folder/space
    //               color. Nav rows (Today/Everything/Favorites) don't define
    //               --node-color, so CSS falls back to the accent for them.
    //   "#xxx"    → use the hex directly via the variable
    const text = this.index?.workspace?.active_text_color;
    root.classList.toggle("inventtasks-active-text-inherit", text === "inherit");
    root.classList.toggle("inventtasks-active-text-node", text === "node");
    const isHex = typeof text === "string" && /^#[0-9a-fA-F]{3,8}$/.test(text.trim());
    if (text !== "inherit" && text !== "node" && isHex) {
      root.style.setProperty("--inventtasks-active-text-color", text!);
    } else {
      root.style.removeProperty("--inventtasks-active-text-color");
    }
  }
}
