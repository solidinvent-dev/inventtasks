import { parseYaml, stringifyYaml } from "obsidian";
import { TaskData, WorkspaceConfig, SpaceConfig, FolderConfig, ListConfig, ViewConfig, DocMeta, DocPage, ConfigurableSet, CalendarSyncRule } from "../types";
import { t } from "../i18n";
import { isSecretFieldsConfig } from "./secret-fields";

// ---------- Frontmatter helpers ----------

const FRONTMATTER_REGEX = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;
const CALENDAR_SYNC_STATUS_POLICIES = new Set(["sync_all", "exclude_done_closed", "exclude_closed"]);

// Google Calendar and Outlook targets were removed; rules saved before that
// keep their CalDAV / ICS targets and silently lose the rest.
export function withoutRemovedCalendarTargets(rules: CalendarSyncRule[]): CalendarSyncRule[] {
  return rules.map((rule) =>
    rule && Array.isArray(rule.targets)
      ? { ...rule, targets: rule.targets.filter((tg) => tg?.kind === "caldav" || tg?.kind === "ics") }
      : rule
  );
}

/** Parsed YAML frontmatter: keys and values are whatever the file holds. */
export type Frontmatter = Record<string, unknown>;

export interface ParsedFile {
  fm: Frontmatter;
  body: string;
  hadFrontmatter: boolean;
  yamlError?: string;
}

export function splitFrontmatter(raw: string): ParsedFile {
  const match = raw.match(FRONTMATTER_REGEX);
  if (!match) {
    return { fm: {}, body: raw, hadFrontmatter: false };
  }
  let fm: Frontmatter = {};
  let yamlError: string | undefined;
  try {
    fm = normalizeYamlDates(parseYaml(match[1]) ?? {}) as Frontmatter;
  } catch (err) {
    fm = {};
    yamlError = (err as Error | undefined)?.message || String(err);
  }
  const body = raw.slice(match[0].length);
  return { fm, body, hadFrontmatter: true, yamlError };
}

/**
 * parseYaml implementations differ on unquoted YAML timestamps
 * (`due_date: 2026-06-05`): Obsidian returns plain strings, but stock js-yaml
 * (default schema) resolves them into JS Date objects. The plugin's data
 * model is strings-only — a Date leaking through reads as "empty" in the date
 * editors and gets silently wiped on the next save. Normalizing here, at the
 * single frontmatter choke point, makes every caller immune to the parser's
 * dialect. Mutates in place (fresh parse output) and returns the value.
 */
export function normalizeYamlDates(value: unknown): unknown {
  if (value instanceof Date) return yamlDateToString(value);
  if (Array.isArray(value)) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) arr[i] = normalizeYamlDates(arr[i]);
    return arr;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) obj[k] = normalizeYamlDates(obj[k]);
    return obj;
  }
  return value;
}

/** YAML timestamps parse as UTC; date-only values land on UTC midnight —
 *  render those back as the plain date the file actually contained. */
function yamlDateToString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) return ymd;
  return `${ymd} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function joinFrontmatter(fm: object, body: string): string {
  const cleaned = pruneEmpty(fm);
  const yaml = stringifyYaml(cleaned).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, "")}`;
}

function pruneEmpty(obj: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    const arr = (obj as unknown[])
      .map(pruneEmpty)
      .filter((v) => v !== undefined && v !== null && !(typeof v === "string" && v === ""));
    return arr.length ? arr : undefined;
  }
  if (typeof obj === "object") {
    const src = obj as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let kept = 0;
    for (const k of Object.keys(src)) {
      if (k === "calendar_sync_rules" && Array.isArray(src[k])) {
        out[k] = src[k];
        kept++;
        continue;
      }
      const v = pruneEmpty(src[k]);
      if (v !== undefined) {
        out[k] = v;
        kept++;
      }
    }
    return kept ? out : undefined;
  }
  return obj;
}

// ---------- Specific parsers ----------

