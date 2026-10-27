import type { CustomFieldDef, TaskData, TaskFile } from "../types";
import { DATE_SOURCE_DUE, DATE_SOURCE_START } from "../constants";

// ---------- Configurable date sources (Calendar / Gantt / Timeline) ----------
//
// The date-driven views can read their date(s) from a task field other than
// start_date/due_date: any of the built-in date stamps or a date/datetime
// custom field ("custom_field:<id>"). These helpers centralize reading and
// writing through that indirection so every view behaves identically.

/** Read a task's date value for a configured source ("" / undefined → fallback). */
export function taskDateValue(t: TaskFile, source: string | undefined, fallback: string): string | null | undefined {
  const f = source || fallback;
  if (f === "due_date") return t.data.due_date;
  if (f === "start_date") return t.data.start_date;
  if (f === "created_at") return t.data.created_at;
  if (f === "updated_at") return t.data.updated_at;
  if (f.startsWith("custom_field:")) {
    const v = t.data.custom_fields?.[f.slice(13)];
    return typeof v === "string" && v ? v : undefined;
  }
  return undefined;
}

/** created_at / updated_at are system stamps — views must not drag-edit them. */
export function isDateSourceWritable(source: string | undefined, fallback: string): boolean {
  const f = source || fallback;
  return f === "due_date" || f === "start_date" || f.startsWith("custom_field:");
}

// Build a new-task preset fragment that lands the task on `iso` for a given
// date source. Used when a task is created from a calendar cell so the clicked
// day fills whichever field the calendar is placed by (not just due_date).
// Read-only sources (created_at / updated_at) return {} — nothing to seed.
export function presetForDateSource(
  source: string | undefined,
  iso: string,
): { due_date?: string; start_date?: string; custom_fields?: Record<string, unknown> } {
  const f = source || DATE_SOURCE_DUE;
  if (f === DATE_SOURCE_DUE) return { due_date: iso };
  if (f === DATE_SOURCE_START) return { start_date: iso };
  if (f.startsWith("custom_field:")) return { custom_fields: { [f.slice(13)]: iso } };
  return {};
}

// Translate a drag-engine patch (its native {start_date?, due_date?} keys) onto
// the configured source fields. Non-writable sources drop their part silently
// (callers disable dragging for those, so this is just a safety net).
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_OF_DAY = /^\d{4}-\d{2}-\d{2}T(.+)$/;

/**
 * Move a stored date onto a new day without discarding the time it was set to.
 *
 * Every drag reschedule — a Gantt bar, a Timeline bar, a drop on a calendar day
 * — snaps to whole days and therefore hands us a bare `YYYY-MM-DD`. Written
 * straight through, that silently erased the time on an Item scheduled for, say,
 * 09:30: nudging its bar one day to the right cost the user the hour they had
 * set, with nothing on screen to say so. Day-granularity edits now move the day
 * and leave the clock alone. A caller that supplies a full datetime (the Item
 * modal) is passed through untouched.
 */
export function keepTimeOfDay(previous: unknown, next: string): string {
  if (!DAY_ONLY.test(next)) return next;
  const time = typeof previous === "string" ? TIME_OF_DAY.exec(previous)?.[1] : undefined;
  return time ? `${next}T${time}` : next;
}

export function mapDatePatch(
  d: TaskData,
  patch: { start_date?: string; due_date?: string },
  startSource: string | undefined,
  dueSource: string | undefined,
): Partial<TaskData> {
  const out: Partial<TaskData> = {};
  let cfs: Record<string, unknown> | undefined;
  const write = (source: string, value: string) => {
    if (source === "due_date") out.due_date = keepTimeOfDay(d.due_date, value);
    else if (source === "start_date") out.start_date = keepTimeOfDay(d.start_date, value);
    else if (source.startsWith("custom_field:")) {
      const id = source.slice(13);
      cfs = cfs || { ...(d.custom_fields || {}) };
      cfs[id] = keepTimeOfDay(cfs[id], value);
    }
  };
  if (patch.start_date !== undefined) write(startSource || DATE_SOURCE_START, patch.start_date);
  if (patch.due_date !== undefined) write(dueSource || DATE_SOURCE_DUE, patch.due_date);
  if (cfs) out.custom_fields = cfs;
  return out;
}

/** Custom fields usable as a date source. */
export function dateBearingCustomFields(cfs: CustomFieldDef[]): CustomFieldDef[] {
  return cfs.filter((f) => f.type === "date" || f.type === "datetime");
}
