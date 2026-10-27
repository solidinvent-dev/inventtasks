/** Pure recurring-Item domain rules shared by the plugin and External API. */

export interface RecurringConfig {
  enabled: boolean;
  pattern: "daily" | "weekly" | "monthly" | "yearly";
  every?: number;
  on?: string[];
  day_of_month?: number;
  end?: { type: "never" | "date" | "after_n_occurrences"; date?: string; count?: number };
  occurrences_passed?: number;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const addDays = (date: Date, count: number): Date => { const next = new Date(date); next.setDate(next.getDate() + count); return next; };
const addCalendarMonths = (date: Date, count: number, requestedDay = date.getDate()): Date => {
  // setMonth on Jan 31 overflows into March before callers can correct the
  // day. Anchor on day 1, move to the target month, then clamp to its real
  // final day (31 -> Feb 28/29, Apr 30, etc.). Hours are preserved.
  const next = new Date(date);
  next.setDate(1);
  next.setMonth(next.getMonth() + count);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(Math.max(1, requestedDay), lastDay));
  return next;
};
const copyTime = (target: Date, source: Date): Date => {
  target.setHours(source.getHours(), source.getMinutes(), source.getSeconds(), source.getMilliseconds());
  return target;
};
const parseDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const isoDay = (date: Date): string => {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const formatOccurrenceLike = (date: Date, source: string | null | undefined): string => {
  // InventTasks stores UI datetimes as YYYY-MM-DDTHH:mm. Keep the complete
  // time/offset suffix when a recurring datetime advances; date-only inputs
  // deliberately remain date-only.
  // Obsidian's YAML parser can normalize an unquoted `T` timestamp to
  // `YYYY-MM-DD HH:mm`, so accept both separators here.
  const suffix = typeof source === "string" ? source.match(/^\d{4}-\d{2}-\d{2}([T ].+)$/)?.[1] : undefined;
  return suffix ? `${isoDay(date)}${suffix}` : isoDay(date);
};
const validIsoDay = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
};

export function validateRecurringConfig(value: unknown): string | undefined {
  if (!isRecord(value)) return "recurring must be an object or null";
  if (typeof value.enabled !== "boolean") return "recurring.enabled must be a boolean";
  if (!(["daily", "weekly", "monthly", "yearly"] as unknown[]).includes(value.pattern)) return "recurring.pattern is invalid";
  if (value.every !== undefined && (!Number.isInteger(value.every) || Number(value.every) < 1 || Number(value.every) > 1000)) {
    return "recurring.every must be an integer between 1 and 1000";
  }
  if (value.on !== undefined) {
    if (!Array.isArray(value.on) || !value.on.every((day) => typeof day === "string" && (WEEKDAYS as readonly string[]).includes(day))) {
      return "recurring.on must contain valid lowercase weekdays";
    }
    if (new Set(value.on).size !== value.on.length) return "recurring.on must not contain duplicates";
  }
  if (value.day_of_month !== undefined && (!Number.isInteger(value.day_of_month) || Number(value.day_of_month) < 1 || Number(value.day_of_month) > 31)) {
    return "recurring.day_of_month must be an integer between 1 and 31";
  }
  if (value.occurrences_passed !== undefined && (!Number.isInteger(value.occurrences_passed) || Number(value.occurrences_passed) < 0)) {
    return "recurring.occurrences_passed must be a non-negative integer";
  }
  if (value.end !== undefined) {
    if (!isRecord(value.end) || !(["never", "date", "after_n_occurrences"] as unknown[]).includes(value.end.type)) return "recurring.end is invalid";
    if (value.end.type === "date" && !validIsoDay(value.end.date)) {
      return "recurring.end.date must be YYYY-MM-DD";
    }
    if (value.end.type === "after_n_occurrences" && (!Number.isInteger(value.end.count) || Number(value.end.count) < 1)) {
      return "recurring.end.count must be a positive integer";
    }
  }
  return undefined;
}

