// ---------- Core type definitions ----------

export type StatusGroup = "not_started" | "active" | "done" | "closed";

export interface StatusDef {
  id: string;
  name: string;
  group: StatusGroup;
  color: string;
  order: number;
  is_default?: boolean;
  clear_dependencies?: boolean;
}

export type PriorityId = 1 | 2 | 3 | 4;

export interface PriorityDef {
  id: PriorityId;
  label: string;
  color: string;
  icon?: string;
}

export interface TagDef {
  name: string;
  color: string;
  description?: string;
}

export interface ContextLabelDef {
  name: string;
  color: string;
  description?: string;
}

// Active set of custom field types. Anything not on this list is unsupported.
// Dropped previously: time stayed, files/location/formula/rollup/verify/voting
// were never implemented (dead). `tasks` was a duplicate of `relationship`.
export type CustomFieldType =
  | "text"
  | "textarea"
  | "markdown"
  | "secret_text"
  | "secret_textarea"
  | "secret_markdown"
  | "number"
  | "money"
  | "date"
  | "datetime"
  | "time"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "location"
  | "dropdown"
  | "labels"
  | "rating"
  | "progress_manual"
  | "progress_auto"
  | "relationship"
  | "doc_relationship"
  | "attachment";

export interface CustomFieldOption {
  value?: string;
  label: string;
  color?: string;
}

export interface CustomFieldDef {
  id: string;
  name: string;
  type: CustomFieldType;
  options?: CustomFieldOption[];
  // `money`: 3-letter ISO code (defaults to workspace default_currency)
  currency?: string;
  required?: boolean;
  description?: string;
  // `rating`: glyph + scale length
  icon?: string;
  scale?: number;
  // `progress_auto`: how to derive the % live (no manual input)
  //   "subtasks" → ratio of subtasks in done/closed group
  //   "checklist" → ratio of checked items
  progress_source?: "subtasks" | "checklist";
}

/** Workspace-wide password metadata. The password/key is never persisted;
 * this stores only the KDF parameters and an authenticated verifier. */
export interface SecretFieldsConfig {
  version: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  verifier: SecretFieldValue;
}

/** Encrypted value stored under task.data.custom_fields[fieldId]. */
export interface SecretFieldValue {
  __inventtasks_secret: 1;
  version: 1;
  algorithm: "AES-256-GCM";
  iv: string;
  ciphertext: string;
}

// Storage shape for `url` / `email` / `phone` custom fields. The label is
// optional — when absent the raw value is shown as the link text.
export interface LinkedValue {
  label?: string;
  value: string;
}

// Storage shape for `location` custom fields. All fields are optional but at
// least one of label / url / lat+lng should be provided.
//   label — human-readable address shown as the link text
//   url   — direct map link (Google Maps, OSM, etc.)
//   lat   — latitude (decimal degrees)
//   lng   — longitude (decimal degrees)
export interface LocationValue {
  label?: string;
  url?: string;
  lat?: number;
  lng?: number;
}

export interface TaskType {
  id: string;
  name: string;
  plural?: string;
  icon?: string;
  color?: string;
  default_fields?: string[];
}

// ---------- Chip (label) styling ----------
// Per-element styling that controls how colored labels render in views and
// modals: a colored border, a heavier (bold) colored border, and a tinted
// background. Each property is tri-state per level: true=on, false=off,
// undefined=inherit from parent.

export type ChipStyleSetting = boolean | undefined;

export type ChipKind =
  | "status"
  | "priority"
  | "task_type"
  | "tag"
  | "context"
  | "custom_field";

export interface ChipStyleConfig {
  border?: ChipStyleSetting;
  bold_border?: ChipStyleSetting;
  background?: ChipStyleSetting;
}

export type ChipStyles = Partial<Record<ChipKind, ChipStyleConfig>>;

// Fully resolved (no undefined) — what views consume to actually paint chips.
export interface ResolvedChipStyle {
  border: boolean;
  bold_border: boolean;
  background: boolean;
}
export type ResolvedChipStyles = Record<ChipKind, ResolvedChipStyle>;

