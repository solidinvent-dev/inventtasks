import { App, Modal, Notice, setIcon, Setting } from "obsidian";
import { renderIconish, renderCfTypeIcon, renderFieldIcon } from "../ui/icons";
import { showPopover, buildDropdown } from "../ui/components";
import { renderIconRow, renderColorRow, openColorPicker, openIconPicker } from "../ui/pickers";
import type InventTasksPlugin from "../main";
import {
  SpaceConfig, ListConfig, FolderConfig, WorkspaceConfig,
  StatusDef, StatusGroup, CustomFieldDef, CustomFieldType, CustomFieldOption,
  TagDef, ContextLabelDef, TaskType, PriorityDef, ViewType, PerViewDefaults,
  ChipKind, ChipStyles, ChipStyleConfig, ResolvedChipStyles,
  CalendarSyncRule, CalendarSyncTarget, CalendarSyncTargetKind, CalendarSyncStatusPolicy,
} from "../types";
import {
  STATUS_TEMPLATES, PALETTE, DEFAULT_PRIORITIES, DEFAULT_TASK_TYPES, DEFAULT_CONTEXT_LABELS, DEFAULT_STATUS_SET,
  DEFAULT_CHIP_STYLES, CHIP_KINDS,
  availableFieldsFor, defaultVisibleFor, filterFieldsByFeatures,
  CALENDAR_COLOR_SOURCE_DEFAULT, CALENDAR_COLOR_SOURCES_BUILTIN,
  CUSTOM_FIELD_TYPE_META, customFieldTypeMeta, fieldIconMeta,
  DATE_SOURCES_BUILTIN, DATE_SOURCE_DUE, DATE_SOURCE_START,
  MODAL_DISPLAY_FEATURE_IDS, RENAMEABLE_FIELD_KEYS,
} from "../constants";
import { dateBearingCustomFields } from "../data/date-source";
import { applyChipStyle } from "../ui/components";
import { ConfirmModal } from "./confirm-modal";
import { FilterModal, FilterFieldDef, FilterFieldType } from "./filter-modal";
import { slugify } from "../utils/slug";
import { customFieldTypeLabel, fieldLabel, t } from "../i18n";

export type ConfigLevel = "workspace" | "space" | "folder" | "list";

const CF_TYPES: CustomFieldType[] = [
  "text", "textarea", "markdown", "secret_text", "secret_textarea", "secret_markdown",
  "number", "money", "date", "datetime", "time", "checkbox",
  "url", "email", "phone", "location", "dropdown", "labels", "rating",
  "progress_manual", "progress_auto", "relationship", "doc_relationship", "attachment",
];

function cfgLevel(level: ConfigLevel): string {
  return t(`cfg.level.${level}`);
}

function confirmConfigRemove(app: App, message: string, onConfirm: () => void): void {
  new ConfirmModal(app, {
    title: t("modal.deleteConfirm"),
    message,
    destructive: true,
    confirmLabel: t("common.remove"),
    onConfirm,
  }).open();
}

function cfgSectionLabel(key: string): string {
  return t(`cfg.section.${key}`);
}

function statusGroupLabel(g: StatusGroup): string {
  return t(`cfg.statusGroup.${g}`);
}

function chipKindLabel(kind: ChipKind): string {
  return t(`cfg.chipKind.${kind}`);
}

function colorSourceLabel(value: string): string {
  const k = value === CALENDAR_COLOR_SOURCE_DEFAULT ? "default" : value;
  return t(`cfg.colorSource.${k}`) || value;
}

const STATUS_GROUP_COLORS: Record<StatusGroup, string> = {
  not_started: "#9E9E9E",
  active: "#2196F3",
  done: "#4CAF50",
  closed: "#2E7D32",
};

type ResetAxis = "status" | "priority" | "tags" | "context" | "type";

// Maps each configurable section (tab id) to the single ConfigurableSet field
// it owns plus, for palette sections, the Empty-position axis that must be
// cleared alongside it. Setting the field to `null` makes pruneEmpty drop it on
// save, so the level resumes inheriting that section from its parent.
const SECTION_RESET: Record<string, { sectionKey: string; field: string; emptyAxis?: ResetAxis }> = {
  statuses: { sectionKey: "statuses", field: "status_set", emptyAxis: "status" },
  priorities: { sectionKey: "priorities", field: "priorities", emptyAxis: "priority" },
  task_types: { sectionKey: "taskTypes", field: "task_types", emptyAxis: "type" },
  tags: { sectionKey: "tagsPalette", field: "tags_palette", emptyAxis: "tags" },
  context: { sectionKey: "contextLabels", field: "context_labels", emptyAxis: "context" },
  fields: { sectionKey: "customFields", field: "custom_fields" },
  views: { sectionKey: "viewDefaults", field: "view_defaults" },
  features: { sectionKey: "features", field: "features" },
  task_behavior: { sectionKey: "taskBehavior", field: "task_behavior" },
  chip_styles: { sectionKey: "labelStyles", field: "chip_styles" },
  field_names: { sectionKey: "fieldNames", field: "field_labels" },
  calendar_rules: { sectionKey: "calendarRules", field: "calendar_sync_rules" },
};

// Every override field cleared by a whole-level "Reset all" (empty_positions is
// handled separately since it isn't a section of its own).
const RESET_ALL_FIELDS = [
  "status_set", "priorities", "task_types", "tags_palette", "context_labels",
  "custom_fields", "view_defaults", "features", "task_behavior", "chip_styles", "field_labels", "notifications_enabled",
  "notify_system", "notify_ntfy", "calendar_sync", "calendar_sync_status_policy", "calendar_sync_rules",
];

/** Config fields stored as arrays: `null` = inherit, `[]` = explicit empty override. */
const ARRAY_OVERRIDE_FIELDS = new Set([
  "status_set", "priorities", "task_types", "tags_palette", "context_labels", "custom_fields",
  "calendar_sync_rules",
]);

export class ConfigModal extends Modal {
  plugin: InventTasksPlugin;
  level: ConfigLevel;
  path?: string;
  draft: any;
  activeTab = "general";
  initialTab?: string;
  private newCustomFields = new Set<CustomFieldDef>();

  constructor(app: App, plugin: InventTasksPlugin, level: ConfigLevel, path?: string, initialTab?: string) {
    super(app);
    this.plugin = plugin;
    this.level = level;
    this.path = path;
    this.initialTab = initialTab;
    this.draft = this.makeDraft();
    if (initialTab) this.activeTab = initialTab;
  }

  // Pulls the configurable set (the elements that exist at every level) from a
  // source config object. `undefined` for an element = inherit from parent.
  // For workspace level we use the source-of-truth defaults if the field is
  // somehow missing.
  private extractConfigurableSet(src: any, fillDefaults: boolean): any {
    const def = fillDefaults;
    // For chip_styles, an existing workspace from before this feature shipped
    // serializes as `{}` — which is truthy, so `?? defaults` won't kick in.
    // At workspace level, treat empty as missing so the editor shows seeded
    // defaults (and they get persisted on save).
    const srcChipStyles = src?.chip_styles;
    const chipStylesIsEmpty = !srcChipStyles || (typeof srcChipStyles === "object" && Object.keys(srcChipStyles).length === 0);
    return {
      status_set: deepClone(src?.status_set ?? (def ? DEFAULT_STATUS_SET : null)),
      priorities: deepClone(src?.priorities ?? (def ? DEFAULT_PRIORITIES : null)),
      task_types: deepClone(src?.task_types ?? (def ? DEFAULT_TASK_TYPES : null)),
      tags_palette: deepClone(src?.tags_palette ?? (def ? [] : null)),
      context_labels: deepClone(src?.context_labels ?? (def ? DEFAULT_CONTEXT_LABELS : null)),
      custom_fields: deepClone(src?.custom_fields ?? (def ? [] : null)),
      view_defaults: deepClone(src?.view_defaults ?? (def ? {} : null)),
      features: deepClone(src?.features ?? (def ? {} : null)),
      empty_positions: deepClone(src?.empty_positions ?? (def ? {} : null)),
      chip_styles: deepClone((def && chipStylesIsEmpty) ? DEFAULT_CHIP_STYLES : (srcChipStyles ?? {})),
      task_behavior: deepClone(src?.task_behavior ?? (def ? {} : null)),
      field_labels: deepClone(src?.field_labels ?? (def ? {} : null)),
      notifications_enabled: src?.notifications_enabled ?? (def ? true : null),
      notify_system: src?.notify_system ?? (def ? true : null),
      notify_ntfy: src?.notify_ntfy ?? (def ? true : null),
      calendar_sync: src?.calendar_sync ?? (def ? true : null),
      calendar_sync_status_policy: src?.calendar_sync_status_policy ?? (def ? "exclude_done_closed" : null),
      calendar_sync_rules: deepClone(src?.calendar_sync_rules ?? null),
    };
  }

