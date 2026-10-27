import type { TaskFile } from "../types";

const CRLF = "\r\n";
const PRODID = "-//InventTasks//Obsidian Task Manager//EN";

function escapeIcs(s: string): string {
  // RFC 5545: escape backslash, semicolon, comma, newline
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold long lines per RFC 5545 (max 75 octets, continuation with SP). */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let start = 0;
  let firstChunk = true;
  while (start < line.length) {
    const maxLen = firstChunk ? 75 : 74; // first chunk full, subsequent: 74 + 1 space prefix
    chunks.push(line.slice(start, start + maxLen));
    start += maxLen;
    firstChunk = false;
  }
  return chunks.join(CRLF + " ");
}

function toIcsDate(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  // "2026-05-22T17:00" or "2026-05-22"
  const hasTime = /T\d{2}:\d{2}/.test(iso);
  if (hasTime) {
    // Convert to UTC format: 20260522T170000Z
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return undefined;
    return dt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  }
  // Date only: 20260522
  return iso.slice(0, 10).replace(/-/g, "");
}

function toIcsDateParam(iso: string): { param: string; value: string } {
  const hasTime = /T/.test(iso);
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return { param: "", value: iso.replace(/-/g, "").slice(0, 8) };
  if (hasTime) {
    return {
      param: "",
      value: dt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""),
    };
  }
  return { param: ";VALUE=DATE", value: iso.replace(/-/g, "").slice(0, 8) };
}