// Task-level behavior preferences (not view-specific). Each field is
// inherited through the WS→Space→Folder→List chain; first explicit value
// wins. `undefined` at every level → resolver returns its own fallback.
export interface TaskBehavior {
  // When the user ticks a checkbox next to a SUBTASK in the task modal,
  // which status group to flip to. Independent of the list-row checkbox
  // setting (which lives in view_defaults.list.checkbox_action).
  subtasks_checkbox_action?: "done" | "closed";
}

export type CalendarSyncTargetKind = "caldav" | "ics";
export type CalendarSyncStatusPolicy = "sync_all" | "exclude_done_closed" | "exclude_closed";

export interface CalendarSyncTarget {
  kind: CalendarSyncTargetKind;
  // CalDAV calendar path, or empty for local ICS.
  calendarId?: string;
  label?: string;
}

export interface CalendarSyncRule {
  id: string;
  name: string;
  filter?: FilterGroup;
  targets: CalendarSyncTarget[];
}

// Uniform configurable elements. Every level (Workspace/Space/Folder/List)
// can define any of them. Workspace is the source — it has all of them set
// at creation. Each lower level: `undefined` = inherit, defined = override.
export interface ConfigurableSet {
  status_set?: StatusDef[];
  priorities?: PriorityDef[];
  task_types?: TaskType[];
  tags_palette?: TagDef[];
  context_labels?: ContextLabelDef[];
  custom_fields?: CustomFieldDef[];
  view_defaults?: PerViewDefaults;
  features?: Record<string, boolean>;
  empty_positions?: Record<string, number>;
  chip_styles?: ChipStyles;
  task_behavior?: TaskBehavior;
  // Custom DISPLAY names for built-in fields, keyed by field key
  // (e.g. "status", "due_date"). Purely cosmetic — the markdown property /
  // storage key is unchanged; only the label shown in the UI (dialogs, views,
  // menus, filters) is overridden. Per-key merge across WS→Space→Folder→List
  // (narrower wins); a missing key inherits, an empty string is ignored.
  field_labels?: Record<string, string>;
  // Whether tasks under this scope participate in the Notifications inbox.
  // Workspace is the default source; lower levels use undefined = inherit.
  notifications_enabled?: boolean;
  // Per-scope toggles for the EXTERNAL notification channels (separate
  // from the in-app inbox above). undefined = inherit from parent; default on.
  // These gate whether the external scheduler may deliver a task's overdue /
  // reminder / started / digest notifications via each channel.
  notify_system?: boolean;
  notify_ntfy?: boolean;
  // Whether tasks under this scope are exported to external calendars
  // (CalDAV / ICS). undefined = inherit from parent; default on.
  calendar_sync?: boolean;
  // Which status groups are eligible for calendar export. This uses status_group
  // ("done" / "closed"), not status names or ids. undefined = inherit.
  calendar_sync_status_policy?: CalendarSyncStatusPolicy;
  // Optional routing rules for calendar sync. undefined = inherit from parent;
  // [] = explicit override with no rules. Each matching rule can send the task
  // to one or more calendar targets.
  calendar_sync_rules?: CalendarSyncRule[];
}

// Persisted sidebar ordering — stored in _workspace.md
export interface SidebarOrder {
  // Persisted values use stable refs (`id:space:*`, `id:folder:*`,
  // `id:list:*`, `id:doc:*`) rather than device-specific vault paths.
  // WorkspaceIndex exposes runtime paths to the renderer for compatibility.
  spaces?: string[];
  // parent ref → ordered child refs (folders + lists + docs mixed).
  children?: Record<string, string[]>;
}

// The three independent favorites surfaces. "left" = the legacy sidebar bucket.
export type FavLocation = "left" | "bar" | "right";

