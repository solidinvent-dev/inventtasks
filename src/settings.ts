import { App, Modal, Notice, Platform, PluginSettingTab, Setting, TFolder, normalizePath, setIcon } from "obsidian";
import type InventTasksPlugin from "./main";
import { ContextLocation, ViewType } from "./types";
import { ConfirmModal } from "./modals/confirm-modal";
import { PersistedViewState } from "./view-state";
import { VIEW_COLOR_SCHEMES, ViewColorSet, WEBSITE_URL, resolveViewColorSet } from "./constants";
import { HOTKEY_ACTIONS, COMMON_OBSIDIAN_COMBOS, comboFromEvent, resolveHotkeys, formatCombo } from "./hotkeys";
import { openIconPicker } from "./ui/pickers";
import { renderIconish, appendSvg } from "./ui/icons";
import { renderLogo, SPARK_SVG } from "./ui/logo";
import { ExportModal } from "./modals/export-modal";
import { ImportModal } from "./modals/import-modal";
import { IncrementalBackupRestoreModal } from "./modals/incremental-backup-modal";
import { TrashModal } from "./modals/trash-modal";
import { getTemplates } from "./data/templates";
import { setLicense, isLicensed, freeLimit } from "./data/license";
import { activateAccount } from "./data/license-check";
import { TemplateManagerModal } from "./modals/template-modals";
import { AppLanguage, LANGUAGE_OPTIONS, hotkeyLabel, t, viewLabel, colorSchemeLabel, setLocale } from "./i18n";
import {
  NotifChannel,
  NotifRuntimeState,
  NtfyAccount,
  WorkspaceNotifConfig,
  normalizeWorkspaceNotifConfig,
} from "./notifications/types";
import { NtfyChannel } from "./notifications/channels/ntfy";
import { normalizeDigestTime } from "./notifications/engine";
import { CalendarSyncPrefs, defaultCalendarSyncPrefs } from "./calendar-sync/types";
import { SyncSettings, makeSyncSettings } from "./sync/types";
import { VaultSyncSettings, makeVaultSyncSettings, vaultSyncConfigured } from "./vault-sync/types";
import { overlappingWholeVaultRoot } from "./vault-sync/exclusions";
import { SyncHistoryModal } from "./modals/sync-history-modal";
import { SyncPathPickerModal } from "./modals/sync-path-picker-modal";
import { testCalDav } from "./calendar-sync/caldav";
import { runCalendarSync } from "./calendar-sync/sync";
import { makeIncrementalBackupSettings, type IncrementalBackupSettings } from "./data/incremental-backup";

export interface ActivitySettings {
  showActivity: boolean;      // Show "Activity" section in task modal
  showComments: boolean;      // Show "Comments" section in task modal
  log_created: boolean;
  log_status: boolean;
  log_priority: boolean;
  log_dates: boolean;         // start_date + due_date
  log_title: boolean;
  log_parent: boolean;        // parent_added/removed + subtask_added/removed
  log_relationships: boolean; // blocks/waiting/related add/remove
  log_checklist: boolean;
  log_comments: boolean;
  maxEntries: number;         // 0 = unlimited; default 100. Older entries dropped.
}

// One InventTasks "workspace" — its own root folder, its own ribbon icon, and
// its own full copy of every setting (it behaves like a separate plugin
// instance). Multiple workspaces can be added; one is active at a time and is
// switched via its ribbon icon. The markdown-stored config (statuses, custom
// fields, …) is naturally separate too, since each root has its own
// `_workspace.md`.
export interface WorkspaceEntry {
  id: string;                   // stable id (used for active selection + ribbon)
  name: string;                 // display name (ribbon tooltip)
  icon: string;                 // Lucide icon id shown on the ribbon

  // ---- per-workspace settings (everything below is independent per workspace) ----
  workspaceRoot: string;        // folder in vault that holds _workspace.md and Spaces
  defaultStartupView: ViewType;
  // What location the explorer opens at on launch. Encoded as one of:
  //   "today" | "everything" | "favorites" | "list:<path>" | "folder:<path>" | "space:<path>"
  defaultStartupLocation: string;
  mobileBottomOffset: number;          // px to avoid Obsidian's bottom bar
  sidebarPlacement: "embedded" | "left" | "right"; // where the it-sidebar navigator renders
  favoritesBarVisible: boolean;        // show the narrow favorites bar at the bottom of the main window
  favoritesPanelOnStart: boolean;      // auto-open the right-sidebar Favorites panel on launch
  favoritesPanelBootstrapped: boolean; // whether the panel was opened once on first run (so its icon appears)
  // Timezone that drives "today" / overdue / calendar day placement.
  //   "auto" (or "") = this device's local zone; "UTC"; or a fixed IANA zone.
  timezone: string;
  dateFormat: string;          // "YYYY-MM-DD" | "DD.MM.YYYY" | "MM/DD/YYYY" | "D MMM YYYY"
  timeFormat: string;          // "HH:mm" (24h) | "hh:mm A" (12h)
  weekStart: "monday" | "sunday";
  defaultCurrency: string;     // ISO code used as the default for new Money fields
  showClosedByDefault: boolean;
  openTaskMode: "modal" | "editor";    // double click on task: modal or open .md
  // Desktop-only task-modal layout. "wide" = ClickUp-style two-pane (main +
  // right rail with details/comments); "classic" = the original single column.
  // Ignored on mobile (always single column). Toggled from inside the modal.
  taskModalLayout?: "classic" | "wide";
  activityConfig: ActivitySettings;    // Activity log + Comments toggles, cap
  recurringProjectionMonths: number;   // calendar future-recurrence horizon (1–12)
  // Last-used Group / Sort / Show-closed / column calcs per location. Keys are
  // `locationKey(loc)` — see ./view-state.ts.
  viewStateByLocation: Record<string, PersistedViewState>;
  recentTaskIds: string[];             // most-recent-first, capped (RECENTS_CAP)
  notifications: {
    dismissed: Record<string, string>;  // notificationKey -> dismissedAt
    snoozed: Record<string, string>;    // notificationKey -> untilIso
    read: Record<string, string>;       // notificationKey -> readAt
    returned?: Record<string, string>;  // notificationKey -> returnedFromSnoozeAt
  };
  // Explorer "Global" section: item order + which are hidden. Header shortcuts
  // (Search / Notifications / Trash / Reminders / Short notes / Docs) live above it.
  // Item keys: today / everything / recents / favorites.
  globalNavOrder: string[];
  globalNavHidden: string[];
  bookmarksCollapsed: boolean;        // persisted collapsed state for Global → Bookmarks
  // Opt-in global-search scope. Both default to false: matching every Item's
  // body or custom-field values walks unbounded user text on each keystroke,
  // which is free on a small vault and costly on a large one. Toggled from the
  // search prompt itself, so the choice sits where its effect is visible.
  searchItemBodies: boolean;
  searchCustomFieldValues: boolean;
  viewColorScheme: string;           // id from VIEW_COLOR_SCHEMES (default: "brand")
  viewColors?: ViewColorSet; // 7 per-view overrides [list,board,calendar,table,gantt,timeline,doc]; falls back to scheme
  // Keyboard-shortcut overrides: actionId → combo ("Mod+Shift+T"); "" = disabled.
  // Absent key = use the action's default. See src/hotkeys.ts.
  hotkeys?: Record<string, string>;
  // External notifications — per-workspace CONFIG (master switch, channel
  // toggles, triggers). Plain data.json settings; see src/notifications/types.
  notifConfig: WorkspaceNotifConfig;
  // External notifications — RUNTIME state (sent dedup, history, last error).
  // NOT persisted to data.json; lives in the vault-synced workspace state file
  // (src/data/workspace-state.ts) and is populated on load.
  notifState?: NotifRuntimeState;
  backup: IncrementalBackupSettings;
  // Self-hosted file sync (src/sync/) — per-workspace server + token config.
  // Client state (cursor/manifest) is per device and lives in the plugin dir.
  sync: SyncSettings;
}

export const DEFAULT_GLOBAL_NAV = ["today", "everything", "recents", "favorites", "archived"];

export interface PluginSettings {
  /** Interface language (plugin-wide, not per-workspace). Default: English. */
  language?: AppLanguage;
  /**
   * Optional pure-background override for InventTasks' own surfaces (main area,
   * docked sidebar, favourites panel, modals). Only the BACKGROUND changes — no
   * text/border colours, and never a shade of grey. Split per Obsidian mode:
   *   - lightBackground "white" → force #fff, but ONLY while Obsidian is Light.
   *   - darkBackground  "black" → force #000, but ONLY while Obsidian is Dark.
   * Gating each to its mode keeps text contrast correct automatically and lets
   * the override follow Obsidian when the user flips light/dark. Default on both
   * = "obsidian" (no override — the original look).
   */
  lightBackground?: "obsidian" | "white";
  darkBackground?: "obsidian" | "black";
  workspaces: WorkspaceEntry[];
  activeWorkspaceId: string;
  /** Calendar sync is configured once for the whole plugin. Per-location rules stay in workspace config files. */
  calendarSync?: CalendarSyncPrefs;
  /** ntfy push account (server/topic/token) — configured once for the whole plugin. */
  ntfy?: NtfyAccount;
  /** Registered support account: { id: email, token: key }. */
  account?: { id?: string; token?: string };
  /** Opaque device-coordination blob — managed by the plugin, do not edit. */
  seed?: string;
  /**
   * Vault Sync (src/vault-sync/) — whole-vault sync, plugin-wide (one vault =
   * one server workspace of kind "vault"). Fully independent from the
   * per-workspace task sync above; client state lives in the plugin dir.
   */
  vaultSync?: VaultSyncSettings;
}

// How many recently-opened tasks to remember for the "Recent" view.
export const RECENTS_CAP = 25;

export const DEFAULT_ACTIVITY_SETTINGS: ActivitySettings = {
  showActivity: true,
  showComments: true,
  log_created: true,
  log_status: true,
  log_priority: true,
  log_dates: true,
  log_title: true,
  log_parent: true,
  log_relationships: true,
  log_checklist: true,
  log_comments: true,
  maxEntries: 100,
};

let __wsSeq = 0;
// Builds a WorkspaceEntry, filling every field with a sane default.
export function makeWorkspaceEntry(partial: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    id: partial.id || `ws-${Date.now().toString(36)}-${(__wsSeq++).toString(36)}`,
    name: partial.name || "Vault",
    icon: partial.icon || "check-square",
    workspaceRoot: partial.workspaceRoot ?? "Tasks",
    defaultStartupView: partial.defaultStartupView ?? "list",
    defaultStartupLocation: partial.defaultStartupLocation ?? "everything",
    mobileBottomOffset: partial.mobileBottomOffset ?? 48,
    sidebarPlacement: partial.sidebarPlacement ?? "left",
    favoritesBarVisible: partial.favoritesBarVisible ?? true,
    favoritesPanelOnStart: partial.favoritesPanelOnStart ?? false,
    favoritesPanelBootstrapped: partial.favoritesPanelBootstrapped ?? false,
    timezone: partial.timezone ?? "auto",
    dateFormat: partial.dateFormat ?? "YYYY-MM-DD",
    timeFormat: partial.timeFormat ?? "HH:mm",
    weekStart: partial.weekStart ?? "monday",
    defaultCurrency: partial.defaultCurrency ?? "PLN",
    showClosedByDefault: partial.showClosedByDefault ?? false,
    openTaskMode: partial.openTaskMode ?? "modal",
    taskModalLayout: partial.taskModalLayout ?? undefined,
    activityConfig: { ...DEFAULT_ACTIVITY_SETTINGS, ...(partial.activityConfig || {}) },
    recurringProjectionMonths: partial.recurringProjectionMonths ?? 3,
    viewStateByLocation: partial.viewStateByLocation ?? {},
    recentTaskIds: partial.recentTaskIds ?? [],
    notifications: {
      dismissed: partial.notifications?.dismissed ?? {},
      snoozed: partial.notifications?.snoozed ?? {},
      read: partial.notifications?.read ?? {},
      returned: partial.notifications?.returned ?? {},
    },
    globalNavOrder: partial.globalNavOrder ?? [...DEFAULT_GLOBAL_NAV],
    globalNavHidden: partial.globalNavHidden ?? [],
    bookmarksCollapsed: partial.bookmarksCollapsed ?? false,
    searchItemBodies: partial.searchItemBodies ?? false,
    searchCustomFieldValues: partial.searchCustomFieldValues ?? false,
    viewColorScheme: partial.viewColorScheme ?? "brand",
    viewColors: partial.viewColors ?? undefined,
    hotkeys: partial.hotkeys ?? undefined,
    notifConfig: normalizeWorkspaceNotifConfig(partial.notifConfig),
    backup: makeIncrementalBackupSettings(partial.backup),
    sync: makeSyncSettings(partial.sync),
  };
}

