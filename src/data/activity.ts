// Activity log: appends auto-generated events to a task's `activity[]`
// frontmatter array. Designed to be folded into the same `updateTask`
// mutator as the change that triggered it — one file write, one emit.
//
// Settings are held at module scope so callers (in helpers and modals)
// don't need to thread them around. Configure once at plugin load and on
// every settings save.

import type { ActivityEntry, ActivityKind, TaskData } from "../types";
import type { ActivitySettings } from "../settings";

let _settings: ActivitySettings | null = null;

export function configureActivity(s: ActivitySettings | null): void {
  _settings = s;
}

function isKindEnabled(kind: ActivityKind): boolean {
  if (!_settings) return true; // fail-open if uninitialized
  switch (kind) {
    case "created":              return _settings.log_created;
    case "status":               return _settings.log_status;
    case "priority":             return _settings.log_priority;
    case "due_date":
    case "start_date":           return _settings.log_dates;
    case "title":                return _settings.log_title;
    case "parent_added":
    case "parent_removed":
    case "subtask_added":
    case "subtask_removed":      return _settings.log_parent;
    case "blocks_added":
    case "blocks_removed":
    case "waiting_added":
    case "waiting_removed":
    case "related_added":
    case "related_removed":      return _settings.log_relationships;
    case "checklist_added":
    case "checklist_checked":
    case "checklist_unchecked":
    case "checklist_text_changed":
    case "checklist_removed":    return _settings.log_checklist;
    case "comment_added":
    case "comment_edited":
    case "comment_removed":      return _settings.log_comments;
    default:                     return true;
  }
}

// Returns the next activity array — either with the new entry appended
// (and capped to settings.maxEntries), or unchanged if this kind is
// disabled. Pure function — caller decides what to do with the result.
export function appendActivity(
  existing: ActivityEntry[] | undefined,
  entry: Omit<ActivityEntry, "ts"> & { ts?: string },
): ActivityEntry[] {
  const cur = existing ?? [];
  if (!isKindEnabled(entry.kind)) return cur;
  const full: ActivityEntry = { ts: entry.ts ?? new Date().toISOString(), ...entry };
  const next = [...cur, full];
  const cap = _settings?.maxEntries ?? 0;
  if (cap > 0 && next.length > cap) return next.slice(-cap);
  return next;
}

// Convenience: produce the next `activity` value as part of a TaskData
// mutator. Use like:
//   return { data: { ...d, status: v, activity: withActivity(d, {kind:"status", from:d.status, to:v}) } }
export function withActivity(
  data: Pick<TaskData, "activity">,
  entry: Omit<ActivityEntry, "ts"> & { ts?: string },
): ActivityEntry[] {
  return appendActivity(data.activity, entry);
}