export interface WorkspaceConfig extends ConfigurableSet {
  workspace_id: string;
  name: string;
  icon?: string;
  color?: string;
  date_format: string;
  time_format: string;
  week_start: "monday" | "sunday";
  default_currency: string;
  // At workspace level these are always defined (resolver source of truth).
  priorities: PriorityDef[];
  status_set: StatusDef[];
  task_types: TaskType[];
  tags_palette: TagDef[];
  context_labels: ContextLabelDef[];
  custom_fields: CustomFieldDef[];
  view_defaults: PerViewDefaults;
  features: Record<string, boolean>;
  empty_positions: Record<string, number>;
  // Always defined at workspace — the source of truth for chip styling.
  chip_styles: ChipStyles;
  // Persisted sidebar ordering
  sidebar_order?: SidebarOrder;
  // Favorites are split into THREE independent, separately-ordered buckets —
  // one per surface. An item lives in whichever bucket(s) the
  // user filed it under; moving between surfaces relocates it.
  //   favorites        → left sidebar
  //   favorites_bar    → bottom bar of the main window
  //   favorites_right  → right-sidebar panel
  favorites?: string[];
  favorites_bar?: string[];
  favorites_right?: string[];
  // Accent color used for the active row in the sidebar/explorer.
  // Optional — falls back to the built-in lavender/purple pair.
  active_color?: string;
  // Text color for the active row. Encoded as one of:
  //   undefined  → use the accent color itself (default — current behaviour)
  //   "inherit"  → use the same color as inactive rows
  //   "node"     → use the row's own color (list/folder/space dot color)
  //   "#xxx"     → use this specific hex color
  // Only takes effect when `active_color` is also set.
  active_text_color?: string;
  // One password per workspace. Contains no password and no reusable key.
  secret_fields?: SecretFieldsConfig;
}

export interface ViewDefaults {
  visible_fields?: string[];
  // Calendar-specific: identifies the data source whose color tints the
  // calendar pill background. One of: "status", "priority", "context", "type",
  // or "custom_field:<id>". `undefined` = inherit from parent scope; `"default"`
  // means explicit fallback chain (task.color → priority → status).
  color_by?: string;
  // Date sources for the date-driven views. Same inheritance semantics as
  // `color_by` (`undefined` at a level = inherit from parent).
  //   date_field       → calendar pill placement / gantt+timeline bar END.
  //   start_date_field → gantt+timeline bar START (unused by calendar).
  // Values: "due_date" | "start_date" | "created_at" | "updated_at" |
  // "custom_field:<id>" (date/datetime custom fields).
  date_field?: string;
  start_date_field?: string;
  // Custom-field display toggles. Used by board + calendar (where each CF
  // is rendered as a chip). `undefined` = inherit; explicit boolean = override.
  //   cf_show_name      → prepend "<Field name>: " to the chip
  //   cf_show_when_empty → render the chip even when the task has no value
  cf_show_name?: boolean;
  cf_show_when_empty?: boolean;
  // Field-type icons (List/Table column headers + Board/Calendar field chips).
  // `undefined` = inherit; explicit boolean = override. Default true.
  cf_show_type_icon?: boolean;
  // Timeline-specific: show the "Unscheduled" tray below the chart.
  // `undefined` = inherit; explicit boolean = override. Default true.
  show_unscheduled?: boolean;
  // List-specific: when the user clicks the row checkbox, which status
  // group to switch to. Defaults to "done" (with "closed" as fallback if
  // no done-group status exists, and vice versa). Same shape for the
  // subtask checkboxes in the task modal, so both stay consistent.
  checkbox_action?: "done" | "closed";
}

export type PerViewDefaults = Partial<Record<ViewType, ViewDefaults>>;

export interface SpaceConfig extends ConfigurableSet {
  space_id: string;
  name: string;
  icon?: string;
  color?: string;
  hidden?: boolean;
  custom_id_prefix?: string;
  // "list" | "board" | "calendar" | "table" | "last_selected".
  // When "last_selected", the view-state persistence layer restores whatever
  // view the user last used at this location. Unset = inherit current view.
  default_view?: string;
}

export interface FolderConfig extends ConfigurableSet {
  folder_id: string;
  name: string;
  icon?: string;
  color?: string;
  // Same semantics as SpaceConfig.default_view above.
  default_view?: string;
}

export interface ListConfig extends ConfigurableSet {
  list_id: string;
  name: string;
  icon?: string;
  color?: string;
  description?: string;
  default_view?: string;
  default_task_type?: string;
  hidden?: boolean;
  system_kind?: "reminders" | "short_notes";
}

// ---------- Task ----------

// Single-source storage shape. `waiting_on` is NOT stored — it is derived
// from inverse `blocks` at read time (see src/data/relationships.ts).
export interface TaskRelationships {
  blocks?: string[];
  related?: string[];
}