export const DEFAULT_SETTINGS: PluginSettings = {
  language: "en",
  lightBackground: "obsidian",
  darkBackground: "obsidian",
  workspaces: [makeWorkspaceEntry({ id: "ws-default", name: "Vault" })],
  activeWorkspaceId: "ws-default",
};

// Google Calendar, Outlook and SMTP email were removed in 1.2.0. Their OAuth
// tokens and the SMTP password are dropped on load so the next save rewrites
// data.json without them, instead of carrying dead credentials forever.
function withoutRemovedCalendarServices(calendar: any): CalendarSyncPrefs | undefined {
  if (!calendar || typeof calendar !== "object") return calendar;
  const { google: _google, outlook: _outlook, ...rest } = calendar;
  return rest;
}

export function loadPluginSettings(raw: any): PluginSettings {
  const data = raw || {};
  // An EMPTY workspaces array is a valid state (the user can run without the
  // task manager and use e.g. Vault Sync only) — only a missing/corrupt field
  // falls back to the default single workspace (fresh install).
  if (Array.isArray(data.workspaces)) {
    const workspaces = data.workspaces.map((w: any) => makeWorkspaceEntry(w));
    const activeWorkspaceId = workspaces.some((w: WorkspaceEntry) => w.id === data.activeWorkspaceId)
      ? data.activeWorkspaceId
      : (workspaces[0]?.id ?? "");
    const language = (["en", "pl", "de", "fr", "it", "es"] as const).includes(data.language)
      ? data.language as AppLanguage
      : "en";
    const lightBackground = data.lightBackground === "white" ? "white" : "obsidian";
    const darkBackground = data.darkBackground === "black" ? "black" : "obsidian";
    return {
      language, lightBackground, darkBackground, workspaces, activeWorkspaceId,
      calendarSync: withoutRemovedCalendarServices(data.calendarSync), ntfy: data.ntfy, account: data.account,
      seed: typeof data.seed === "string" ? data.seed : undefined,
      vaultSync: data.vaultSync ? makeVaultSyncSettings(data.vaultSync) : undefined,
    };
  }
  return { ...DEFAULT_SETTINGS, workspaces: DEFAULT_SETTINGS.workspaces.map((w) => makeWorkspaceEntry(w)) };
}

// Resolve the persisted startup-location string into a runtime ContextLocation.
// Falls back to "everything" if the saved entry no longer exists (e.g. the
// list/folder/space was deleted on another device). Called by the main view
// when constructing its initial state.
export function resolveStartupLocation(
  plugin: InventTasksPlugin,
  raw: string | undefined,
): ContextLocation {
  const value = (raw || "everything").trim();
  if (value === "today") return { kind: "today" };
  if (value === "everything") return { kind: "everything" };
  if (value === "archived") return { kind: "archived" };
  if (value === "favorites") return { kind: "favorites" };
  if (value === "recents") return { kind: "recents" };
  const sep = value.indexOf(":");
  if (sep > 0) {
    const kind = value.slice(0, sep);
    const path = value.slice(sep + 1);
    if (kind === "list" && plugin.index.findList(path)) return { kind: "list", path };
    if (kind === "folder" && plugin.index.findFolder(path)) return { kind: "folder", path };
    if (kind === "space" && plugin.index.findSpace(path)) return { kind: "space", path };
  }
  return { kind: "everything" };
}

export class InventTasksSettingTab extends PluginSettingTab {
  plugin: InventTasksPlugin;

  constructor(app: App, plugin: InventTasksPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Marks our settings tab so styles.css can re-tint Obsidian-rendered toggles
    // (which default to Obsidian's purple accent) to the plugin accent color.
    containerEl.addClass("inventtasks-settings");

    renderLogo(containerEl, { size: 42, wordmark: true, cls: "it-settings-about-logo it-settings-top-logo" });
    const about = containerEl.createEl("p", { cls: "setting-item-description" });
    about.createEl("strong", { text: "InventTasks" });
    about.appendText(t("settings.aboutText"));
    about.appendText(t("settings.aboutSync"));
    new Setting(containerEl)
      .setName(`InventTasks v${this.plugin.manifest.version}`)
      .setDesc(t("about.byline"))
      .addButton((b) =>
        b.setButtonText(t("about.openWebsite")).onClick(() => {
          window.open(WEBSITE_URL);
        })
      )
      .addButton((b) =>
        b.setButtonText(t("about.viewLicense")).onClick(() => {
          new LicenseModal(this.app, this.plugin).open();
        })
      );

    // Activation sits right above Health/Diagnostics so license state is the
    // first thing visible — prominent when inactive, discreet when active.
    this.renderActivation(containerEl);
    this.renderHealthDiagnostics(containerEl);

    new Setting(containerEl).setName(t("settings.title")).setHeading();
    containerEl.createEl("p", {
      text: t("settings.intro"),
      cls: "setting-item-description",
    });

    // ---------- General (this device) — per-machine prefs (localStorage,
    // never synced). Topmost so device-only settings aren't mistaken for the
    // shared "All workspaces" / per-workspace ones below. ----------
    this.sectionHeader(containerEl, t("settings.deviceGeneral"), ["device"]);
    containerEl.createEl("p", {
      text: t("settings.deviceGeneralDesc"),
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName(t("settings.startupReveal"))
      .setDesc(t("settings.startupRevealDesc"))
      .addDropdown((d) =>
        d
          .addOption("inventtasks", t("settings.startupRevealInventtasks"))
          .addOption("restore", t("settings.startupRevealRestore"))
          .setValue(this.plugin.getStartupReveal())
          .onChange((v) => this.plugin.setStartupReveal(v as "inventtasks" | "restore")));

    this.sectionHeader(containerEl, t("settings.general"), ["global"]);
    containerEl.createEl("p", {
      text: t("settings.generalDesc"),
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName(t("settings.language"))
      .setDesc(t("settings.languageDesc"))
      .addDropdown((d) => {
        for (const opt of LANGUAGE_OPTIONS) d.addOption(opt.value, t(opt.labelKey));
        d.setValue(this.plugin.settings.language || "en");
        d.onChange(async (v) => {
          this.plugin.settings.language = v as AppLanguage;
          setLocale(v);
          this.plugin.registerCommands();
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
          this.display();
        });
      });

    // Background override. The offered choice tracks Obsidian's CURRENT mode:
    // Light → Obsidian / White, Dark → Obsidian / Black. Each mode's pick is
    // stored independently, so flipping Obsidian's theme restores the other.
    new Setting(containerEl)
      .setName(t("settings.background"))
      .setDesc(t("settings.backgroundDesc"))
      .addDropdown((d) => {
        const isDark = document.body.classList.contains("theme-dark");
        d.addOption("obsidian", t("settings.bg.obsidian"));
        if (isDark) {
          d.addOption("black", t("settings.bg.black"));
          d.setValue(this.plugin.settings.darkBackground || "obsidian");
          d.onChange(async (v) => {
            this.plugin.settings.darkBackground = v === "black" ? "black" : "obsidian";
            await this.plugin.saveSettings();
            this.plugin.applyBackgroundTheme();
          });
        } else {
          d.addOption("white", t("settings.bg.white"));
          d.setValue(this.plugin.settings.lightBackground || "obsidian");
          d.onChange(async (v) => {
            this.plugin.settings.lightBackground = v === "white" ? "white" : "obsidian";
            await this.plugin.saveSettings();
            this.plugin.applyBackgroundTheme();
          });
        }
      });

    // ---------- Vault sync (whole vault, plugin-wide — hence up here with
    // the other "All workspaces" settings) ----------
    this.sectionHeader(containerEl, t("vaultSync.section"), ["global"]);
    this.renderVaultSyncSettings(containerEl);

    this.renderNtfyAccountSettings(containerEl);
    this.renderCalendarSyncSettings(containerEl);

    // ---------- Vaults manager ----------
    this.renderWorkspacesManager(containerEl);

    // Zero workspaces = the task manager is off. Everything below is
    // per-workspace configuration, so it disappears; the plugin-wide sections
    // above (General, Vault sync, accounts) stay fully usable.
    if (!this.plugin.hasWorkspaces) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: t("settings.noWorkspacesNote"),
      });
      return;
    }

    // ---------- Active vault settings ----------
    const active = this.plugin.prefs;
    this.sectionHeader(containerEl, t("settings.vaultSettings", { name: active.name }), ["workspace"]);
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: t("settings.vaultSettingsDesc"),
    });