// Frontmatter keys this plugin owns. Everything else in an Item file was put
// there by the user or another plugin — Obsidian's own `aliases` and
// `cssclasses`, Dataview properties, whatever — and it has to survive a
// round-trip. The parser used to build `data` from this list alone, so any
// other key was dropped the moment the plugin rewrote the file for an
// unrelated edit, quietly deleting data it never owned.
const OWNED_TASK_KEYS = new Set([
  "activity",
  "additional_lists",
  "archived",
  "attachments",
  "checklist",
  "color",
  "comments",
  "context",
  "cover_image",
  "created_at",
  "custom_fields",
  "custom_id",
  "documents",
  "due_date",
  "folder",
  "icon",
  "id",
  "list",
  "parent_task",
  "priority",
  "recurring",
  "relationships",
  "space",
  "sprint_points",
  "start_date",
  "status",
  "status_group",
  "tags",
  "time_estimate",
  "time_tracked",
  "title",
  "type",
  "updated_at",
]);

/** Key under which foreign frontmatter rides along. Enumerable on purpose: the
 *  update paths patch tasks with object spreads, so it has to survive those. It
 *  is unpacked again in `serializeTask` and never written under this name. */
export const FOREIGN_FM_KEY = "__foreign_fm";

/** Frontmatter read as the shape it is expected to have. A cast, not a check:
 *  values reach the model exactly as the YAML holds them, as they always have. */
type Loose<T> = Partial<T> & Frontmatter;

export function parseTaskFile(raw: string): { data: TaskData; body: string } {
  const parsed = splitFrontmatter(raw);
  const fm = parsed.fm as Loose<TaskData>;
  const body = parsed.body;
  const data: TaskData = {
    id: fm.id ?? "",
    title: fm.title ?? "",
    type: fm.type ?? "task",
    custom_id: fm.custom_id,
    space: fm.space,
    folder: fm.folder,
    list: fm.list,
    parent_task: fm.parent_task ?? null,
    additional_lists: Array.isArray(fm.additional_lists) ? fm.additional_lists : undefined,
    status: fm.status,
    status_group: fm.status_group,
    priority: fm.priority ?? null,
    start_date: fm.start_date ?? null,
    due_date: fm.due_date ?? null,
    created_at: fm.created_at,
    updated_at: fm.updated_at,
    time_estimate: fm.time_estimate,
    time_tracked: fm.time_tracked,
    sprint_points: fm.sprint_points,
    tags: Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [],
    context: Array.isArray(fm.context) ? fm.context : fm.context ? [fm.context] : [],
    custom_fields: fm.custom_fields,
    relationships: fm.relationships,
    documents: Array.isArray(fm.documents) ? fm.documents : undefined,
    attachments: Array.isArray(fm.attachments) ? fm.attachments : undefined,
    checklist: Array.isArray(fm.checklist) ? fm.checklist : undefined,
    activity: Array.isArray(fm.activity) ? fm.activity : undefined,
    comments: Array.isArray(fm.comments) ? fm.comments : undefined,
    color: fm.color,
    icon: fm.icon,
    cover_image: fm.cover_image,
    recurring: fm.recurring,
    archived: fm.archived === true ? true : undefined,
  };
  const foreign: Record<string, unknown> = {};
  for (const key of Object.keys(fm)) if (!OWNED_TASK_KEYS.has(key)) foreign[key] = fm[key];
  if (Object.keys(foreign).length) (data as TaskData & Frontmatter)[FOREIGN_FM_KEY] = foreign;
  return { data, body };
}

export function serializeTask(data: TaskData, body: string): string {
  const { [FOREIGN_FM_KEY]: foreign, ...owned } = data as TaskData & { [FOREIGN_FM_KEY]?: Frontmatter };
  // Owned keys first so the plugin's canonical layout stays stable, foreign
  // ones appended after. They cannot collide: only non-owned keys are captured.
  const fm: Frontmatter = { ...owned, ...(foreign ?? {}) };
  // Empty arrays/strings get pruned by joinFrontmatter
  return joinFrontmatter(fm, body || `\n# ${data.title || t("fallback.untitledTask")}\n`);
}