// Stored on a task and inside `custom_fields[<id>]` when the field is of
// type "attachment". `path` is RELATIVE to the per-task attachment folder
// (see src/data/attachments.ts for the resolver). Keeping paths relative
// means the absolute storage location can be changed in one place without
// rewriting frontmatter.
export interface TaskAttachment {
  name: string;     // user-visible filename, with collision suffix if needed
  path: string;     // relative to _attachments/<task_id>/
  size?: number;    // bytes
  mime?: string;
  uploaded?: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

// Auto-generated event entries for a task. Stored as a JSON array in the
// task's frontmatter under `activity`. Append-only from the plugin's POV
// (older entries get dropped past the cap configured in settings).
export type ActivityKind =
  | "created"
  | "archived" | "unarchived"
  | "merged"
  | "status" | "priority" | "due_date" | "start_date" | "title" | "tags" | "custom_field"
  | "list_added" | "list_removed"
  | "parent_added" | "parent_removed"
  | "subtask_added" | "subtask_removed"
  | "blocks_added" | "blocks_removed"
  | "waiting_added" | "waiting_removed"
  | "related_added" | "related_removed"
  | "checklist_added" | "checklist_checked" | "checklist_unchecked"
  | "checklist_text_changed" | "checklist_removed"
  | "comment_added" | "comment_edited" | "comment_removed"
  | "attachment_added" | "attachment_removed" | "attachment_renamed"
  | "recurring_enabled" | "recurring_disabled" | "recurring_rescheduled";

export interface ActivityEntry {
  ts: string;
  kind: ActivityKind;
  // Per-kind optional payload — kept loose to survive YAML round-trips.
  from?: string | number | null;
  to?: string | number | null;
  id?: string;         // partner task id, checklist item id, comment id, etc.
  text?: string;       // checklist text snapshot, etc.
}

// Manually authored, timestamped comment. Markdown body, stored as JSON
// array in the task's frontmatter. Unlike activity entries these are
// editable and reorderable by the user.
export interface CommentEntry {
  id: string;
  text: string;
  created_at: string;
  updated_at?: string;
}

// Recurring task config — reschedule-only model. Closing a task with this
// config bumps `due_date` forward to the next occurrence and resets the
// status to the list's default. The task stays a single file across all
// occurrences; calendar projects future ones virtually.
export interface RecurringConfig {
  enabled: boolean;
  pattern: "daily" | "weekly" | "monthly" | "yearly";
  // Step size in pattern units. daily/every=2 → every 2 days; weekly/every=3
  // → every 3 weeks; etc. Default 1 if absent.
  every?: number;
  // Weekly only: which days of the week the task repeats on. Lower-case
  // names: "mon","tue","wed","thu","fri","sat","sun". If absent for weekly,
  // uses the weekday of the current due_date.
  on?: string[];
  // Monthly only: which day of the month (1-31). If absent for monthly,
  // uses the day-of-month of the current due_date.
  day_of_month?: number;
  // End condition for projection / auto-reschedule. "after_n_occurrences"
  // counts total occurrences from the original task creation.
  end?: {
    type: "never" | "date" | "after_n_occurrences";
    date?: string;
    count?: number;
  };
  // Internal counter — how many times the task has been auto-rescheduled
  // (= occurrences past). Used to honor `end.count`.
  occurrences_passed?: number;
}

export interface TaskData {
  id: string;
  custom_id?: string;
  type?: string;
  title: string;

  space?: string;
  folder?: string;
  list?: string;
  parent_task?: string | string[] | null;
  // Multiple Lists (ClickApp): list folder paths this task is ALSO shown in,
  // beyond its home list (= the folder the file physically lives in). Status
  // and custom fields always come from the home list. Paths, consistent with
  // how locations / favorites are stored.
  additional_lists?: string[];

  status?: string;
  status_group?: StatusGroup;
  priority?: PriorityId | null;

  start_date?: string | null;
  due_date?: string | null;
  created_at?: string;
  updated_at?: string;

  time_estimate?: number;
  time_tracked?: number;
  sprint_points?: number;

