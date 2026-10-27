import { ChipKind, ChipStyles, ContextLabelDef, CustomFieldType, PriorityDef, ResolvedChipStyle, ResolvedChipStyles, StatusDef, TaskType, ViewType } from "./types";
import { customFieldTypeLabel } from "./i18n";
import {
  DEFAULT_PRIORITIES as SHARED_DEFAULT_PRIORITIES,
  DEFAULT_STATUS_SET as SHARED_DEFAULT_STATUS_SET,
  DEFAULT_TASK_TYPES as SHARED_DEFAULT_TASK_TYPES,
} from "../shared/config-defaults";

// ---------- Custom-field type metadata (icon + color + label) ----------
// One source of truth so every place a field's TYPE/value/label appears renders
// the same colored icon. Icons are Lucide names (bundled set);
// colors are mid-tone so they read on both light and dark themes.
export interface CustomFieldTypeMeta { label: string; icon: string; color: string; }
export const CUSTOM_FIELD_TYPE_META: Record<CustomFieldType, CustomFieldTypeMeta> = {
  text:            { label: "Text",                 icon: "type",               color: "#607D8B" },
  textarea:        { label: "Long text",            icon: "align-left",         color: "#546E7A" },
  markdown:        { label: "Markdown note",        icon: "file-text",          color: "#455A64" },
  secret_text:     { label: "Secret text",          icon: "lock-keyhole",       color: "#7B1FA2" },
  secret_textarea: { label: "Secret long text",     icon: "file-lock",          color: "#6A1B9A" },
  secret_markdown: { label: "Secret Markdown note", icon: "file-lock",          color: "#512DA8" },
  number:          { label: "Number",               icon: "hash",               color: "#1E88E5" },
  money:           { label: "Money",                icon: "circle-dollar-sign", color: "#2E9E5B" },
  date:            { label: "Date",                 icon: "calendar",           color: "#E53935" },
  datetime:        { label: "Date & time",          icon: "calendar-clock",     color: "#D81B60" },
  time:            { label: "Time of day",          icon: "clock",              color: "#FB8C00" },
  checkbox:        { label: "Checkbox",             icon: "square-check",       color: "#43A047" },
  url:             { label: "URL",                  icon: "external-link",      color: "#3949AB" },
  email:           { label: "Email",                icon: "mail",               color: "#00897B" },
  phone:           { label: "Phone",                icon: "phone",              color: "#00ACC1" },
  location:        { label: "Location",             icon: "map-pin",            color: "#C2185B" },
  dropdown:        { label: "Dropdown",             icon: "list",               color: "#8E24AA" },
  labels:          { label: "Labels",               icon: "tags",               color: "#6D4C9E" },
  rating:          { label: "Rating",               icon: "star",               color: "#FFB300" },
  progress_manual: { label: "Progress (manual)",    icon: "sliders",            color: "#5E35B1" },
  progress_auto:   { label: "Progress (auto)",      icon: "loader-circle",      color: "#7E57C2" },
  relationship:    { label: "Relationship",         icon: "network",            color: "#00838F" },
  doc_relationship:{ label: "Doc link",             icon: "book-open",          color: "#10B981" },
  attachment:      { label: "Attachment",           icon: "paperclip",          color: "#6D4C41" },
};
export function customFieldTypeMeta(type: string | undefined): CustomFieldTypeMeta {
  const base = (type && (CUSTOM_FIELD_TYPE_META as Partial<Record<string, CustomFieldTypeMeta>>)[type]) || { label: type || "Field", icon: "circle", color: "#9E9E9E" };
  return { ...base, label: customFieldTypeLabel(type) || base.label };
}

