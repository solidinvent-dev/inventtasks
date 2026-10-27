// Date utilities — keep things ISO-friendly. We accept strings like
// "2026-05-20", "2026-05-20T10:30", and full ISO timestamps.
//
// ---------- Timezone handling ----------
// A stored date value carries its calendar day in its leading "YYYY-MM-DD".
// We NEVER route a date-only string through `new Date()` for day logic
// (that parses as UTC midnight and shifts a day west of UTC). Instead we
// read the day directly off the string. The configurable timezone only
// governs what "now"/"today" is — useful when syncing across devices in
// different zones. "" / "auto" / "local" = device local; "UTC"; or any
// IANA zone (e.g. "Europe/Warsaw").
//
// ---------- Display formats ----------
// Date / time presentation is driven by user settings (one place — the plugin
// settings tab), applied process-wide via `configureDateTimeFormats`. Every
// date/time we *show* the user routes through `formatDate` / `formatTimeOfDay`
// so a single setting governs all views, modals and controls. The native
// <input type="date|time"> controls ignore these (the browser/OS locale wins),
// so editable cells overlay our own formatted text on top — see
// src/ui/datetime-field.ts.

import { monthName } from "../i18n";

const pad2 = (n: number) => n.toString().padStart(2, "0");

let _timezone = "";
export function configureTimezone(tz: string | undefined): void {
  _timezone = (tz || "").trim();
}

// ---------- Configurable display formats ----------

export type WeekStart = "monday" | "sunday";

let _dateFormat = "YYYY-MM-DD";
let _timeFormat = "HH:mm";
let _weekStart: WeekStart = "monday";

export function configureDateTimeFormats(opts: {
  dateFormat?: string;
  timeFormat?: string;
  weekStart?: WeekStart;
}): void {
  if (opts.dateFormat) _dateFormat = opts.dateFormat;
  if (opts.timeFormat) _timeFormat = opts.timeFormat;
  if (opts.weekStart) _weekStart = opts.weekStart;
}

export function getWeekStart(): WeekStart { return _weekStart; }
// First day of the week as a JS getDay() index (Sunday=0 … Saturday=6).
export function weekStartIndex(): number { return _weekStart === "sunday" ? 0 : 1; }

// ---------- Format primitives ----------

interface DateParts { y: number; mo: number; d: number; h: number; mi: number; hasTime: boolean; }

// Pull calendar parts straight off an ISO date / datetime string. Timezone-safe:
// a date-only value keeps its written calendar day (never UTC-shifted).
function isoParts(s: string): DateParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  return {
    y: +m[1], mo: +m[2] - 1, d: +m[3],
    h: m[4] != null ? +m[4] : 0,
    mi: m[5] != null ? +m[5] : 0,
    hasTime: m[4] != null,
  };
}

function partsFromDate(d: Date): DateParts {
  return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), hasTime: true };
}

// Localised 3-letter month for the `MMM` token.
function monthShort(mo: number): string {
  const name = monthName(mo) || "";
  return name.slice(0, 3);
}

function applyDateFormat(p: DateParts, fmt: string): string {
  const map: Record<string, string> = {
    YYYY: String(p.y),
    YY: pad2(p.y % 100),
    MMM: monthShort(p.mo),
    MM: pad2(p.mo + 1),
    M: String(p.mo + 1),
    DD: pad2(p.d),
    D: String(p.d),
  };
  // Longest tokens first so MM/DD never get eaten by M/D.
  return fmt.replace(/YYYY|YY|MMM|MM|DD|M|D/g, (tok) => map[tok] ?? tok);
}

function applyTimeFormat(h: number, mi: number, fmt: string): string {
  if (fmt === "HH:mm") return `${pad2(h)}:${pad2(mi)}`;
  // 12-hour ("hh:mm A") — the only other supported variant.
  const suffix = h < 12 ? "AM" : "PM";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${pad2(h12)}:${pad2(mi)} ${suffix}`;
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Constructing Intl.DateTimeFormat is expensive (~0.1–1 ms each); these
// helpers run per task in filters (is_today) and per render, so formatters are
// cached per (locale, options) signature. Exported for other modules that
// need timezone math (e.g. the notifications view).
const dtfCache = new Map<string, Intl.DateTimeFormat>();
export function cachedDateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${options.timeZone || ""}|${options.year || ""}${options.month || ""}${options.day || ""}${options.hour || ""}${options.minute || ""}${options.second || ""}${options.hour12 ?? ""}`;
  let fmt = dtfCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, options);
    dtfCache.set(key, fmt);
  }
  return fmt;
}

