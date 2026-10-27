// ---------- Calendar sync — type definitions ----------
// Calendar sync is configured ONCE for the whole plugin (PluginSettings.
// calendarSync); per-location routing rules live in workspace config files.

export type CalDavPreset = "custom" | "google" | "outlook365" | "outlookPersonal" | "icloud" | "nextcloud" | "fastmail";
/** "vevent" for Google/Outlook365 (they don't accept VTODO); "vtodo" for iCloud/Nextcloud/Fastmail */
export type CalDavEventFormat = "vevent" | "vtodo";

export interface CalDavConfig {
  enabled: boolean;
  serverUrl: string;
  username: string;
  password: string;
  calendarPath?: string;    // discovered or manually set
  preset?: CalDavPreset;
  eventFormat?: CalDavEventFormat; // default: "vtodo"
}

export interface CalendarSyncScope {
  withDueDateOnly: boolean;
  statusGroups: string[];   // e.g. ["not_started","active"]
  /** Optional date window (by due/start date). 0 / undefined = unlimited. */
  pastDays?: number;        // don't sync tasks dated more than this many days ago
  futureDays?: number;      // don't sync tasks dated more than this many days ahead
}

export type CalendarSyncFrequency = "manual" | "15min" | "1hour";

export interface SyncedEventEntry {
  caldav?: string;          // CalDAV event UID
  lastHash?: string;        // hash of task fields to detect changes
}

export interface CalendarSyncPrefs {
  enabled: boolean;
  generateIcs: boolean;     // write _tasks-calendar.ics to vault root
  /**
   * Which iCalendar component the exported file carries.
   *
   * "event" (the default) writes VEVENT, which every calendar displays —
   * including Google Calendar, which ignores VTODO entirely. Since this file
   * exists to be subscribed to from a calendar, an export nobody's calendar
   * shows is an export that failed at its one job. Dated items only: an item
   * without a date has nowhere to sit in a calendar and is left out.
   *
   * "todo" writes VTODO instead — the technically correct shape for a task,
   * read by Apple Reminders, Thunderbird and other task-aware clients.
   */
  icsComponent?: "todo" | "event";
  caldav: CalDavConfig;
  scope: CalendarSyncScope;
  frequency: CalendarSyncFrequency;
  /** taskId → external event IDs per service */
  syncedEvents: Record<string, SyncedEventEntry>;
  lastSync?: string;        // ISO timestamp
  /** Last sync failure (e.g. expired token / server down), surfaced in settings.
   *  Cleared on a fully successful sync. */
  lastSyncError?: { ts: string; message: string };
  /** Last partial sync warning (e.g. individual event create/update failed while the target stayed reachable). */
  lastSyncWarning?: { ts: string; message: string };
}

export function defaultCalendarSyncPrefs(): CalendarSyncPrefs {
  return {
    enabled: false,
    generateIcs: false,
    icsComponent: "event",
    caldav: { enabled: false, serverUrl: "", username: "", password: "" },
    scope: { withDueDateOnly: true, statusGroups: ["not_started", "active"] },
    frequency: "manual",
    syncedEvents: {},
  };
}