// Icon + color for BUILT-IN field keys, so every field (not only custom ones)
// shows a consistent colored icon next to its label.
export const FIELD_META: Record<string, { icon: string; color: string }> = {
  title:               { icon: "type",          color: "#607D8B" },
  status:              { icon: "circle-dot",     color: "#2196F3" },
  priority:            { icon: "flag",           color: "#F44336" },
  due_date:            { icon: "calendar",       color: "#E53935" },
  start_date:          { icon: "calendar-days",  color: "#FB8C00" },
  created_at:          { icon: "calendar-plus",  color: "#9E9E9E" },
  updated_at:          { icon: "history",        color: "#9E9E9E" },
  tags:                { icon: "tags",           color: "#9C27B0" },
  context:             { icon: "bookmark",       color: "#00897B" },
  type:                { icon: "shapes",         color: "#607D8B" },
  type_icon:           { icon: "shapes",         color: "#607D8B" },
  list:                { icon: "list",           color: "#2196F3" },
  folder:              { icon: "folder",         color: "#6647F0" },
  space:               { icon: "layout-grid",    color: "#FF5722" },
  time_estimate:       { icon: "hourglass",      color: "#FF9800" },
  time_tracked:        { icon: "timer",          color: "#FB8C00" },
  sprint_points:       { icon: "signal",         color: "#FFB300" },
  custom_id:           { icon: "hash",           color: "#607D8B" },
  id:                  { icon: "hash",           color: "#9E9E9E" },
  subtask_count:       { icon: "list-tree",      color: "#607D8B" },
  relationship_count:  { icon: "network",        color: "#00838F" },
  documents:           { icon: "book-open",      color: "#10B981" },
  checkbox:            { icon: "square-check",    color: "#43A047" },
  cover:               { icon: "image",          color: "#607D8B" },
  description_preview: { icon: "align-left",      color: "#607D8B" },
};

// Resolve the icon+color for ANY field key (built-in or "custom_field:<id>").
export function fieldIconMeta(key: string, customFields?: { id: string; type: string }[]): { icon: string; color: string } {
  if (key.startsWith("custom_field:")) {
    const cf = customFields?.find((c) => c.id === key.slice("custom_field:".length));
    const m = customFieldTypeMeta(cf?.type);
    return { icon: m.icon, color: m.color };
  }
  return FIELD_META[key] || { icon: "circle", color: "#9E9E9E" };
}

// ---------- Product ----------

/** Public website — downloads, license purchase, documentation. */
export const WEBSITE_URL = "https://inventtasks.solidinvent.pl";

// ---------- File markers ----------

export const WORKSPACE_FILE = "_workspace.md";
export { WORKSPACE_STATE_FILE } from "../shared/protocol";
export const SPACE_FILE = "_space.md";
export const FOLDER_FILE = "_folder.md";
export const LIST_FILE = "_list.md";
// Non-dot on purpose: Obsidian's vault API ignores dot-prefixed files/folders
// (getAbstractFileByPath returns null, they're absent from folder.children),
// so a ".views" dir can't be created/read/scanned reliably. "_views" matches
// the existing "_workspace.md" / "_trash" convention and works with the API.
export const VIEWS_DIR = "_views";

// Docs live alongside views in a per-location dir (same non-dot rationale as
// VIEWS_DIR above). A Doc accent color + icons keep the chips/tree consistent
// with the rest of the app's colored-icon system.
export const DOCS_DIR = "_docs";
export const DOC_ACCENT = "#10B981";   // emerald — distinct from the view-type palette
export const DOC_ICON = "book-open";
export const DOC_PAGE_ICON = "file-text";

export const VIEW_TYPE_INVENTTASKS = "inventtasks-main";
export const VIEW_TYPE_INVENTTASKS_SIDEBAR = "inventtasks-sidebar";
// Favorites panel docked in Obsidian's right sidebar (alongside Backlinks/Tags).
export const VIEW_TYPE_INVENTTASKS_FAVORITES = "inventtasks-favorites";

// ---------- Default workspace config ----------

// Single source shared with the External API server (shared/config-defaults.ts)
// so plugin views and API labels/validation resolve identical built-ins.
export const DEFAULT_PRIORITIES: PriorityDef[] = SHARED_DEFAULT_PRIORITIES;