// Current clock time (HH:MM, 24h) in the configured timezone.
export function hhmmKey(now = new Date()): string {
  if (!_timezone || _timezone === "auto" || _timezone === "local") {
    return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  }
  try {
    const parts = cachedDateTimeFormat("en-GB", {
      timeZone: _timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const h = get("hour"), m = get("minute");
    if (h && m) return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  } catch { /* invalid zone → fall back to local */ }
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

// Today's calendar day (YYYY-MM-DD) in the configured timezone. The Intl
// round-trip only happens once per minute — "today" can't change more often,
// and this is called per task by date filters/grouping.
let _todayCache: { tz: string; minute: number; value: string } | null = null;
export function todayKey(): string {
  const now = new Date();
  const tz = _timezone || "";
  if (!tz || tz === "auto" || tz === "local") return localDayKey(now);
  const minute = Math.floor(now.getTime() / 60_000);
  if (_todayCache && _todayCache.tz === tz && _todayCache.minute === minute) return _todayCache.value;
  let value: string | null = null;
  try {
    const parts = cachedDateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const y = get("year"), m = get("month"), day = get("day");
    if (y && m && day) value = `${y}-${m}-${day}`;
  } catch { /* invalid zone → fall back to local */ }
  const resolved = value ?? localDayKey(now);
  _todayCache = { tz, minute, value: resolved };
  return resolved;
}

// The calendar day (YYYY-MM-DD) a stored value belongs to. Reads the leading
// date off ISO date/datetime strings directly (timezone-safe); only falls
// back to parsing for non-ISO inputs.
export function dayKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = parseDate(value);
  return d ? localDayKey(d) : null;
}

// Whole-day difference between two YYYY-MM-DD keys (toKey - fromKey).
// Uses UTC arithmetic on the parts so DST never skews the count.
export function dayDiff(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

export function nowIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function todayIso(): string {
  return todayKey();
}

export function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  // Accept "YYYY-MM-DD" and "YYYY-MM-DDTHH:mm"
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d;
}

// Format a stored date/datetime for display, honouring the configured date &
// time formats. Pass `format` to override the date pattern for a single call.
export function formatDate(v: string | Date | null | undefined, opts: { withTime?: boolean; format?: string } = {}): string {
  if (!v) return "";
  let parts: DateParts | null;
  if (typeof v === "string") {
    parts = isoParts(v);
    if (!parts) { const d = parseDate(v); parts = d ? partsFromDate(d) : null; }
  } else {
    parts = partsFromDate(v);
  }
  if (!parts) return "";
  const includeTime = opts.withTime ?? (typeof v === "string" && v.includes("T"));
  const datePart = applyDateFormat(parts, opts.format || _dateFormat);
  if (includeTime) return `${datePart} ${applyTimeFormat(parts.h, parts.mi, _timeFormat)}`;
  return datePart;
}

// Format a wall-clock time for display, honouring the configured time format.
// Accepts an "HH:mm" string, a full ISO datetime, or a Date.
export function formatTimeOfDay(v: string | Date | null | undefined): string {
  if (!v) return "";
  if (typeof v !== "string") return applyTimeFormat(v.getHours(), v.getMinutes(), _timeFormat);
  // Bare "HH:mm" (optionally with seconds)
  const hm = /^(\d{1,2}):(\d{2})/.exec(v);
  if (hm) return applyTimeFormat(Number(hm[1]), Number(hm[2]), _timeFormat);
  // ISO datetime — read the time straight off the string.
  const p = isoParts(v);
  if (p && p.hasTime) return applyTimeFormat(p.h, p.mi, _timeFormat);
  return "";
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

export function isOverdue(due: string | null | undefined, statusGroup: string | undefined): boolean {
  if (!due) return false;
  if (statusGroup === "done" || statusGroup === "closed") return false;
  const dk = dayKey(due);
  if (!dk) return false;
  return dk < todayKey(); // lexicographic compare is valid for YYYY-MM-DD
}

export function relativeBucket(due: string | null | undefined): string {
  const dk = dayKey(due);
  if (!dk) return "No date";
  const diff = dayDiff(todayKey(), dk);
  if (diff < 0) return "Overdue";
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff <= 7) return "This week";
  if (diff <= 14) return "Next week";
  return "Later";
}

export function bucketOrder(b: string): number {
  const ord: Record<string, number> = {
    "Overdue": 0,
    "Today": 1,
    "Tomorrow": 2,
    "This week": 3,
    "Next week": 4,
    "Later": 5,
    "No date": 6,
  };
  return ord[b] ?? 99;
}

export function formatDuration(minutes: number | undefined | null): string {
  if (!minutes || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Whether times render in 24-hour form. With no argument it reflects the
// process-wide configured time format (the single source of truth); pass an
// explicit format only to test a specific value.
export function uses24HourTime(format?: string | null): boolean {
  return (format ?? _timeFormat ?? "HH:mm") === "HH:mm";
}

