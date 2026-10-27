/**
 * shared/config-defaults.ts — built-in workspace-config defaults shared by the
 * plugin and the External API server.
 *
 * The plugin resolves statuses/priorities/task types down the config chain and
 * falls back to these built-ins when nothing overrides them. The External API
 * must resolve the SAME effective config (labels, field catalog, validation),
 * so both sides read one definition. Like protocol.ts, nothing here may import
 * from src/ — the types below are structural mirrors of the plugin's
 * StatusDef / PriorityDef / TaskType (src/types.ts re-exports the data under
 * those richer types).
 */

export interface DefaultStatusDef {
  id: string;
  name: string;
  group: "not_started" | "active" | "done" | "closed";
  color: string;
  order: number;
  is_default?: boolean;
}

export interface DefaultPriorityDef {
  id: 1 | 2 | 3 | 4;
  label: string;
  color: string;
  icon?: string;
}

export interface DefaultTaskType {
  id: string;
  name: string;
  plural?: string;
  icon?: string;
  color?: string;
}

/** The Kanban template — the plugin's DEFAULT_STATUS_SET and the set the UI
 *  Space wizard preselects. The API's Space creation seeds this when the
 *  caller does not supply a status_set. */
export const DEFAULT_STATUS_SET: DefaultStatusDef[] = [
  { id: "todo", name: "To Do", group: "active", color: "#2196F3", order: 0, is_default: true },
  { id: "in_progress", name: "In Progress", group: "active", color: "#FF9800", order: 1 },
  { id: "done", name: "Done", group: "done", color: "#4CAF50", order: 2 },
  { id: "complete", name: "Complete", group: "closed", color: "#2E7D32", order: 3 },
];

export const DEFAULT_PRIORITIES: DefaultPriorityDef[] = [
  { id: 1, label: "Urgent", color: "#F44336", icon: "flag" },
  { id: 2, label: "High", color: "#FFC107", icon: "flag" },
  { id: 3, label: "Normal", color: "#2196F3", icon: "flag" },
  { id: 4, label: "Low", color: "#9E9E9E", icon: "flag" },
];

export const DEFAULT_TASK_TYPES: DefaultTaskType[] = [
  { id: "task",      name: "Task",      plural: "Tasks",      icon: "check-square",  color: "#607D8B" },
  { id: "bug",       name: "Bug",       plural: "Bugs",       icon: "bug",           color: "#E53935" },
  { id: "story",     name: "Story",     plural: "Stories",    icon: "book-open",     color: "#1E88E5" },
  { id: "epic",      name: "Epic",      plural: "Epics",      icon: "rocket",        color: "#8E24AA" },
  { id: "feature",   name: "Feature",   plural: "Features",   icon: "sparkles",      color: "#43A047" },
  { id: "milestone", name: "Milestone", plural: "Milestones", icon: "award",         color: "#FB8C00" },
  { id: "meeting",   name: "Meeting",   plural: "Meetings",   icon: "calendar",      color: "#00ACC1" },
  { id: "person",    name: "Person",    plural: "People",     icon: "user-round",    color: "#1565C0" },
];