export const DEFAULT_CONTEXT_LABELS: ContextLabelDef[] = [
  { name: "PRIV", color: "#9C27B0" },
  { name: "HOME", color: "#4CAF50" },
  { name: "BUSINESS", color: "#2196F3" },
];

export const DEFAULT_TASK_TYPES: TaskType[] = SHARED_DEFAULT_TASK_TYPES;

// ---------- Default status templates ----------

export const STATUS_TEMPLATES: Record<string, StatusDef[]> = {
  // kanban is the shared built-in default (shared/config-defaults.ts) — the
  // API server seeds/validates with the same set.
  kanban: SHARED_DEFAULT_STATUS_SET,
  scrum: [
    { id: "backlog", name: "Backlog", group: "not_started", color: "#9E9E9E", order: 0, is_default: true },
    { id: "todo", name: "To Do", group: "active", color: "#2196F3", order: 1 },
    { id: "in_progress", name: "In Progress", group: "active", color: "#FF9800", order: 2 },
    { id: "review", name: "Review", group: "active", color: "#9C27B0", order: 3 },
    { id: "done", name: "Done", group: "done", color: "#4CAF50", order: 4 },
    { id: "closed", name: "Closed", group: "closed", color: "#2E7D32", order: 5 },
  ],
  marketing: [
    { id: "idea", name: "Idea", group: "not_started", color: "#9E9E9E", order: 0, is_default: true },
    { id: "planning", name: "Planning", group: "active", color: "#2196F3", order: 1 },
    { id: "in_production", name: "In Production", group: "active", color: "#FF9800", order: 2 },
    { id: "client_review", name: "Client Review", group: "active", color: "#9C27B0", order: 3 },
    { id: "approved", name: "Approved", group: "done", color: "#4CAF50", order: 4 },
    { id: "published", name: "Published", group: "closed", color: "#2E7D32", order: 5 },
  ],
  simple: [
    { id: "todo", name: "To Do", group: "active", color: "#2196F3", order: 0, is_default: true },
    { id: "done", name: "Done", group: "done", color: "#4CAF50", order: 1 },
  ],
};

export const DEFAULT_STATUS_SET = STATUS_TEMPLATES.kanban;

// ---------- Brand colors (from DESIGN.md) ----------

export const BRAND_COLORS = {
  vividBlue: "#0091FF",
  boldPurple: "#6647F0",
  brightMagenta: "#FF02F0",
  deepPurple: "#7612FA",
  burntOrange: "#ED5F00",
  mutedPurple: "#5D5D85",
  charcoalDark: "#292D34",
  jetBlack: "#202020",
  mediumGray: "#646464",
  lightGray: "#E8E8E8",
  paleGray: "#D9D9D9",
  white: "#FFFFFF",
  offWhite: "#F8F9FA",
  lightLavender: "#EFEDFD",
};

export const PALETTE = [
  "#F44336", "#E91E63", "#9C27B0", "#3F51B5",
  "#2196F3", "#00BCD4", "#009688", "#4CAF50",
  "#8BC34A", "#FFEB3B", "#FF9800", "#795548", "#9E9E9E",
];

// ---------- View color schemes ----------
// Each scheme provides 6 distinct colors for the 6 view tabs.
// Order: list, board, calendar, table, gantt, timeline.

// 7 colors: [list, board, calendar, table, gantt, timeline, doc] — see
// VIEW_COLOR_KEYS for the index → kind mapping.
export type ViewColorSet = [string, string, string, string, string, string, string];

export const VIEW_COLOR_KEYS = ["list", "board", "calendar", "table", "gantt", "timeline", "doc"] as const;
// Index of each view type in a ViewColorSet (Docs is the 7th slot).
export const VIEW_COLOR_INDEX: Record<string, number> = { list: 0, board: 1, calendar: 2, table: 3, gantt: 4, timeline: 5, doc: 6 };

