// Shared status-resolution helpers. Centralised so list/board/modal all
// flip checkboxes the same way and respect the same view-defaults
// preference (done vs closed) with consistent fallbacks.

import type { StatusDef } from "../types";

export type CheckboxAction = "done" | "closed";

// Pick the status ID to set when a row/subtask checkbox is CHECKED.
// Returns undefined when neither a "done" nor "closed" status exists in
// the set (caller should silently no-op in that case — clicking a
// checkbox without target statuses doesn't make sense).
//
// Preference: try the user's preferred group first ("done" or "closed"),
// fall back to the other group. Within a group, picks the first defined
// status in the set's declared order — which is the user's own ordering
// in their statuses config.
export function pickCheckboxCheckedStatus(
  set: StatusDef[],
  preference: CheckboxAction,
): string | undefined {
  const other: CheckboxAction = preference === "done" ? "closed" : "done";
  return set.find((s) => s.group === preference)?.id
      ?? set.find((s) => s.group === other)?.id;
}

// Status to revert to when a row/subtask checkbox is UNCHECKED. The
// default status of the list (`is_default: true`) takes precedence;
// otherwise the first status in the set.
export function pickCheckboxUncheckedStatus(set: StatusDef[]): string | undefined {
  return set.find((s) => s.is_default)?.id ?? set[0]?.id;
}
