import type { ColumnCalc, ContextLocation, FilterGroup, SortRule, ViewType, TimeZoom } from "./types";

// ---------- Persisted per-location view-state ----------
//
// Stores the user's last-used "filter" choices (Group / Sort / Show closed /
// future additions) so navigating away and back to a List/Folder/Space — or to
// Today/Everything/Favorites — restores what they had set.
//
// Adding a new persisted filter dimension in the future:
//   1. Add the field here (optional — undefined means "no override").
//   2. Read it in `applyPersistedToState` to mutate ViewState.
//   3. Write it in `pickPersistedFromState`.
//   4. Call `persistViewState()` from wherever the new control changes state.
//
// That's it — storage, keying, save/load wiring is generic.

// ---------- Appearance overrides ----------
//
// Which fields a view shows, in what order, and the display choices around
// them. These used to reset on every navigation while the column WIDTHS and
// calculations for those same columns were remembered per location — so a user
// who reordered or hid a column got the old set back on reload, with widths
// still keyed to it. They now sit in the same per-location layer as Group /
// Sort, one step below a saved view marked "default", which still wins.
//
// Only an explicit override is stored: a location the user never customised
// keeps inheriting its View defaults, so changing those in config still
// reaches every untouched location.
export interface AppearanceOverrides {
  /** Visible fields, in the order they are shown. */
  visibleFields?: string[];
  calendarColorBy?: string;
  dateField?: string;
  startField?: string;
  cfShowName?: boolean;
  cfShowWhenEmpty?: boolean;
  cfShowTypeIcon?: boolean;
  timelineShowUnscheduled?: boolean;
}

const APPEARANCE_KEYS = [
  "visibleFields", "calendarColorBy", "dateField", "startField",
  "cfShowName", "cfShowWhenEmpty", "cfShowTypeIcon", "timelineShowUnscheduled",
] as const;

/** The overrides actually set on `state` — absent keys mean "inherit". */
export function pickAppearance(state: AppearanceOverrides): AppearanceOverrides {
  const out: AppearanceOverrides = {};
  for (const key of APPEARANCE_KEYS) {
    const value = state[key];
    if (value === undefined) continue;
    (out as any)[key] = Array.isArray(value) ? value.slice() : value;
  }
  return out;
}

/** Copy stored overrides onto `state`; anything absent is cleared to inherit. */
export function applyAppearance(saved: AppearanceOverrides | undefined, state: AppearanceOverrides): void {
  for (const key of APPEARANCE_KEYS) {
    const value = saved?.[key];
    (state as any)[key] = value === undefined ? undefined : Array.isArray(value) ? value.slice() : value;
  }
}

export interface PersistedViewState extends AppearanceOverrides {
  // The last viewType (List/Board/Calendar/Table) the user picked here.
  // Restored when the location's default_view is "last_selected" (or unset).
  viewType?: ViewType;
  groupBy?: string;
  groupDirection?: "asc" | "desc";
  subGroupBy?: string;
  sortBy?: SortRule[];
  filters?: FilterGroup;
  showClosed?: boolean;
  subtaskMode?: "parents" | "nested" | "flat";
  // Table view column widths (px) keyed by column key.
  tableColWidths?: Record<string, number>;
  // Column calculations (List + Table footer / per-group summaries). Per-view:
  // keyed by view type, then by field key (e.g. "time_estimate" or
  // "custom_field:cf_abc"). A List's footer is independent from the Table's.
  columnCalcs?: Partial<Record<ViewType, Record<string, ColumnCalc>>>;
  // Collapsed List/Table group buckets, independently persisted per view type.
  collapsedGroups?: Partial<Record<"list" | "table", string[]>>;
  // Time-based views (Gantt + Timeline): horizontal zoom and the scroll anchor
  // (ISO yyyy-mm-dd the toolbar's prev/next/today center on). Kept per zoom so
  // each view restores its own granularity.
  ganttZoom?: TimeZoom;
  timelineZoom?: TimeZoom;
  ganttRailWidth?: number;
  timelineRailWidth?: number;
  timeRefDate?: string;
  // Gantt toggles — dependency arrows + in-bar progress fill.
  ganttShowDependencies?: boolean;
  ganttShowProgress?: boolean;
}