// Lucide icon name per view type — single source for the Views-bar chips, the
// topbar switcher, and favorited-view rows so they never diverge.
export const VIEW_TYPE_ICON: Record<string, string> = {
  list: "list",
  board: "trello",
  calendar: "calendar",
  table: "table",
  gantt: "bar-chart-horizontal-big",
  timeline: "git-commit-horizontal",
};

export interface ViewColorScheme {
  id: string;
  name: string;
  colors: ViewColorSet;
}

export const VIEW_COLOR_SCHEMES: ViewColorScheme[] = [
  {
    id: "brand",
    name: "Brand Palette",
    colors: ["#0091FF", "#6647F0", "#ED5F00", "#43A047", "#FF02F0", "#00BCD4", "#10B981"],
  },
  {
    id: "warm-cool",
    name: "Warm-Cool Split",
    colors: ["#2196F3", "#E91E63", "#FF9800", "#4CAF50", "#9C27B0", "#00BCD4", "#009688"],
  },
  {
    id: "neon-pop",
    name: "Neon Pop",
    colors: ["#0091FF", "#E91E63", "#FF6D00", "#00C853", "#AA00FF", "#00E5FF", "#00E676"],
  },
  {
    id: "pastel-soft",
    name: "Pastel Soft",
    colors: ["#5B9BD5", "#8E6FBF", "#E8943A", "#6AAF6A", "#D45D8E", "#4DBFBF", "#5FBF8F"],
  },
  {
    id: "material-rainbow",
    name: "Material Rainbow",
    colors: ["#1976D2", "#7B1FA2", "#E64A19", "#388E3C", "#C2185B", "#00838F", "#2E7D32"],
  },
  {
    id: "dark-pro",
    name: "Dark Professional",
    colors: ["#1565C0", "#6A1B9A", "#BF360C", "#2E7D32", "#AD1457", "#006064", "#1B5E20"],
  },
  {
    id: "vivid-contrast",
    name: "Vivid Contrast",
    colors: ["#0091FF", "#FF02F0", "#ED5F00", "#00C853", "#6647F0", "#FFD600", "#00BFA5"],
  },
  {
    id: "ocean-earth",
    name: "Ocean & Earth",
    colors: ["#0277BD", "#6D4C9E", "#D84315", "#558B2F", "#C62828", "#00838F", "#00695C"],
  },
  {
    id: "candy",
    name: "Candy",
    colors: ["#42A5F5", "#AB47BC", "#FF7043", "#66BB6A", "#EC407A", "#26C6DA", "#26A69A"],
  },
  {
    id: "mono-accent",
    name: "Monochrome Accent",
    colors: ["#0091FF", "#5C6BC0", "#FF8F00", "#26A69A", "#D81B60", "#78909C", "#43A047"],
  },
];

// Resolve the active 7-color set: scheme defaults with per-color overrides applied.
export function resolveViewColorSet(schemeId: string | undefined, overrides?: string[]): ViewColorSet {
  const scheme = VIEW_COLOR_SCHEMES.find((s) => s.id === (schemeId || "brand")) || VIEW_COLOR_SCHEMES[0];
  const out = [...scheme.colors] as ViewColorSet;
  if (overrides) for (let i = 0; i < out.length; i++) if (overrides[i]) out[i] = overrides[i];
  return out;
}

export const DEFAULT_VIEW_COLOR_SCHEME = "brand";

// ---------- Filter operators ----------

export const OPERATORS_BY_TYPE: Record<string, string[]> = {
  text: ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with", "is_empty", "is_not_empty"],
  number: ["equals", "not_equals", "gt", "lt", "gte", "lte", "between", "is_empty", "is_not_empty"],
  date: ["equals", "before", "after", "between", "is_today", "is_tomorrow", "is_yesterday", "in_next", "in_last", "is_overdue", "is_empty", "is_not_empty"],
  time: ["is", "is_not", "before", "after", "between", "is_empty", "is_not_empty"],
  dropdown: ["is", "is_not", "in", "not_in", "is_empty", "is_not_empty"],
  multi: ["any_of", "none_of", "all_of", "is_empty", "is_not_empty"],
  checkbox: ["is_checked", "is_unchecked"],
};