  tags?: string[];
  context?: string[];
  custom_fields?: Record<string, any>;
  relationships?: TaskRelationships;
  documents?: string[];   // linked Doc ids (built-in "Documents" field)
  attachments?: TaskAttachment[];
  checklist?: ChecklistItem[];
  activity?: ActivityEntry[];
  comments?: CommentEntry[];

  color?: string;
  icon?: string;
  cover_image?: string;

  recurring?: RecurringConfig;
  archived?: boolean;
}

export interface TaskFile {
  data: TaskData;
  body: string;
  // Internal — file location:
  filePath: string;
  spacePath?: string;
  folderPath?: string;
  listPath?: string;
}

// ---------- View configs ----------

export type ViewType = "list" | "table" | "board" | "calendar" | "gantt" | "timeline";

// Horizontal zoom shared by the time-based views (Gantt + Timeline). Drives the
// pixels-per-day of the axis and the header tick granularity. (Gantt's spec also
// lists "flexible"; v1 maps it onto these discrete steps.)
export type TimeZoom = "day" | "week" | "month" | "quarter" | "year";

export type FilterLogic = "AND" | "OR";

export interface FilterCondition {
  field: string;
  operator: string;
  value: any;
  unit?: string;
}

export interface FilterGroup {
  logic: FilterLogic;
  conditions: Array<FilterCondition | FilterGroup>;
}

export interface SortRule {
  field: string;
  direction: "asc" | "desc";
}

// ---- Column calculations (List / Table footer + per-group summaries) ----
// A per-column aggregation shown under each group (when grouping is on) and at
// the very bottom over all rows. Configured per-location, shared by List/Table.
export type CalcType =
  | "count"          // number of rows
  | "count_filled"   // rows with a non-empty value
  | "count_empty"    // rows with an empty value
  | "count_unique"   // distinct non-empty values
  | "sum"            // numeric sum
  | "avg"            // numeric average
  | "min"            // numeric min / earliest date
  | "max"            // numeric max / latest date
  | "range"          // numeric max − min
  | "checked"        // count of checked (true) booleans
  | "checked_percent"// percent checked of all rows
  | "regex_count"    // rows whose text matches a regex
  | "equals_count";  // rows whose text equals a value

export interface ColumnCalc {
  type: CalcType;
  // regex_count: the pattern; equals_count: the value to match.
  pattern?: string;
  match?: string;
  // Optional multiplier applied to numeric aggregates (sum/avg/min/max/range).
  // e.g. 0.23 → "23%" of the aggregate.
  factor?: number;
}

export interface ViewConfig {
  view_id: string;
  name: string;
  type: ViewType;
  location?: string;
  pinned?: boolean;        // deprecated (Pin removed from the Views bar UI)
  default?: boolean;
  order?: number;          // manual left→right position in the Views bar
  description?: string;

  group_by?: { field: string; direction?: "asc" | "desc" };
  sub_group_by?: { field: string; direction?: "asc" | "desc" };
  sort_by?: SortRule[];
  filters?: FilterGroup;

  visible_fields?: string[];

  // Column calculations for this view's footer / per-group summaries, keyed by
  // field key. A saved view carries its own (independent of other views and of
  // the per-location transient state). Only meaningful for List/Table.
  column_calcs?: Record<string, ColumnCalc>;

  // Table column widths (px) by column key. Column order lives in
  // `visible_fields`; this captures the resize state. Table only.
  table_col_widths?: Record<string, number>;

  layout_options?: {
    show_subtask_count?: boolean;
    show_relationships?: boolean;
    card_size?: "small" | "medium" | "large";
    density?: "compact" | "normal" | "comfortable";
    show_closed?: boolean;
    subtask_mode?: "parents" | "nested" | "flat";
  };

  // type specific
  // Collapsed group keys for List/Table saved views. Keys include the grouping
  // axis, so changing Group by cannot collapse an unrelated bucket.
  collapsed_groups?: string[];
  board_columns_field?: string;
  board_collapsed_groups?: string[];

  calendar_date_field?: string;
  calendar_color_by?: string;
  // "monthCompact" is the fit-to-width month overview (Overview tab).
  calendar_default_period?: "day" | "week" | "month" | "monthCompact";