// Shared parser for the configurable set fields, used at every level.
function parseConfigurableSet(raw: Frontmatter) {
  const fm = raw as Loose<ConfigurableSet>;
  return {
    status_set: fm.status_set,
    priorities: fm.priorities,
    task_types: fm.task_types,
    tags_palette: fm.tags_palette,
    context_labels: fm.context_labels,
    custom_fields: fm.custom_fields,
    view_defaults: fm.view_defaults,
    features: fm.features,
    empty_positions: fm.empty_positions,
    chip_styles: fm.chip_styles,
    task_behavior: fm.task_behavior,
    field_labels: fm.field_labels && typeof fm.field_labels === "object" ? fm.field_labels : undefined,
    notifications_enabled: typeof fm.notifications_enabled === "boolean" ? fm.notifications_enabled : undefined,
    notify_system: typeof fm.notify_system === "boolean" ? fm.notify_system : undefined,
    notify_ntfy: typeof fm.notify_ntfy === "boolean" ? fm.notify_ntfy : undefined,
    calendar_sync: typeof fm.calendar_sync === "boolean" ? fm.calendar_sync : undefined,
    calendar_sync_status_policy: CALENDAR_SYNC_STATUS_POLICIES.has(fm.calendar_sync_status_policy as string) ? fm.calendar_sync_status_policy : undefined,
    calendar_sync_rules: Array.isArray(fm.calendar_sync_rules) ? withoutRemovedCalendarTargets(fm.calendar_sync_rules) : undefined,
  };
}

export function parseWorkspaceConfig(raw: string): { config: WorkspaceConfig; body: string } {
  const parsed = splitFrontmatter(raw);
  const fm = parsed.fm as Loose<WorkspaceConfig>;
  const body = parsed.body;
  const set = parseConfigurableSet(fm);
  return {
    config: {
      workspace_id: fm.workspace_id ?? "WSP-0001",
      name: fm.name ?? t("fallback.myWorkspace"),
      icon: fm.icon,
      color: fm.color,
      date_format: fm.date_format ?? "YYYY-MM-DD",
      time_format: fm.time_format ?? "HH:mm",
      week_start: fm.week_start ?? "monday",
      default_currency: fm.default_currency ?? "PLN",
      // Workspace is the source — fields always present (with sensible fallbacks).
      status_set: set.status_set ?? [],
      priorities: set.priorities ?? [],
      task_types: set.task_types ?? [],
      tags_palette: set.tags_palette ?? [],
      context_labels: set.context_labels ?? [],
      custom_fields: set.custom_fields ?? [],
      view_defaults: set.view_defaults ?? {},
      features: set.features ?? {},
      empty_positions: set.empty_positions ?? {},
      chip_styles: set.chip_styles ?? {},
      task_behavior: set.task_behavior ?? {},
      field_labels: set.field_labels ?? {},
      notifications_enabled: set.notifications_enabled ?? true,
      notify_system: set.notify_system ?? true,
      notify_ntfy: set.notify_ntfy ?? true,
      calendar_sync: set.calendar_sync ?? true,
      calendar_sync_status_policy: set.calendar_sync_status_policy ?? "exclude_done_closed",
      calendar_sync_rules: set.calendar_sync_rules,
      sidebar_order: fm.sidebar_order,
      favorites: Array.isArray(fm.favorites) ? fm.favorites : undefined,
      favorites_bar: Array.isArray(fm.favorites_bar) ? fm.favorites_bar : undefined,
      favorites_right: Array.isArray(fm.favorites_right) ? fm.favorites_right : undefined,
      active_color: typeof fm.active_color === "string" ? fm.active_color : undefined,
      active_text_color: typeof fm.active_text_color === "string" ? fm.active_text_color : undefined,
      secret_fields: isSecretFieldsConfig(fm.secret_fields) ? fm.secret_fields : undefined,
    },
    body,
  };
}

export function parseSpaceConfig(raw: string): { config: SpaceConfig; body: string } {
  const parsed = splitFrontmatter(raw);
  const fm = parsed.fm as Loose<SpaceConfig>;
  const body = parsed.body;
  return {
    config: {
      space_id: fm.space_id ?? "",
      name: fm.name ?? t("fallback.untitledSpace"),
      icon: fm.icon,
      color: fm.color,
      hidden: fm.hidden === true,
      custom_id_prefix: fm.custom_id_prefix,
      default_view: fm.default_view,
      ...parseConfigurableSet(fm),
    },
    body,
  };
}

export function parseFolderConfig(raw: string): { config: FolderConfig; body: string } {
  const parsed = splitFrontmatter(raw);
  const fm = parsed.fm as Loose<FolderConfig>;
  const body = parsed.body;
  return {
    config: {
      folder_id: fm.folder_id ?? "",
      name: fm.name ?? t("fallback.untitledFolder"),
      icon: fm.icon,
      color: fm.color,
      default_view: fm.default_view,
      ...parseConfigurableSet(fm),
    },
    body,
  };
}