// ---------- Field labels ----------

export const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  status: "Status",
  priority: "Priority",
  due_date: "Due date",
  start_date: "Start date",
  created_at: "Created",
  updated_at: "Updated",
  tags: "Tags",
  context: "Context",
  type: "Item type",
  type_icon: "Type icon",
  list: "List",
  folder: "Folder",
  space: "Space",
  time_estimate: "Estimate",
  time_tracked: "Tracked",
  sprint_points: "Sprint points",
  custom_id: "Custom ID",
  id: "Item ID",
  subtask_count: "Subitem count",
  relationship_count: "Relationship count",
  checkbox: "Done checkbox",
  cover: "Cover image",
  description_preview: "Description preview",
};

// ---------- Available + default visible fields per view ----------

// Hierarchy reference fields are always offered (and default-ordered) broad →
// narrow: Space, Folder, List. Keep this order consistent across every view.
export const AVAILABLE_FIELDS_LIST: string[] = [
  "checkbox", "type_icon", "id", "custom_id", "status", "priority",
  "due_date", "start_date", "tags", "context", "subtask_count", "relationship_count",
  "time_estimate", "time_tracked", "sprint_points", "space", "folder", "list",
  "created_at", "updated_at",
];

export const AVAILABLE_FIELDS_BOARD: string[] = [
  "cover", "type_icon", "id", "custom_id", "status", "priority",
  "due_date", "start_date", "tags", "context", "subtask_count", "relationship_count",
  "time_estimate", "time_tracked", "sprint_points", "description_preview",
  "space", "folder", "list",
];

export const AVAILABLE_FIELDS_TABLE: string[] = [
  "id", "custom_id", "type", "title", "status", "priority",
  "due_date", "start_date", "tags", "context", "time_estimate", "time_tracked", "sprint_points",
  "space", "folder", "list", "created_at", "updated_at",
];

// Calendar pills can render only a compact subset of fields — the cell is tight
// and "due_date" is already implicit (the pill lives on its due date).
export const AVAILABLE_FIELDS_CALENDAR: string[] = [
  "type_icon", "custom_id", "id", "status", "priority", "start_date",
  "tags", "context", "subtask_count", "relationship_count",
  "time_estimate", "time_tracked", "sprint_points",
  "space", "folder", "list",
];

// Gantt renders a List-like left rail next to each bar. Dates drive the bar
// itself, so they're not offered as rail columns; everything else mirrors List.
export const AVAILABLE_FIELDS_GANTT: string[] = [
  "type_icon", "id", "custom_id", "status", "priority",
  "tags", "context", "subtask_count", "relationship_count",
  "time_estimate", "time_tracked", "sprint_points", "space", "folder", "list",
];

// Timeline bars carry a compact chip strip (like calendar pills). due_date is
// implicit (the bar ends on it); start_date likewise drives the bar start.
export const AVAILABLE_FIELDS_TIMELINE: string[] = [
  "type_icon", "custom_id", "id", "status", "priority",
  "tags", "context", "subtask_count", "relationship_count",
  "time_estimate", "time_tracked", "sprint_points", "space", "folder", "list",
];

// Default visible fields per view (title is always shown implicitly)
export const DEFAULT_VISIBLE_LIST: string[] = [
  "checkbox", "type_icon", "status", "priority", "context", "due_date", "tags", "subtask_count",
];
export const DEFAULT_VISIBLE_BOARD: string[] = [
  "priority", "context", "due_date", "tags", "subtask_count", "relationship_count",
];
export const DEFAULT_VISIBLE_TABLE: string[] = [
  "title", "status", "priority", "context", "due_date", "start_date", "tags",
  "time_estimate", "time_tracked", "list",
];
// Calendar pills are tight — show only a tiny default set on top of the title.
export const DEFAULT_VISIBLE_CALENDAR: string[] = [
  "priority",
];
// Gantt left rail — a couple of List-like columns beside the bar.
export const DEFAULT_VISIBLE_GANTT: string[] = [
  "type_icon", "status", "priority",
];
// Timeline bars are tight — one compact field on top of the title.
export const DEFAULT_VISIBLE_TIMELINE: string[] = [
  "priority",
];