export function computeNextOccurrence(config: RecurringConfig, from: Date): Date | null {
  const every = Math.max(1, config.every ?? 1);
  switch (config.pattern) {
    case "daily": return addDays(from, every);
    case "weekly": {
      const days = (config.on ?? []).map((day) => day.toLowerCase()).filter((day) => (WEEKDAYS as readonly string[]).includes(day));
      if (!days.length) return addDays(from, 7 * every);
      const wanted = new Set(days.map((day) => (WEEKDAYS as readonly string[]).indexOf(day)));
      const fromDay = new Date(from); fromDay.setHours(0, 0, 0, 0);
      const weekStart = addDays(fromDay, -((fromDay.getDay() + 6) % 7));
      const nextWeekStart = addDays(weekStart, 7);
      for (let index = 1; index <= 7; index++) {
        const candidate = addDays(fromDay, index);
        if (candidate >= nextWeekStart) break;
        if (wanted.has(candidate.getDay())) return copyTime(candidate, from);
      }
      const targetWeekStart = addDays(weekStart, 7 * every);
      for (let index = 0; index < 7; index++) {
        const candidate = addDays(targetWeekStart, index);
        if (wanted.has(candidate.getDay())) return copyTime(candidate, from);
      }
      return addDays(from, 7 * every);
    }
    case "monthly": {
      return addCalendarMonths(from, every, config.day_of_month ?? from.getDate());
    }
    case "yearly": return addCalendarMonths(from, 12 * every, config.day_of_month ?? from.getDate());
    default: return null;
  }
}

export function isEndReached(config: RecurringConfig, nextDate: Date): boolean {
  if (!config.end || config.end.type === "never") return false;
  if (config.end.type === "date") { const end = parseDate(config.end.date); return !!end && nextDate > end; }
  return (config.occurrences_passed ?? 0) + 1 >= (config.end.count ?? 0);
}

export function projectOccurrences(config: RecurringConfig, start: Date, horizonEnd: Date): Date[] {
  if (!config.enabled) return [];
  const result: Date[] = [];
  let cursor = start, passed = config.occurrences_passed ?? 0;
  const cap = config.end?.type === "after_n_occurrences" ? (config.end.count ?? 0) : Number.POSITIVE_INFINITY;
  for (let index = 0; index < 500; index++) {
    if (passed + 1 >= cap) break;
    const next = computeNextOccurrence(config, cursor);
    if (!next || next > horizonEnd) break;
    if (config.end?.type === "date") { const end = parseDate(config.end.date); if (end && next > end) break; }
    result.push(next); cursor = next; passed++;
  }
  return result;
}

export interface RescheduleResult {
  due_date: string;
  recurring: RecurringConfig;
  /** True when this close consumed the last occurrence: the series is over and
   *  the Item must stay closed on its current date rather than move again. */
  ended: boolean;
}

/**
 * A monthly or yearly series has to remember which day the user actually meant.
 * Without it, each step reads the day back off the previous — already clamped —
 * date, so 31 Jan lands on 28 Feb and the series then walks on as "the 28th"
 * for ever instead of returning to the 31st. A 29 February series degrades the
 * same way and never comes back on the next leap year. Deriving the day once
 * from the anchor date and storing it in the config makes the intent explicit
 * in the Item's own frontmatter, and fixes series that are already running: the
 * first advance still happens from the original date, so the day recovered here
 * is the right one.
 */
const ANCHORED_PATTERNS = new Set(["monthly", "yearly"]);

function withAnchoredDayOfMonth(config: RecurringConfig, anchor: Date): RecurringConfig {
  if (!ANCHORED_PATTERNS.has(config.pattern) || config.day_of_month !== undefined) return config;
  return { ...config, day_of_month: anchor.getDate() };
}

export function rescheduleOnClose(data: { due_date?: string | null; recurring?: RecurringConfig }): RescheduleResult | null {
  const raw = data.recurring;
  if (!raw?.enabled) return null;
  const from = parseDate(data.due_date) ?? new Date();
  const config = withAnchoredDayOfMonth(raw, from);
  const next = computeNextOccurrence(config, from);
  if (!next) return null;
  const recurring = { ...config, occurrences_passed: (config.occurrences_passed ?? 0) + 1 };
  if (isEndReached(config, next)) {
    // The series is finished, so switching recurrence off is the whole change.
    // Moving the date as well would manufacture one occurrence beyond what the
    // user asked for — past an "end on" date, or a fourth date for "after 3
    // occurrences" — and it is an occurrence projectOccurrences never shows,
    // so the calendar and the Item would disagree. It would also re-open the
    // Item the user just finished, because the caller resets the status after
    // a reschedule.
    recurring.enabled = false;
    return { due_date: data.due_date ?? formatOccurrenceLike(next, data.due_date), recurring, ended: true };
  }
  return { due_date: formatOccurrenceLike(next, data.due_date), recurring, ended: false };
}