export function parseListConfig(raw: string): { config: ListConfig; body: string } {
  const parsed = splitFrontmatter(raw);
  const fm = parsed.fm as Loose<ListConfig>;
  const body = parsed.body;
  return {
    config: {
      list_id: fm.list_id ?? "",
      name: fm.name ?? t("fallback.untitledList"),
      icon: fm.icon,
      color: fm.color,
      description: fm.description,
      default_view: fm.default_view,
      default_task_type: fm.default_task_type,
      hidden: fm.hidden === true,
      system_kind: fm.system_kind === "reminders" || fm.system_kind === "short_notes" ? fm.system_kind : undefined,
      ...parseConfigurableSet(fm),
    },
    body,
  };
}

export function parseDocMeta(raw: string): { meta: DocMeta; body: string } {
  const parsed = splitFrontmatter(raw);
  const fm = parsed.fm as Loose<DocMeta>;
  const body = parsed.body;
  return {
    meta: {
      doc_id: fm.doc_id ?? "",
      name: fm.name ?? t("fallback.untitledDoc"),
      icon: fm.icon,
      color: fm.color,
      location: fm.location,
      order: typeof fm.order === "number" ? fm.order : undefined,
      default: fm.default,
      created_at: fm.created_at,
      updated_at: fm.updated_at,
    },
    body,
  };
}

export function parseDocPage(raw: string): { page: DocPage; body: string } {
  const parsed = splitFrontmatter(raw);
  const fm = parsed.fm as Loose<DocPage>;
  const body = parsed.body;
  return {
    page: {
      page_id: fm.page_id ?? "",
      doc_id: fm.doc_id ?? "",
      parent_page: fm.parent_page ?? null,
      title: fm.title ?? t("common.untitled"),
      icon: fm.icon,
      color: fm.color,
      order: typeof fm.order === "number" ? fm.order : undefined,
      created_at: fm.created_at,
      updated_at: fm.updated_at,
    },
    body,
  };
}

export function parseViewConfig(raw: string): { config: ViewConfig; body: string } {
  const parsed = splitFrontmatter(raw);
  const fm = parsed.fm as Loose<ViewConfig>;
  const body = parsed.body;
  return {
    config: {
      view_id: fm.view_id ?? "",
      name: fm.name ?? "Unnamed view",
      type: fm.type ?? "list",
      location: fm.location,
      pinned: fm.pinned,
      default: fm.default,
      order: typeof fm.order === "number" ? fm.order : undefined,
      description: fm.description,
      group_by: fm.group_by,
      sub_group_by: fm.sub_group_by,
      sort_by: fm.sort_by,
      filters: fm.filters,
      visible_fields: fm.visible_fields,
      column_calcs: fm.column_calcs,
      table_col_widths: fm.table_col_widths,
      layout_options: fm.layout_options,
      collapsed_groups: fm.collapsed_groups,
      board_columns_field: fm.board_columns_field,
      board_collapsed_groups: fm.board_collapsed_groups,
      calendar_date_field: fm.calendar_date_field,
      calendar_color_by: fm.calendar_color_by,
      calendar_default_period: fm.calendar_default_period,
      // Chip/field display toggles (were silently dropped on load before).
      cf_show_name: fm.cf_show_name,
      cf_show_when_empty: fm.cf_show_when_empty,
      cf_show_type_icon: fm.cf_show_type_icon,
      gantt_time_period: fm.gantt_time_period,
      gantt_show_dependencies: fm.gantt_show_dependencies,
      gantt_show_critical_path: fm.gantt_show_critical_path,
      gantt_show_progress: fm.gantt_show_progress,
      gantt_rail_width: fm.gantt_rail_width,
      gantt_date_field: fm.gantt_date_field,
      gantt_start_field: fm.gantt_start_field,
      timeline_date_field: fm.timeline_date_field,
      timeline_start_field: fm.timeline_start_field,
      timeline_group_by: fm.timeline_group_by,
      timeline_zoom: fm.timeline_zoom,
      timeline_color_by: fm.timeline_color_by,
      timeline_rail_width: fm.timeline_rail_width,
      timeline_show_unscheduled: typeof fm.timeline_show_unscheduled === "boolean" ? fm.timeline_show_unscheduled : undefined,
    },
    body,
  };
}