export function defaultVisibleFor(view: ViewType): string[] {
  if (view === "list") return DEFAULT_VISIBLE_LIST.slice();
  if (view === "board") return DEFAULT_VISIBLE_BOARD.slice();
  if (view === "table") return DEFAULT_VISIBLE_TABLE.slice();
  if (view === "calendar") return DEFAULT_VISIBLE_CALENDAR.slice();
  if (view === "gantt") return DEFAULT_VISIBLE_GANTT.slice();
  if (view === "timeline") return DEFAULT_VISIBLE_TIMELINE.slice();
  return [];
}

export function availableFieldsFor(view: ViewType): string[] {
  if (view === "list") return AVAILABLE_FIELDS_LIST.slice();
  if (view === "board") return AVAILABLE_FIELDS_BOARD.slice();
  if (view === "table") return AVAILABLE_FIELDS_TABLE.slice();
  if (view === "calendar") return AVAILABLE_FIELDS_CALENDAR.slice();
  if (view === "gantt") return AVAILABLE_FIELDS_GANTT.slice();
  if (view === "timeline") return AVAILABLE_FIELDS_TIMELINE.slice();
  return [];
}

// Calendar background-color sources. Same inheritance semantics as visible_fields:
// `undefined` at a level = inherit from parent; `"default"` = workspace fallback
// (task.color → priority → status); any other value picks a specific source.
export const CALENDAR_COLOR_SOURCE_DEFAULT = "default";
export const CALENDAR_COLOR_SOURCES_BUILTIN: Array<{ value: string; label: string }> = [
  { value: CALENDAR_COLOR_SOURCE_DEFAULT, label: "Default (item → priority → status)" },
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "context", label: "Context" },
  { value: "type", label: "Item type" },
];

// Date sources for the date-driven views (Calendar / Gantt / Timeline). Same
// inheritance semantics as color_by: `undefined` at a level = inherit; a value
// picks the task field the view reads its date(s) from. Custom date/datetime
// fields join the list as "custom_field:<id>".
export const DATE_SOURCE_DUE = "due_date";
export const DATE_SOURCE_START = "start_date";
export const DATE_SOURCES_BUILTIN: string[] = [
  "due_date", "start_date", "created_at", "updated_at",
];

// ---------- Renameable built-in fields ----------
// Which built-in field keys the user may give a custom DISPLAY name to
// (per-scope, inherited). Purely cosmetic — the markdown property / storage
// key is never affected. Structural proper nouns (Space/Folder/List) and
// visual-only columns (type_icon/checkbox/cover) are intentionally excluded.
export const RENAMEABLE_FIELD_KEYS: string[] = [
  "title", "type", "status", "priority",
  "due_date", "start_date", "created_at", "updated_at",
  "tags", "context",
  "time_estimate", "time_tracked", "sprint_points",
  "id", "custom_id", "subtask_count", "relationship_count",
  "documents",
];

// ---------- Modal-display-only feature toggles ----------
// These gate PURELY the display of a section/field inside the task-edit modal
// (both classic and wide layouts). They do NOT disable any functionality and
// are deliberately NOT part of FEATURE_FIELDS — the underlying data and its
// presence in the list/board/table/etc. views are untouched. Inheritance
// (WS → Space → Folder → List) works like every other feature toggle.
export const MODAL_DISPLAY_FEATURE_IDS = [
  "modal_status", "modal_task_type", "modal_task_id", "modal_breadcrumb",
  "modal_custom_fields", "modal_parents", "modal_subtasks",
] as const;