export const groupCollapseKey = (groupBy: string, bucketKey: string): string => `${groupBy}\u0000${bucketKey}`;

export function toggleCollapsedGroup(
  current: Partial<Record<"list" | "table", string[]>> | undefined,
  viewType: "list" | "table",
  key: string,
): Partial<Record<"list" | "table", string[]>> {
  const set = new Set(current?.[viewType] || []);
  if (set.has(key)) set.delete(key); else set.add(key);
  return { ...(current || {}), [viewType]: [...set] };
}

// Stable string key for any ContextLocation, used as the map key in
// PluginSettings.viewStateByLocation. The same location → same key across
// sessions, regardless of object identity.
export function locationKey(loc: ContextLocation): string {
  switch (loc.kind) {
    case "everything": return "everything";
    case "archived": return "archived";
    case "notifications": return "notifications";
    case "reminders": return "reminders";
    case "short_notes": return "short_notes";
    case "today": return "today";
    case "favorites": return "favorites";
    case "recents": return "recents";
    case "space": return `space:${loc.path}`;
    case "folder": return `folder:${loc.path}`;
    case "list": return `list:${loc.path}`;
    case "doc": return `doc:${loc.path}`;
  }
}

// ---------- Location-key portability (saved views + docs frontmatter) ----------
//
// Views-bar items (saved views, doc containers) persist their location as a
// `kind:path` key in FRONTMATTER — files that sync between devices whose
// workspace roots differ (web root is "", desktops vary). Stored paths must
// therefore be ROOT-RELATIVE; at scan time they are rebased onto the current
// root so all runtime comparisons keep using absolute paths. Without this, a
// doc created on a device with root "TasksMD1" carried
// `location: space:TasksMD1/Space - X` and matched nothing anywhere else.

const PATH_LOCATION_KINDS = new Set(["space", "folder", "list", "doc"]);

function splitPathLocationKey(key: string | undefined | null): { kind: string; path: string } | null {
  if (!key) return null;
  const sep = key.indexOf(":");
  if (sep <= 0) return null;
  const kind = key.slice(0, sep);
  if (!PATH_LOCATION_KINDS.has(kind)) return null;
  return { kind, path: key.slice(sep + 1) };
}

const normRoot = (root: string | undefined): string => (!root || root === "/" ? "" : root);

/** Stored → runtime: prefix the current root (legacy absolute keys pass through). */
export function absoluteLocationKey(key: string, root: string | undefined): string {
  const parts = splitPathLocationKey(key);
  const r = normRoot(root);
  if (!parts || !r || !parts.path) return key;
  if (parts.path === r || parts.path.startsWith(`${r}/`)) return key; // already absolute
  return `${parts.kind}:${r}/${parts.path}`;
}

/** Runtime → stored: strip the current root so the key is device-portable. */
export function portableLocationKey(key: string, root: string | undefined): string {
  const parts = splitPathLocationKey(key);
  const r = normRoot(root);
  if (!parts || !r) return key;
  if (parts.path.startsWith(`${r}/`)) return `${parts.kind}:${parts.path.slice(r.length + 1)}`;
  return key;
}

// Inverse of locationKey: parse a stored key (e.g. a saved view's `location`)
// back into a ContextLocation. Unknown keys fall back to Everything.
export function locationFromKey(key: string): ContextLocation {
  if (key === "archived") return { kind: "archived" };
  if (key === "today") return { kind: "today" };
  if (key === "notifications") return { kind: "notifications" };
  if (key === "reminders") return { kind: "reminders" };
  if (key === "short_notes") return { kind: "short_notes" };
  if (key === "favorites") return { kind: "favorites" };
  if (key === "recents") return { kind: "recents" };
  if (key.startsWith("space:")) return { kind: "space", path: key.slice("space:".length) };
  if (key.startsWith("folder:")) return { kind: "folder", path: key.slice("folder:".length) };
  if (key.startsWith("list:")) return { kind: "list", path: key.slice("list:".length) };
  if (key.startsWith("doc:")) return { kind: "doc", path: key.slice("doc:".length) };
  return { kind: "everything" };
}