    new Setting(containerEl)
      .setName(t("settings.startData"))
      .setDesc(t("settings.startDataDesc"))
      .addButton((b) =>
        b
          .setButtonText(t("settings.startDataBtn"))
          .onClick(() => {
            new ConfirmModal(this.app, {
              title: t("confirm.startDataTitle"),
              message: t("confirm.startDataMsg"),
              onConfirm: async () => {
                try {
                  await this.plugin.generateStartData();
                } catch (e: any) {
                  console.error("InventTasks start data failed", e);
                  new Notice(t("notice.richDemoFailed", { msg: e?.message ?? String(e) }));
                }
              },
            }).open();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.richDemo"))
      .setDesc(t("settings.richDemoDesc"))
      .addButton((b) =>
        b
          .setButtonText(t("settings.richDemoBtn"))
          .setWarning()
          .onClick(() => {
            new ConfirmModal(this.app, {
              title: t("confirm.richDemoTitle"),
              message: t("confirm.richDemoMsg"),
              onConfirm: async () => {
                try {
                  await this.plugin.generateRichDemo();
                } catch (e: any) {
                  console.error("InventTasks rich demo failed", e);
                  new Notice(t("notice.richDemoFailed", { msg: e?.message ?? String(e) }));
                }
              },
            }).open();
          })
      );

    this.renderExternalNotificationsSettings(containerEl);

    // ---------- File sync (self-hosted server, per workspace) ----------
    this.sectionHeader(containerEl, t("sync.section"), ["workspace"]);
    this.renderSyncSettings(containerEl);

    // ---------- Backup, export & import ----------
    this.sectionHeader(containerEl, t("settings.backup"), ["workspace"]);
    this.renderIncrementalBackupSettings(containerEl);
    new Setting(containerEl)
      .setName(t("settings.exportVault"))
      .setDesc(t("settings.exportVaultDesc"))
      .addButton((b) => b.setButtonText(t("settings.exportBtn")).setCta().onClick(() => new ExportModal(this.app, this.plugin, { scope: "workspace" }).open()));
    new Setting(containerEl)
      .setName(t("settings.importBackup"))
      .setDesc(t("settings.importBackupDesc"))
      .addButton((b) => b.setButtonText(t("settings.importBtn")).onClick(() => new ImportModal(this.app, this.plugin).open()));
    new Setting(containerEl)
      .setName(t("modal.trash"))
      .addButton((b) => b.setButtonText(t("nav.trash")).onClick(() => new TrashModal(this.app, this.plugin).open()));

    // ---------- Templates ----------
    this.sectionHeader(containerEl, t("settings.templates"), ["workspace"]);
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: t("settings.templatesDesc"),
    });
    const templateCount = getTemplates().length;
    new Setting(containerEl)
      .setName(t("settings.manageTemplates"))
      .setDesc(templateCount ? t("settings.manageTemplatesDesc", { count: templateCount }) : t("settings.manageTemplatesEmpty"))
      .addButton((b) => b.setButtonText(t("settings.manageTemplatesBtn")).onClick(() => new TemplateManagerModal(this.app, this.plugin).open()));

    // ---------- Activity & Comments ----------
    this.sectionHeader(containerEl, t("settings.activity"), ["workspace"]);
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: t("settings.activityDesc"),
    });

    const ac = () => this.plugin.prefs.activityConfig;

    new Setting(containerEl)
      .setName(t("settings.showActivity"))
      .addToggle((tog) => tog.setValue(ac().showActivity).onChange(async (v) => {
        ac().showActivity = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName(t("settings.showComments"))
      .addToggle((tog) => tog.setValue(ac().showComments).onChange(async (v) => {
        ac().showComments = v; await this.plugin.saveSettings();
      }));

    const logToggle = (nameKey: string, key: keyof ActivitySettings) => {
      new Setting(containerEl)
        .setName(t(nameKey))
        .addToggle((tog) => tog.setValue(ac()[key] as boolean).onChange(async (v) => {
          (ac() as any)[key] = v; await this.plugin.saveSettings();
        }));
    };
    logToggle("settings.logCreated", "log_created");
    logToggle("settings.logStatus", "log_status");
    logToggle("settings.logPriority", "log_priority");
    logToggle("settings.logDates", "log_dates");
    logToggle("settings.logTitle", "log_title");
    logToggle("settings.logParent", "log_parent");
    logToggle("settings.logRelationships", "log_relationships");
    logToggle("settings.logChecklist", "log_checklist");
    logToggle("settings.logComments", "log_comments");

    new Setting(containerEl)
      .setName(t("settings.activityCap"))
      .setDesc(t("settings.activityCapDesc"))
      .addText((t) =>
        t.setValue(String(ac().maxEntries)).onChange(async (v) => {
          const n = parseInt(v, 10);
          ac().maxEntries = isNaN(n) || n < 0 ? 0 : n;
          await this.plugin.saveSettings();
        })
      );

    // ---------- Dates & time ----------
    this.sectionHeader(containerEl, t("settings.datesTime"), ["workspace"]);

    new Setting(containerEl)
      .setName(t("settings.timezone"))
      .setDesc(t("settings.timezoneDesc"))
      .addDropdown((d) => {
        d.addOption("auto", t("settings.timezoneAuto"));
        d.addOption("UTC", "UTC");
        let zones: string[] = [];
        try {
          const sv = (Intl as any).supportedValuesOf;
          if (typeof sv === "function") zones = sv("timeZone") as string[];
        } catch { /* not available — use fallback list */ }
        if (!zones || zones.length === 0) {
          zones = [
            "Europe/Warsaw", "Europe/London", "Europe/Berlin", "Europe/Paris", "Europe/Moscow",
            "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo",
            "Asia/Dubai", "Asia/Kolkata", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
          ];
        }
        for (const z of zones) { if (z !== "UTC") d.addOption(z, z); }
        const cur = this.plugin.prefs.timezone || "auto";
        const known = Array.from(d.selectEl.options).some((o) => o.value === cur);
        d.setValue(known ? cur : "auto");
        d.onChange(async (v) => {
          this.plugin.prefs.timezone = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName(t("cfg.dateFormat"))
      .setDesc(t("settings.dateFormatDesc"))
      .addDropdown((d) => {
        d.addOption("YYYY-MM-DD", t("cfg.dateFmtIso"))
          .addOption("DD.MM.YYYY", t("cfg.dateFmtEu"))
          .addOption("MM/DD/YYYY", t("cfg.dateFmtUs"))
          .addOption("D MMM YYYY", t("cfg.dateFmtLong"))
          .setValue(this.plugin.prefs.dateFormat ?? "YYYY-MM-DD")
          .onChange(async (v) => {
            this.plugin.prefs.dateFormat = v;
            await this.plugin.saveSettings();
            // The date engine holds these in module state; redrawing the views
            // without pushing them again would repaint the same old format.
            this.plugin.applyDateTimePrefs();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName(t("cfg.timeFormat"))
      .setDesc(t("settings.timeFormatDesc"))
      .addDropdown((d) => {
        d.addOption("HH:mm", t("cfg.timeFmt24"))
          .addOption("hh:mm A", t("cfg.timeFmt12"))
          .setValue(this.plugin.prefs.timeFormat ?? "HH:mm")
          .onChange(async (v) => {
            this.plugin.prefs.timeFormat = v;
            await this.plugin.saveSettings();
            // The date engine holds these in module state; redrawing the views
            // without pushing them again would repaint the same old format.
            this.plugin.applyDateTimePrefs();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName(t("cfg.weekStartsOn"))
      .setDesc(t("settings.weekStartDesc"))
      .addDropdown((d) => {
        d.addOption("monday", t("cfg.weekMonday"))
          .addOption("sunday", t("cfg.weekSunday"))
          .setValue(this.plugin.prefs.weekStart ?? "monday")
          .onChange(async (v) => {
            this.plugin.prefs.weekStart = v as "monday" | "sunday";
            await this.plugin.saveSettings();
            // The date engine holds these in module state; redrawing the views
            // without pushing them again would repaint the same old format.
            this.plugin.applyDateTimePrefs();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName(t("cfg.defaultCurrency"))
      .setDesc(t("settings.defaultCurrencyDesc"))
      .addText((el) =>
        el
          .setPlaceholder("PLN")
          .setValue(this.plugin.prefs.defaultCurrency ?? "PLN")
          .onChange(async (v) => {
            this.plugin.prefs.defaultCurrency = v.toUpperCase().slice(0, 4) || "PLN";
            await this.plugin.saveSettings();
          })
      );

    // ---------- Recurring ----------
    this.sectionHeader(containerEl, t("settings.recurring"), ["workspace"]);

    new Setting(containerEl)
      .setName(t("settings.recurringHorizon"))
      .setDesc(t("settings.recurringHorizonDesc"))
      .addText((t) =>
        t.setValue(String(this.plugin.prefs.recurringProjectionMonths)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.prefs.recurringProjectionMonths = isNaN(n) ? 3 : Math.max(1, Math.min(12, n));
          await this.plugin.saveSettings();
        })
      );

    // ---------- View prefs ----------
    this.sectionHeader(containerEl, t("settings.viewPrefs"), ["workspace"]);

    // View color scheme picker + per-view color overrides
    const schemeSetting = new Setting(containerEl)
      .setName(t("settings.viewColorScheme"))
      .setDesc(t("settings.viewColorSchemeDesc"));
    schemeSetting.addDropdown((d) => {
      for (const s of VIEW_COLOR_SCHEMES) d.addOption(s.id, colorSchemeLabel(s.id));
      d.setValue(this.plugin.prefs.viewColorScheme || "brand");
      d.onChange(async (v) => {
        this.plugin.prefs.viewColorScheme = v;
        // Reset manual overrides when switching scheme
        this.plugin.prefs.viewColors = undefined;
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
        renderSchemePreview();
      });
    });

    // Color swatch preview row with color pickers (7: the 6 view types + Docs)
    const schemePreview = containerEl.createDiv({ cls: "it-scheme-preview" });
    const VIEW_NAMES = ["list", "board", "calendar", "table", "gantt", "timeline", "doc"].map(viewLabel);
    const resolveViewColors = (): ViewColorSet =>
      resolveViewColorSet(this.plugin.prefs.viewColorScheme, this.plugin.prefs.viewColors);
    const renderSchemePreview = () => {
      schemePreview.empty();
      const colors = resolveViewColors();
      for (let i = 0; i < VIEW_NAMES.length; i++) {
        const col = schemePreview.createDiv({ cls: "it-scheme-col" });
        const picker = col.createEl("input", {
          type: "color",
          cls: "it-scheme-picker",
          attr: { title: VIEW_NAMES[i], value: colors[i] },
        });
        picker.value = colors[i];
        const label = col.createSpan({ cls: "it-scheme-label", text: VIEW_NAMES[i] });
        picker.addEventListener("input", async (e) => {
          const val = (e.target as HTMLInputElement).value;
          const current = resolveViewColors();
          current[i] = val;
          this.plugin.prefs.viewColors = current;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        });
      }
    };
    renderSchemePreview();

    new Setting(containerEl)
      .setName(t("settings.defaultStartupView"))
      .setDesc(t("settings.defaultStartupViewDesc"))
      .addDropdown((d) =>
        d
          .addOption("list", viewLabel("list"))
          .addOption("board", viewLabel("boardKanban"))
          .addOption("calendar", viewLabel("calendar"))
          .addOption("table", viewLabel("table"))
          .addOption("gantt", viewLabel("gantt"))
          .addOption("timeline", viewLabel("timeline"))
          .setValue(this.plugin.prefs.defaultStartupView)
          .onChange(async (v) => {
            this.plugin.prefs.defaultStartupView = v as ViewType;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.defaultStartupLocation"))
      .setDesc(t("settings.defaultStartupLocationDesc"))
      .addDropdown((d) => {
        const sel = d.selectEl;
        // Global options
        d.addOption("today", t("nav.today"));
        d.addOption("everything", t("nav.everything"));
        d.addOption("favorites", t("nav.favorites"));
        d.addOption("recents", t("nav.recents"));
        d.addOption("archived", t("nav.archived"));

        // Spaces / Folders / Lists grouped by parent so qualified names stay readable
        for (const space of this.plugin.index.spaces) {
          const grp = document.createElement("optgroup");
          grp.label = t("settings.startupSpaceGroup", { name: space.config.name });
          // The space itself
          const spaceOpt = document.createElement("option");
          spaceOpt.value = `space:${space.path}`;
          spaceOpt.textContent = t("settings.startupWholeSpace", { name: space.config.name });
          grp.appendChild(spaceOpt);
          // Lists directly under the space
          for (const list of space.lists) {
            const o = document.createElement("option");
            o.value = `list:${list.path}`;
            o.textContent = `  ${list.config.name}`;
            grp.appendChild(o);
          }
          // Folders + their lists
          for (const folder of space.folders) {
            const folderOpt = document.createElement("option");
            folderOpt.value = `folder:${folder.path}`;
            folderOpt.textContent = `📁 ${folder.config.name}`;
            grp.appendChild(folderOpt);
            for (const list of folder.lists) {
              const o = document.createElement("option");
              o.value = `list:${list.path}`;
              o.textContent = `   ${folder.config.name} / ${list.config.name}`;
              grp.appendChild(o);
            }
          }
          sel.appendChild(grp);
        }

        // If the persisted value no longer exists (deleted list/folder/space),
        // fall back to "everything" so the dropdown isn't blank.
        const saved = this.plugin.prefs.defaultStartupLocation || "everything";
        const exists = Array.from(sel.options).some((o) => o.value === saved);
        d.setValue(exists ? saved : "everything");
        d.onChange(async (v) => {
          this.plugin.prefs.defaultStartupLocation = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("settings.sidebarPlacement"))
      .setDesc(t("settings.sidebarPlacementDesc"))
      .addDropdown((d) =>
        d
          .addOption("embedded", t("settings.sidebarEmbedded"))
          .addOption("left", t("settings.sidebarLeft"))
          .addOption("right", t("settings.sidebarRight"))
          .setValue(this.plugin.prefs.sidebarPlacement)
          .onChange(async (v) => {
            this.plugin.prefs.sidebarPlacement = v as "embedded" | "left" | "right";
            await this.plugin.saveSettings();
            await this.plugin.applySidebarPlacement();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.favoritesBar"))
      .setDesc(t("settings.favoritesBarDesc"))
      .addToggle((tog) =>
        tog.setValue(this.plugin.prefs.favoritesBarVisible).onChange(async (v) => {
          await this.plugin.setFavoritesBarVisible(v);
        })
      );

    new Setting(containerEl)
      .setName(t("settings.favoritesPanel"))
      .setDesc(t("settings.favoritesPanelDesc"))
      .addToggle((tog) =>
        tog.setValue(this.plugin.prefs.favoritesPanelOnStart).onChange(async (v) => {
          this.plugin.prefs.favoritesPanelOnStart = v;
          await this.plugin.saveSettings();
          if (v) void this.plugin.openFavoritesPanel();
        })
      )
      .addButton((b) =>
        b.setButtonText(t("settings.favoritesPanelOpen")).onClick(() => this.plugin.openFavoritesPanel())
      );

    new Setting(containerEl)
      .setName(t("settings.showClosedDefault"))
      .setDesc(t("settings.showClosedDefaultDesc"))
      .addToggle((t) =>
        t.setValue(this.plugin.prefs.showClosedByDefault).onChange(async (v) => {
          this.plugin.prefs.showClosedByDefault = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.openTask"))
      .setDesc(t("settings.openTaskDesc"))
      .addDropdown((d) =>
        d
          .addOption("modal", t("settings.openTaskModal"))
          .addOption("editor", t("settings.openTaskEditor"))
          .setValue(this.plugin.prefs.openTaskMode)
          .onChange(async (v) => {
            this.plugin.prefs.openTaskMode = v as "modal" | "editor";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.mobileOffset"))
      .setDesc(t("settings.mobileOffsetDesc"))
      .addText((t) =>
        t
          .setPlaceholder("48")
          .setValue(String(this.plugin.prefs.mobileBottomOffset))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.prefs.mobileBottomOffset = isNaN(n) ? 48 : n;
            await this.plugin.saveSettings();
            this.plugin.applyMobileOffset();
          })
      );

    this.renderHotkeysSection(containerEl);
  }

  // Section header with scope chip(s) so it's clear whether a section is global
  // (whole plugin), per-workspace, or desktop-only.
  private sectionHeader(
    parent: HTMLElement,
    title: string,
    scopes: Array<"global" | "workspace" | "desktop" | "device">,
    level: "h2" | "h3" = "h3",
  ): HTMLElement {
    const h = parent.createEl(level, { cls: "it-settings-head" });
    h.createSpan({ text: title });
    for (const scope of scopes) {
      h.createSpan({ cls: `it-scope-chip it-scope-${scope}`, text: t(`settings.scope.${scope}`) });
    }
    return h;
  }

  // ---------- Keyboard shortcuts manager ----------

  private async setHotkey(id: string, combo: string | undefined) {
    const map: Record<string, string> = { ...(this.plugin.prefs.hotkeys || {}) };
    if (combo === undefined) delete map[id];   // reset → use the action's default
    else map[id] = combo;                      // set, or "" = disabled
    this.plugin.prefs.hotkeys = Object.keys(map).length ? map : undefined;
    await this.plugin.saveSettings();
  }

  private renderHotkeysSection(containerEl: HTMLElement) {
    this.sectionHeader(containerEl, t("settings.hotkeys"), ["workspace", "desktop"]);
    if (Platform.isMobile) {
      containerEl.createEl("p", { cls: "it-settings-desktop-note", text: t("settings.hotkeysMobile") });
      return;
    }
    containerEl.createEl("p", { cls: "setting-item-description", text: t("settings.hotkeysDesc") });

    const wrap = containerEl.createDiv({ cls: "it-hotkeys" });
    let recordingId: string | null = null;
    let cleanup = () => {};

    const startRecording = (id: string) => {
      recordingId = id;
      render();
      const onKey = async (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") { cleanup(); recordingId = null; render(); return; }
        if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return; // wait for the real key
        const combo = comboFromEvent(e);
        if (!combo) { new Notice(t("notice.hotkeyNeedModifier")); return; }
        cleanup();
        recordingId = null;
        const resolved = resolveHotkeys(this.plugin);
        const clash = HOTKEY_ACTIONS.find((a) => a.id !== id && resolved[a.id] && resolved[a.id] === combo);
        if (clash) { new Notice(t("notice.hotkeyClash", { combo: formatCombo(combo), label: hotkeyLabel(clash.id) })); render(); return; }
        if (COMMON_OBSIDIAN_COMBOS.has(combo)) {
          new Notice(t("notice.hotkeyObsidianOverlap", { combo: formatCombo(combo) }));
        }
        await this.setHotkey(id, combo);
        render();
      };
      // Keys arrive in the settings window, which is its own window since
      // Obsidian 1.14 — listen there, not on the main window's document.
      const keyDoc = wrap.ownerDocument;
      cleanup = () => keyDoc.removeEventListener("keydown", onKey, true);
      keyDoc.addEventListener("keydown", onKey, true);
    };

    const render = () => {
      wrap.empty();
      const resolved = resolveHotkeys(this.plugin);
      for (const action of HOTKEY_ACTIONS) {
        const combo = resolved[action.id];
        const row = wrap.createDiv({ cls: "it-hotkey-row" });
        row.createDiv({ cls: "it-hotkey-label", text: hotkeyLabel(action.id) });
        const right = row.createDiv({ cls: "it-hotkey-controls" });
        const keyBtn = right.createEl("button", { cls: "it-hotkey-key" + (recordingId === action.id ? " is-recording" : "") + (!combo && recordingId !== action.id ? " is-empty" : "") });
        if (recordingId === action.id) keyBtn.setText(t("common.pressKeys"));
        else keyBtn.setText(combo ? formatCombo(combo) : t("common.notSet"));
        keyBtn.addEventListener("click", () => { if (recordingId !== action.id) startRecording(action.id); });

        const resetBtn = right.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { title: t("common.resetDefault"), "aria-label": t("common.resetDefault") } });
        setIcon(resetBtn, "rotate-ccw");
        resetBtn.addEventListener("click", async () => { cleanup(); recordingId = null; await this.setHotkey(action.id, undefined); render(); });

        const clearBtn = right.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { title: t("common.clear"), "aria-label": t("common.clear") } });
        setIcon(clearBtn, "x");
        clearBtn.addEventListener("click", async () => { cleanup(); recordingId = null; await this.setHotkey(action.id, ""); render(); });
      }
    };

    render();
  }

  // Renders the list of workspaces with controls to add / rename / set the
  // ribbon icon / set the root folder / set active / remove. Each workspace
  // gets its own ribbon icon; one is active at a time.
  private renderWorkspacesManager(containerEl: HTMLElement) {
    const s = this.plugin.settings;
    this.sectionHeader(containerEl, t("settings.vaults"), ["global"]);
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: t("settings.vaultsDesc"),
    });

    for (const ws of s.workspaces) {
      const isActive = ws.id === s.activeWorkspaceId;
      const block = containerEl.createDiv({ cls: "it-ws-block" + (isActive ? " is-active" : "") });

      // Heading: icon + name (+ active badge) and the set-active / remove buttons.
      const head = new Setting(block);
      renderIconish(head.nameEl, ws.icon || "check-square", { cls: "it-ws-icon-prev" });
      const headName = head.nameEl.createSpan({ cls: "it-ws-head-name", text: ws.name });
      if (isActive) head.nameEl.createSpan({ cls: "it-ws-active-badge", text: t("settings.activeBadge") });
      head.addButton((b) => {
        b.setButtonText(isActive ? t("common.active") : t("common.setActive"));
        if (isActive) b.setDisabled(true);
        else b.onClick(async () => { await this.plugin.switchWorkspace(ws.id); this.display(); });
      });
      head.addExtraButton((b) =>
        b.setIcon("trash").setTooltip(t("settings.removeVaultTooltip")).onClick(() => {
          // Removing the LAST workspace is allowed: the task manager simply
          // turns off (files stay on disk) while plugin-wide features — most
          // importantly Vault sync — keep working.
          new ConfirmModal(this.app, {
            title: t("confirm.removeVault"),
            message: t("confirm.removeVaultMsg", { name: ws.name, root: ws.workspaceRoot }),
            destructive: true,
            confirmLabel: t("common.remove"),
            onConfirm: async () => {
              const wasActive = s.activeWorkspaceId === ws.id;
              const idx = s.workspaces.findIndex((w) => w.id === ws.id);
              if (idx >= 0) s.workspaces.splice(idx, 1);
              if (wasActive) s.activeWorkspaceId = s.workspaces[0]?.id ?? "";
              // Reflect the removal on the ribbon immediately (before any await
              // that could throw and skip the rebuild).
              this.plugin.rebuildRibbons();
              if (wasActive && s.activeWorkspaceId) await this.plugin.switchWorkspace(s.activeWorkspaceId);
              else await this.plugin.saveSettings();
              if (!this.plugin.hasWorkspaces) this.plugin.refreshViews();
              this.plugin.refreshBackgroundServices();
              this.display();
            },
          }).open();
        })
      );

      new Setting(block).setName(t("settings.vaultName")).addText((inp) =>
        inp.setValue(ws.name).onChange(async (v) => {
          ws.name = v.trim() || t("common.vault");
          headName.setText(ws.name);
          await this.plugin.saveSettings();
          this.plugin.rebuildRibbons();
        })
      );

      new Setting(block)
        .setName(t("settings.ribbonIcon"))
        .setDesc(t("settings.ribbonIconDesc"))
        .addButton((b) => {
          b.buttonEl.addClass("it-ws-icon-btn");
          renderIconish(b.buttonEl, ws.icon || "check-square", { cls: "it-ws-icon-prev" });
          b.buttonEl.createSpan({ text: t("settings.changeIcon") });
          b.onClick(() =>
            openIconPicker(b.buttonEl, ws.icon, async (icon) => {
              ws.icon = icon;
              await this.plugin.saveSettings();
              this.plugin.rebuildRibbons();
              this.display();
            })
          );
        });

      let pendingRoot = ws.workspaceRoot;
      new Setting(block)
        .setName(t("settings.vaultFolder"))
        .setDesc(t("settings.vaultFolderDesc"))
        .addText((inp) =>
          inp.setPlaceholder("Tasks").setValue(ws.workspaceRoot).onChange((v) => { pendingRoot = v.trim() || "/"; })
        )
        .addButton((b) =>
          b.setButtonText(t("common.apply")).onClick(async () => {
            // Changing the root must MOVE the workspace, not abandon it:
            // leaving the old folder behind means the (empty) new root reads
            // as "everything was deleted" — sync would tombstone every file
            // on the server and every other device. When the old folder has
            // the content and the new path is free, rename it (relative paths
            // stay identical, so sync sees a no-op).
            const oldRoot = (ws.workspaceRoot || "").trim();
            const newRoot = pendingRoot === "/" ? "" : normalizePath(pendingRoot);
            const renamed = await this.moveWorkspaceRoot(oldRoot, newRoot);
            ws.workspaceRoot = pendingRoot;
            await this.plugin.saveSettings();
            if (ws.id === s.activeWorkspaceId) await this.plugin.onRootChanged();
            this.plugin.refreshBackgroundServices();
            new Notice(renamed ? t("notice.vaultFolderMoved", { from: oldRoot, to: newRoot }) : t("notice.vaultFolderSet"));
            this.display();
          })
        );
    }

    new Setting(containerEl).addButton((b) =>
      b.setButtonText(t("settings.addVault")).setCta().onClick(async () => {
        if (!isLicensed() && s.workspaces.length >= 1) { new Notice(t("lim.vaults", { n: 1 })); return; }
        const n = s.workspaces.length + 1;
        // New vaults default to docking the navigator in Obsidian's left sidebar.
        const ws = makeWorkspaceEntry({ name: `Vault ${n}`, workspaceRoot: `Tasks-${n}`, sidebarPlacement: "left" });
        // File sync is strictly per workspace: a NEW workspace always starts
        // with a pristine, disabled config (never inherits another's
        // server/token/remote — that would bootstrap against foreign data).
        ws.sync = makeSyncSettings();
        s.workspaces.push(ws);
        s.activeWorkspaceId = ws.id;
        await this.plugin.saveSettings();
        this.plugin.rebuildRibbons();
        await this.plugin.switchWorkspace(ws.id);
        this.display();
      })
    );
  }

  /**
   * Best-effort move of a workspace's folder when its root setting changes:
   * rename old → new when the old folder exists (with the content) and the
   * new path is free. Returns true when a rename happened. Falls back to the
   * old behavior (onRootChanged creates the folder) for every other case:
   * same path, whole-vault roots, target already exists, or rename failure.
   */
  private async moveWorkspaceRoot(oldRoot: string, newRoot: string): Promise<boolean> {
    const from = !oldRoot || oldRoot === "/" ? "" : normalizePath(oldRoot);
    const to = !newRoot || newRoot === "/" ? "" : normalizePath(newRoot);
    if (!from || !to || from === to) return false;
    if (to === from || to.startsWith(`${from}/`) || from.startsWith(`${to}/`)) return false; // nested — ambiguous
    const source = this.app.vault.getAbstractFileByPath(from);
    if (!(source instanceof TFolder)) return false;
    if (this.app.vault.getAbstractFileByPath(to)) return false; // target exists — just switch
    try {
      // Ensure the target's parent chain exists (rename does not mkdir -p).
      const slash = to.lastIndexOf("/");
      if (slash > 0) {
        const parent = to.slice(0, slash);
        if (!this.app.vault.getAbstractFileByPath(parent)) {
          await this.app.vault.createFolder(parent);
        }
      }
      // fileManager.renameFile also rewrites wiki-links pointing into the tree.
      await this.app.fileManager.renameFile(source, to);
      return true;
    } catch (e) {
      console.warn("[InventTasks] workspace root rename failed — falling back to create", e);
      return false;
    }
  }

  // ---- helpers ----

  private notifConfig(): WorkspaceNotifConfig {
    return this.plugin.prefs.notifConfig;
  }

  private calPrefs(): CalendarSyncPrefs {
    return this.plugin.globalCalendarSync();
  }

  private async save(): Promise<void> {
    await this.plugin.saveSettings();
  }

  private async saveAndRunNotifications(): Promise<void> {
    await this.save();
    await this.plugin.notificationCenter?.runNow();
    // The user is actively tweaking settings — deliver right away instead of
    // waiting out the outbox quiet window.
    await this.plugin.notificationCenter?.flushNow();
  }

  private async saveAndRefreshBackup(): Promise<void> {
    await this.save();
    this.plugin.refreshIncrementalBackupService();
  }

  private backupPrefs(): IncrementalBackupSettings {
    this.plugin.prefs.backup = makeIncrementalBackupSettings(this.plugin.prefs.backup);
    return this.plugin.prefs.backup;
  }

  private renderSyncSettings(containerEl: HTMLElement): void {
    const ws = this.plugin.prefs;
    const sync = ws.sync;
    const save = async () => {
      await this.plugin.saveSettings();
      void this.plugin.syncManager?.reconfigure();
    };

    containerEl.createEl("p", { cls: "setting-item-description", text: t("sync.desc") });

    const status = this.plugin.syncManager?.statusFor(ws.id);
    if (sync.enabled) {
      const parts: string[] = [];
      parts.push(status?.lastSyncAt
        ? t("sync.statusLast", { value: new Date(status.lastSyncAt).toLocaleString() })
        : t("sync.statusNever"));
      if (status && status.pending > 0) parts.push(t("sync.statusPending", { count: status.pending }));
      containerEl.createEl("p", { cls: "setting-item-description", text: parts.join(" • ") });
      if (status?.lastError) {
        containerEl.createEl("p", { cls: "it-export-error", text: t("sync.statusError", { msg: status.lastError }) });
      }
    }

    new Setting(containerEl)
      .setName(t("sync.enabled"))
      .setDesc(t("sync.enabledDesc"))
      .addToggle((tog) => tog.setValue(sync.enabled).onChange(async (value) => {
        sync.enabled = value;
        await save();
        this.display();
      }));

    if (!sync.enabled) return;

    new Setting(containerEl)
      .setName(t("sync.serverUrl"))
      .setDesc(t("sync.serverUrlDesc"))
      .addText((txt) => txt.setPlaceholder("https://sync.example.com")
        .setValue(sync.serverUrl)
        .onChange(async (value) => {
          sync.serverUrl = value.trim().replace(/\/+$/, "");
          await save();
        }));

    new Setting(containerEl)
      .setName(t("sync.token"))
      .setDesc(t("sync.tokenDesc"))
      .addText((txt) => {
        txt.setValue(sync.token).onChange(async (value) => {
          sync.token = value.trim();
          await save();
        });
        txt.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName(t("sync.remoteWorkspace"))
      .setDesc(t("sync.remoteWorkspaceDesc"))
      .addText((txt) => txt.setPlaceholder("main")
        .setValue(sync.remoteWorkspace)
        .onChange(async (value) => {
          sync.remoteWorkspace = value.trim();
          await save();
        }));

    new Setting(containerEl)
      .setName(t("sync.interval"))
      .setDesc(t("sync.intervalDesc"))
      .addText((txt) => txt.setValue(String(sync.intervalMinutes)).onChange(async (value) => {
        sync.intervalMinutes = Math.max(1, Math.min(120, parseInt(value, 10) || 5));
        await save();
      }));

    new Setting(containerEl)
      .setName(t("sync.liveUpdates"))
      .setDesc(t("sync.liveUpdatesDesc"))
      .addToggle((tog) => tog.setValue(sync.liveUpdates).onChange(async (value) => {
        sync.liveUpdates = value;
        await save();
      }));

    new Setting(containerEl)
      .setName(t("sync.conflictCopies"))
      .setDesc(t("sync.conflictCopiesDesc"))
      .addToggle((tog) => tog.setValue(sync.conflictCopies).onChange(async (value) => {
        sync.conflictCopies = value;
        await save();
      }));

    new Setting(containerEl)
      .setName(t("sync.actions"))
      .setDesc(t("sync.actionsDesc"))
      .addButton((b) => b.setButtonText(t("sync.testConnection")).onClick(async () => {
        if (!this.plugin.syncManager) return;
        const res = await this.plugin.syncManager.testConnection(sync);
        new Notice(res.message, res.ok ? 5000 : 10000);
      }))
      .addButton((b) => b.setButtonText(t("sync.syncNow")).setCta().onClick(async () => {
        if (!this.plugin.syncManager) return;
        new Notice(t("sync.syncing"));
        const sum = await this.plugin.syncManager.syncNow(ws.id);
        if (!sum) {
          const st = this.plugin.syncManager.statusFor(ws.id);
          new Notice(t("sync.syncFailed", { msg: st?.lastError || "?" }), 10000);
        } else if (sum.blocked) {
          new Notice(t("sync.blockedMassDelete"), 10000);
        } else {
          new Notice(t("sync.syncDone", {
            pulled: sum.pulled,
            pushed: sum.pushed + sum.deletedRemote,
            conflicts: sum.conflicts,
          }));
        }
        this.display();
      }));

    new Setting(containerEl)
      .setName(t("syncHistory.section"))
      .setDesc(t("syncHistory.sectionDesc"))
      .addButton((b) => b.setButtonText(t("syncHistory.browse")).onClick(() => {
        const mgr = this.plugin.syncManager;
        if (!mgr?.isActive(ws.id)) { new Notice(t("sync.notConfigured")); return; }
        const paths = mgr.syncedPaths(ws.id);
        if (paths.length === 0) { new Notice(t("syncHistory.empty")); return; }
        new SyncPathPickerModal(this.app, paths, (path) => {
          new SyncHistoryModal(this.app, this.plugin.taskSyncHistoryProvider(ws.id), path).open();
        }).open();
      }));
  }

  private renderVaultSyncSettings(containerEl: HTMLElement): void {
    if (!this.plugin.settings.vaultSync) this.plugin.settings.vaultSync = makeVaultSyncSettings();
    const vs = this.plugin.settings.vaultSync;
    const save = async () => {
      await this.plugin.saveSettings();
      void this.plugin.vaultSyncManager?.reconfigure();
    };

    containerEl.createEl("p", { cls: "setting-item-description", text: t("vaultSync.desc") });

    const overlap = overlappingWholeVaultRoot(this.plugin.settings.workspaces.map((w) => w.workspaceRoot));
    if (overlap) {
      containerEl.createEl("p", { cls: "it-export-error", text: t("vaultSync.overlapNotice") });
    }

    const status = this.plugin.vaultSyncManager?.status;
    if (vs.enabled && !overlap) {
      const parts: string[] = [];
      parts.push(status?.lastSyncAt
        ? t("sync.statusLast", { value: new Date(status.lastSyncAt).toLocaleString() })
        : t("sync.statusNever"));
      if (status && status.pending > 0) parts.push(t("sync.statusPending", { count: status.pending }));
      if (status && status.skippedLarge > 0) parts.push(t("vaultSync.statusSkipped", { count: status.skippedLarge }));
      containerEl.createEl("p", { cls: "setting-item-description", text: parts.join(" • ") });
      if (status?.lastError) {
        containerEl.createEl("p", { cls: "it-export-error", text: t("sync.statusError", { msg: status.lastError }) });
      }
    }

    new Setting(containerEl)
      .setName(t("vaultSync.enabled"))
      .setDesc(t("vaultSync.enabledDesc"))
      .addToggle((tog) => tog.setValue(vs.enabled).onChange(async (value) => {
        vs.enabled = value;
        await save();
        this.display();
      }));

    if (!vs.enabled) return;

    new Setting(containerEl)
      .setName(t("sync.serverUrl"))
      .setDesc(t("vaultSync.serverUrlDesc"))
      .addText((txt) => txt.setPlaceholder("https://sync.example.com")
        .setValue(vs.serverUrl)
        .onChange(async (value) => {
          vs.serverUrl = value.trim().replace(/\/+$/, "");
          await save();
        }));

    new Setting(containerEl)
      .setName(t("sync.token"))
      .setDesc(t("vaultSync.tokenDesc"))
      .addText((txt) => {
        txt.setValue(vs.token).onChange(async (value) => {
          vs.token = value.trim();
          await save();
        });
        txt.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName(t("vaultSync.remoteId"))
      .setDesc(t("vaultSync.remoteIdDesc"))
      .addText((txt) => txt.setPlaceholder("vault")
        .setValue(vs.remoteId)
        .onChange(async (value) => {
          vs.remoteId = value.trim();
          await save();
        }));

    new Setting(containerEl)
      .setName(t("sync.interval"))
      .setDesc(t("vaultSync.intervalDesc"))
      .addText((txt) => txt.setValue(String(vs.intervalMinutes)).onChange(async (value) => {
        vs.intervalMinutes = Math.max(1, Math.min(120, parseInt(value, 10) || 5));
        await save();
      }));

    new Setting(containerEl)
      .setName(t("sync.liveUpdates"))
      .setDesc(t("sync.liveUpdatesDesc"))
      .addToggle((tog) => tog.setValue(vs.liveUpdates).onChange(async (value) => {
        vs.liveUpdates = value;
        await save();
      }));

    new Setting(containerEl)
      .setName(t("sync.conflictCopies"))
      .setDesc(t("sync.conflictCopiesDesc"))
      .addToggle((tog) => tog.setValue(vs.conflictCopies).onChange(async (value) => {
        vs.conflictCopies = value;
        await save();
      }));

    new Setting(containerEl)
      .setName(t("vaultSync.obsidianConfig"))
      .setDesc(t("vaultSync.obsidianConfigDesc"))
      .addToggle((tog) => tog.setValue(vs.syncObsidianConfig).onChange(async (value) => {
        vs.syncObsidianConfig = value;
        await save();
      }));

    new Setting(containerEl)
      .setName(t("vaultSync.obsidianPlugins"))
      .setDesc(t("vaultSync.obsidianPluginsDesc"))
      .addToggle((tog) => tog.setValue(vs.syncObsidianPlugins).onChange(async (value) => {
        vs.syncObsidianPlugins = value;
        await save();
      }));

    new Setting(containerEl)
      .setName(t("vaultSync.maxFile"))
      .setDesc(t("vaultSync.maxFileDesc"))
      .addText((txt) => txt.setValue(String(vs.maxFileMB)).onChange(async (value) => {
        vs.maxFileMB = Math.max(0, Math.min(1024, parseInt(value, 10) || 0));
        await save();
      }));

    const ignore = new Setting(containerEl)
      .setName(t("vaultSync.ignorePatterns"))
      .setDesc(t("vaultSync.ignorePatternsDesc"));
    ignore.settingEl.addClass("it-vault-sync-ignore");
    ignore.addTextArea((ta) => {
      ta.setPlaceholder("Big Media/\n*.mp4\n# comment")
        .setValue(vs.ignorePatterns.join("\n"))
        .onChange(async (value) => {
          vs.ignorePatterns = value.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
          await save();
        });
      ta.inputEl.rows = 4;
    });

    new Setting(containerEl)
      .setName(t("sync.actions"))
      .setDesc(t("vaultSync.actionsDesc"))
      .addButton((b) => b.setButtonText(t("sync.testConnection")).onClick(async () => {
        if (!this.plugin.vaultSyncManager) return;
        const res = await this.plugin.vaultSyncManager.testConnection(vs);
        new Notice(res.message, res.ok ? 5000 : 10000);
      }))
      .addButton((b) => b.setButtonText(t("sync.syncNow")).setCta().onClick(async () => {
        const mgr = this.plugin.vaultSyncManager;
        if (!mgr?.isActive()) { new Notice(t("sync.notConfigured")); return; }
        new Notice(t("sync.syncing"));
        const sum = await mgr.syncNow();
        if (!sum) {
          new Notice(t("sync.syncFailed", { msg: mgr.status.lastError || "?" }), 10000);
        } else if (sum.blocked) {
          new Notice(t("sync.blockedMassDelete"), 10000);
        } else {
          new Notice(t("sync.syncDone", {
            pulled: sum.pulled,
            pushed: sum.pushed + sum.deletedRemote,
            conflicts: sum.conflicts,
          }));
        }
        this.display();
      }));

    new Setting(containerEl)
      .setName(t("syncHistory.section"))
      .setDesc(t("vaultSync.historyDesc"))
      .addButton((b) => b.setButtonText(t("syncHistory.browse")).onClick(() => {
        const mgr = this.plugin.vaultSyncManager;
        if (!mgr?.isActive()) { new Notice(t("sync.notConfigured")); return; }
        const paths = mgr.syncedPaths();
        if (paths.length === 0) { new Notice(t("syncHistory.empty")); return; }
        new SyncPathPickerModal(this.app, paths, (path) => {
          new SyncHistoryModal(this.app, this.plugin.vaultSyncHistoryProvider(), path).open();
        }).open();
      }));
  }

  private renderIncrementalBackupSettings(containerEl: HTMLElement): void {
    const backup = this.backupPrefs();
    const status = this.plugin.incrementalBackupService?.backupStatus(this.plugin.prefs);
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: t("backup.desc", { path: status?.root || ".obsidian/plugins/inventtasks/backups" }),
    });
    if (status?.lastError) {
      containerEl.createEl("p", { cls: "it-export-error", text: t("backup.lastError", { msg: status.lastError }) });
    }
    const statusLine = [
      status?.lastSnapshotAt ? t("backup.lastSnapshot", { value: status.lastSnapshotAt }) : t("backup.noSnapshot"),
      status?.lastJournalAt ? t("backup.lastJournal", { value: status.lastJournalAt }) : t("backup.noJournal"),
    ].join(" • ");
    containerEl.createEl("p", { cls: "setting-item-description", text: statusLine });

    new Setting(containerEl)
      .setName(t("backup.enabled"))
      .setDesc(t("backup.enabledDesc"))
      .addToggle((tog) => tog.setValue(backup.enabled).onChange(async (value) => {
        backup.enabled = value;
        await this.saveAndRefreshBackup();
        this.display();
      }));

    new Setting(containerEl)
      .setName(t("backup.location"))
      .setDesc(t("backup.locationDesc"))
      .addDropdown((d) => {
        d.addOption("plugin", t("backup.locationPlugin"))
          .addOption("vault", t("backup.locationVault"));
        d.setValue(backup.locationMode);
        d.onChange(async (value) => {
          backup.locationMode = value as any;
          await this.saveAndRefreshBackup();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName(t("backup.snapshotEvery"))
      .setDesc(t("backup.snapshotEveryDesc"))
      .addText((txt) => txt.setValue(String(backup.snapshotEveryHours)).onChange(async (value) => {
        backup.snapshotEveryHours = Math.max(1, Math.min(168, parseInt(value, 10) || 6));
        await this.saveAndRefreshBackup();
      }));

    new Setting(containerEl)
      .setName(t("backup.journalDebounce"))
      .setDesc(t("backup.journalDebounceDesc"))
      .addText((txt) => txt.setValue(String(backup.journalDebounceSeconds)).onChange(async (value) => {
        backup.journalDebounceSeconds = Math.max(5, Math.min(3600, parseInt(value, 10) || 30));
        await this.saveAndRefreshBackup();
      }));

    new Setting(containerEl)
      .setName(t("backup.retention"))
      .setDesc(t("backup.retentionDesc"))
      .addText((txt) => txt.setValue(String(backup.retentionDays)).onChange(async (value) => {
        backup.retentionDays = Math.max(1, Math.min(365, parseInt(value, 10) || 7));
        await this.saveAndRefreshBackup();
      }));

    new Setting(containerEl)
      .setName(t("backup.maxMb"))
      .setDesc(t("backup.maxMbDesc"))
      .addText((txt) => txt.setValue(String(backup.maxMb)).onChange(async (value) => {
        backup.maxMb = Math.max(10, Math.min(10240, parseInt(value, 10) || 200));
        await this.saveAndRefreshBackup();
      }));

    new Setting(containerEl)
      .setName(t("backup.bodyMode"))
      .setDesc(t("backup.bodyModeDesc"))
      .addDropdown((d) => d
        .addOption("auto", t("backup.bodyAuto"))
        .addOption("always", t("backup.bodyAlways"))
        .addOption("never", t("backup.bodyNever"))
        .setValue(backup.includeMarkdownBody)
        .onChange(async (value) => {
          backup.includeMarkdownBody = value as any;
          await this.saveAndRefreshBackup();
        }));

    if (backup.includeMarkdownBody === "auto") {
      new Setting(containerEl)
        .setName(t("backup.maxRawFileKb"))
        .setDesc(t("backup.maxRawFileKbDesc"))
        .addText((txt) => txt.setValue(String(backup.maxRawFileKb)).onChange(async (value) => {
          backup.maxRawFileKb = Math.max(1, Math.min(10240, parseInt(value, 10) || 512));
          await this.saveAndRefreshBackup();
        }));
    }

    new Setting(containerEl)
      .setName(t("backup.actions"))
      .setDesc(t("backup.actionsDesc"))
      .addButton((b) => b.setButtonText(t("backup.snapshotNow")).setCta().onClick(async () => {
        try {
          const summary = await this.plugin.incrementalBackupService.runSnapshot(this.plugin.prefs);
          new Notice(t("backup.snapshotDone", { files: summary.files, size: `${(summary.bytes / (1024 * 1024)).toFixed(2)} MB` }));
          if (summary.skipped?.length) {
            new Notice(t("backup.snapshotSkipped", {
              count: String(summary.skipped.length),
              files: summary.skipped.slice(0, 5).map((sk) => sk.path).join(", "),
            }), 15000);
          }
          this.display();
        } catch (e: any) {
          new Notice(t("backup.snapshotFailed", { msg: e?.message ?? String(e) }));
        }
      }))
      .addButton((b) => b.setButtonText(t("backup.restore")).onClick(() => new IncrementalBackupRestoreModal(this.app, this.plugin).open()));
  }

  // Activation panel — a self-contained card. Inactive: prominent (brand-tinted,
  // sparkle, bold CTA buttons) so it can't be missed. Active: a quiet confirmed
  // state with discreet manage buttons. Buttons are the app's own styles, never
  // raw Obsidian CTA chrome, so it reads as one coherent product.
  private renderActivation(containerEl: HTMLElement): void {
    const active = isLicensed();
    const acct = this.plugin.settings.account;
    const card = containerEl.createDiv({ cls: `it-activation ${active ? "is-active" : "is-inactive"}` });

    const head = card.createDiv({ cls: "it-activation-head" });
    const mark = head.createSpan({ cls: "it-activation-mark" });
    if (active) {
      mark.setText("✓");
      head.createDiv({ cls: "it-activation-title", text: t("license.active", { email: acct?.id || "" }) });
    } else {
      appendSvg(mark, SPARK_SVG);
      const titles = head.createDiv({ cls: "it-activation-titles" });
      titles.createDiv({ cls: "it-activation-title", text: t("license.inactiveTitle") });
      const sub = titles.createDiv({ cls: "it-activation-sub" });
      sub.appendText(t("license.freePlanPrefix"));
      sub.createEl("span", { cls: "it-activation-limits", text: t("license.inactiveLimits", { s: freeLimit(0), l: freeLimit(1), tk: freeLimit(2) }) });
      sub.appendText(". " + t("license.inactivePromo"));
    }

    let emailVal = acct?.id || "";
    let keyVal = acct?.token || "";
    new Setting(card).setName(t("license.email")).setDesc(t("license.emailDesc"))
      .addText((tx) => tx.setPlaceholder("you@example.com").setValue(emailVal).onChange((v) => { emailVal = v; }));
    new Setting(card).setName(t("license.key")).setDesc(t("license.keyDesc"))
      .addText((tx) => tx.setPlaceholder("IT1.…").setValue(keyVal).onChange((v) => { keyVal = v; }));

    const actions = card.createDiv({ cls: "it-activation-actions" });

    // Paint buttons with INLINE !important styles. Obsidian's settings tab and
    // community themes style `button` with high-specificity + !important rules
    // that beat any stylesheet selector we can write; an inline !important is
    // the only thing guaranteed to win the cascade. Literal hex (not CSS vars)
    // so nothing can leave the colours unresolved.
    const RED = "#e12d2d", RED_HOVER = "#c41f1f", BLUE = "#0091ff";
    const paintBtn = (el: HTMLElement, kind: "red" | "outline") => {
      const set = (p: string, v: string) => el.style.setProperty(p, v, "important");
      set("padding", "9px 18px");
      set("border-radius", "8px");
      set("font-weight", "600");
      set("font-size", "13.5px");
      set("cursor", "pointer");
      set("box-shadow", "none");
      set("transition", "background 120ms ease, transform 60ms ease");
      if (kind === "red") {
        set("background", RED); set("color", "#ffffff"); set("border", "1.5px solid transparent");
        el.addEventListener("mouseenter", () => set("background", RED_HOVER));
        el.addEventListener("mouseleave", () => set("background", RED));
      } else {
        set("background", "transparent"); set("color", BLUE); set("border", "1.5px solid " + BLUE);
        el.addEventListener("mouseenter", () => set("background", "rgba(0,145,255,0.10)"));
        el.addEventListener("mouseleave", () => set("background", "transparent"));
      }
    };

    const activateBtn = actions.createEl("button", {
      cls: active ? "it-btn-outline" : "it-btn-cta is-red",
      text: active ? t("license.reactivate") : t("license.activate"),
    });
    paintBtn(activateBtn, active ? "outline" : "red");
    activateBtn.addEventListener("click", async () => {
      const id = emailVal.trim().toLowerCase();
      const token = keyVal.trim();
      // Manual activation: the key is validated offline, then — when online —
      // the vendor's fresh signed standing decides. A re-activate with the
      // server saying active=1 clears a stale block right away; a server "rev"
      // (or an offline device with a local "rev") refuses. Offline + no local
      // block activates on key validity alone.
      const res = await activateAccount(this.plugin, id, token);
      if (res === "invalid") {
        new Notice(t("license.invalid"));
      } else if (res === "revoked") {
        new Notice(t("license.revokedActivate"), 12000);
        this.display();
      } else {
        new Notice(t("license.ok"));
        this.display();
      }
    });

    // The upsell is always available: when inactive it's the headline action;
    // when active it offers Pro for a *different* email (a separate license).
    const pro = actions.createEl("button", { cls: active ? "it-pro-btn is-subtle is-blue" : "it-pro-btn" });
    paintBtn(pro, active ? "outline" : "red");
    pro.addClass("it-pro-btn-row");
    appendSvg(pro.createSpan({ cls: "it-pro-btn-spark" }), SPARK_SVG);
    pro.createSpan({ text: active ? t("license.buyAnother") : t("license.buy") });
    pro.addEventListener("click", () => window.open(WEBSITE_URL));

    if (active) {
      const remove = actions.createEl("button", { cls: "it-btn-ghost it-activation-remove", text: t("license.remove") });
      remove.addEventListener("click", async () => {
        this.plugin.settings.account = undefined;
        setLicense(undefined, undefined);
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
        this.display();
      });
    }

    // Pricing model, stated plainly so repeat purchases of one email aren't a surprise.
    card.createDiv({ cls: "it-activation-note", text: t("license.sameEmailNote") });
    // Anti-leak reminder — keep your key private (consequence only, not mechanism).
    card.createDiv({ cls: "it-activation-note", text: t("license.keepPrivateNote") });
  }

  private renderHealthDiagnostics(containerEl: HTMLElement): void {
    this.sectionHeader(containerEl, t("health.title"), ["global"], "h2");
    containerEl.createEl("p", { text: t("health.desc"), cls: "setting-item-description" });

    const indexes = [this.plugin.index, ...(this.plugin.backgroundServices?.indexes() || [])].filter(Boolean);
    const rootOf = (root: string | undefined) => {
      const value = (root || "").trim();
      return !value || value === "/" ? "/" : value.replace(/\/+$/, "");
    };
    const workspaceNameForRoot = (root: string | undefined) =>
      this.plugin.settings.workspaces.find((ws) => rootOf(ws.workspaceRoot) === rootOf(root))?.name || rootOf(root);
    const diagnostics = indexes.map((index: any) => ({ index, name: workspaceNameForRoot(index.rootPath), diag: index.diagnostics?.() }));
    const workspaceStateIssues = this.plugin.workspaceStateIssues || [];
    const calError = this.plugin.settings.calendarSync?.lastSyncError;
    const calWarning = this.plugin.settings.calendarSync?.lastSyncWarning;
    const notifErrors = this.plugin.settings.workspaces
      .map((ws) => ({ ws, err: ws.notifState?.lastError }))
      .filter((x) => !!x.err);
    const activeNotif = this.notifConfig();
    const activeState = this.plugin.prefs.notifState;
    const ntfy = this.plugin.settings.ntfy;

    // Errors and warnings are counted apart on purpose. An error means something
    // is damaged — YAML that will not parse, a sync that failed outright. A
    // warning means the run SUCCEEDED and skipped some items. Folding both into
    // one red count made "15 events were not synced" look identical to a corrupt
    // vault, and a badge that cannot tell those apart is one the user learns to
    // ignore — which is exactly when it stops doing its job.
    const errors = [
      ...diagnostics.flatMap(({ name, diag }) => (diag?.corruptedYaml || []).map((i: string) => `${name}: ${i}`)),
      ...diagnostics.flatMap(({ name, diag }) => (diag?.duplicateIds || []).map((i: string) => `${name}: ${i}`)),
      ...diagnostics.flatMap(({ name, diag }) => (diag?.missingIds || []).map((i: string) => `${name}: ${i}`)),
      ...workspaceStateIssues.map((i) => `${i.workspaceName}: ${i.path}: ${i.message}`),
      ...(calError ? [`Calendar: ${calError.message}`] : []),
      ...notifErrors.map(({ ws, err }) => `${ws.name} ${err!.channel}: ${err!.message}`),
    ];
    const warnings = calWarning ? [`Calendar warning: ${calWarning.message}`] : [];

    const summary = containerEl.createDiv({ cls: "it-health-summary" });
    if (errors.length) {
      summary.createDiv({ cls: "it-health-pill is-error", text: t("health.statusErrors", { count: errors.length }) });
    }
    if (warnings.length) {
      summary.createDiv({ cls: "it-health-pill is-warning", text: t("health.statusWarnings", { count: warnings.length }) });
    }
    if (!errors.length && !warnings.length) {
      summary.createDiv({ cls: "it-health-pill is-ok", text: t("health.statusOk") });
    }
    summary.createDiv({ cls: "it-health-pill", text: t("health.channels", {
      system: activeNotif.channels.system ? "ON" : "OFF",
      ntfy: activeNotif.channels.ntfy && ntfy?.topic ? "ON" : "OFF",
    }) });
    summary.createDiv({ cls: "it-health-pill", text: t("health.lastDigest", {
      value: activeState?.lastDigestDate ? `${activeState.lastDigestDate} ${activeState.lastDigestTime || ""}`.trim() : "—",
    }) });

    const duplicateTaskIds = diagnostics.flatMap(({ name, diag }) => (diag?.duplicateTaskIds || []).map((i: any) => ({ ...i, workspaceName: name })));
    if (duplicateTaskIds.length) {
      new Setting(containerEl)
        .setName(t("health.duplicateIds"))
        .setDesc(duplicateTaskIds.map((i) => `${i.workspaceName}: ${i.id}: ${i.duplicatePath} ← ${i.keptPath}`).join("\n"))
        .addButton((b) => b.setButtonText(t("health.repairDuplicateIds")).setCta().onClick(async () => {
          let fixed = 0;
          for (const { index } of diagnostics) fixed += await index.repairDuplicateTaskIds();
          new Notice(t("health.repairedDuplicateIds", { count: fixed }));
          this.plugin.refreshViews();
          this.display();
        }));
    }

    const addList = (title: string, items: string[] | undefined) => {
      if (!items?.length) return;
      new Setting(containerEl).setName(title).setHeading();
      const list = containerEl.createEl("ul", { cls: "it-health-list" });
      for (const item of items.slice(0, 20)) list.createEl("li", { text: item });
      if (items.length > 20) list.createEl("li", { text: t("health.moreItems", { count: items.length - 20 }) });
    };

    addList(t("health.corruptedYaml"), diagnostics.flatMap(({ name, diag }) => (diag?.corruptedYaml || []).map((i: string) => `${name}: ${i}`)));
    addList(t("health.missingIds"), diagnostics.flatMap(({ name, diag }) => (diag?.missingIds || []).map((i: string) => `${name}: ${i}`)));
    addList(t("health.workspaceStateErrors"), workspaceStateIssues.map((i) => `${i.workspaceName}: ${i.path}: ${i.message}`));
    addList(t("health.syncErrors"), [
      ...(calError ? [`Calendar: ${calError.message}`] : []),
      ...notifErrors.map(({ ws, err }) => `${ws.name} ${err!.channel}: ${err!.message}`),
    ]);
    // Its own heading: listing a warning under "errors" is what made a partial
    // sync read as a broken one.
    addList(t("health.syncWarnings"), warnings);
  }

  // ---- External Notifications settings UI ----

  private renderExternalNotificationsSettings(containerEl: HTMLElement): void {
    this.sectionHeader(containerEl, t("extNotif.title"), ["workspace"], "h2");
    containerEl.createEl("p", { text: t("extNotif.desc"), cls: "setting-item-description" });
    containerEl.createEl("p", { text: t("extNotif.multiDeviceNote"), cls: "setting-item-description it-settings-warning" });
    if (Platform.isMobile) {
      containerEl.createEl("p", { text: t("extNotif.mobileWorkspaceNote"), cls: "setting-item-description it-settings-warning" });
    }

    const cfg = this.notifConfig();
    const state = this.plugin.prefs.notifState;
    const ntfy = this.plugin.globalNtfy();

    // Master toggle
    new Setting(containerEl)
      .setName(t("extNotif.enabled"))
      .setDesc(t("extNotif.enabledDesc"))
      .addToggle((tg) =>
        tg.setValue(cfg.enabled).onChange(async (v) => {
          cfg.enabled = v;
          await this.save();
          this.display();
        })
      );

    if (!cfg.enabled) return;

    if (state?.lastError) {
      containerEl.createEl("p", {
        text: t("extNotif.lastError", {
          channel: state.lastError.channel,
          ts: state.lastError.ts.slice(0, 16).replace("T", " "),
          message: state.lastError.message,
        }),
        cls: "setting-item-description it-settings-error",
      });
    }

    // ---- Channels (per workspace; accounts are global, configured below) ----
    new Setting(containerEl).setName(t("extNotif.channels.title")).setHeading();
    containerEl.createEl("p", { text: t("extNotif.channels.desc"), cls: "setting-item-description" });
    containerEl.createEl("p", { text: t("extNotif.mergeNote"), cls: "setting-item-description" });

    new Setting(containerEl)
      .setName(t("extNotif.system.enabled"))
      .setDesc(t("extNotif.system.desc"))
      .addToggle((tg) =>
        tg.setValue(cfg.channels.system).onChange(async (v) => {
          cfg.channels.system = v;
          await this.save();
        })
      )
      .addButton((b) =>
        b.setButtonText(t("common.test")).onClick(async () => {
          if (!("Notification" in window)) { new Notice(t("extNotif.system.unavailable")); return; }
          const granted = await this.plugin.notificationCenter?.requestSystemPermission();
          if (granted) {
            new Notification("InventTasks — Test", {
              body: t("extNotif.testOk"),
              requireInteraction: true,
            } as NotificationOptions & { requireInteraction?: boolean });
            new Notice(t("extNotif.testOk"));
          } else {
            new Notice(t("extNotif.system.denied"));
          }
        })
      );

    const ntfySetting = new Setting(containerEl)
      .setName(t("extNotif.ntfy.enabled"))
      .setDesc(t("extNotif.ntfy.workspaceNote"))
      .addToggle((tg) =>
        tg.setValue(cfg.channels.ntfy).onChange(async (v) => {
          cfg.channels.ntfy = v;
          await this.save();
          this.display();
        })
      );
    if (cfg.channels.ntfy && !ntfy.topic) {
      // Passive hint only — the toggle stays exactly where the user put it;
      // sending simply starts once the account below is filled in.
      ntfySetting.descEl.createDiv({ cls: "it-settings-warning", text: t("extNotif.ntfy.notConfigured") });
    }

    // ---- Triggers ----
    new Setting(containerEl).setName(t("extNotif.triggers.title")).setHeading();
    containerEl.createEl("p", { text: t("extNotif.triggers.priorityNote"), cls: "setting-item-description" });

    const chanOpts: Array<{ id: NotifChannel; label: string }> = [
      { id: "system", label: t("extNotif.chan.system") },
      { id: "ntfy", label: t("extNotif.chan.ntfy") },
    ];

    const renderChannelPicker = (
      parent: HTMLElement,
      trigger: { channels: NotifChannel[] },
    ) => {
      const setting = new Setting(parent).setName(t("extNotif.triggers.channels"));
      for (const opt of chanOpts) {
        setting.addToggle((tg) => {
          tg.toggleEl.title = opt.label;
          tg.setValue(trigger.channels.includes(opt.id)).onChange(async (v) => {
            const next = trigger.channels.filter((c) => c !== opt.id);
            if (v) next.push(opt.id);
            trigger.channels = next;
            await this.save();
          });
          tg.toggleEl.insertAdjacentText("beforebegin", opt.label + " ");
        });
      }
    };

    const renderTriggerToggle = (
      name: string,
      desc: string,
      trigger: { enabled: boolean },
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((tg) =>
          tg.setValue(trigger.enabled).onChange(async (v) => {
            trigger.enabled = v;
            await this.save();
            this.display();
          })
        );
    };

    // Overdue
    renderTriggerToggle(t("extNotif.triggers.overdue"), t("extNotif.triggers.overdueDesc"), cfg.triggers.overdue);
    if (cfg.triggers.overdue.enabled) renderChannelPicker(containerEl, cfg.triggers.overdue);

    // Reminders (explicit alarms from the Reminders list)
    renderTriggerToggle(t("extNotif.triggers.reminderAlarm"), t("extNotif.triggers.reminderAlarmDesc"), cfg.triggers.reminder);
    if (cfg.triggers.reminder.enabled) renderChannelPicker(containerEl, cfg.triggers.reminder);

    // Before due (tiers)
    renderTriggerToggle(t("extNotif.triggers.beforeDue"), t("extNotif.triggers.beforeDueDesc"), cfg.triggers.before_due);
    if (cfg.triggers.before_due.enabled) {
      const timings: Array<{ mins: number; label: string }> = [
        { mins: 15, label: t("extNotif.reminder.15min") },
        { mins: 60, label: t("extNotif.reminder.1h") },
        { mins: 1440, label: t("extNotif.reminder.1d") },
      ];
      const timingEl = containerEl.createDiv({ cls: "setting-item" });
      timingEl.createDiv({ cls: "setting-item-info" }).createEl("div", {
        cls: "setting-item-name",
        text: t("extNotif.triggers.reminderTimings"),
      });
      const timingControls = timingEl.createDiv({ cls: "setting-item-control" });
      for (const timing of timings) {
        const label = timingControls.createEl("label", { cls: "it-timing-label" });
        const chk = label.createEl("input", { type: "checkbox" });
        chk.checked = cfg.triggers.before_due.minutesBefore.includes(timing.mins);
        label.createSpan({ text: " " + timing.label });
        chk.addEventListener("change", async () => {
          const next = cfg.triggers.before_due.minutesBefore.filter((m) => m !== timing.mins);
          if (chk.checked) next.push(timing.mins);
          cfg.triggers.before_due.minutesBefore = next.sort((a, b) => a - b);
          await this.save();
        });
      }
      renderChannelPicker(containerEl, cfg.triggers.before_due);
    }

    // Task started
    renderTriggerToggle(t("extNotif.triggers.taskStarted"), t("extNotif.triggers.taskStartedDesc"), cfg.triggers.started);
    if (cfg.triggers.started.enabled) renderChannelPicker(containerEl, cfg.triggers.started);

    // Daily digest
    new Setting(containerEl)
      .setName(t("extNotif.triggers.digest"))
      .setDesc(t("extNotif.triggers.digestDesc"))
      .addToggle((tg) =>
        tg.setValue(cfg.triggers.digest.enabled).onChange(async (v) => {
          cfg.triggers.digest.enabled = v;
          await this.saveAndRunNotifications();
          this.display();
        })
      );
    if (cfg.triggers.digest.enabled) {
      new Setting(containerEl)
        .setName(t("extNotif.triggers.digestTime"))
        .addText((inp) => {
          inp.inputEl.type = "time";
          inp.setValue(cfg.triggers.digest.time || "08:00")
            .onChange(async (v) => {
              cfg.triggers.digest.time = normalizeDigestTime(v);
              await this.saveAndRunNotifications();
            });
        });
      renderChannelPicker(containerEl, cfg.triggers.digest);
    }
  }

  // ---- ntfy account (global) ----

  private renderNtfyAccountSettings(containerEl: HTMLElement): void {
    this.sectionHeader(containerEl, t("extNotif.ntfyAccount.title"), ["global"], "h2");
    containerEl.createEl("p", { text: t("extNotif.ntfyAccount.desc"), cls: "setting-item-description" });
    const ntfy = this.plugin.globalNtfy();

    new Setting(containerEl)
      .setName(t("extNotif.ntfy.serverUrl"))
      .setDesc(t("extNotif.ntfy.serverUrlDesc"))
      .addText((inp) =>
        inp
          .setPlaceholder("https://ntfy.sh")
          .setValue(ntfy.serverUrl || "https://ntfy.sh")
          .onChange(async (v) => { ntfy.serverUrl = v.trim() || "https://ntfy.sh"; await this.save(); })
      );

    new Setting(containerEl)
      .setName(t("extNotif.ntfy.topic"))
      .setDesc(t("extNotif.ntfy.topicDesc"))
      .addText((inp) =>
        inp
          .setPlaceholder("my-inventtasks-topic")
          .setValue(ntfy.topic)
          .onChange(async (v) => { ntfy.topic = v.trim(); await this.save(); })
      );

    new Setting(containerEl)
      .setName(t("extNotif.ntfy.authToken"))
      .setDesc(t("extNotif.ntfy.authTokenDesc"))
      .addText((inp) => {
        inp.inputEl.type = "password";
        inp
          .setPlaceholder(t("extNotif.optional"))
          .setValue(ntfy.authToken || "")
          .onChange(async (v) => { ntfy.authToken = v.trim() || undefined; await this.save(); });
      })
      .addButton((b) =>
        b.setButtonText(t("common.test")).onClick(async () => {
          b.setDisabled(true);
          const ch = new NtfyChannel();
          const err = await ch.test(this.plugin.globalNtfy());
          b.setDisabled(false);
          if (err) new Notice(`${t("extNotif.testFail")}: ${err}`);
          else new Notice(t("extNotif.testOk"));
        })
      );
  }

  // ---- Calendar Sync settings UI ----

  // Collapsible step-by-step setup guide. `steps` is a newline-separated string,
  // one numbered step per non-empty line.
  private renderSetupGuide(containerEl: HTMLElement, title: string, steps: string): void {
    const details = containerEl.createEl("details", { cls: "it-setup-guide" });
    const summary = details.createEl("summary", { text: title });
    const list = details.createEl("ol");
    for (const raw of steps.split("\n")) {
      const line = raw.trim();
      if (line) list.createEl("li", { text: line });
    }
  }

  // Read-only calendar list preview, with a refresh button to re-fetch it from
  // the provider. Actual sync targets are selected explicitly in calendar rules.
  private renderCalendarPicker(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    cached: Array<{ id: string; name: string }> | undefined,
    current: string,
    onRefresh: () => Promise<void>,
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addDropdown((dd) => {
        const opts = (cached && cached.length) ? cached.slice() : [];
        // Make sure the currently-saved id is always selectable, even if the
        // cache is empty or stale.
        if (current && !opts.some((o) => o.id === current)) opts.unshift({ id: current, name: current });
        if (!opts.length) opts.push({ id: current || "", name: current || "—" });
        for (const o of opts) dd.addOption(o.id, o.name || o.id);
        dd.setValue(current || opts[0].id);
      })
      .addExtraButton((b) =>
        b.setIcon("refresh-cw").setTooltip(t("calSync.refreshCalendars")).onClick(async () => {
          b.setDisabled(true);
          try { await onRefresh(); } finally { b.setDisabled(false); }
        })
      );
  }

  private renderCalendarSyncSettings(containerEl: HTMLElement): void {
    this.sectionHeader(containerEl, t("calSync.title"), ["global", "desktop"], "h2");
    containerEl.createEl("p", { text: t("calSync.desc"), cls: "setting-item-description" });

    // Calendar sync runs on desktop only (it reconciles the shared calendar
    // against all workspaces; mobile loads only the active one). On mobile show
    // the config grayed-out + non-interactive with a note.
    if (Platform.isMobile) {
      containerEl.createEl("p", { cls: "it-settings-desktop-note", text: t("settings.calendarMobileNote") });
      containerEl.createEl("p", { cls: "it-settings-desktop-note", text: t("calSync.mobileDesktopNote") });
      containerEl = containerEl.createDiv({ cls: "it-settings-disabled" });
    }

    const cal = this.calPrefs();

    // Master toggle
    new Setting(containerEl)
      .setName(t("calSync.enabled"))
      .setDesc(t("calSync.enabledDesc"))
      .addToggle((tg) =>
        tg.setValue(cal.enabled).onChange(async (v) => {
          cal.enabled = v;
          await this.save();
          this.display();
          if (v) this.plugin.calendarSyncManager?.restart();
          else this.plugin.calendarSyncManager?.stop();
        })
      );

    if (!cal.enabled) return;

    // ---- Scope ----
    new Setting(containerEl).setName(t("calSync.scope.title")).setHeading();

    new Setting(containerEl)
      .setName(t("calSync.scope.dueDateOnly"))
      .setDesc(t("calSync.scope.dueDateOnlyDesc"))
      .addToggle((tg) =>
        tg.setValue(cal.scope.withDueDateOnly).onChange(async (v) => {
          cal.scope.withDueDateOnly = v;
          await this.save();
        })
      );

    // Status groups (multi-checkbox). Done/closed are controlled per
    // workspace/space/folder/list in Calendar rules because that setting is
    // inherited by task location.
    const groups = ["not_started", "active"];
    const statusEl = containerEl.createDiv({ cls: "setting-item" });
    statusEl.createDiv({ cls: "setting-item-info" }).createEl("div", {
      cls: "setting-item-name", text: t("calSync.scope.statusGroups"),
    });
    const statusControls = statusEl.createDiv({ cls: "setting-item-control" });
    for (const grp of groups) {
      const label = statusControls.createEl("label", { cls: "it-timing-label" });
      const chk = label.createEl("input", { type: "checkbox" });
      chk.checked = cal.scope.statusGroups.includes(grp);
      label.createSpan({ text: " " + t(`calSync.scope.sg.${grp}`) });
      chk.addEventListener("change", async () => {
        let sgs = [...cal.scope.statusGroups];
        if (chk.checked && !sgs.includes(grp)) sgs.push(grp);
        else sgs = sgs.filter((s) => s !== grp);
        cal.scope.statusGroups = sgs;
        await this.save();
      });
    }
    containerEl.createEl("p", { text: t("calSync.scope.doneRemovedNote"), cls: "setting-item-description" });

    // Optional date window — limit how far back / ahead tasks are exported.
    new Setting(containerEl)
      .setName(t("calSync.scope.pastDays"))
      .setDesc(t("calSync.scope.pastDaysDesc"))
      .addText((inp) => {
        inp.inputEl.type = "number";
        inp.inputEl.min = "0";
        inp.inputEl.addClass("it-input-90");
        inp.setPlaceholder(t("calSync.scope.unlimited")).setValue(cal.scope.pastDays ? String(cal.scope.pastDays) : "");
        inp.onChange(async (v) => {
          const n = parseInt(v, 10);
          cal.scope.pastDays = n > 0 ? n : undefined;
          await this.save();
        });
      });
    new Setting(containerEl)
      .setName(t("calSync.scope.futureDays"))
      .setDesc(t("calSync.scope.futureDaysDesc"))
      .addText((inp) => {
        inp.inputEl.type = "number";
        inp.inputEl.min = "0";
        inp.inputEl.addClass("it-input-90");
        inp.setPlaceholder(t("calSync.scope.unlimited")).setValue(cal.scope.futureDays ? String(cal.scope.futureDays) : "");
        inp.onChange(async (v) => {
          const n = parseInt(v, 10);
          cal.scope.futureDays = n > 0 ? n : undefined;
          await this.save();
        });
      });

    // Sync frequency
    new Setting(containerEl)
      .setName(t("calSync.frequency"))
      .addDropdown((d) => {
        d.addOption("manual", t("calSync.freq.manual"));
        d.addOption("15min", t("calSync.freq.15min"));
        d.addOption("1hour", t("calSync.freq.1hour"));
        d.setValue(cal.frequency);
        d.onChange(async (v) => {
          cal.frequency = v as any;
          await this.save();
          this.plugin.calendarSyncManager?.restart();
        });
      });

    // Sync Now button
    new Setting(containerEl)
      .setName(t("calSync.syncNow"))
      .addButton((b) =>
        b.setButtonText(t("calSync.syncNowBtn")).setCta().onClick(async () => {
          b.setDisabled(true);
          b.setButtonText(t("calSync.syncing"));
          try {
            await this.plugin.syncNow();
            const warning = this.plugin.syncWarningMessage();
            new Notice(warning ? t("calSync.syncDoneWithWarnings", { message: warning }) : t("calSync.syncDone"));
          } catch (e: any) {
            new Notice(`${t("calSync.syncFailed")}: ${e?.message || e}`);
          }
          b.setDisabled(false);
          b.setButtonText(t("calSync.syncNowBtn"));
          this.display();
        })
      );

    if (cal.lastSync) {
      containerEl.createEl("p", {
        text: t("calSync.lastSync", { ts: cal.lastSync.slice(0, 16).replace("T", " ") }),
        cls: "setting-item-description",
      });
    }
    if (cal.lastSyncError) {
      containerEl.createEl("p", {
        text: t("calSync.lastError", {
          ts: cal.lastSyncError.ts.slice(0, 16).replace("T", " "),
          message: cal.lastSyncError.message,
        }),
        cls: "setting-item-description it-settings-error",
      });
    }

    // ---- ICS File ----
    new Setting(containerEl).setName(t("calSync.ics.title")).setHeading();
    containerEl.createEl("p", { text: t("calSync.ics.desc"), cls: "setting-item-description" });

    new Setting(containerEl)
      .setName(t("calSync.ics.enabled"))
      .setDesc(t("calSync.ics.enabledDesc"))
      .addToggle((tg) =>
        tg.setValue(cal.generateIcs).onChange(async (v) => { cal.generateIcs = v; await this.save(); })
      )
      .addButton((b) =>
        b.setButtonText(t("calSync.ics.generateNow")).onClick(async () => {
          b.setDisabled(true);
          try {
            await this.plugin.syncAllCalendars(); // global sync across all workspaces
            new Notice(t("calSync.ics.generated"));
          } catch (e: any) {
            new Notice(`${t("calSync.syncFailed")}: ${e?.message || e}`);
          }
          b.setDisabled(false);
        })
      );

    // ---- CalDAV ----
    new Setting(containerEl).setName(t("calSync.caldav.title")).setHeading();
    containerEl.createEl("p", { text: t("calSync.caldav.desc"), cls: "setting-item-description" });

    new Setting(containerEl)
      .setName(t("calSync.caldav.enabled"))
      .addToggle((tg) =>
        tg.setValue(cal.caldav.enabled).onChange(async (v) => {
          cal.caldav.enabled = v;
          await this.save();
          this.display();
        })
      );

    if (cal.caldav.enabled) {
      // -- Quick setup preset buttons --
      new Setting(containerEl)
        .setName(t("calSync.caldav.quickSetup"))
        .setDesc(t("calSync.caldav.quickSetupDesc"))
        .addButton((b) => b.setButtonText(t("calSync.caldav.preset.google")).onClick(async () => {
          const email = cal.caldav.username || "{email}";
          cal.caldav.serverUrl = `https://www.google.com/calendar/dav/${email}/events/`;
          cal.caldav.eventFormat = "vevent";
          cal.caldav.preset = "google";
          await this.save(); this.display();
        }))
        .addButton((b) => b.setButtonText(t("calSync.caldav.preset.outlook365")).onClick(async () => {
          const email = cal.caldav.username || "{email}";
          cal.caldav.serverUrl = `https://outlook.office365.com/caldav/v1/${email}/Calendar/`;
          cal.caldav.eventFormat = "vevent";
          cal.caldav.preset = "outlook365";
          await this.save(); this.display();
        }))
        .addButton((b) => b.setButtonText(t("calSync.caldav.preset.outlookPersonal")).onClick(async () => {
          cal.caldav.preset = "outlookPersonal";
          await this.save(); this.display();
        }))
        .addButton((b) => b.setButtonText(t("calSync.caldav.preset.icloud")).onClick(async () => {
          cal.caldav.serverUrl = "https://caldav.icloud.com";
          cal.caldav.eventFormat = "vtodo";
          cal.caldav.preset = "icloud";
          await this.save(); this.display();
        }))
        .addButton((b) => b.setButtonText(t("calSync.caldav.preset.nextcloud")).onClick(async () => {
          cal.caldav.serverUrl = "https://";
          cal.caldav.eventFormat = "vtodo";
          cal.caldav.preset = "nextcloud";
          await this.save(); this.display();
        }))
        .addButton((b) => b.setButtonText(t("calSync.caldav.preset.fastmail")).onClick(async () => {
          cal.caldav.serverUrl = "https://caldav.fastmail.com";
          cal.caldav.eventFormat = "vtodo";
          cal.caldav.preset = "fastmail";
          await this.save(); this.display();
        }));

      // -- Provider note (shown when a preset is selected) --
      const noteKey = `calSync.caldav.note.${cal.caldav.preset ?? ""}`;
      const noteText = t(noteKey);
      if (noteText && !noteText.startsWith("calSync.caldav.note.")) {
        const noteEl = containerEl.createDiv({ cls: "setting-item-description inventtasks-caldav-note" });
        noteEl.setText(noteText);
      }

      // -- Event format --
      new Setting(containerEl)
        .setName(t("calSync.caldav.eventFormat"))
        .setDesc(t("calSync.caldav.eventFormatDesc"))
        .addDropdown((dd) =>
          dd
            .addOption("vtodo", t("calSync.caldav.eventFormatVtodo"))
            .addOption("vevent", t("calSync.caldav.eventFormatVevent"))
            .setValue(cal.caldav.eventFormat || "vtodo")
            .onChange(async (v) => {
              cal.caldav.eventFormat = v as "vtodo" | "vevent";
              await this.save();
            })
        );

      new Setting(containerEl)
        .setName(t("calSync.caldav.serverUrl"))
        .setDesc(t("calSync.caldav.serverUrlDesc"))
        .addText((inp) =>
          inp.setPlaceholder("https://caldav.example.com")
            .setValue(cal.caldav.serverUrl)
            .onChange(async (v) => { cal.caldav.serverUrl = v.trim(); await this.save(); })
        );

      new Setting(containerEl)
        .setName(t("calSync.caldav.username"))
        .addText((inp) =>
          inp.setValue(cal.caldav.username)
            .onChange(async (v) => { cal.caldav.username = v.trim(); await this.save(); })
        );

      new Setting(containerEl)
        .setName(t("calSync.caldav.password"))
        .addText((inp) => {
          inp.inputEl.type = "password";
          inp.setValue(cal.caldav.password)
            .onChange(async (v) => { cal.caldav.password = v; await this.save(); });
        });

      new Setting(containerEl)
        .setName(t("calSync.caldav.calendarPath"))
        .setDesc(t("calSync.caldav.calendarPathDesc"))
        .addText((inp) =>
          inp.setPlaceholder("/dav/calendars/user/calendar/")
            .setValue(cal.caldav.calendarPath || "")
            .onChange(async (v) => { cal.caldav.calendarPath = v.trim() || undefined; await this.save(); })
        )
        .addButton((b) =>
          b.setButtonText(t("common.test")).onClick(async () => {
            b.setDisabled(true);
            const err = await testCalDav(cal.caldav);
            b.setDisabled(false);
            if (err) new Notice(`${t("extNotif.testFail")}: ${err}`);
            else new Notice(t("extNotif.testOk"));
          })
        );
    }
  }
}

// ---- About → license viewer ----

/** Shows the full EULA. The text ships with every install (LICENSE is part of
 *  the packaged plugin folder — see scripts/package.mjs), so it is read from
 *  the plugin directory at runtime instead of being duplicated in the bundle. */
class LicenseModal extends Modal {
  private plugin: InventTasksPlugin;

  constructor(app: App, plugin: InventTasksPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    this.modalEl.addClass("it-license-modal");
    this.titleEl.setText(t("about.licenseTitle"));
    renderLogo(this.contentEl, { size: 26, wordmark: true });
    const pre = this.contentEl.createEl("pre", { cls: "it-license-text" });
    try {
      const dir = this.plugin.manifest.dir;
      if (!dir) throw new Error("plugin dir unknown");
      pre.setText(await this.app.vault.adapter.read(`${dir}/LICENSE`));
    } catch {
      pre.remove();
      this.contentEl.createEl("p", {
        cls: "setting-item-description",
        text: t("about.licenseUnavailable", { url: WEBSITE_URL }),
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