// Default map (all ON) — spread into the feature defaults in workspace-index.
export const DEFAULT_MODAL_DISPLAY_FEATURES: Record<string, boolean> =
  Object.fromEntries(MODAL_DISPLAY_FEATURE_IDS.map((id) => [id, true]));

// ---------- Feature → field gates ----------
// When a feature toggle is OFF (explicitly), the listed fields are hidden from
// view rendering and from view-defaults pickers.
export const FEATURE_FIELDS: Record<string, string[]> = {
  priorities: ["priority"],
  tags: ["tags"],
  context: ["context"],
  time_tracking: ["time_tracked"],
  time_estimate: ["time_estimate"],
  sprint_points: ["sprint_points"],
  dependencies: ["relationship_count"],
  due_dates: ["due_date"],
  start_dates: ["start_date"],
  cover_images: ["cover"],
  description: ["description_preview"],
};

export function isFieldGatedOut(field: string, features: Record<string, boolean>): boolean {
  for (const featId of Object.keys(FEATURE_FIELDS)) {
    if (FEATURE_FIELDS[featId].includes(field) && features[featId] === false) return true;
  }
  return false;
}

export function filterFieldsByFeatures(fields: string[], features: Record<string, boolean>): string[] {
  return fields.filter((f) => !isFieldGatedOut(f, features));
}

// ---------- Chip styling ----------

// Ordered list of chip kinds — used by the settings UI when rendering one
// section per kind.
export const CHIP_KINDS: ChipKind[] = [
  "status", "priority", "task_type", "tag", "context", "custom_field",
];

export const CHIP_KIND_LABELS: Record<ChipKind, string> = {
  status: "Statuses",
  priority: "Priorities",
  task_type: "Task types",
  tag: "Tags",
  context: "Context",
  custom_field: "Custom fields",
};

// Workspace-level defaults. Every kind starts with a colored border and a
// tinted background so colored labels are visible at a glance everywhere;
// bold border is off by default. Lower levels inherit each property unless
// explicitly overridden.
export const DEFAULT_CHIP_STYLE_PER_KIND: Record<ChipKind, ResolvedChipStyle> = {
  status:       { border: true, bold_border: false, background: true },
  priority:     { border: true, bold_border: false, background: true },
  task_type:    { border: true, bold_border: false, background: true },
  tag:          { border: true, bold_border: false, background: true },
  context:      { border: true, bold_border: false, background: true },
  custom_field: { border: true, bold_border: false, background: true },
};

export const DEFAULT_CHIP_STYLES: ChipStyles = {
  status:       { ...DEFAULT_CHIP_STYLE_PER_KIND.status },
  priority:     { ...DEFAULT_CHIP_STYLE_PER_KIND.priority },
  task_type:    { ...DEFAULT_CHIP_STYLE_PER_KIND.task_type },
  tag:          { ...DEFAULT_CHIP_STYLE_PER_KIND.tag },
  context:      { ...DEFAULT_CHIP_STYLE_PER_KIND.context },
  custom_field: { ...DEFAULT_CHIP_STYLE_PER_KIND.custom_field },
};

export function defaultResolvedChipStyles(): ResolvedChipStyles {
  return {
    status:       { ...DEFAULT_CHIP_STYLE_PER_KIND.status },
    priority:     { ...DEFAULT_CHIP_STYLE_PER_KIND.priority },
    task_type:    { ...DEFAULT_CHIP_STYLE_PER_KIND.task_type },
    tag:          { ...DEFAULT_CHIP_STYLE_PER_KIND.tag },
    context:      { ...DEFAULT_CHIP_STYLE_PER_KIND.context },
    custom_field: { ...DEFAULT_CHIP_STYLE_PER_KIND.custom_field },
  };
}

/**
 * License status endpoint (Cloudflare Worker, POST {eh}). Versions before
 * 1.2.0 call the worker's workers.dev address, which stays live. An
 * unreachable URL degrades to the offline behavior (local state stands),
 * never to a lockout.
 */
export const LICENSE_STATUS_URL = "https://inventtasks-license.solidinvent.pl/status";