  private makeDraft(): any {
    // Backfill stable ids that are missing on legacy marker files created
    // before the plugin started writing them. Saving now persists the new id,
    // so deep links, the External API, and the sidebar "Copy id" entry all
    // start working without a manual frontmatter edit.
    const ensureId = (prefix: string, current?: string): string => {
      if (current && current.trim()) return current;
      return `${prefix}-${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;
    };
    if (this.level === "workspace") {
      const ws = this.plugin.index.workspace;
      return {
        workspace_id: ensureId("WSP", ws?.workspace_id),
        name: ws?.name || "My Workspace",
        icon: ws?.icon || "layout-dashboard",
        color: ws?.color || "#0091FF",
        date_format: ws?.date_format || "YYYY-MM-DD",
        time_format: ws?.time_format || "HH:mm",
        week_start: ws?.week_start || "monday",
        default_currency: ws?.default_currency || "PLN",
        active_color: ws?.active_color,
        active_text_color: ws?.active_text_color,
        ...this.extractConfigurableSet(ws, true),
      };
    }
    if (this.level === "space" && this.path) {
      const s = this.plugin.index.findSpace(this.path);
      if (!s) return {};
      return {
        space_id: ensureId("SPC", s.config.space_id),
        name: s.config.name,
        icon: s.config.icon || "🏷️",
        color: s.config.color || "#0091FF",
        custom_id_prefix: s.config.custom_id_prefix,
        default_view: s.config.default_view || "last_selected",
        ...this.extractConfigurableSet(s.config, false),
      };
    }
    if (this.level === "folder" && this.path) {
      const f = this.plugin.index.findFolder(this.path);
      if (!f) return {};
      return {
        folder_id: ensureId("FLD", f.config.folder_id),
        name: f.config.name,
        icon: f.config.icon || "📁",
        color: f.config.color || "#6647F0",
        default_view: f.config.default_view || "last_selected",
        ...this.extractConfigurableSet(f.config, false),
      };
    }
    if (this.level === "list" && this.path) {
      const l = this.plugin.index.findList(this.path);
      if (!l) return {};
      return {
        list_id: ensureId("LST", l.config.list_id),
        name: l.config.name,
        icon: l.config.icon || "📋",
        color: l.config.color || "#2196F3",
        description: l.config.description || "",
        default_view: l.config.default_view || "list",
        default_task_type: l.config.default_task_type || "task",
        ...this.extractConfigurableSet(l.config, false),
      };
    }
    return {};
  }

  onOpen() {
    this.modalEl.addClass("it-config-modal");
    this.titleEl.setText(this.headerTitle());
    const c = this.contentEl;
    // Most user actions trigger a full re-render via onOpen(). Preserve the
    // scroll position of the scrolling body across the rebuild so clicking a
    // toggle deep in the list doesn't bounce the user back to the top.
    const prevBody = c.querySelector<HTMLElement>(".it-config-body");
    const prevScroll = prevBody?.scrollTop ?? 0;
    const prevTab = prevBody ? this.activeTab : null;
    c.empty();

    // Tab strip
    const tabsBar = c.createDiv({ cls: "it-config-tabs" });
    for (const tabDef of this.tabs()) {
      const btn = tabsBar.createEl("button", { cls: "it-config-tab" + (this.activeTab === tabDef.id ? " is-active" : ""), text: tabDef.label });
      btn.addEventListener("click", () => {
        this.activeTab = tabDef.id;
        this.onOpen();
      });
    }

    // Content
    const body = c.createDiv({ cls: "it-config-body" });
    const tab = this.tabs().find((tabDef) => tabDef.id === this.activeTab) || this.tabs()[0];
    tab.render(body);

    // Footer
    const footer = c.createDiv({ cls: "it-modal-footer" });
    footer.createEl("button", { text: t("common.cancel"), cls: "it-btn-ghost" }).addEventListener("click", () => this.close());
    const save = footer.createEl("button", { cls: "it-btn-primary", text: t("common.saveChanges") });
    save.addEventListener("click", () => this.save());

    // Restore scroll only if we stayed within the same tab — switching tabs
    // logically starts at the top.
    if (prevTab === this.activeTab && prevScroll > 0) {
      body.scrollTop = prevScroll;
    }
  }

  private headerTitle(): string {
    if (this.level === "workspace") return t("modal.workspaceSettings");
    if (this.level === "space") return t("modal.spaceSettings", { name: this.draft.name });
    if (this.level === "folder") return t("modal.folderSettings", { name: this.draft.name });
    if (this.level === "list") return t("modal.listSettings", { name: this.draft.name });
    return t("modal.settings");
  }

  private tabs(): Array<{ id: string; label: string; render: (parent: HTMLElement) => void }> {
    // Unified tab set — every level shows the same configurable elements.
    // Only the "General" tab varies by level; the rest delegate to one editor
    // per element that internally handles "edit at top level" vs "override on
    // lower levels".
    const general =
      this.level === "workspace" ? { id: "general", label: t("cfg.tabGeneral"), render: (p: HTMLElement) => this.renderWorkspaceGeneral(p) }
      : this.level === "space" ? { id: "general", label: t("cfg.tabGeneral"), render: (p: HTMLElement) => this.renderSpaceGeneral(p) }
      : this.level === "folder" ? { id: "general", label: t("cfg.tabGeneral"), render: (p: HTMLElement) => this.renderFolderGeneral(p) }
      : { id: "general", label: t("cfg.tabGeneral"), render: (p: HTMLElement) => this.renderListGeneral(p) };
    return [
      general,
      { id: "statuses", label: t("cfg.tabStatuses"), render: (p) => this.renderSingleStatusSet(p) },
      { id: "priorities", label: t("cfg.tabPriorities"), render: (p) => this.renderPrioritiesOverride(p) },
      { id: "task_types", label: t("cfg.tabTaskTypes"), render: (p) => this.renderTaskTypesOverride(p) },
      { id: "tags", label: t("cfg.tabTags"), render: (p) => this.renderTagsPalette(p) },
      { id: "context", label: t("cfg.tabContext"), render: (p) => this.renderContextLabels(p) },
      { id: "fields", label: t("cfg.tabCustomFields"), render: (p) => this.renderCustomFields(p) },
      { id: "field_names", label: t("cfg.tabFieldNames"), render: (p) => this.renderFieldNames(p) },
      { id: "views", label: t("cfg.tabViewDefaults"), render: (p) => this.renderViewDefaults(p) },
      { id: "features", label: t("cfg.tabFeatures"), render: (p) => this.renderFeatures(p) },
      { id: "task_behavior", label: t("cfg.tabTaskBehavior"), render: (p) => this.renderTaskBehavior(p) },
      { id: "chip_styles", label: t("cfg.tabLabelStyles"), render: (p) => this.renderChipStyles(p) },
      { id: "calendar_rules", label: t("cfg.tabCalendarRules"), render: (p) => this.renderCalendarSyncRules(p) },
    ];
  }

  // ===== Workspace tabs =====

  private renderWorkspaceGeneral(parent: HTMLElement) {
    parent.createEl("h3", { text: t("cfg.workspaceNameIdentity") });

    new Setting(parent).setName(t("cfg.name")).addText((el) =>
      el.setValue(this.draft.name).onChange((v) => (this.draft.name = v))
    );

    renderIconRow(parent, t("cfg.icon"), this.draft.icon, (v) => { this.draft.icon = v; this.onOpen(); }, { color: this.draft.color });
    renderColorRow(parent, t("cfg.color"), this.draft.color, (v) => { this.draft.color = v; this.onOpen(); });

    // Date format, time format, week start and default currency moved to the
    // plugin's settings tab (one home, per-vault — like the timezone), so they
    // apply consistently everywhere. Leave a pointer here so they're findable.
    parent.createEl("h3", { text: t("cfg.formats") });
    parent.createEl("p", { cls: "setting-item-description", text: t("cfg.formatsMoved") });

    this.renderNotificationsScopeSetting(parent);

    parent.createEl("h3", { text: t("cfg.explorerAppearance") });

    renderColorRow(
      parent,
      t("cfg.activeRowColor"),
      this.draft.active_color,
      (v) => { this.draft.active_color = v; this.onOpen(); },
      t("cfg.activeRowColorDesc")
    );
    if (this.draft.active_color) {
      new Setting(parent)
        .setName(t("common.resetDefault"))
        .setDesc(t("cfg.resetAccentDesc"))
        .addButton((b) => b.setButtonText(t("cfg.reset")).onClick(() => {
          this.draft.active_color = undefined;
          this.draft.active_text_color = undefined;
          this.onOpen();
        }));

      const textRaw: string | undefined = this.draft.active_text_color;
      const textMode: "accent" | "inherit" | "node" | "custom" =
        textRaw === "inherit" ? "inherit"
        : textRaw === "node" ? "node"
        : (typeof textRaw === "string" && textRaw.length > 0) ? "custom"
        : "accent";

      new Setting(parent)
        .setName(t("cfg.activeRowTextColor"))
        .setDesc(t("cfg.activeRowTextColorDesc"))
        .addDropdown((d) => {
          d.addOption("accent", t("cfg.textColorDefault"));
          d.addOption("inherit", t("cfg.textColorInherit"));
          d.addOption("node", t("cfg.textColorNode"));
          d.addOption("custom", t("cfg.textColorCustom"));
          d.setValue(textMode);
          d.onChange((v) => {
            if (v === "accent") this.draft.active_text_color = undefined;
            else if (v === "inherit") this.draft.active_text_color = "inherit";
            else if (v === "node") this.draft.active_text_color = "node";
            else this.draft.active_text_color = (typeof textRaw === "string" && /^#[0-9a-fA-F]{3,8}$/.test(textRaw)) ? textRaw : "#000000";
            this.onOpen();
          });
        });

      if (textMode === "custom") {
        renderColorRow(
          parent,
          t("cfg.textColor"),
          this.draft.active_text_color,
          (v) => { this.draft.active_text_color = v; this.onOpen(); }
        );
      }
    }
  }

  // ===== Space general =====

  private renderSpaceGeneral(parent: HTMLElement) {
    parent.createEl("h3", { text: t("cfg.identity") });
    new Setting(parent).setName(t("cfg.name")).addText((el) => el.setValue(this.draft.name).onChange((v) => (this.draft.name = v)));
    renderIconRow(parent, t("cfg.icon"), this.draft.icon, (v) => { this.draft.icon = v; this.onOpen(); }, { color: this.draft.color });
    renderColorRow(parent, t("cfg.color"), this.draft.color, (v) => { this.draft.color = v; this.onOpen(); });
    new Setting(parent)
      .setName(t("cfg.customTaskIdPrefix"))
      .setDesc(t("cfg.customTaskIdPrefixDesc"))
      .addText((el) => el.setPlaceholder("MKT").setValue(this.draft.custom_id_prefix || "").onChange((v) => (this.draft.custom_id_prefix = v.trim() || undefined)));
    this.renderNotificationsScopeSetting(parent);
    this.renderDefaultViewRow(parent);
    this.renderResetAllZone(parent);
  }

  private renderFolderGeneral(parent: HTMLElement) {
    new Setting(parent).setName(t("cfg.name")).addText((el) => el.setValue(this.draft.name).onChange((v) => (this.draft.name = v)));
    renderIconRow(parent, t("cfg.icon"), this.draft.icon, (v) => { this.draft.icon = v; this.onOpen(); }, { color: this.draft.color });
    renderColorRow(parent, t("cfg.color"), this.draft.color, (v) => { this.draft.color = v; this.onOpen(); });
    this.renderNotificationsScopeSetting(parent);
    this.renderDefaultViewRow(parent);
    parent.createEl("p", { cls: "setting-item-description", text: t("cfg.folderOverrideHint") });
    this.renderResetAllZone(parent);
  }

  // Shared Default-view dropdown used at every level. "Last selected" is the
  // 5th option — picking it makes view-state persistence supply the actual
  // viewType (see main-view's selectLocation flow).
  private renderDefaultViewRow(parent: HTMLElement) {
    new Setting(parent)
      .setName(t("cfg.defaultView"))
      .setDesc(t("cfg.defaultViewDesc"))
      .addDropdown((d) =>
        d
          .addOption("list", t("view.list"))
          .addOption("board", t("view.board"))
          .addOption("calendar", t("view.calendar"))
          .addOption("table", t("view.table"))
          .addOption("gantt", t("view.gantt"))
          .addOption("timeline", t("view.timeline"))
          .addOption("last_selected", t("cfg.lastSelected"))
          .setValue(this.draft.default_view || "last_selected")
          .onChange((v) => (this.draft.default_view = v))
      );
  }

  private renderListGeneral(parent: HTMLElement) {
    new Setting(parent).setName(t("cfg.name")).addText((el) => el.setValue(this.draft.name).onChange((v) => (this.draft.name = v)));
    renderIconRow(parent, t("cfg.icon"), this.draft.icon, (v) => { this.draft.icon = v; this.onOpen(); }, { color: this.draft.color });
    renderColorRow(parent, t("cfg.color"), this.draft.color, (v) => { this.draft.color = v; this.onOpen(); });
    new Setting(parent).setName(t("cfg.description")).addTextArea((el) => {
      el.setValue(this.draft.description).onChange((v) => (this.draft.description = v));
      el.inputEl.rows = 4;
      el.inputEl.addClass("it-input-full");
    });
    this.renderNotificationsScopeSetting(parent);
    this.renderDefaultViewRow(parent);

    // Default task type — use a custom popover dropdown so we can render the
    // type's icon (emoji OR Lucide SVG) instead of stringifying its name.
    const draftTypes: TaskType[] | null = Array.isArray(this.draft.task_types) && this.draft.task_types.length
      ? this.draft.task_types
      : null;
    const availableTypes: TaskType[] = draftTypes || (this.path ? this.plugin.index.resolveTaskTypes({ listPath: this.path }) : DEFAULT_TASK_TYPES);
    const currentId = this.draft.default_task_type || availableTypes[0]?.id || "task";
    const currentDef = availableTypes.find((tt) => tt.id === currentId);

    const row = new Setting(parent)
      .setName(t("cfg.defaultTaskType"))
      .setDesc(t("cfg.defaultTaskTypeDesc"));
    const trigger = row.controlEl.createEl("button", { cls: "it-secondary-btn it-type-picker-trigger", attr: { type: "button" } });
    if (currentDef?.icon) {
      const triggerIconEl = renderIconish(trigger, currentDef.icon, { cls: "it-iconish-trigger" });
      if (triggerIconEl && currentDef?.color) triggerIconEl.style.color = currentDef.color;
    }
    trigger.createSpan({ text: currentDef?.name || currentId });
    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showPopover(trigger, (root) => {
        buildDropdown({
          parent: root,
          current: this.draft.default_task_type || currentId,
          items: availableTypes.map((tt) => ({
            value: tt.id,
            label: tt.name,
            color: tt.color,
            icon: tt.icon,
          })),
          onSelect: (v) => {
            this.draft.default_task_type = v;
            document.querySelectorAll(".it-popover").forEach((el) => el.remove());
            this.onOpen();
          },
        });
      });
    });
    this.renderResetAllZone(parent);
  }

  private renderNotificationsScopeSetting(parent: HTMLElement) {
    const inherited = this.resolveInheritedNotificationsEnabled();
    const explicit = this.draft.notifications_enabled;
    const current = this.level === "workspace" ? !!explicit : (typeof explicit === "boolean" ? explicit : inherited);
    const stateText = this.level === "workspace"
      ? (current ? t("cfg.notificationsOn") : t("cfg.notificationsOff"))
      : typeof explicit === "boolean"
        ? (current ? t("cfg.notificationsOn") : t("cfg.notificationsOff"))
        : t(inherited ? "cfg.notificationsStateInheritOn" : "cfg.notificationsStateInheritOff");

    new Setting(parent)
      .setName(t("cfg.notifications"))
      .setDesc(t("cfg.notificationsScopeDesc", { level: cfgLevel(this.level), state: stateText }))
      .addDropdown((d) => {
        if (this.level !== "workspace") d.addOption("inherit", t(inherited ? "cfg.notificationsInheritOn" : "cfg.notificationsInheritOff"));
        d.addOption("on", t("cfg.notificationsOn"));
        d.addOption("off", t("cfg.notificationsOff"));
        d.setValue(this.level === "workspace"
          ? (current ? "on" : "off")
          : (typeof explicit === "boolean" ? (explicit ? "on" : "off") : "inherit"));
        d.onChange((v) => {
          this.draft.notifications_enabled = v === "inherit" ? null : v === "on";
          this.onOpen();
        });
      });

    // External notification channels (system / ntfy) — independent of
    // the in-app inbox above, each with the same inherit/on/off semantics.
    parent.createEl("div", { cls: "setting-item-description it-cfg-subhead", text: t("cfg.extNotifyHint") });
    this.renderInheritedBoolSetting(parent, "notify_system", t("cfg.notifySystem"), t("cfg.notifySystemDesc"));
    this.renderInheritedBoolSetting(parent, "notify_ntfy", t("cfg.notifyNtfy"), t("cfg.notifyNtfyDesc"));

    // Calendar export (CalDAV / ICS) — same inheritance model.
    parent.createEl("div", { cls: "setting-item-description it-cfg-subhead", text: t("cfg.calendarSyncHint") });
    this.renderInheritedBoolSetting(parent, "calendar_sync", t("cfg.calendarSync"), t("cfg.calendarSyncDesc"));
  }

  // Generic inherit/on/off dropdown for any boolean config field that uses the
  // narrowest-wins inheritance chain (notify_system / notify_ntfy).
  private renderInheritedBoolSetting(parent: HTMLElement, field: string, name: string, desc: string, fallback = true) {
    const inherited = this.resolveInheritedConfigBool(field, fallback);
    const explicit = this.draft[field];
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addDropdown((d) => {
        if (this.level !== "workspace") d.addOption("inherit", t(inherited ? "cfg.notificationsInheritOn" : "cfg.notificationsInheritOff"));
        d.addOption("on", t("cfg.notificationsOn"));
        d.addOption("off", t("cfg.notificationsOff"));
        d.setValue(this.level === "workspace"
          ? (explicit === false ? "off" : "on")
          : (typeof explicit === "boolean" ? (explicit ? "on" : "off") : "inherit"));
        d.onChange((v) => {
          this.draft[field] = v === "inherit" ? null : v === "on";
        });
      });
  }

  private resolveInheritedNotificationsEnabled(): boolean {
    return this.resolveInheritedConfigBool("notifications_enabled");
  }

  // Resolves what a boolean config field would inherit from the PARENT chain
  // (used to label the "Inherit (ON/OFF)" option). Mirrors the parent lookup
  // used for notifications_enabled.
  private resolveInheritedConfigBool(field: string, fallback = true): boolean {
    const r = (loc: import("../types").ContextLocation) => this.plugin.index.resolveConfigBoolForLocation(loc, field, fallback);
    if (this.level === "workspace") return fallback;
    if (this.level === "space") return r({ kind: "everything" });
    if (this.level === "folder" && this.path) {
      const f = this.plugin.index.findFolder(this.path);
      return f?.spacePath ? r({ kind: "space", path: f.spacePath }) : fallback;
    }
    if (this.level === "list" && this.path) {
      const l = this.plugin.index.findList(this.path);
      if (l?.folderPath) return r({ kind: "folder", path: l.folderPath });
      if (l?.spacePath) return r({ kind: "space", path: l.spacePath });
    }
    return fallback;
  }

  private renderCalendarStatusPolicySetting(parent: HTMLElement) {
    const inherited = this.resolveInheritedCalendarStatusPolicy();
    const explicit = this.draft.calendar_sync_status_policy;
    const current = this.level === "workspace"
      ? (this.isCalendarStatusPolicy(explicit) ? explicit : "exclude_done_closed")
      : (this.isCalendarStatusPolicy(explicit) ? explicit : inherited);
    new Setting(parent)
      .setName(t("cfg.calendarSyncStatusPolicy"))
      .setDesc(t("cfg.calendarSyncStatusPolicyDesc"))
      .addDropdown((d) => {
        if (this.level !== "workspace") {
          d.addOption("inherit", t("cfg.calendarSyncStatusPolicyInherit", { value: this.calendarStatusPolicyLabel(inherited) }));
        }
        d.addOption("sync_all", t("cfg.calendarSyncStatusPolicySyncAll"));
        d.addOption("exclude_done_closed", t("cfg.calendarSyncStatusPolicyExcludeDoneClosed"));
        d.addOption("exclude_closed", t("cfg.calendarSyncStatusPolicyExcludeClosed"));
        d.setValue(this.level === "workspace"
          ? current
          : (this.isCalendarStatusPolicy(explicit) ? explicit : "inherit"));
        d.onChange((v) => {
          this.draft.calendar_sync_status_policy = v === "inherit" ? null : v as CalendarSyncStatusPolicy;
        });
      });
  }

  private resolveInheritedCalendarStatusPolicy(): CalendarSyncStatusPolicy {
    const r = (loc: import("../types").ContextLocation) => this.plugin.index.resolveCalendarSyncStatusPolicyForLocation(loc);
    if (this.level === "workspace") return "exclude_done_closed";
    if (this.level === "space") return r({ kind: "everything" });
    if (this.level === "folder" && this.path) {
      const f = this.plugin.index.findFolder(this.path);
      return f?.spacePath ? r({ kind: "space", path: f.spacePath }) : "exclude_done_closed";
    }
    if (this.level === "list" && this.path) {
      const l = this.plugin.index.findList(this.path);
      if (l?.folderPath) return r({ kind: "folder", path: l.folderPath });
      if (l?.spacePath) return r({ kind: "space", path: l.spacePath });
    }
    return "exclude_done_closed";
  }

  private isCalendarStatusPolicy(value: unknown): value is CalendarSyncStatusPolicy {
    return value === "sync_all" || value === "exclude_done_closed" || value === "exclude_closed";
  }

  private calendarStatusPolicyLabel(policy: CalendarSyncStatusPolicy): string {
    if (policy === "sync_all") return t("cfg.calendarSyncStatusPolicySyncAll");
    if (policy === "exclude_closed") return t("cfg.calendarSyncStatusPolicyExcludeClosed");
    return t("cfg.calendarSyncStatusPolicyExcludeDoneClosed");
  }

  // ===== Statuses (uniform across all levels) =====

  private renderSingleStatusSet(parent: HTMLElement) {
    this.renderSectionHead(parent, "statuses", t("cfg.statuses"),
      this.level === "workspace"
        ? t("cfg.statusesDescWorkspace")
        : t("cfg.statusesDescOverride"));

    const showEditor = this.renderOverrideToggleFor(
      parent,
      cfgSectionLabel("statuses"),
      this.isArrayFieldOverridden("status_set"),
      () => {
        this.draft.status_set = deepClone(this.resolveInheritedStatusSet());
        this.cloneEmptyFor("status");
      },
      () => {
        this.draft.status_set = null;
        this.clearEmptyFor("status");
      }
    );

    if (showEditor) {
      // Status_set might be missing at workspace level if file was hand-edited.
      this.draft.status_set ||= deepClone(DEFAULT_STATUS_SET);
      renderStatusList(this.app, parent, this.draft.status_set, () => this.onOpen(), this.emptyCtxFor("status"));

      const tplBar = parent.createDiv({ cls: "it-cfg-actions" });
      tplBar.createSpan({ cls: "setting-item-description", text: t("cfg.applyTemplate") + " " });
      for (const tplKey of Object.keys(STATUS_TEMPLATES)) {
        const b = tplBar.createEl("button", { cls: "it-btn-secondary", text: tplKey });
        b.addEventListener("click", () => {
          this.draft.status_set = deepClone(STATUS_TEMPLATES[tplKey]);
          this.onOpen();
        });
      }
    }
  }

  // Builds a ContextLocation matching this config modal's level/path. Used by
  // resolvers (e.g. for inherited Empty positions) so a level that's about to
  // override a palette can see what the parent currently has.
  private currentLoc(): import("../types").ContextLocation {
    if (this.level === "space" && this.path) return { kind: "space", path: this.path };
    if (this.level === "folder" && this.path) return { kind: "folder", path: this.path };
    if (this.level === "list" && this.path) return { kind: "list", path: this.path };
    return { kind: "everything" };
  }

  // Copies the inherited Empty position into the draft for the given axis.
  // Called from override-clone callbacks so the cloned palette retains the
  // parent's Empty placement (along with colours, names, order, etc.).
  private cloneEmptyFor(axis: "status" | "priority" | "tags" | "context" | "type") {
    const pos = this.plugin.index.resolveEmptyPosition(axis, this.currentLoc());
    this.draft.empty_positions ||= {};
    this.draft.empty_positions[axis] = pos;
  }

  // Clears the local override of Empty position for the given axis. Called
  // from override-clear callbacks so the draft no longer carries a stale
  // Empty position that would shadow the inherited one.
  private clearEmptyFor(axis: "status" | "priority" | "tags" | "context" | "type") {
    if (this.draft.empty_positions) delete this.draft.empty_positions[axis];
  }

  // ===== Reset to inherited (sub-levels only) =====

  // True when the draft carries a real override for this field.
  // Array fields: `null`/missing = inherit; `[]` or `[…]` = override (even when empty).
  // Objects: non-null non-empty object = override.
  private fieldHasValue(field: string): boolean {
    const v = this.draft[field];
    if (field === "notifications_enabled" || field === "notify_system" || field === "notify_ntfy" || field === "calendar_sync") return typeof v === "boolean";
    if (field === "calendar_sync_status_policy") return v === "sync_all" || v === "exclude_done_closed" || v === "exclude_closed";
    if (ARRAY_OVERRIDE_FIELDS.has(field)) return Array.isArray(v);
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === "object") return Object.keys(v).length > 0;
    return v != null && v !== false && v !== "";
  }

  private isArrayFieldOverridden(field: string): boolean {
    return Array.isArray(this.draft[field]);
  }

  private sectionHasOverride(sectionId: string): boolean {
    const spec = SECTION_RESET[sectionId];
    if (!spec) return false;
    if (sectionId === "calendar_rules") {
      return this.fieldHasValue(spec.field) || this.fieldHasValue("calendar_sync_status_policy");
    }
    return this.fieldHasValue(spec.field);
  }

  // Drops a single section's override so it inherits from the parent again.
  // Mutates the draft only — committed when the user clicks "Save changes".
  private clearSection(sectionId: string) {
    const spec = SECTION_RESET[sectionId];
    if (!spec) return;
    this.draft[spec.field] = null;
    if (sectionId === "calendar_rules") this.draft.calendar_sync_status_policy = null;
    if (spec.emptyAxis) this.clearEmptyFor(spec.emptyAxis);
  }

  // Section heading row: the title on the left and, on sub-levels, a subtle
  // "Reset to inherited" control on the right (disabled when nothing to reset).
  private renderSectionHead(parent: HTMLElement, sectionId: string, title: string, desc: string) {
    const head = parent.createDiv({ cls: "it-cfg-section-head" });
    head.createEl("h3", { text: title });
    if (this.level !== "workspace" && SECTION_RESET[sectionId]) {
      const has = this.sectionHasOverride(sectionId);
      const btn = head.createEl("button", { cls: "it-cfg-reset-btn", attr: { type: "button" } });
      setIcon(btn, "rotate-ccw");
      btn.createSpan({ text: t("cfg.resetToInherited") });
      btn.disabled = !has;
      const spec = SECTION_RESET[sectionId];
      btn.title = has
        ? t("cfg.resetSectionTitle", { level: cfgLevel(this.level), section: cfgSectionLabel(spec.sectionKey) })
        : t("cfg.resetSectionAlready");
      if (has) btn.addEventListener("click", () => { this.clearSection(sectionId); this.onOpen(); });
    }
    parent.createEl("p", { cls: "setting-item-description", text: desc });
  }

  // Whole-level reset zone, appended to the General tab on sub-levels. Clears
  // every override so the level fully inherits its parent, keeping identity
  // (name/icon/colour/default view). Staged in the draft until Save.
  private renderResetAllZone(parent: HTMLElement) {
    if (this.level === "workspace") return;
    const has = RESET_ALL_FIELDS.some((f) => this.fieldHasValue(f)) || this.fieldHasValue("empty_positions");
    const zone = parent.createDiv({ cls: "it-cfg-danger-zone" });
    zone.createEl("h4", { text: t("cfg.resetConfiguration") });
    zone.createEl("p", {
      cls: "setting-item-description",
      text: t("cfg.resetAllDesc", { level: cfgLevel(this.level) }),
    });
    const btn = zone.createEl("button", { cls: "it-btn-danger", text: t("cfg.resetAllToInherited"), attr: { type: "button" } });
    btn.disabled = !has;
    if (!has) {
      btn.title = t("cfg.resetAllNothing", { level: cfgLevel(this.level) });
      return;
    }
    btn.addEventListener("click", () => {
      new ConfirmModal(this.app, {
        title: t("cfg.confirmResetAllTitle"),
        message: t("cfg.confirmResetAllMsg", { level: cfgLevel(this.level) }),
        destructive: true,
        confirmLabel: t("cfg.confirmResetAllBtn"),
        onConfirm: () => {
          for (const f of RESET_ALL_FIELDS) this.draft[f] = null;
          this.draft.empty_positions = null;
          new Notice(t("cfg.noticeOverridesCleared"));
          this.onOpen();
        },
      }).open();
    });
  }

  // Helper: override-toggle pattern. Returns true when the editor should render
  // (workspace level always, or non-workspace with override on). When the
  // toggle is OFF on a lower level we render a preview of the inherited value.
  private renderOverrideToggleFor(
    parent: HTMLElement,
    label: string,
    isOverridden: boolean,
    cloneFromParent: () => void,
    clear: () => void,
    previewRenderer?: () => void
  ): boolean {
    if (this.level === "workspace") return true;
    new Setting(parent)
      .setName(t("cfg.override", { label }))
      .setDesc(isOverridden ? t("cfg.overrideOwn", { level: cfgLevel(this.level), label }) : t("cfg.overrideInherit"))
      .addToggle((t) =>
        t.setValue(isOverridden).onChange((v) => {
          if (v && !isOverridden) cloneFromParent();
          else if (!v && isOverridden) clear();
          this.onOpen();
        })
      );
    if (!isOverridden) {
      if (previewRenderer) previewRenderer();
      return false;
    }
    return true;
  }

  private resolveInheritedStatusSet(): StatusDef[] {
    // Walk parent chain to find inherited statuses (without the current draft).
    if (this.level === "list" && this.path) {
      const list = this.plugin.index.findList(this.path);
      if (list?.folderPath) {
        const f = this.plugin.index.findFolder(list.folderPath);
        if (f?.config.status_set?.length) return f.config.status_set;
      }
      if (list?.spacePath) {
        const s = this.plugin.index.findSpace(list.spacePath);
        if (s?.config.status_set?.length) return s.config.status_set;
      }
    } else if (this.level === "folder" && this.path) {
      const f = this.plugin.index.findFolder(this.path);
      if (f?.spacePath) {
        const s = this.plugin.index.findSpace(f.spacePath);
        if (s?.config.status_set?.length) return s.config.status_set;
      }
    }
    return this.plugin.index.workspace?.status_set?.length
      ? this.plugin.index.workspace.status_set
      : DEFAULT_STATUS_SET;
  }

  // ===== Custom Fields =====

  private renderCustomFields(parent: HTMLElement) {
    this.renderSectionHead(parent, "fields", t("cfg.customFieldsTitle"),
      this.level === "workspace"
        ? t("cfg.customFieldsDescWorkspace")
        : t("cfg.customFieldsDescOverride"));

    const inherited = this.resolveInheritedCustomFields();
    const showEditor = this.renderOverrideToggleFor(
      parent,
      cfgSectionLabel("customFields"),
      this.isArrayFieldOverridden("custom_fields"),
      () => { this.draft.custom_fields = inherited.length ? deepClone(inherited) : []; },
      () => { this.draft.custom_fields = null; },
      () => {
        const preview = parent.createDiv({ cls: "it-cfg-preview" });
        preview.createDiv({ cls: "it-cfg-preview-label", text: t("cfg.inheritedCustomFieldsPreview") });
        const list = preview.createDiv({ cls: "it-cfg-list" });
        if (inherited.length === 0) list.createDiv({ cls: "it-empty-row", text: t("common.none") });
        for (const f of inherited) {
          const row = list.createDiv({ cls: "it-cfg-row" });
          row.createSpan({ text: f.name, cls: "it-cfg-row-tag" });
          row.createSpan({ text: f.type });
        }
      }
    );
    if (!showEditor) return;

    const fields = (this.draft.custom_fields ||= []) as CustomFieldDef[];
    parent.createDiv({
      cls: "setting-item-description",
      text: t("cfg.fieldsImmutableNote"),
    });
    if (fields.length === 0) {
      parent.createDiv({ cls: "it-empty-row", text: t("cfg.noCustomFieldsYet") });
    }
    for (let i = 0; i < fields.length; i++) {
      renderFieldEditor(this.app, parent, fields, i, () => this.onOpen(), this.newCustomFields.has(fields[i]));
    }
    const addBar = parent.createDiv({ cls: "it-cfg-actions" });
    const addBtn = addBar.createEl("button", { cls: "it-btn-secondary", text: t("cfg.addField") });
    addBtn.addEventListener("click", () => {
      let id = "";
      do { id = `cf_${Math.random().toString(36).slice(2, 7)}`; }
      while (fields.some((field) => field.id === id));
      const field: CustomFieldDef = { id, name: t("cfg.newField"), type: "text" };
      fields.push(field);
      this.newCustomFields.add(field);
      this.onOpen();
    });

    this.renderStandardFieldIdReference(parent);
  }

  /** Collapsed reference listing the built-in field ids the External API can
   *  address (standard fields have no visible id in the task modal — this is
   *  where developers look them up). Read-only info; not shown on tasks. */
  private renderStandardFieldIdReference(parent: HTMLElement) {
    const STANDARD_FIELD_IDS = [
      "title", "type", "status", "priority", "start_date", "due_date", "custom_id",
      "tags", "context", "time_estimate", "time_tracked", "sprint_points",
      "parent_task", "color", "icon", "recurring", "created_at", "updated_at", "body",
    ];
    const box = parent.createEl("details", { cls: "it-cfg-api-fields" });
    box.createEl("summary", { text: t("cfg.apiFieldIdsTitle") });
    box.createDiv({ cls: "setting-item-description", text: t("cfg.apiFieldIdsDesc") });
    const list = box.createDiv({ cls: "it-cfg-fieldid-list" });
    for (const id of STANDARD_FIELD_IDS) list.createSpan({ text: id, cls: "it-cfg-fieldid" });
  }

  // ===== Tags palette =====

  private renderTagsPalette(parent: HTMLElement) {
    this.renderSectionHead(parent, "tags", t("cfg.tagsPalette"),
      this.level === "workspace"
        ? t("cfg.tagsPaletteDescWorkspace")
        : t("cfg.tagsPaletteDescOverride"));

    const inherited = this.resolveInheritedTagsPalette();
    const showEditor = this.renderOverrideToggleFor(
      parent,
      cfgSectionLabel("tagsPalette"),
      this.isArrayFieldOverridden("tags_palette"),
      () => { this.draft.tags_palette = inherited.length ? deepClone(inherited) : []; this.cloneEmptyFor("tags"); },
      () => { this.draft.tags_palette = null; this.clearEmptyFor("tags"); },
      () => {
        const preview = parent.createDiv({ cls: "it-cfg-preview" });
        preview.createDiv({ cls: "it-cfg-preview-label", text: t("cfg.inheritedTagsPreview") });
        const list = preview.createDiv({ cls: "it-cfg-list" });
        if (inherited.length === 0) list.createDiv({ cls: "it-empty-row", text: t("common.none") });
        for (const t of inherited) {
          const row = list.createDiv({ cls: "it-cfg-row" });
          const sw = row.createSpan({ cls: "it-cfg-swatch" });
          sw.style.background = t.color;
          row.createSpan({ text: t.name });
        }
      }
    );
    if (!showEditor) return;

    const tags = (this.draft.tags_palette ||= []) as TagDef[];

    if (tags.length === 0) parent.createDiv({ cls: "it-empty-row", text: t("cfg.noTagsYet") });

    const tagsEmpty = this.emptyCtxFor("tags");
    const tagsEmptyPos = Math.max(0, Math.min(tags.length, tagsEmpty.position));
    const renderTagsEmptyRow = () => renderEmptyRow(parent, t("cfg.emptyNoTags"), tagsEmptyPos, tags.length, tagsEmpty.onChange);

    for (let i = 0; i < tags.length; i++) {
      if (i === tagsEmptyPos) renderTagsEmptyRow();
      const tg = tags[i];
      const row = parent.createDiv({ cls: "it-cfg-row" });
      const moves = row.createDiv({ cls: "it-cfg-row-moves" });
      const up = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveUp"), type: "button" } });
      setIcon(up, "chevron-up");
      up.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (i === 0) return; [tags[i-1], tags[i]] = [tags[i], tags[i-1]]; this.onOpen(); });
      const down = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveDown"), type: "button" } });
      setIcon(down, "chevron-down");
      down.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (i === tags.length - 1) return; [tags[i+1], tags[i]] = [tags[i], tags[i+1]]; this.onOpen(); });
      const swatch = row.createSpan({ cls: "it-cfg-swatch" });
      swatch.style.background = tg.color;
      swatch.addEventListener("click", () => openColorPicker(swatch, tg.color, (c) => { tg.color = c; swatch.style.background = c; }));
      const oldName = tg.name;
      const nameInput = row.createEl("input", { cls: "it-input-inline" });
      nameInput.value = tg.name;
      nameInput.addEventListener("change", async () => {
        const v = slugify(nameInput.value);
        if (!v) { nameInput.value = oldName; return; }
        tg.name = v;
        nameInput.value = v;
      });
      const remove = row.createEl("button", { cls: "it-btn-ghost", text: t("common.remove") });
      remove.addEventListener("click", () => {
        new ConfirmModal(this.app, {
          title: t("cfg.removeTagTitle", { name: tg.name }),
          message: t("cfg.removeTagMsg"),
          destructive: true,
          onConfirm: () => { tags.splice(i, 1); this.onOpen(); },
        }).open();
      });
    }
    if (tagsEmptyPos === tags.length) renderTagsEmptyRow();

    const addBar = parent.createDiv({ cls: "it-cfg-actions" });
    const addBtn = addBar.createEl("button", { cls: "it-btn-secondary", text: t("cfg.addTag") });
    addBtn.addEventListener("click", () => {
      tags.push({ name: `tag-${tags.length + 1}`, color: PALETTE[tags.length % PALETTE.length] });
      this.onOpen();
    });
  }

  // ===== Task types =====

  private renderTaskTypes(parent: HTMLElement) {
    const types = (this.draft.task_types ||= []) as TaskType[];

    parent.createEl("h3", { text: t("cfg.taskTypesTitle") });
    parent.createEl("p", {
      cls: "setting-item-description",
      text: t("cfg.taskTypesDesc"),
    });

    const typesEmpty = this.emptyCtxFor("type");
    const typesEmptyPos = Math.max(0, Math.min(types.length, typesEmpty.position));
    const renderTypesEmptyRow = () => renderEmptyRow(parent, t("cfg.emptyNoType"), typesEmptyPos, types.length, typesEmpty.onChange);

    for (let i = 0; i < types.length; i++) {
      if (i === typesEmptyPos) renderTypesEmptyRow();
      const tt = types[i];
      const wrap = parent.createDiv({ cls: "it-cfg-row it-cfg-row-block" });
      const top = wrap.createDiv({ cls: "it-cfg-row-top" });

      const moves = top.createDiv({ cls: "it-cfg-row-moves" });
      const up = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveUp"), type: "button" } });
      setIcon(up, "chevron-up");
      up.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (i === 0) return; [types[i-1], types[i]] = [types[i], types[i-1]]; this.onOpen(); });
      const down = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveDown"), type: "button" } });
      setIcon(down, "chevron-down");
      down.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (i === types.length - 1) return; [types[i+1], types[i]] = [types[i], types[i+1]]; this.onOpen(); });

      const iconBtn = top.createEl("button", { cls: "it-icon-trigger", attr: { type: "button", "aria-label": t("cfg.pickIcon"), title: t("cfg.pickIcon") } });
      const refreshIcon = () => {
        iconBtn.empty();
        const iconEl = renderIconish(iconBtn, tt.icon, { cls: "it-iconish", fallback: "·" });
        if (tt.color && iconEl) iconEl.style.color = tt.color;
      };
      refreshIcon();
      iconBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openIconPicker(iconBtn, tt.icon, (v) => { tt.icon = v; refreshIcon(); });
      });

      // Color swatch — opens color picker
      const swatch = top.createEl("button", { cls: "it-cfg-swatch", attr: { type: "button", "aria-label": t("cfg.pickColor"), title: t("cfg.pickColor") } });
      swatch.style.background = tt.color || "#9E9E9E";
      swatch.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openColorPicker(swatch, tt.color || "#9E9E9E", (c) => { tt.color = c; swatch.style.background = c; });
      });

      const idInput = top.createEl("input", { cls: "it-input-inline", placeholder: t("cfg.placeholderId") });
      idInput.value = tt.id;
      idInput.addEventListener("change", () => (tt.id = slugify(idInput.value) || tt.id));
      const nameInput = top.createEl("input", { cls: "it-input-inline", placeholder: t("cfg.name") });
      nameInput.value = tt.name;
      nameInput.addEventListener("change", () => (tt.name = nameInput.value || tt.name));
      const pluralInput = top.createEl("input", { cls: "it-input-inline", placeholder: t("cfg.plural") });
      pluralInput.value = tt.plural || "";
      pluralInput.addEventListener("change", () => (tt.plural = pluralInput.value || tt.name));

      const remove = top.createEl("button", { cls: "it-btn-ghost", text: t("common.remove") });
      remove.addEventListener("click", () => {
        confirmConfigRemove(this.app, `${t("common.remove")}: ${tt.name}`, () => { types.splice(i, 1); this.onOpen(); });
      });
    }
    if (typesEmptyPos === types.length) renderTypesEmptyRow();

    const addBar = parent.createDiv({ cls: "it-cfg-actions" });
    const addBtn = addBar.createEl("button", { cls: "it-btn-secondary", text: t("cfg.addTaskType") });
    addBtn.addEventListener("click", () => {
      types.push({ id: `type_${types.length + 1}`, name: t("cfg.untitledType"), icon: "📌", color: "#9E9E9E" });
      this.onOpen();
    });
  }

  // ===== Priorities =====

  private renderPrioritiesOverride(parent: HTMLElement) {
    this.renderSectionHead(parent, "priorities", t("cfg.priorities"),
      this.level === "workspace"
        ? t("cfg.prioritiesDescWorkspace")
        : t("cfg.prioritiesDescOverride"));

    const inherited = this.resolveInheritedPriorities();
    const showEditor = this.renderOverrideToggleFor(
      parent,
      cfgSectionLabel("priorities"),
      this.isArrayFieldOverridden("priorities"),
      () => { this.draft.priorities = inherited.length ? deepClone(inherited) : deepClone(DEFAULT_PRIORITIES); this.cloneEmptyFor("priority"); },
      () => { this.draft.priorities = null; this.clearEmptyFor("priority"); },
      () => {
        const preview = parent.createDiv({ cls: "it-cfg-preview" });
        preview.createDiv({ cls: "it-cfg-preview-label", text: t("cfg.inheritedPrioritiesPreview") });
        const list = preview.createDiv({ cls: "it-cfg-list" });
        for (const p of inherited) {
          const row = list.createDiv({ cls: "it-cfg-row" });
          const sw = row.createSpan({ cls: "it-cfg-swatch" });
          sw.style.background = p.color;
          row.createSpan({ text: `${p.id}.`, cls: "it-cfg-row-tag" });
          row.createSpan({ text: p.label });
        }
      }
    );
    if (showEditor) {
      this.draft.priorities ||= deepClone(DEFAULT_PRIORITIES);
      renderPriorityList(this.app, parent, this.draft.priorities, () => this.onOpen(), this.emptyCtxFor("priority"));
    }
  }

  private resolveInheritedPriorities(): PriorityDef[] {
    if (this.level === "list" && this.path) {
      const list = this.plugin.index.findList(this.path);
      if (list?.folderPath) {
        const f = this.plugin.index.findFolder(list.folderPath);
        if (f?.config.priorities?.length) return f.config.priorities;
      }
      if (list?.spacePath) {
        const s = this.plugin.index.findSpace(list.spacePath);
        if (s?.config.priorities?.length) return s.config.priorities;
      }
    } else if (this.level === "folder" && this.path) {
      const f = this.plugin.index.findFolder(this.path);
      if (f?.spacePath) {
        const s = this.plugin.index.findSpace(f.spacePath);
        if (s?.config.priorities?.length) return s.config.priorities;
      }
    }
    return this.plugin.index.getPriorities();
  }

  private resolveInheritedTagsPalette(): TagDef[] {
    if (this.level === "list" && this.path) {
      const list = this.plugin.index.findList(this.path);
      if (list?.folderPath) {
        const f = this.plugin.index.findFolder(list.folderPath);
        if (f?.config.tags_palette?.length) return f.config.tags_palette;
      }
      if (list?.spacePath) {
        const s = this.plugin.index.findSpace(list.spacePath);
        if (s?.config.tags_palette?.length) return s.config.tags_palette;
      }
    } else if (this.level === "folder" && this.path) {
      const f = this.plugin.index.findFolder(this.path);
      if (f?.spacePath) {
        const s = this.plugin.index.findSpace(f.spacePath);
        if (s?.config.tags_palette?.length) return s.config.tags_palette;
      }
    }
    return this.plugin.index.workspace?.tags_palette ?? [];
  }

  private resolveInheritedCustomFields(): CustomFieldDef[] {
    if (this.level === "list" && this.path) {
      const list = this.plugin.index.findList(this.path);
      if (list?.folderPath) {
        const f = this.plugin.index.findFolder(list.folderPath);
        if (f?.config.custom_fields?.length) return f.config.custom_fields;
      }
      if (list?.spacePath) {
        const s = this.plugin.index.findSpace(list.spacePath);
        if (s?.config.custom_fields?.length) return s.config.custom_fields;
      }
    } else if (this.level === "folder" && this.path) {
      const f = this.plugin.index.findFolder(this.path);
      if (f?.spacePath) {
        const s = this.plugin.index.findSpace(f.spacePath);
        if (s?.config.custom_fields?.length) return s.config.custom_fields;
      }
    }
    return this.plugin.index.workspace?.custom_fields ?? [];
  }

  // ===== View defaults (visible fields per view type) =====

  private viewSubTab: ViewType = "list";

  private renderViewDefaults(parent: HTMLElement) {
    this.renderSectionHead(parent, "views", t("cfg.viewDefaults"),
      t("cfg.viewDefaultsDesc"));

    const subBar = parent.createDiv({ cls: "it-config-subtabs" });
    const viewTabs: Array<{ id: ViewType; label: string }> = [
      { id: "list", label: t("view.list") },
      { id: "board", label: t("view.board") },
      { id: "calendar", label: t("view.calendar") },
      { id: "table", label: t("view.table") },
      { id: "gantt", label: t("view.gantt") },
      { id: "timeline", label: t("view.timeline") },
    ];
    for (const vt of viewTabs) {
      const btn = subBar.createEl("button", { cls: "it-config-subtab" + (this.viewSubTab === vt.id ? " is-active" : ""), text: vt.label });
      btn.addEventListener("click", () => { this.viewSubTab = vt.id; this.onOpen(); });
    }

    const view = this.viewSubTab;
    const vd: PerViewDefaults = (this.draft.view_defaults ||= {});
    const cur = vd[view] || {};
    const inheritedFields = this.resolveInheritedVisibleFields(view);

    const hasOverride = Array.isArray(cur.visible_fields) && cur.visible_fields.length > 0;
    new Setting(parent)
      .setName(t("cfg.overrideVisibleFields", { view: t(`view.${view}`) }))
      .setDesc(hasOverride ? t("cfg.overrideVisibleFieldsOn") : t("cfg.overrideVisibleFieldsOff"))
      .addToggle((t) =>
        t.setValue(hasOverride).onChange((v) => {
          if (v && !hasOverride) {
            // Preserve any sibling settings (e.g. color_by on calendar) by
            // merging instead of overwriting the per-view entry.
            vd[view] = { ...(vd[view] || {}), visible_fields: inheritedFields.slice() };
          } else if (!v && hasOverride) {
            const next = { ...(vd[view] || {}) };
            delete next.visible_fields;
            if (Object.keys(next).length === 0) delete vd[view];
            else vd[view] = next;
          }
          this.onOpen();
        })
      );

    // Honor feature toggles: when a feature is OFF at this level (or inherited),
    // its corresponding fields are not selectable in view defaults.
    const effectiveFeatures = this.resolveEffectiveFeaturesAtThisLevel();
    // Collect custom fields visible at this scope (own + inherited from parents).
    const customFields = this.collectCustomFieldsAtThisLevel();
    const cfKeys = customFields.map((f) => `custom_field:${f.id}`);
    const labelFor = (key: string): string => {
      if (key.startsWith("custom_field:")) {
        const id = key.slice(13);
        return customFields.find((c) => c.id === id)?.name || id;
      }
      return this.fieldLabelAt(key);
    };
    // Colored type icon for a custom-field key (used in the field chips/lists).
    const cfTypeOf = (key: string): string | undefined =>
      key.startsWith("custom_field:") ? customFields.find((c) => c.id === key.slice(13))?.type : undefined;
    const labeledChip = (parentEl: HTMLElement, key: string, cls: string): HTMLButtonElement => {
      const el = parentEl.createEl("button", { cls });
      renderFieldIcon(el, key, customFields); // icon for built-in + custom fields
      el.createSpan({ text: labelFor(key) });
      return el;
    };
    const activeFields = filterFieldsByFeatures(
      hasOverride ? (cur.visible_fields || []) : inheritedFields,
      effectiveFeatures
    );
    const all = [
      ...filterFieldsByFeatures(availableFieldsFor(view as any), effectiveFeatures),
      ...cfKeys,
    ];

    const help = parent.createDiv({ cls: "it-cfg-help" });
    help.createEl("strong", { text: t("cfg.tip") });
    help.appendText(t("cfg.tipToggleFields"));

    const fieldsList = parent.createDiv({ cls: "it-cfg-fields-grid" });
    for (const f of all) {
      const on = activeFields.includes(f);
      const chip = labeledChip(fieldsList, f, "it-chip it-chip-toggle" + (on ? " is-active" : ""));
      chip.disabled = !hasOverride;
      if (!hasOverride) chip.title = t("cfg.enableOverrideAbove");
      chip.addEventListener("click", () => {
        if (!hasOverride) return;
        // Read CURRENT visible_fields from vd[view] (not stale `cur` closed
        // over at render time) so toggling stays consistent even if some
        // other code path mutated draft in between renders.
        const live = vd[view] || {};
        const next = (live.visible_fields || []).slice();
        const idx = next.indexOf(f);
        if (idx >= 0) next.splice(idx, 1);
        else next.push(f);
        vd[view] = { ...live, visible_fields: next };
        this.onOpen();
      });
    }

    if (!hasOverride) {
      const preview = parent.createDiv({ cls: "it-cfg-preview" });
      preview.createDiv({ cls: "it-cfg-preview-label", text: t("cfg.currentlyShowingInherited") });
      const row = preview.createDiv({ cls: "it-tags-list" });
      for (const f of inheritedFields) {
        const prevChip = row.createSpan({ cls: "it-chip it-chip-tag" });
        renderFieldIcon(prevChip, f, customFields);
        prevChip.createSpan({ text: labelFor(f) });
      }
    } else {
      // Re-order controls for active fields
      parent.createEl("h4", { text: t("cfg.activeFieldOrder") });
      const orderWrap = parent.createDiv({ cls: "it-cfg-list" });
      const list: string[] = (cur.visible_fields || []).slice();
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const r = orderWrap.createDiv({ cls: "it-cfg-row" });
        const moves = r.createDiv({ cls: "it-cfg-row-moves" });
        const up = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveUp") } });
        setIcon(up, "chevron-up");
        up.addEventListener("click", () => {
          if (i === 0) return;
          [list[i-1], list[i]] = [list[i], list[i-1]];
          vd[view] = { ...(vd[view] || {}), visible_fields: list };
          this.onOpen();
        });
        const down = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveDown") } });
        setIcon(down, "chevron-down");
        down.addEventListener("click", () => {
          if (i === list.length - 1) return;
          [list[i+1], list[i]] = [list[i], list[i+1]];
          vd[view] = { ...(vd[view] || {}), visible_fields: list };
          this.onOpen();
        });
        const ordLabel = r.createSpan({ cls: "it-tree-label" });
        renderFieldIcon(ordLabel, f, customFields);
        ordLabel.createSpan({ text: labelFor(f) });
      }

      const resetBar = parent.createDiv({ cls: "it-cfg-actions" });
      const reset = resetBar.createEl("button", { cls: "it-btn-secondary", text: t("cfg.resetToDefaults") });
      reset.addEventListener("click", () => {
        vd[view] = { ...(vd[view] || {}), visible_fields: defaultVisibleFor(view as any) };
        this.onOpen();
      });
      const inherit = resetBar.createEl("button", { cls: "it-btn-ghost", text: t("cfg.inheritFromParent") });
      inherit.addEventListener("click", () => {
        vd[view] = { ...(vd[view] || {}), visible_fields: inheritedFields.slice() };
        this.onOpen();
      });
    }

    // Calendar + the time views (Gantt/Timeline) add a color-source knob —
    // the same `color_by` slot drives calendar pills and time-view bars.
    if (view === "calendar" || view === "gantt" || view === "timeline") {
      this.renderCalendarColorBy(parent, vd, customFields, view);
      this.renderDateFieldDefaults(parent, vd, customFields, view);
    }

    // Board + Calendar: extra toggles controlling how custom-field chips
    // render. Each toggle is tri-state at storage level: explicit
    // true/false (override) OR absent (inherit from parent scope).
    if (view === "board" || view === "calendar") {
      this.renderCfDisplayToggles(parent, vd, view);
    }

    // List/Table/Board/Calendar: show colored field-type icons (headers/chips).
    if (["list", "table", "board", "calendar"].includes(view)) {
      this.renderFieldIconToggle(parent, vd, view);
    }

    // List: checkbox-click behaviour (which status group to flip to).
    if (view === "list") {
      this.renderListCheckboxAction(parent, vd);
    }
  }

  // Tri-state "Field icons" default (On / Off / Inherit) for the views that show
  // field-type icons. Stored per-view in view_defaults.cf_show_type_icon.
  private renderFieldIconToggle(parent: HTMLElement, vd: PerViewDefaults, view: ViewType) {
    const cur = (vd[view] ||= {});
    new Setting(parent)
      .setName(t("cfg.fieldIcons"))
      .setDesc(t("cfg.fieldIconsDesc"))
      .addDropdown((d) => {
        d.addOption("", t("common.inherit"));
        d.addOption("true", t("cfg.on"));
        d.addOption("false", t("cfg.off"));
        const v = cur.cf_show_type_icon;
        d.setValue(v === true ? "true" : v === false ? "false" : "");
        d.onChange((val) => { if (val === "") delete cur.cf_show_type_icon; else cur.cf_show_type_icon = val === "true"; });
      });
  }

  // Tri-state selector for the list-row checkbox action. Picks which
  // status group the checkbox flips to when checked.
  //   Inherit → use parent scope's setting (or "done" if nothing set)
  //   Done    → first status in the "done" group, fall back to "closed"
  //   Closed  → first status in the "closed" group, fall back to "done"
  private renderListCheckboxAction(parent: HTMLElement, vd: PerViewDefaults) {
    const cur = (vd["list"] ||= {});
    const block = parent.createDiv({ cls: "it-cfg-section" });
    block.createEl("h4", { text: t("cfg.rowCheckboxAction") });
    block.createEl("p", {
      cls: "setting-item-description",
      text: t("cfg.rowCheckboxDesc"),
    });
    const wrap = block.createDiv({ cls: "it-cfg-row" });
    const meta = wrap.createDiv({ cls: "it-cfg-row-meta" });
    meta.createDiv({ cls: "it-cfg-row-title", text: t("cfg.onCheckSetStatusGroup") });
    const sel = wrap.createEl("select", { cls: "it-input" });
    sel.createEl("option", { value: "", text: t("common.inherit") });
    sel.createEl("option", { value: "done", text: t("cfg.doneFirstDone") });
    sel.createEl("option", { value: "closed", text: t("cfg.closedFirstClosed") });
    sel.value = cur.checkbox_action === "done" ? "done" : cur.checkbox_action === "closed" ? "closed" : "";
    sel.addEventListener("change", () => {
      if (sel.value === "") delete cur.checkbox_action;
      else cur.checkbox_action = sel.value as "done" | "closed";
    });
  }

  // Two tri-state booleans applied to custom-field chips in board / calendar:
  //   cf_show_name      — prepend "<Field name>: " to the chip body
  //   cf_show_when_empty — render the chip even with no value
  // Each renders as a 3-way select (Inherit / On / Off). The resolved value
  // is what views actually use; this UI shows what's saved AT THIS LEVEL.
  private renderCfDisplayToggles(parent: HTMLElement, vd: PerViewDefaults, view: ViewType) {
    const cur = (vd[view] ||= {});
    const block = parent.createDiv({ cls: "it-cfg-section" });
    block.createEl("h4", { text: t("cfg.customFieldDisplay") });
    block.createEl("p", {
      cls: "setting-item-description",
      text: t("cfg.customFieldDisplayDesc"),
    });

    const triState = (
      key: "cf_show_name" | "cf_show_when_empty",
      label: string,
      desc: string,
    ) => {
      const wrap = block.createDiv({ cls: "it-cfg-row" });
      const meta = wrap.createDiv({ cls: "it-cfg-row-meta" });
      meta.createDiv({ cls: "it-cfg-row-title", text: label });
      meta.createDiv({ cls: "setting-item-description", text: desc });
      const sel = wrap.createEl("select", { cls: "it-input" });
      sel.createEl("option", { value: "", text: t("common.inherit") });
      sel.createEl("option", { value: "true", text: t("cfg.on") });
      sel.createEl("option", { value: "false", text: t("cfg.off") });
      const v = cur[key];
      sel.value = v === true ? "true" : v === false ? "false" : "";
      sel.addEventListener("change", () => {
        if (sel.value === "") delete cur[key];
        else cur[key] = sel.value === "true";
      });
    };
    triState("cf_show_name", t("cfg.showFieldName"), t("cfg.showFieldNameDesc"));
    triState("cf_show_when_empty", t("cfg.showFieldWhenEmpty"), t("cfg.showFieldWhenEmptyDesc"));
  }

  // Inheritable "background color from" picker for calendar pills. Sits inside
  // the View defaults → Calendar sub-tab, with the same inheritance UX as the
  // visible_fields toggle above.
  private renderCalendarColorBy(
    parent: HTMLElement,
    vd: PerViewDefaults,
    customFields: CustomFieldDef[],
    view: ViewType = "calendar",
  ) {
    const isBars = view === "gantt" || view === "timeline";
    parent.createEl("h4", { text: isBars ? t("cfg.barColor") : t("cfg.backgroundColor") });
    parent.createEl("p", {
      cls: "setting-item-description",
      text: isBars ? t("cfg.barColorDesc") : t("cfg.calendarColorDesc"),
    });

    const cur = vd[view] || {};
    const inheritedColorBy = this.resolveInheritedColorBy(view) || CALENDAR_COLOR_SOURCE_DEFAULT;
    const hasOverride = typeof cur.color_by === "string" && cur.color_by.length > 0;

    // Color-bearing custom fields (dropdown/labels with palette).
    const colorBearingCFs = customFields.filter((f) => f.type === "dropdown" || f.type === "labels");
    const sourceLabel = (value: string): string => {
      const built = CALENDAR_COLOR_SOURCES_BUILTIN.find((s) => s.value === value);
      if (built) return colorSourceLabel(built.value);
      if (value.startsWith("custom_field:")) {
        const id = value.slice(13);
        const f = colorBearingCFs.find((c) => c.id === id);
        return f ? `${f.name} ${t("cfg.customSuffix")}` : id;
      }
      return value;
    };

    new Setting(parent)
      .setName(t("cfg.overrideColorSource"))
      .setDesc(
        hasOverride
          ? t("cfg.overrideColorActive", { source: sourceLabel(cur.color_by!) })
          : t("cfg.overrideColorInherit", { source: sourceLabel(inheritedColorBy) })
      )
      .addToggle((t) =>
        t.setValue(hasOverride).onChange((v) => {
          if (v && !hasOverride) {
            vd[view] = { ...(vd[view] || {}), color_by: inheritedColorBy };
          } else if (!v && hasOverride) {
            const next = { ...(vd[view] || {}) };
            delete next.color_by;
            if (Object.keys(next).length === 0) delete vd[view];
            else vd[view] = next;
          }
          this.onOpen();
        })
      );

    if (!hasOverride) return;

    const grid = parent.createDiv({ cls: "it-cfg-fields-grid" });
    const renderOption = (value: string, label: string) => {
      const on = (cur.color_by || "") === value;
      const chip = grid.createEl("button", {
        cls: "it-chip it-chip-toggle" + (on ? " is-active" : ""),
        text: label,
      });
      chip.addEventListener("click", () => {
        vd[view] = { ...(vd[view] || {}), color_by: value };
        this.onOpen();
      });
    };
    for (const opt of CALENDAR_COLOR_SOURCES_BUILTIN) renderOption(opt.value, colorSourceLabel(opt.value));
    for (const f of colorBearingCFs) renderOption(`custom_field:${f.id}`, `${f.name} ${t("cfg.customSuffix")}`);

    const actions = parent.createDiv({ cls: "it-cfg-actions" });
    const inherit = actions.createEl("button", { cls: "it-btn-ghost", text: t("cfg.inheritFromParent") });
    inherit.addEventListener("click", () => {
      vd[view] = { ...(vd[view] || {}), color_by: inheritedColorBy };
      this.onOpen();
    });
  }

  private resolveInheritedColorBy(view: ViewType = "calendar"): string | undefined {
    return this.resolveInheritedViewDefaultString(view, "color_by");
  }

  // Inheritable "date source" pickers for the date-driven views. Calendar has
  // one knob (which field places the pill); Gantt/Timeline get two (bar start
  // + bar end). Mirrors the color-source UX above.
  private renderDateFieldDefaults(
    parent: HTMLElement,
    vd: PerViewDefaults,
    customFields: CustomFieldDef[],
    view: ViewType,
  ) {
    const dateCFs = dateBearingCustomFields(customFields);
    const sourceLabel = (value: string): string => {
      if (value.startsWith("custom_field:")) {
        const f = dateCFs.find((c) => c.id === value.slice(13));
        return f ? `${f.name} ${t("cfg.customSuffix")}` : value.slice(13);
      }
      return this.fieldLabelAt(value);
    };

    const knob = (key: "date_field" | "start_date_field", head: string, desc: string, fallback: string) => {
      parent.createEl("h4", { text: head });
      parent.createEl("p", { cls: "setting-item-description", text: desc });

      const cur = vd[view] || {};
      const inherited = this.resolveInheritedViewDefaultString(view, key) || fallback;
      const curVal = cur[key];
      const hasOverride = typeof curVal === "string" && curVal.length > 0;

      new Setting(parent)
        .setName(t("cfg.overrideDateField"))
        .setDesc(
          hasOverride
            ? t("cfg.overrideDateFieldActive", { source: sourceLabel(curVal!) })
            : t("cfg.overrideDateFieldInherit", { source: sourceLabel(inherited) })
        )
        .addToggle((tg) =>
          tg.setValue(hasOverride).onChange((v) => {
            if (v && !hasOverride) {
              vd[view] = { ...(vd[view] || {}), [key]: inherited };
            } else if (!v && hasOverride) {
              const next = { ...(vd[view] || {}) };
              delete next[key];
              if (Object.keys(next).length === 0) delete vd[view];
              else vd[view] = next;
            }
            this.onOpen();
          })
        );

      if (!hasOverride) return;

      const grid = parent.createDiv({ cls: "it-cfg-fields-grid" });
      const renderOption = (value: string) => {
        const on = (curVal || "") === value;
        const chip = grid.createEl("button", { cls: "it-chip it-chip-toggle" + (on ? " is-active" : "") });
        renderFieldIcon(chip, value, customFields);
        chip.createSpan({ text: sourceLabel(value) });
        chip.addEventListener("click", () => {
          vd[view] = { ...(vd[view] || {}), [key]: value };
          this.onOpen();
        });
      };
      for (const v of DATE_SOURCES_BUILTIN) renderOption(v);
      for (const f of dateCFs) renderOption(`custom_field:${f.id}`);

      const actions = parent.createDiv({ cls: "it-cfg-actions" });
      const inherit = actions.createEl("button", { cls: "it-btn-ghost", text: t("cfg.inheritFromParent") });
      inherit.addEventListener("click", () => {
        vd[view] = { ...(vd[view] || {}), [key]: inherited };
        this.onOpen();
      });
    };

    if (view === "calendar") {
      knob("date_field", t("cfg.calDateField"), t("cfg.calDateFieldDesc"), DATE_SOURCE_DUE);
    } else {
      knob("start_date_field", t("cfg.barStartField"), t("cfg.barStartFieldDesc"), DATE_SOURCE_START);
      knob("date_field", t("cfg.barDueField"), t("cfg.barDueFieldDesc"), DATE_SOURCE_DUE);
    }
  }

  // Generic "first parent level that defines this string prop wins" resolver
  // for view_defaults props (color_by / date_field / start_date_field).
  private resolveInheritedViewDefaultString(view: ViewType, prop: "color_by" | "date_field" | "start_date_field"): string | undefined {
    const pick = (cfg: any): string | undefined => {
      const v = cfg?.view_defaults?.[view]?.[prop];
      return typeof v === "string" && v.length ? v : undefined;
    };
    if (this.level === "list" && this.path) {
      const list = this.plugin.index.findList(this.path);
      if (list?.folderPath) {
        const f = this.plugin.index.findFolder(list.folderPath);
        const v = pick(f?.config); if (v) return v;
      }
      if (list?.spacePath) {
        const s = this.plugin.index.findSpace(list.spacePath);
        const v = pick(s?.config); if (v) return v;
      }
    } else if (this.level === "folder" && this.path) {
      const f = this.plugin.index.findFolder(this.path);
      if (f?.spacePath) {
        const s = this.plugin.index.findSpace(f.spacePath);
        const v = pick(s?.config); if (v) return v;
      }
    } else if (this.level === "space") {
      // Spaces inherit from workspace only.
    }
    return pick(this.plugin.index.workspace);
  }

  // Returns the effective Features map for the current config level, taking
  // the in-progress draft into account so changes propagate immediately to
  // dependent UI (e.g., the View defaults picker) without needing a save.
  private resolveEffectiveFeaturesAtThisLevel(): Record<string, boolean> {
    const idx = this.plugin.index;
    if (this.level === "workspace") {
      // No features at workspace level — everything defaults to ON.
      return idx.resolveFeatures();
    }
    if (this.level === "space" && this.path) {
      const merged = idx.resolveFeatures({ spacePath: this.path });
      // Overlay draft (unsaved) edits on top of saved space features.
      if (this.draft.features) {
        for (const k of Object.keys(this.draft.features)) {
          const v = this.draft.features[k];
          if (v === true || v === false) merged[k] = v;
        }
      }
      return merged;
    }
    if (this.level === "folder" && this.path) {
      const merged = idx.resolveFeatures({ folderPath: this.path });
      if (this.draft.features) {
        for (const k of Object.keys(this.draft.features)) {
          const v = this.draft.features[k];
          if (v === true || v === false) merged[k] = v;
        }
      }
      return merged;
    }
    if (this.level === "list" && this.path) {
      return idx.resolveFeatures({ listPath: this.path });
    }
    return idx.resolveFeatures();
  }

  // Returns { position, onChange } for an empty-bucket pseudo row, scoped to
  // the current draft's `empty_positions[axis]`. Stays optional — pass to
  // palette editors that should expose this affordance.
  private emptyCtxFor(axis: "status" | "priority" | "tags" | "context" | "type"): { position: number; onChange: (pos: number) => void } {
    const map = (this.draft.empty_positions ||= {}) as Record<string, number>;
    return {
      position: typeof map[axis] === "number" ? map[axis] : 0,
      onChange: (pos: number) => {
        map[axis] = pos;
        this.onOpen();
      },
    };
  }

  // Custom fields visible at this config level (draft's own + inherited from parents).
  // What custom fields apply to tasks resolved at THIS level. Mirrors the
  // override semantics used by WorkspaceIndex.resolveCustomFields: narrowest
  // non-empty definition wins. We walk the chain from this level up to the
  // workspace and return the first non-empty array we find.
  //
  // The unsaved `this.draft.custom_fields` always counts as "this level" so
  // newly-added fields appear in the View-defaults picker immediately.
  private collectCustomFieldsAtThisLevel(): CustomFieldDef[] {
    const idx = this.plugin.index;
    const chain: Array<CustomFieldDef[] | undefined> = [this.draft.custom_fields];
    if (this.level === "list" && this.path) {
      const list = idx.findList(this.path);
      if (list?.folderPath) chain.push(idx.findFolder(list.folderPath)?.config.custom_fields);
      if (list?.spacePath) chain.push(idx.findSpace(list.spacePath)?.config.custom_fields);
      chain.push(idx.workspace?.custom_fields);
    } else if (this.level === "folder" && this.path) {
      const folder = idx.findFolder(this.path);
      if (folder?.spacePath) chain.push(idx.findSpace(folder.spacePath)?.config.custom_fields);
      chain.push(idx.workspace?.custom_fields);
    } else if (this.level === "space") {
      chain.push(idx.workspace?.custom_fields);
    }
    // Workspace level: only chain[0] = draft is meaningful — there's nothing above.
    for (const arr of chain) {
      if (arr && arr.length) return arr;
    }
    return [];
  }

  private resolveInheritedContextLabels(): ContextLabelDef[] {
    if (this.level === "workspace") return DEFAULT_CONTEXT_LABELS.map((l) => ({ ...l }));
    if (this.level === "space") {
      return this.plugin.index.workspace?.context_labels?.length
        ? this.plugin.index.workspace.context_labels
        : DEFAULT_CONTEXT_LABELS.map((l) => ({ ...l }));
    }
    if (this.level === "folder" && this.path) {
      const folder = this.plugin.index.findFolder(this.path);
      const spacePath = folder?.spacePath;
      if (spacePath) {
        return this.plugin.index.resolveContextLabels({ spacePath });
      }
    }
    if (this.level === "list" && this.path) {
      const list = this.plugin.index.findList(this.path);
      if (list?.folderPath) return this.plugin.index.resolveContextLabels({ folderPath: list.folderPath });
      if (list?.spacePath) return this.plugin.index.resolveContextLabels({ spacePath: list.spacePath });
    }
    return DEFAULT_CONTEXT_LABELS.map((l) => ({ ...l }));
  }

  private resolveInheritedVisibleFields(view: ViewType): string[] {
    if (this.level === "list" && this.path) {
      const list = this.plugin.index.findList(this.path);
      if (list?.folderPath) {
        const f = this.plugin.index.findFolder(list.folderPath);
        const v = f?.config.view_defaults?.[view];
        if (v?.visible_fields?.length) return v.visible_fields;
      }
      if (list?.spacePath) {
        const s = this.plugin.index.findSpace(list.spacePath);
        const v = s?.config.view_defaults?.[view];
        if (v?.visible_fields?.length) return v.visible_fields;
      }
    } else if (this.level === "folder" && this.path) {
      const f = this.plugin.index.findFolder(this.path);
      if (f?.spacePath) {
        const s = this.plugin.index.findSpace(f.spacePath);
        const v = s?.config.view_defaults?.[view];
        if (v?.visible_fields?.length) return v.visible_fields;
      }
    }
    return defaultVisibleFor(view as any);
  }

  // ===== Task types override (Folder/List) =====

  private renderTaskTypesOverride(parent: HTMLElement) {
    this.renderSectionHead(parent, "task_types", t("cfg.taskTypesTitle"),
      this.level === "workspace"
        ? t("cfg.taskTypesDescWorkspace")
        : t("cfg.taskTypesDescOverride"));

    const inherited = this.resolveInheritedTaskTypes();
    const showEditor = this.renderOverrideToggleFor(
      parent,
      cfgSectionLabel("taskTypes"),
      this.isArrayFieldOverridden("task_types"),
      () => { this.draft.task_types = inherited.length ? deepClone(inherited) : []; this.cloneEmptyFor("type"); },
      () => { this.draft.task_types = null; this.clearEmptyFor("type"); },
      () => {
        const preview = parent.createDiv({ cls: "it-cfg-preview" });
        preview.createDiv({ cls: "it-cfg-preview-label", text: t("cfg.inheritedTaskTypesPreview") });
        const list = preview.createDiv({ cls: "it-cfg-list" });
        for (const tt of inherited) {
          const row = list.createDiv({ cls: "it-cfg-row" });
          const sw = row.createSpan({ cls: "it-cfg-swatch" });
          sw.style.background = tt.color || "#9E9E9E";
          const iconEl = renderIconish(row, tt.icon, { cls: "it-tree-emoji", fallback: "·" });
          if (iconEl) iconEl.style.color = tt.color || "#9E9E9E";
          row.createSpan({ text: tt.name, cls: "it-tree-label" });
          row.createSpan({ text: tt.id, cls: "it-cfg-row-tag" });
        }
      }
    );
    if (showEditor) {
      this.draft.task_types ||= deepClone(DEFAULT_TASK_TYPES);
      this.renderTaskTypes(parent);
    }
  }

  private resolveInheritedTaskTypes(): TaskType[] {
    if (this.level === "list" && this.path) {
      const list = this.plugin.index.findList(this.path);
      if (list?.folderPath) {
        const f = this.plugin.index.findFolder(list.folderPath);
        if (f?.config.task_types?.length) return f.config.task_types;
      }
      if (list?.spacePath) {
        const s = this.plugin.index.findSpace(list.spacePath);
        if (s?.config.task_types?.length) return s.config.task_types;
      }
    } else if (this.level === "folder" && this.path) {
      const f = this.plugin.index.findFolder(this.path);
      if (f?.spacePath) {
        const s = this.plugin.index.findSpace(f.spacePath);
        if (s?.config.task_types?.length) return s.config.task_types;
      }
    }
    if (this.plugin.index.workspace?.task_types?.length) return this.plugin.index.workspace.task_types;
    return DEFAULT_TASK_TYPES;
  }

  // ===== Task behavior =====
  // Task-level behavior settings that are NOT view-specific. Inherits
  // WS→Space→Folder→List like the other configurable elements.
  private renderTaskBehavior(parent: HTMLElement) {
    this.renderSectionHead(parent, "task_behavior", t("cfg.taskBehavior"),
      t("cfg.taskBehaviorDesc"));

    const tb = (this.draft.task_behavior ||= {});

    const block = parent.createDiv({ cls: "it-cfg-section" });
    block.createEl("h4", { text: t("cfg.subtasks") });

    const row = block.createDiv({ cls: "it-cfg-row" });
    const meta = row.createDiv({ cls: "it-cfg-row-meta" });
    meta.createDiv({ cls: "it-cfg-row-title", text: t("cfg.subtaskCheckboxAction") });
    meta.createDiv({
      cls: "setting-item-description",
      text: t("cfg.subtaskCheckboxDesc"),
    });
    const sel = row.createEl("select", { cls: "it-input" });
    sel.createEl("option", { value: "", text: t("common.inherit") });
    sel.createEl("option", { value: "done", text: t("cfg.doneFirstDone") });
    sel.createEl("option", { value: "closed", text: t("cfg.closedFirstClosed") });
    sel.value = tb.subtasks_checkbox_action === "done" ? "done" : tb.subtasks_checkbox_action === "closed" ? "closed" : "";
    sel.addEventListener("change", () => {
      if (sel.value === "") delete tb.subtasks_checkbox_action;
      else tb.subtasks_checkbox_action = sel.value as "done" | "closed";
    });
  }

  // ===== Features =====

  private renderFeatures(parent: HTMLElement) {
    this.renderSectionHead(parent, "features", t("cfg.features"),
      this.level === "workspace"
        ? t("cfg.featuresDescWorkspace")
        : t("cfg.featuresDescOverride"));

    const apps = (this.draft.features ||= {}) as Record<string, boolean>;
    // Functional feature toggles — these enable/disable actual behaviour and,
    // where applicable, hide the field from every view (see FEATURE_FIELDS).
    const toggleIds = [
      "priorities", "due_dates", "start_dates", "tags", "context", "time_tracking",
      "time_estimate", "dependencies", "custom_task_types", "sprint_points",
      "recurring_tasks", "multiple_lists", "checklists", "attachments", "comments",
      "documents", "description", "cover_images", "incomplete_warning",
      "dependency_warning", "nested_subtasks",
    ] as const;

    // Compute the parent's effective Features so we can label the "Inherit"
    // option when on a non-workspace level.
    const parentEffective = this.level !== "workspace"
      ? this.computeParentFeatures()
      : null;

    for (const id of toggleIds) this.renderFeatureToggleRow(parent, id, apps, parentEffective);

    // ----- Modal-display-only group -----
    // Visually separated + labeled so it's unmistakable these ONLY hide the
    // field in the task-edit window (classic + wide) — the data and its use
    // everywhere else are untouched. Inheritance behaves like above.
    const modalGroup = parent.createDiv({ cls: "it-feature-group it-feature-group-modal" });
    modalGroup.createEl("h4", { cls: "it-feature-group-title", text: t("cfg.featModalGroup") });
    modalGroup.createEl("p", { cls: "setting-item-description it-feature-group-desc", text: t("cfg.featModalGroupDesc") });
    for (const id of MODAL_DISPLAY_FEATURE_IDS) this.renderFeatureToggleRow(modalGroup, id, apps, parentEffective);
  }

  // One Feature toggle row (2-state at workspace, tri-state below). Shared by
  // both the functional group and the modal-display-only group.
  private renderFeatureToggleRow(
    parent: HTMLElement,
    id: string,
    apps: Record<string, boolean>,
    parentEffective: Record<string, boolean> | null,
  ) {
    const row = parent.createDiv({ cls: "it-feature-row" });
    const info = row.createDiv({ cls: "it-feature-info" });
    info.createDiv({ cls: "it-feature-name", text: t(`cfg.feat.${id}`) });
    info.createDiv({ cls: "it-feature-desc", text: t(`cfg.feat.${id}Desc`) });
    const controls = row.createDiv({ cls: "it-feature-controls" });

    if (this.level === "workspace") {
      this.renderTwoStateInto(controls, apps[id] !== false, (next) => {
        apps[id] = next;
      });
    } else if (parentEffective) {
      this.renderTriStateInto(controls, apps[id], parentEffective[id] !== false, (next) => {
        if (next === undefined) delete apps[id];
        else apps[id] = next;
      });
    }
  }

  // Returns the parent's effective Features (used to label "Inherit").
  private computeParentFeatures(): Record<string, boolean> {
    if (this.level === "space") return this.plugin.index.resolveFeatures();
    if (this.level === "folder" && this.path) {
      const f = this.plugin.index.findFolder(this.path);
      return f?.spacePath ? this.plugin.index.resolveFeatures({ spacePath: f.spacePath }) : this.plugin.index.resolveFeatures();
    }
    if (this.level === "list" && this.path) {
      const list = this.plugin.index.findList(this.path);
      if (list?.folderPath) return this.plugin.index.resolveFeatures({ folderPath: list.folderPath });
      if (list?.spacePath) return this.plugin.index.resolveFeatures({ spacePath: list.spacePath });
    }
    return this.plugin.index.resolveFeatures();
  }

  // ===== Field names (custom display labels for built-in fields) =====
  //
  // DISPLAY-ONLY overrides: they change the label shown in the UI (dialogs,
  // views, menus, filters) but NEVER the markdown property / storage key.
  // Per-key inheritance WS→Space→Folder→List, mirroring Features.

  private renderFieldNames(parent: HTMLElement) {
    this.renderSectionHead(parent, "field_names", t("cfg.fieldNames"),
      this.level === "workspace"
        ? t("cfg.fieldNamesDescWorkspace")
        : t("cfg.fieldNamesDescOverride"));

    // Prominent, unmissable note that this is a display rename only.
    const note = parent.createDiv({ cls: "it-cfg-note it-cfg-note-info" });
    setIcon(note.createSpan({ cls: "it-cfg-note-ic" }), "info");
    note.createSpan({ cls: "it-cfg-note-text", text: t("cfg.fieldNamesNote") });

    const labels = (this.draft.field_labels ||= {}) as Record<string, string>;
    // Parent's effective custom names (excluding this level's draft) — used to
    // show what a blank field will inherit/display.
    const parentEffective = this.level !== "workspace" ? this.computeParentFieldLabels() : {};

    for (const key of RENAMEABLE_FIELD_KEYS) {
      const defaultLabel = fieldLabel(key); // i18n default (never changes)
      const inheritedLabel = parentEffective[key] || defaultLabel;

      const row = parent.createDiv({ cls: "it-fieldname-row" });
      const info = row.createDiv({ cls: "it-fieldname-info" });
      renderFieldIcon(info, key); // colored field-type icon for quick scanning
      const meta = info.createDiv({ cls: "it-fieldname-meta" });
      meta.createDiv({ cls: "it-fieldname-default", text: defaultLabel });
      // Muted reference to the untouched storage key, reinforcing "display only".
      meta.createDiv({ cls: "it-fieldname-key", text: t("cfg.fieldNamesProperty", { key }) });

      const controls = row.createDiv({ cls: "it-fieldname-controls" });
      const input = controls.createEl("input", {
        cls: "it-input it-fieldname-input",
        type: "text",
        attr: { placeholder: this.level === "workspace" ? defaultLabel : inheritedLabel },
      });
      input.value = typeof labels[key] === "string" ? labels[key] : "";
      input.addEventListener("change", () => {
        const v = input.value.trim();
        if (v && v !== defaultLabel) labels[key] = v;
        else delete labels[key];
      });
      // At a sub-level, show what a blank input resolves to (inherited/default).
      if (this.level !== "workspace") {
        controls.createDiv({
          cls: "it-fieldname-inherit",
          text: parentEffective[key] ? t("cfg.fieldNamesInherits", { label: inheritedLabel }) : t("cfg.fieldNamesDefault"),
        });
      }
    }
  }

  // Effective display name for a built-in field AT THIS config level, taking
  // the unsaved draft into account so the modal's own pickers (view defaults,
  // filters) reflect renames immediately. Draft override > inherited > default.
  private fieldLabelAt(key: string): string {
    const draftLabels = (this.draft.field_labels || {}) as Record<string, string>;
    const own = typeof draftLabels[key] === "string" ? draftLabels[key].trim() : "";
    if (own) return own;
    const parentEff = this.level === "workspace" ? {} : this.computeParentFieldLabels();
    return parentEff[key] || fieldLabel(key);
  }

  // Parent scope's effective field-label overrides (used for placeholders).
  private computeParentFieldLabels(): Record<string, string> {
    if (this.level === "space") return this.plugin.index.resolveFieldLabels();
    if (this.level === "folder" && this.path) {
      const f = this.plugin.index.findFolder(this.path);
      return f?.spacePath ? this.plugin.index.resolveFieldLabels({ spacePath: f.spacePath }) : this.plugin.index.resolveFieldLabels();
    }
    if (this.level === "list" && this.path) {
      const list = this.plugin.index.findList(this.path);
      if (list?.folderPath) return this.plugin.index.resolveFieldLabels({ folderPath: list.folderPath });
      if (list?.spacePath) return this.plugin.index.resolveFieldLabels({ spacePath: list.spacePath });
    }
    return this.plugin.index.resolveFieldLabels();
  }

  // 3-state segmented control: undefined (Inherit), true (On), false (Off)
  private renderTriStateInto(
    parent: HTMLElement,
    current: boolean | undefined,
    inheritedEffective: boolean,
    onChange: (next: boolean | undefined) => void
  ) {
    const wrap = parent.createDiv({ cls: "it-tri-state" });
    const states: Array<{ v: boolean | undefined; label: string }> = [
      { v: undefined, label: inheritedEffective ? t("cfg.inheritOn") : t("cfg.inheritOff") },
      { v: true, label: t("cfg.on") },
      { v: false, label: t("cfg.off") },
    ];
    for (const s of states) {
      const isActive = current === s.v;
      const btn = wrap.createEl("button", {
        cls: "it-tri-state-btn" + (isActive ? " is-active" : ""),
        text: s.label,
        attr: { type: "button" },
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(s.v);
        this.onOpen();
      });
    }
  }

  // ===== Chip (label) styles =====
  //
  // Per-element styling for colored labels (statuses, priorities, task types,
  // tags, context, custom fields). Each kind has 3 toggles: Border, Bold
  // border, Background. At workspace level toggles are 2-state (On/Off, since
  // the workspace is the source of truth). At lower levels each toggle is
  // tri-state (Inherit / On / Off) — matching the Features tab pattern.

  private renderChipStyles(parent: HTMLElement) {
    this.renderSectionHead(parent, "chip_styles", t("cfg.labelStyles"),
      this.level === "workspace"
        ? t("cfg.labelStylesDescWorkspace")
        : t("cfg.labelStylesDescOverride", { level: cfgLevel(this.level) }));

    const draftStyles = (this.draft.chip_styles ||= {}) as ChipStyles;
    const parentEffective = this.level !== "workspace" ? this.computeParentChipStyles() : null;
    // What the user currently sees from this level (draft on top of inheritance) —
    // used for the preview chip.
    const effective = this.computeEffectiveChipStyles(draftStyles);

    const cardsWrap = parent.createDiv({ cls: "it-chip-style-cards" });
    for (const kind of CHIP_KINDS) {
      const card = cardsWrap.createDiv({ cls: "it-chip-style-card" });

      // Header — kind name on the left, live preview chip on the right.
      const head = card.createDiv({ cls: "it-chip-style-card-head" });
      head.createDiv({ cls: "it-chip-style-card-title", text: chipKindLabel(kind) });
      const previewWrap = head.createDiv({ cls: "it-chip-style-preview-wrap" });
      this.renderChipStylePreview(previewWrap, kind, effective[kind]);

      // Body — one row per property with its tri-state / two-state control.
      const body = card.createDiv({ cls: "it-chip-style-card-body" });
      const props: Array<{ key: keyof ChipStyleConfig; label: string; desc: string }> = [
        { key: "border", label: t("cfg.chipBorder"), desc: t("cfg.chipBorderDesc") },
        { key: "bold_border", label: t("cfg.chipBoldBorder"), desc: t("cfg.chipBoldBorderDesc") },
        { key: "background", label: t("cfg.chipBackground"), desc: t("cfg.chipBackgroundDesc") },
      ];
      for (const p of props) {
        const row = body.createDiv({ cls: "it-chip-style-prop" });
        const lbl = row.createDiv({ cls: "it-chip-style-prop-label" });
        lbl.createSpan({ cls: "it-chip-style-prop-name", text: p.label });
        lbl.createSpan({ cls: "it-chip-style-prop-desc", text: p.desc });

        const cur = draftStyles[kind]?.[p.key];
        if (this.level === "workspace") {
          // Workspace is the source — 2-state.
          const value = cur === false ? false : !!cur;
          this.renderTwoStateInto(row, value, (next) => {
            this.setChipStyleProp(draftStyles, kind, p.key, next);
            this.onOpen();
          });
        } else {
          const inheritedEffective = !!parentEffective?.[kind]?.[p.key];
          this.renderTriStateInto(row, cur, inheritedEffective, (next) => {
            this.setChipStyleProp(draftStyles, kind, p.key, next);
            this.onOpen();
          });
        }
      }
    }
  }

  // Mutates the draft's chip_styles map in place, removing empty sub-objects
  // so persisted YAML stays clean (and so "inherit everything" lower-levels
  // serialize as absence rather than `{ status: {} }`).
  private setChipStyleProp(
    styles: ChipStyles,
    kind: ChipKind,
    key: keyof ChipStyleConfig,
    next: boolean | undefined
  ) {
    const cfg = (styles[kind] ||= {});
    if (next === undefined) delete cfg[key];
    else cfg[key] = next;
    // Drop empty sub-objects so YAML output stays tidy.
    if (Object.keys(cfg).length === 0) delete styles[kind];
  }

  // Mirrors `resolveChipStyles` in WorkspaceIndex but stops one level above
  // the current draft — used to label "Inherit" on tri-state controls.
  private computeParentChipStyles(): ResolvedChipStyles {
    const idx = this.plugin.index;
    if (this.level === "space") return idx.resolveChipStyles();
    if (this.level === "folder" && this.path) {
      const f = idx.findFolder(this.path);
      return f?.spacePath ? idx.resolveChipStyles({ spacePath: f.spacePath }) : idx.resolveChipStyles();
    }
    if (this.level === "list" && this.path) {
      const list = idx.findList(this.path);
      if (list?.folderPath) return idx.resolveChipStyles({ folderPath: list.folderPath });
      if (list?.spacePath) return idx.resolveChipStyles({ spacePath: list.spacePath });
    }
    return idx.resolveChipStyles();
  }

  // Composes the draft's chip styles on top of the parent's effective styles
  // so the preview reflects unsaved edits before they're written.
  private computeEffectiveChipStyles(draftStyles: ChipStyles): ResolvedChipStyles {
    const base = this.level === "workspace"
      ? this.plugin.index.resolveChipStyles()
      : this.computeParentChipStyles();
    const merged: ResolvedChipStyles = JSON.parse(JSON.stringify(base));
    for (const k of CHIP_KINDS) {
      const cfg = draftStyles[k];
      if (!cfg) continue;
      if (cfg.border === true || cfg.border === false) merged[k].border = cfg.border;
      if (cfg.bold_border === true || cfg.bold_border === false) merged[k].bold_border = cfg.bold_border;
      if (cfg.background === true || cfg.background === false) merged[k].background = cfg.background;
    }
    return merged;
  }

  private renderChipStylePreview(parent: HTMLElement, kind: ChipKind, style: ResolvedChipStyles[ChipKind]) {
    // Use a representative color and label per kind so the preview chip
    // looks like the real thing in views.
    const sample: Record<ChipKind, { color: string; text: string }> = {
      status:       { color: "#2196F3", text: t("cfg.preview.status") },
      priority:     { color: "#F44336", text: t("cfg.preview.priority") },
      task_type:    { color: "#8E24AA", text: t("cfg.preview.task_type") },
      tag:          { color: "#9C27B0", text: t("cfg.preview.tag") },
      context:      { color: "#4CAF50", text: t("cfg.preview.context") },
      custom_field: { color: "#FF9800", text: t("cfg.preview.custom_field") },
    };
    const s = sample[kind];
    const chip = parent.createSpan({ cls: "it-chip it-chip-style-preview", text: s.text });
    chip.style.setProperty("--chip-color", s.color);
    applyChipStyle(chip, style);
  }

  // 2-state segmented control: On / Off
  private renderTwoStateInto(
    parent: HTMLElement,
    current: boolean,
    onChange: (next: boolean) => void
  ) {
    const wrap = parent.createDiv({ cls: "it-tri-state" });
    const states: Array<{ v: boolean; label: string }> = [
      { v: true, label: t("cfg.on") },
      { v: false, label: t("cfg.off") },
    ];
    for (const s of states) {
      const isActive = current === s.v;
      const btn = wrap.createEl("button", {
        cls: "it-tri-state-btn" + (isActive ? " is-active" : ""),
        text: s.label,
        attr: { type: "button" },
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(s.v);
        this.onOpen();
      });
    }
  }

  // ===== Context labels =====

  private renderContextLabels(parent: HTMLElement) {
    this.renderSectionHead(parent, "context", t("cfg.context"),
      this.level === "workspace"
        ? t("cfg.contextDescWorkspace")
        : t("cfg.contextDescOverride", { level: cfgLevel(this.level) }));

    const inherited = this.resolveInheritedContextLabels();
    const hasOverride = this.isArrayFieldOverridden("context_labels");

    // For non-workspace levels: explicit override toggle.
    if (this.level !== "workspace") {
      new Setting(parent)
        .setName(t("cfg.overrideContextLabels"))
        .setDesc(hasOverride ? t("cfg.overrideContextOwn") : t("cfg.overrideContextInherit"))
        .addToggle((tog) =>
          tog.setValue(hasOverride).onChange((v) => {
            if (v && !hasOverride) {
              this.draft.context_labels = inherited.length ? inherited.map((l) => ({ ...l })) : [];
              this.cloneEmptyFor("context");
            } else if (!v && hasOverride) {
              this.draft.context_labels = null;
              this.clearEmptyFor("context");
            }
            this.onOpen();
          })
        );

      if (!hasOverride) {
        const preview = parent.createDiv({ cls: "it-cfg-preview" });
        preview.createDiv({ cls: "it-cfg-preview-label", text: t("cfg.inheritedContextPreview") });
        const list = preview.createDiv({ cls: "it-cfg-list" });
        for (const cl of inherited) {
          const row = list.createDiv({ cls: "it-cfg-row" });
          const sw = row.createSpan({ cls: "it-cfg-swatch" });
          sw.style.background = cl.color;
          row.createSpan({ text: cl.name });
        }
        return;
      }
    }

    const labels = (this.draft.context_labels ||= []) as ContextLabelDef[];
    if (this.level === "workspace" && labels.length === 0) {
      const empty = parent.createDiv({ cls: "it-empty-row" });
      empty.createSpan({ text: t("cfg.noLabelsFallback") });
      const seed = parent.createEl("button", { cls: "it-btn-secondary", text: t("cfg.seedPrivHomeBusiness") });
      seed.addEventListener("click", () => {
        this.draft.context_labels = DEFAULT_CONTEXT_LABELS.map((l) => ({ ...l }));
        this.onOpen();
      });
    }

    const ctxEmpty = this.emptyCtxFor("context");
    const ctxEmptyPos = Math.max(0, Math.min(labels.length, ctxEmpty.position));
    const renderCtxEmptyRow = () => renderEmptyRow(parent, t("cfg.emptyNoContext"), ctxEmptyPos, labels.length, ctxEmpty.onChange);

    for (let i = 0; i < labels.length; i++) {
      if (i === ctxEmptyPos) renderCtxEmptyRow();
      const cl = labels[i];
      const row = parent.createDiv({ cls: "it-cfg-row" });
      const moves = row.createDiv({ cls: "it-cfg-row-moves" });
      const up = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveUp"), type: "button" } });
      setIcon(up, "chevron-up");
      up.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (i === 0) return; [labels[i-1], labels[i]] = [labels[i], labels[i-1]]; this.onOpen(); });
      const down = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveDown"), type: "button" } });
      setIcon(down, "chevron-down");
      down.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (i === labels.length - 1) return; [labels[i+1], labels[i]] = [labels[i], labels[i+1]]; this.onOpen(); });
      const swatch = row.createSpan({ cls: "it-cfg-swatch" });
      swatch.style.background = cl.color;
      swatch.addEventListener("click", () => openColorPicker(swatch, cl.color, (c) => { cl.color = c; swatch.style.background = c; }));
      const oldName = cl.name;
      const nameInput = row.createEl("input", { cls: "it-input-inline" });
      nameInput.value = cl.name;
      nameInput.addEventListener("change", () => {
        const v = (nameInput.value || "").trim();
        if (!v) { nameInput.value = oldName; return; }
        cl.name = v;
        nameInput.value = v;
      });
      const remove = row.createEl("button", { cls: "it-btn-ghost", text: t("common.remove") });
      remove.addEventListener("click", () => {
        new ConfirmModal(this.app, {
          title: t("cfg.removeContextTitle", { name: cl.name }),
          message: t("cfg.removeContextMsg"),
          destructive: true,
          onConfirm: () => { labels.splice(i, 1); this.onOpen(); },
        }).open();
      });
    }
    if (ctxEmptyPos === labels.length) renderCtxEmptyRow();

    const addBar = parent.createDiv({ cls: "it-cfg-actions" });
    const addBtn = addBar.createEl("button", { cls: "it-btn-secondary", text: t("cfg.addLabel") });
    addBtn.addEventListener("click", () => {
      labels.push({ name: `LABEL-${labels.length + 1}`, color: PALETTE[labels.length % PALETTE.length] });
      this.onOpen();
    });
  }

  // ===== Save =====

  private async save() {
    try {
      validateCustomFields(this.draft.custom_fields);
      if (this.level === "workspace") {
        await this.plugin.index.updateWorkspaceConfig(this.draft);
      } else if (this.level === "space" && this.path) {
        await this.plugin.index.updateSpaceConfig(this.path, this.draft);
      } else if (this.level === "folder" && this.path) {
        await this.plugin.index.updateFolderConfig(this.path, this.draft);
      } else if (this.level === "list" && this.path) {
        await this.plugin.index.updateListConfig(this.path, this.draft);
      }
      await this.plugin.index.rescan();
      new Notice(t("cfg.settingsSaved"));
      this.close();
    } catch (e: any) {
      new Notice(t("cfg.saveFailed", { msg: e?.message ?? String(e) }));
    }
  }

  private renderCalendarSyncRules(parent: HTMLElement) {
    this.renderSectionHead(parent, "calendar_rules", t("cfg.calendarRules"),
      this.level === "workspace"
        ? t("cfg.calendarRulesDescWorkspace")
        : t("cfg.calendarRulesDescOverride"));

    this.renderCalendarStatusPolicySetting(parent);

    const inherited = this.resolveInheritedCalendarSyncRules();
    const showEditor = this.renderOverrideToggleFor(
      parent,
      cfgSectionLabel("calendarRules"),
      this.isArrayFieldOverridden("calendar_sync_rules"),
      () => { this.draft.calendar_sync_rules = inherited.length ? deepClone(inherited) : []; },
      () => { this.draft.calendar_sync_rules = null; },
      () => this.renderCalendarRulesPreview(parent, inherited)
    );
    if (!showEditor) return;

    const rules = (this.draft.calendar_sync_rules ||= []) as CalendarSyncRule[];
    const targets = this.calendarSyncTargets();
    const list = parent.createDiv({ cls: "it-cfg-calendar-rules" });
    if (!rules.length) {
      list.createDiv({ cls: "it-empty-row", text: t("cfg.calendarRulesEmpty") });
    }
    rules.forEach((rule, idx) => this.renderCalendarRuleRow(list, rules, idx, targets));

    const add = parent.createEl("button", { cls: "it-btn-secondary", text: t("cfg.addCalendarRule"), attr: { type: "button" } });
    add.addEventListener("click", () => {
      rules.push({
        id: `cal_rule_${Date.now().toString(36)}`,
        name: t("cfg.newCalendarRule"),
        targets: [],
      });
      this.onOpen();
    });
  }

  private renderCalendarRulesPreview(parent: HTMLElement, rules: CalendarSyncRule[]) {
    const preview = parent.createDiv({ cls: "it-cfg-preview" });
    preview.createDiv({ cls: "it-cfg-preview-label", text: t("cfg.inheritedCalendarRulesPreview") });
    if (!rules.length) {
      preview.createDiv({ cls: "it-empty-inline", text: t("cfg.calendarRulesEmpty") });
      return;
    }
    for (const rule of rules) {
      preview.createDiv({ cls: "it-chip it-chip-mini", text: `${rule.name || t("cfg.unnamedCalendarRule")} · ${rule.targets?.length || 0}` });
    }
  }

  private renderCalendarRuleRow(parent: HTMLElement, rules: CalendarSyncRule[], index: number, targets: CalendarSyncTarget[]) {
    const rule = rules[index];
    rule.targets ||= [];
    const wrap = parent.createDiv({ cls: "it-cfg-field" });
    const head = wrap.createDiv({ cls: "it-cfg-field-head" });

    const moves = head.createDiv({ cls: "it-cfg-row-moves" });
    const up = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveUp"), type: "button" } });
    setIcon(up, "chevron-up");
    up.disabled = index === 0;
    up.addEventListener("click", () => {
      if (index === 0) return;
      [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
      this.onOpen();
    });
    const down = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveDown"), type: "button" } });
    setIcon(down, "chevron-down");
    down.disabled = index === rules.length - 1;
    down.addEventListener("click", () => {
      if (index === rules.length - 1) return;
      [rules[index + 1], rules[index]] = [rules[index], rules[index + 1]];
      this.onOpen();
    });

    const name = head.createEl("input", { cls: "it-input-inline", placeholder: t("cfg.calendarRuleName") });
    name.value = rule.name || "";
    name.addEventListener("change", () => { rule.name = name.value.trim() || t("cfg.unnamedCalendarRule"); });

    const filterBtn = head.createEl("button", { cls: "it-btn-secondary", text: rule.filter ? t("cfg.editFilter") : t("cfg.addFilter"), attr: { type: "button" } });
    filterBtn.addEventListener("click", () => {
      new FilterModal(this.app, {
        current: rule.filter,
        fields: this.buildCalendarRuleFilterFields(),
        onApply: (group) => {
          rule.filter = group;
          this.onOpen();
        },
      }).open();
    });

    const remove = head.createEl("button", { cls: "it-icon-btn it-icon-btn-mini it-danger", attr: { "aria-label": t("common.remove"), type: "button" } });
    setIcon(remove, "trash");
    remove.addEventListener("click", () => {
      confirmConfigRemove(this.app, `${t("common.remove")}: ${rule.name || t("cfg.unnamedCalendarRule")}`, () => {
        rules.splice(index, 1);
        this.onOpen();
      });
    });

    const body = wrap.createDiv({ cls: "it-cfg-field-body" });
    body.createDiv({ cls: "setting-item-description", text: t("cfg.calendarRuleTargetsDesc") });
    if (!targets.length) {
      body.createDiv({ cls: "it-empty-row", text: t("cfg.calendarRuleNoTargets") });
      return;
    }
    const targetWrap = body.createDiv({ cls: "it-filter-multi" });
    for (const target of targets) {
      const active = rule.targets.some((candidate) => this.sameCalendarTarget(candidate, target));
      const chip = targetWrap.createEl("button", {
        cls: "it-chip it-chip-tag" + (active ? " is-active" : ""),
        text: target.label || this.calendarTargetLabel(target),
        attr: {
          type: "button",
          title: this.calendarTargetTitle(target),
          "aria-label": this.calendarTargetTitle(target),
        },
      });
      chip.style.setProperty("--chip-color", this.calendarTargetColor(target.kind));
      chip.addEventListener("click", () => {
        const at = rule.targets.findIndex((candidate) => this.sameCalendarTarget(candidate, target));
        if (at >= 0) rule.targets.splice(at, 1);
        else rule.targets.push({ ...target });
        this.onOpen();
      });
    }
  }

  private resolveInheritedCalendarSyncRules(): CalendarSyncRule[] {
    if (this.level === "workspace") return Array.isArray(this.draft.calendar_sync_rules) ? this.draft.calendar_sync_rules : [];
    const loc = this.parentLocForCurrentLevel();
    return loc ? this.plugin.index.resolveCalendarSyncRulesForLocation(loc) : [];
  }

  private parentLocForCurrentLevel(): import("../types").ContextLocation | undefined {
    if (this.level === "space") return { kind: "everything" };
    if (this.level === "folder" && this.path) {
      const f = this.plugin.index.findFolder(this.path);
      return f?.spacePath ? { kind: "space", path: f.spacePath } : { kind: "everything" };
    }
    if (this.level === "list" && this.path) {
      const l = this.plugin.index.findList(this.path);
      if (l?.folderPath) return { kind: "folder", path: l.folderPath };
      if (l?.spacePath) return { kind: "space", path: l.spacePath };
      return { kind: "everything" };
    }
    return undefined;
  }

  private calendarSyncTargets(): CalendarSyncTarget[] {
    const prefs = this.plugin.settings.calendarSync;
    const out: CalendarSyncTarget[] = [];
    if (prefs?.generateIcs) out.push({ kind: "ics", label: t("cfg.calendarTargetIcs") });
    if (prefs?.caldav?.enabled) {
      const path = prefs.caldav.calendarPath || "";
      out.push({ kind: "caldav", calendarId: path, label: path ? `CalDAV · ${path}` : "CalDAV · default" });
    }
    return out;
  }

  private sameCalendarTarget(a: CalendarSyncTarget, b: CalendarSyncTarget): boolean {
    return a.kind === b.kind && (a.calendarId || "") === (b.calendarId || "");
  }

  private calendarTargetLabel(target: CalendarSyncTarget): string {
    if (target.kind === "ics") return t("cfg.calendarTargetIcs");
    return `${target.kind} · ${target.calendarId || "default"}`;
  }

  private calendarTargetTitle(target: CalendarSyncTarget): string {
    const label = target.label || this.calendarTargetLabel(target);
    if (target.kind === "ics") return label;
    return `${label}${target.calendarId ? ` · ID: ${target.calendarId}` : ""}`;
  }

  private calendarTargetColor(kind: CalendarSyncTargetKind): string {
    if (kind === "caldav") return "#10B981";
    return "#64748B";
  }

  private buildCalendarRuleFilterFields(): FilterFieldDef[] {
    const loc = this.currentLoc();
    const features = this.plugin.index.resolveFeaturesForLocation(loc);
    const statuses = loc.kind === "list" ? this.plugin.index.resolveStatusSet(loc.path).statuses : this.plugin.index.resolveStatusSet().statuses;
    const priorities = this.plugin.index.resolvePrioritiesForLocation(loc);
    const taskTypes = this.plugin.index.resolveTaskTypesForLocation(loc);
    const tags = this.plugin.index.resolveTagsPaletteForLocation(loc);
    const contexts = this.plugin.index.resolveContextLabelsForLocation(loc);
    const customFields = this.plugin.index.resolveCustomFieldsForLocation(loc);
    const out: FilterFieldDef[] = [
      { key: "title", label: this.fieldLabelAt("title"), type: "text" },
      { key: "status", label: this.fieldLabelAt("status"), type: "dropdown", options: statuses.map((s) => ({ value: s.id, label: s.name, color: s.color })) },
      { key: "type", label: this.fieldLabelAt("type"), type: "dropdown", options: taskTypes.map((tt) => ({ value: tt.id, label: tt.name || tt.id, color: tt.color })) },
      ...(features.due_dates !== false ? [{ key: "due_date", label: this.fieldLabelAt("due_date"), type: "date" } as FilterFieldDef] : []),
      ...(features.start_dates !== false ? [{ key: "start_date", label: this.fieldLabelAt("start_date"), type: "date" } as FilterFieldDef] : []),
      { key: "created_at", label: this.fieldLabelAt("created_at"), type: "date" },
      { key: "updated_at", label: this.fieldLabelAt("updated_at"), type: "date" },
    ];
    if (features.priorities !== false) out.splice(2, 0, { key: "priority", label: this.fieldLabelAt("priority"), type: "dropdown", options: priorities.map((p) => ({ value: p.id, label: p.label, color: p.color })) });
    if (features.tags !== false) out.push({ key: "tags", label: this.fieldLabelAt("tags"), type: "multi", options: tags.map((tag) => ({ value: tag.name, label: tag.name, color: tag.color })) });
    if (features.context !== false) out.push({ key: "context", label: this.fieldLabelAt("context"), type: "multi", options: contexts.map((c) => ({ value: c.name, label: c.name, color: c.color })) });
    if (features.time_estimate !== false) out.push({ key: "time_estimate", label: `${this.fieldLabelAt("time_estimate")} (min)`, type: "number" });
    if (features.time_tracking !== false) out.push({ key: "time_tracked", label: `${this.fieldLabelAt("time_tracked")} (min)`, type: "number" });
    if (features.sprint_points !== false) out.push({ key: "sprint_points", label: this.fieldLabelAt("sprint_points"), type: "number" });
    for (const cf of customFields) {
      const ft = cfFilterType(cf.type);
      if (!ft) continue;
      const def: FilterFieldDef = { key: `custom_field:${cf.id}`, label: cf.name, type: ft };
      if (ft === "dropdown" || ft === "multi") def.options = (cf.options || []).map((o) => ({ value: o.value ?? o.label, label: o.label, color: o.color }));
      out.push(def);
    }
    for (const def of out) {
      const meta = fieldIconMeta(def.key, customFields as any);
      def.icon = meta.icon;
      def.color = meta.color;
    }
    return out;
  }
}

// ============= Helpers =============

// Renders a draggable "Empty" placeholder row, positioned at `pos` among real
// items. Used in palette editors so the user can choose where the "no value"
// bucket appears when grouping.
function renderEmptyRow(
  parent: HTMLElement,
  label: string,
  pos: number,
  max: number,
  onMove: (newPos: number) => void
) {
  const row = parent.createDiv({ cls: "it-cfg-row it-cfg-empty-row" });
  const moves = row.createDiv({ cls: "it-cfg-row-moves" });
  const up = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveUp"), type: "button" } });
  setIcon(up, "chevron-up");
  up.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (pos > 0) onMove(pos - 1); });
  const down = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveDown"), type: "button" } });
  setIcon(down, "chevron-down");
  down.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (pos < max) onMove(pos + 1); });
  const dot = row.createSpan({ cls: "it-cfg-swatch it-cfg-swatch-empty" });
  dot.title = t("cfg.emptyBucketTitle");
  row.createSpan({ cls: "it-cfg-empty-label", text: label });
}

function deepClone<T>(x: T): T {
  return x === undefined || x === null ? x : (JSON.parse(JSON.stringify(x)) as T);
}

function cfFilterType(type: string): FilterFieldType | null {
  switch (type) {
    case "text": case "textarea": case "url": case "email": case "phone": case "location":
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


function renderStatusList(
  app: App,
  wrap: HTMLElement,
  statuses: StatusDef[],
  rerender: () => void,
  emptyCtx?: { position: number; onChange: (pos: number) => void }
) {
  // sort by order then by index
  statuses.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const list = wrap.createDiv({ cls: "it-cfg-status-list" });

  const total = statuses.length;
  const emptyPos = emptyCtx ? Math.max(0, Math.min(total, emptyCtx.position)) : -1;
  const renderEmpty = () => {
    if (emptyCtx) renderEmptyRow(list, t("cfg.emptyNoStatus"), emptyPos, total, emptyCtx.onChange);
  };

  for (let i = 0; i < statuses.length; i++) {
    if (i === emptyPos) renderEmpty();
    const s = statuses[i];
    const row = list.createDiv({ cls: "it-cfg-status-row" });

    // Move up/down
    const moves = row.createDiv({ cls: "it-cfg-row-moves" });
    const up = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveUp") } });
    setIcon(up, "chevron-up");
    up.addEventListener("click", () => {
      if (i === 0) return;
      [statuses[i - 1], statuses[i]] = [statuses[i], statuses[i - 1]];
      statuses.forEach((x, idx) => (x.order = idx));
      rerender();
    });
    const down = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveDown") } });
    setIcon(down, "chevron-down");
    down.addEventListener("click", () => {
      if (i === statuses.length - 1) return;
      [statuses[i + 1], statuses[i]] = [statuses[i], statuses[i + 1]];
      statuses.forEach((x, idx) => (x.order = idx));
      rerender();
    });

    // Color
    const swatch = row.createSpan({ cls: "it-cfg-swatch" });
    swatch.style.background = s.color;
    swatch.addEventListener("click", () => openColorPicker(swatch, s.color, (c) => { s.color = c; swatch.style.background = c; }));

    // Name
    const nameInput = row.createEl("input", { cls: "it-input-inline" });
    nameInput.value = s.name;
    nameInput.addEventListener("change", () => {
      s.name = nameInput.value || s.name;
      const slug = slugify(s.name);
      if (!s.id || s.id === "" || /^new(_status)?(_\d+)?$/.test(s.id)) s.id = slug;
    });

    // ID (hidden under name as inline-mini)
    const idInput = row.createEl("input", { cls: "it-input-inline it-input-inline-mini", placeholder: t("cfg.placeholderId") });
    idInput.value = s.id;
    idInput.title = t("cfg.statusIdTitle");
    idInput.addEventListener("change", () => (s.id = slugify(idInput.value) || s.id));

    // Group select
    const groupSel = row.createEl("select", { cls: "it-input-inline" });
    for (const g of ["not_started","active","done","closed"] as StatusGroup[]) {
      const opt = groupSel.createEl("option", { value: g, text: statusGroupLabel(g) });
      if (s.group === g) opt.selected = true;
    }
    groupSel.addEventListener("change", () => (s.group = groupSel.value as StatusGroup));

    // Default toggle
    const def = row.createEl("button", { cls: "it-chip it-chip-mini" + (s.is_default ? " is-active" : ""), text: s.is_default ? t("cfg.default") : t("cfg.setDefault") });
    def.addEventListener("click", () => {
      statuses.forEach((x) => (x.is_default = false));
      s.is_default = true;
      rerender();
    });

    // Remove
    const rm = row.createEl("button", { cls: "it-icon-btn it-icon-btn-mini it-danger", attr: { "aria-label": t("cfg.removeStatus") } });
    setIcon(rm, "trash");
    rm.addEventListener("click", () => {
      confirmConfigRemove(app, `${t("common.remove")}: ${s.name}`, () => {
        statuses.splice(i, 1);
        rerender();
      });
    });
  }

  // Trailing empty row when its position is at the end
  if (emptyPos === total) renderEmpty();

  const addBar = wrap.createDiv({ cls: "it-cfg-actions" });
  const add = addBar.createEl("button", { cls: "it-btn-secondary", text: t("cfg.addStatus") });
  add.addEventListener("click", () => {
    const order = statuses.reduce((m, x) => Math.max(m, x.order ?? 0), -1) + 1;
    statuses.push({ id: `new_${order}`, name: t("cfg.newStatus"), group: "active", color: STATUS_GROUP_COLORS.active, order });
    rerender();
  });
}

function renderPriorityList(
  app: App,
  parent: HTMLElement,
  priorities: PriorityDef[],
  rerender: () => void,
  emptyCtx?: { position: number; onChange: (pos: number) => void }
) {
  const list = parent.createDiv({ cls: "it-cfg-list" });
  const total = priorities.length;
  const emptyPos = emptyCtx ? Math.max(0, Math.min(total, emptyCtx.position)) : -1;
  const renderEmpty = () => {
    if (emptyCtx) renderEmptyRow(list, t("cfg.emptyNoPriority"), emptyPos, total, emptyCtx.onChange);
  };
  for (let i = 0; i < priorities.length; i++) {
    if (i === emptyPos) renderEmpty();
    const p = priorities[i];
    const row = list.createDiv({ cls: "it-cfg-row" });

    const moves = row.createDiv({ cls: "it-cfg-row-moves" });
    const up = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveUp") } });
    setIcon(up, "chevron-up");
    up.addEventListener("click", () => {
      if (i === 0) return;
      [priorities[i-1], priorities[i]] = [priorities[i], priorities[i-1]];
      rerender();
    });
    const down = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveDown") } });
    setIcon(down, "chevron-down");
    down.addEventListener("click", () => {
      if (i === priorities.length - 1) return;
      [priorities[i+1], priorities[i]] = [priorities[i], priorities[i+1]];
      rerender();
    });

    const sw = row.createSpan({ cls: "it-cfg-swatch" });
    sw.style.background = p.color;
    sw.addEventListener("click", () => openColorPicker(sw, p.color, (c) => { p.color = c; sw.style.background = c; }));

    const idInput = row.createEl("input", { cls: "it-input-inline it-input-inline-mini", placeholder: t("cfg.placeholderId") });
    idInput.type = "number";
    idInput.value = String(p.id);
    idInput.title = t("cfg.numericIdTitle");
    idInput.addEventListener("change", () => {
      const n = parseInt(idInput.value, 10);
      if (!isNaN(n)) p.id = n as any;
    });

    const labelInput = row.createEl("input", { cls: "it-input-inline" });
    labelInput.value = p.label;
    labelInput.addEventListener("change", () => { p.label = labelInput.value || p.label; });

    const rm = row.createEl("button", { cls: "it-icon-btn it-icon-btn-mini it-danger", attr: { "aria-label": t("common.remove") } });
    setIcon(rm, "trash");
    rm.addEventListener("click", () => {
      if (priorities.length <= 1) return;
      confirmConfigRemove(app, `${t("common.remove")}: ${p.label}`, () => {
        priorities.splice(i, 1);
        rerender();
      });
    });
  }
  if (emptyPos === total) renderEmpty();

  const addBar = parent.createDiv({ cls: "it-cfg-actions" });
  const add = addBar.createEl("button", { cls: "it-btn-secondary", text: t("cfg.addPriority") });
  add.addEventListener("click", () => {
    const maxId = priorities.reduce((m, x) => Math.max(m, Number(x.id)), 0);
    priorities.push({ id: (maxId + 1) as any, label: t("cfg.newPriority"), color: PALETTE[(priorities.length) % PALETTE.length], icon: "flag" });
    rerender();
  });
}

function validateCustomFields(raw: any): void {
  if (!Array.isArray(raw)) return;
  const ids = new Set<string>();
  for (const field of raw as CustomFieldDef[]) {
    if (!field.id) throw new Error(t("cfg.err.fieldNoId", { name: field.name || t("cfg.err.unnamed") }));
    if (ids.has(field.id)) throw new Error(t("cfg.err.duplicateFieldId", { id: field.id }));
    ids.add(field.id);
    if (field.type !== "dropdown" && field.type !== "labels") continue;
    const values = new Set<string>();
    for (const option of field.options || []) {
      const value = option.value ?? option.label;
      if (!option.label || !value) throw new Error(t("cfg.err.emptyOption", { name: field.name }));
      if (values.has(value)) throw new Error(t("cfg.err.duplicateOption", { value, name: field.name }));
      values.add(value);
    }
  }
}

function renderFieldEditor(app: App, parent: HTMLElement, fields: CustomFieldDef[], index: number, rerender: () => void, isNew: boolean) {
  const f = fields[index];
  const wrap = parent.createDiv({ cls: "it-cfg-field" });

  const head = wrap.createDiv({ cls: "it-cfg-field-head" });

  const moves = head.createDiv({ cls: "it-cfg-row-moves" });
  const up = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveUp") } });
  setIcon(up, "chevron-up");
  up.addEventListener("click", () => {
    if (index === 0) return;
    [fields[index - 1], fields[index]] = [fields[index], fields[index - 1]];
    rerender();
  });
  const down = moves.createEl("button", { cls: "it-icon-btn it-icon-btn-mini", attr: { "aria-label": t("cfg.moveDown") } });
  setIcon(down, "chevron-down");
  down.addEventListener("click", () => {
    if (index === fields.length - 1) return;
    [fields[index + 1], fields[index]] = [fields[index], fields[index + 1]];
    rerender();
  });

  const nameInput = head.createEl("input", { cls: "it-input-inline", placeholder: t("cfg.fieldName") });
  nameInput.value = f.name;
  nameInput.addEventListener("change", () => {
    f.name = nameInput.value || f.name;
  });

  const idInput = head.createEl("input", { cls: "it-input-inline it-input-inline-mini", placeholder: t("cfg.placeholderId") });
  idInput.value = f.id;
  idInput.readOnly = true;
  idInput.title = t("cfg.fieldIdTitle");

  const typeBtn = head.createEl("button", {
    cls: "it-input-inline it-cf-type-trigger",
    attr: { type: "button", title: isNew ? t("cfg.chooseFieldType") : t("cfg.typeLocked") },
  });
  renderCfTypeIcon(typeBtn, f.type);
  typeBtn.createSpan({ cls: "it-cf-type-trigger-label", text: customFieldTypeMeta(f.type).label });
  if (isNew) setIcon(typeBtn.createSpan({ cls: "it-cf-type-trigger-caret" }), "chevron-down");
  typeBtn.disabled = !isNew;
  if (isNew) {
    typeBtn.addEventListener("click", () => {
      showPopover(typeBtn, (root) => {
        buildDropdown({
          parent: root,
          current: f.type,
          items: CF_TYPES.map((type) => ({
            value: type, label: customFieldTypeLabel(type),
            icon: CUSTOM_FIELD_TYPE_META[type].icon, color: CUSTOM_FIELD_TYPE_META[type].color,
          })),
          onSelect: (v) => {
            f.type = v as CustomFieldType;
            document.querySelectorAll(".it-popover").forEach((el) => el.remove());
            rerender();
          },
        });
      });
    });
  }

  const requiredBtn = head.createEl("button", { cls: "it-chip it-chip-mini" + (f.required ? " is-active" : ""), text: f.required ? t("cfg.required") : t("cfg.optional") });
  requiredBtn.addEventListener("click", () => { f.required = !f.required; rerender(); });

  const remove = head.createEl("button", { cls: "it-icon-btn it-icon-btn-mini it-danger", attr: { "aria-label": t("cfg.removeField") } });
  setIcon(remove, "trash");
  remove.addEventListener("click", () => {
    confirmConfigRemove(app, `${t("common.remove")}: ${f.name || f.id}`, () => {
      fields.splice(index, 1);
      rerender();
    });
  });

  // Type specific config
  const body = wrap.createDiv({ cls: "it-cfg-field-body" });
  renderFieldTypeConfig(app, body, f, rerender);
}

function renderFieldTypeConfig(app: App, parent: HTMLElement, f: CustomFieldDef, rerender: () => void) {
  switch (f.type) {
    case "money": {
      new Setting(parent).setName(t("cfg.currency")).addText((el) => el.setValue(f.currency || "PLN").onChange((v) => (f.currency = v.toUpperCase().slice(0, 4))));
      break;
    }
    case "rating": {
      new Setting(parent).setName(t("cfg.scale")).addText((el) => el.setValue(String(f.scale || 5)).onChange((v) => (f.scale = parseInt(v, 10) || 5)));
      new Setting(parent).setName(t("cfg.ratingIcon")).setDesc(t("cfg.ratingIconDesc")).addText((el) => el.setValue(f.icon || "⭐").onChange((v) => (f.icon = v || "⭐")));
      break;
    }
    case "progress_auto": {
      new Setting(parent).setName(t("cfg.progressSource"))
        .setDesc(t("cfg.progressSourceDesc"))
        .addDropdown((d) =>
          d
            .addOption("subtasks", t("cfg.progressSubtasks"))
            .addOption("checklist", t("cfg.progressChecklist"))
            .setValue(f.progress_source || "subtasks")
            .onChange((v) => (f.progress_source = v as "subtasks" | "checklist"))
        );
      break;
    }
    case "dropdown":
    case "labels": {
      parent.createEl("h4", { text: t("cfg.options") });
      const opts = (f.options ||= []) as CustomFieldOption[];
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i];
        // Older configs may omit `value`, in which case task files store the
        // label itself. Materialize that fallback before the label can change.
        if (!o.value) o.value = o.label;
        const row = parent.createDiv({ cls: "it-cfg-row" });
        const sw = row.createSpan({ cls: "it-cfg-swatch" });
        sw.style.background = o.color || "#9E9E9E";
        sw.addEventListener("click", () => openColorPicker(sw, o.color || "#9E9E9E", (c) => { o.color = c; sw.style.background = c; }));
        const labelInput = row.createEl("input", { cls: "it-input-inline", placeholder: t("cfg.optionLabel") });
        labelInput.value = o.label;
        labelInput.addEventListener("change", () => { o.label = labelInput.value || o.label; });
        const valInput = row.createEl("input", { cls: "it-input-inline it-input-inline-mini", placeholder: t("cfg.optionValue") });
        valInput.value = o.value || "";
        valInput.readOnly = true;
        valInput.title = t("cfg.optionValueTitle");
        const rm = row.createEl("button", { cls: "it-btn-ghost", text: t("common.remove") });
        rm.addEventListener("click", () => {
          confirmConfigRemove(app, `${t("common.remove")}: ${o.label || o.value}`, () => { opts.splice(i, 1); rerender(); });
        });
      }
      const add = parent.createEl("button", { cls: "it-btn-secondary", text: t("cfg.addOption") });
      add.addEventListener("click", () => {
        let n = opts.length + 1;
        while (opts.some((option) => (option.value ?? option.label) === `option_${n}`)) n++;
        opts.push({ value: `option_${n}`, label: `Option ${n}`, color: PALETTE[opts.length % PALETTE.length] });
        rerender();
      });
      break;
    }
    case "relationship": {
      new Setting(parent).setName(t("cfg.description")).addText((el) => el.setValue(f.description || "").onChange((v) => (f.description = v)));
      parent.createEl("p", { cls: "setting-item-description", text: t("cfg.relationshipDesc") });
      break;
    }
    case "doc_relationship": {
      new Setting(parent).setName(t("cfg.description")).addText((el) => el.setValue(f.description || "").onChange((v) => (f.description = v)));
      parent.createEl("p", { cls: "setting-item-description", text: t("cfg.docRelationshipDesc") });
      break;
    }
    case "attachment": {
      new Setting(parent).setName(t("cfg.description")).addText((el) => el.setValue(f.description || "").onChange((v) => (f.description = v)));
      parent.createEl("p", { cls: "setting-item-description", text: t("cfg.attachmentDesc") });
      break;
    }
    default:
      new Setting(parent).setName(t("cfg.description")).addText((el) => el.setValue(f.description || "").onChange((v) => (f.description = v)));
  }
}