function nowIcs(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Add one calendar day to a "YYYY-MM-DD" string, returning "YYYY-MM-DD". */
export function addDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/** Compute a simple hash string for a task — used to detect changes. */
export function taskHash(task: TaskFile): string {
  const d = task.data;
  return [d.title, d.status, d.due_date, d.start_date, d.priority, d.status_group].join("|");
}

/** Map InventTasks status_group to VTODO STATUS. */
function vtodoStatus(statusGroup?: string): string {
  switch (statusGroup) {
    case "done": return "COMPLETED";
    case "closed": return "CANCELLED";
    case "active": return "IN-PROCESS";
    default: return "NEEDS-ACTION";
  }
}

/** Map InventTasks status_group to VEVENT STATUS. */
function veventStatus(statusGroup?: string): string {
  switch (statusGroup) {
    case "closed": return "CANCELLED";
    case "active": return "CONFIRMED";
    default: return "TENTATIVE";
  }
}

/** Map priority (1-4) to iCal PRIORITY (1=high…9=low, 0=undefined). */
function icalPriority(p?: number | null): number {
  if (!p) return 0;
  const map: Record<number, number> = { 1: 1, 2: 3, 3: 5, 4: 9 };
  return map[p] ?? 0;
}

/** Generate a single VTODO block for a task. */
export function taskToVTodo(task: TaskFile): string {
  const d = task.data;
  const uid = `inventtasks-${d.id}@inventtasks`;
  const now = nowIcs();

  const lines: string[] = [];
  lines.push("BEGIN:VTODO");
  lines.push(`UID:${uid}`);
  lines.push(`DTSTAMP:${now}`);
  lines.push(`CREATED:${d.created_at ? toIcsDate(d.created_at) || now : now}`);
  lines.push(`LAST-MODIFIED:${d.updated_at ? toIcsDate(d.updated_at) || now : now}`);
  lines.push(foldLine(`SUMMARY:${escapeIcs(d.title || "(untitled)")}`));

  if (d.start_date) {
    const { param, value } = toIcsDateParam(d.start_date);
    lines.push(`DTSTART${param}:${value}`);
  }
  if (d.due_date) {
    const { param, value } = toIcsDateParam(d.due_date);
    lines.push(`DUE${param}:${value}`);
  }

  const status = vtodoStatus(d.status_group);
  lines.push(`STATUS:${status}`);

  const prio = icalPriority(d.priority);
  if (prio > 0) lines.push(`PRIORITY:${prio}`);

  if (d.tags?.length) {
    lines.push(foldLine(`CATEGORIES:${d.tags.map(escapeIcs).join(",")}`));
  }

  // Description: task list path + any description text
  const descParts: string[] = [];
  if (task.listPath) descParts.push(`List: ${task.listPath}`);
  if (d.id) descParts.push(`ID: ${d.id}`);
  const descStr = descParts.join("\\n");
  if (descStr) lines.push(foldLine(`DESCRIPTION:${descStr}`));

  // Progress percentage from sprint_points or progress field
  if (status === "COMPLETED") lines.push("PERCENT-COMPLETE:100");

  lines.push("END:VTODO");
  return lines.join(CRLF);
}

/**
 * Generate a single VEVENT block for a task.
 * Used for CalDAV servers that require VEVENT (Google Calendar, Outlook 365).
 * Returns null if the task has no dates (can't create a meaningful event).
 */
export function taskToVEvent(task: TaskFile): string | null {
  const d = task.data;
  if (!d.start_date && !d.due_date) return null;

  const uid = `inventtasks-${d.id}@inventtasks`;
  const now = nowIcs();

  const lines: string[] = [];
  lines.push("BEGIN:VEVENT");
  lines.push(`UID:${uid}`);
  lines.push(`DTSTAMP:${now}`);
  lines.push(`CREATED:${d.created_at ? toIcsDate(d.created_at) || now : now}`);
  lines.push(`LAST-MODIFIED:${d.updated_at ? toIcsDate(d.updated_at) || now : now}`);
  lines.push(foldLine(`SUMMARY:${escapeIcs(d.title || "(untitled)")}`));

  // DTSTART: prefer start_date, fall back to due_date
  const startIso = d.start_date || d.due_date!;
  const { param: startParam, value: startValue } = toIcsDateParam(startIso);
  lines.push(`DTSTART${startParam}:${startValue}`);

  // DTEND. For all-day (VALUE=DATE) events DTEND is EXCLUSIVE, so it must be the
  // day after the last day. For timed events default to +30 min when no distinct end.
  const endSource = (d.due_date && d.due_date !== startIso) ? d.due_date : startIso;
  if (/T/.test(endSource)) {
    if (endSource === startIso) {
      const dt = new Date(startIso);
      dt.setMinutes(dt.getMinutes() + 30);
      lines.push(`DTEND:${dt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`);
    } else {
      const { param, value } = toIcsDateParam(endSource);
      lines.push(`DTEND${param}:${value}`);
    }
  } else {
    // All-day: end = (end day) + 1, exclusive.
    lines.push(`DTEND;VALUE=DATE:${addDay(endSource.slice(0, 10)).replace(/-/g, "")}`);
  }

  lines.push(`STATUS:${veventStatus(d.status_group)}`);

  const prio = icalPriority(d.priority);
  if (prio > 0) lines.push(`PRIORITY:${prio}`);

  if (d.tags?.length) {
    lines.push(foldLine(`CATEGORIES:${d.tags.map(escapeIcs).join(",")}`));
  }

  const descParts: string[] = [];
  if (task.listPath) descParts.push(`List: ${task.listPath}`);
  if (d.id) descParts.push(`ID: ${d.id}`);
  const descStr = descParts.join("\\n");
  if (descStr) lines.push(foldLine(`DESCRIPTION:${descStr}`));

  lines.push("END:VEVENT");
  return lines.join(CRLF);
}

/**
 * Generate a complete iCalendar (.ics) file string. `tasks` is expected to be
 * already filtered to the export scope by the caller.
 */
export function generateIcsFile(tasks: TaskFile[], component: "todo" | "event" = "event"): string {
  // VEVENT skips undated items: taskToVEvent returns null for them, because an
  // event with no date is not a thing a calendar can place.
  const todos = component === "event"
    ? tasks.map((t) => taskToVEvent(t)).filter((v): v is string => v !== null)
    : tasks.map((t) => taskToVTodo(t));

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:InventTasks`,
    `X-WR-CALDESC:Tasks exported from InventTasks (Obsidian)`,
    ...todos,
    "END:VCALENDAR",
  ];

  return lines.join(CRLF) + CRLF;
}