  // Board/Calendar chip display toggles (mirror of view_defaults; stored on the
  // saved view so applying it restores them).
  cf_show_name?: boolean;
  cf_show_when_empty?: boolean;
  // Field-type icons toggle (List/Table headers + Board/Calendar chips).
  cf_show_type_icon?: boolean;

  gantt_time_period?: "day" | "week" | "month" | "quarter" | "year" | "flexible";
  gantt_show_dependencies?: boolean;
  gantt_show_critical_path?: boolean;
  gantt_show_progress?: boolean;
  gantt_rail_width?: number;
  // Bar END / START date sources — same vocabulary as calendar_date_field
  // ("due_date" | "start_date" | "created_at" | "updated_at" | "custom_field:<id>").
  gantt_date_field?: string;
  gantt_start_field?: string;

  timeline_date_field?: string;
  timeline_start_field?: string;
  timeline_group_by?: string;
  timeline_zoom?: "day" | "week" | "month" | "quarter" | "year";
  timeline_rail_width?: number;
  // Show the "Unscheduled" tray below the timeline. Default true.
  timeline_show_unscheduled?: boolean;
  // Bar tint source for Timeline — same vocabulary as calendar_color_by
  // ("status" | "priority" | "context" | "type" | "custom_field:<id>" | "default").
  timeline_color_by?: string;

  // Internal — source file path, set at scan time so the view can be deleted.
  // Not persisted to frontmatter (stripped before write).
  __path?: string;
}

// ---------- Index node types ----------

export interface SpaceNode {
  config: SpaceConfig;
  configPath: string;
  path: string;
  folders: FolderNode[];
  lists: ListNode[];
}

export interface FolderNode {
  config: FolderConfig;
  configPath: string;
  path: string;
  spacePath: string;
  lists: ListNode[];
}

export interface ListNode {
  config: ListConfig;
  configPath: string;
  path: string;
  spacePath: string;
  folderPath?: string;
  taskFiles: TaskFile[];
}

export type ContextLocation =
  | { kind: "everything" }
  | { kind: "archived" }
  | { kind: "notifications" }
  | { kind: "reminders" }
  | { kind: "short_notes" }
  | { kind: "favorites" }
  | { kind: "today" }
  | { kind: "recents" }
  | { kind: "space"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "list"; path: string }
  | { kind: "doc"; path: string };   // path = doc container file (__path)

export interface ResolvedStatusSet {
  statuses: StatusDef[];
  source: "list" | "folder" | "space" | "default";
}

// ---------- Docs ----------
// Docs: a Doc is a container (attached to a Space/Folder/List)
// holding a tree of markdown pages. Stored under the location's `_docs/` dir:
// the container is `doc-*.md`, pages are `page-*.md` linked by `parent_page`
// (mirrors how tasks use `parent_task`).

export interface DocMeta {
  doc_id: string;
  name: string;
  icon?: string;
  color?: string;
  location?: string;       // locationKey of the owning Space/Folder/List
  order?: number;          // manual position among Views-bar chips at its location
  default?: boolean;       // opens on entry (mutually exclusive with a default view)
  created_at?: string;
  updated_at?: string;
  __path?: string;         // source container file (internal, never persisted)
}

export interface DocPage {
  page_id: string;
  doc_id: string;
  parent_page?: string | null;  // page-tree parent (null/absent = top level)
  title: string;
  icon?: string;
  color?: string;
  order?: number;          // sibling ordering
  created_at?: string;
  updated_at?: string;
  __path?: string;         // source file (internal)
  __body?: string;         // page markdown content (loaded on scan)
}

// ---------- Helpers ----------

// parent_task is stored as `string` for single-parent (the common case, and
// backwards-compatible with existing files) or `string[]` when a task has
// multiple parents. Callers should always normalize via this helper.
export function parentTaskIds(data: Pick<TaskData, "parent_task">): string[] {
  const v = data.parent_task;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && !!x);
  if (typeof v === "string" && v) return [v];
  return [];
}

// Convert an ids array back to the storage shape used in frontmatter:
// null when empty, string when exactly one, array when many. Keeps the
// YAML compact and stable for single-parent tasks.
export function normalizeParentTask(ids: string[]): string | string[] | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];
  return ids;
}
