import { setIcon } from "obsidian";
import type InventTasksPlugin from "../main";
import type { TaskFile } from "../types";
import { monthName, navLabel, t } from "../i18n";
import { showPopover } from "../ui/components";
import { cachedDateTimeFormat, todayKey } from "../utils/dates";
import { ConfirmModal } from "../modals/confirm-modal";
import { fireAndForget } from "../utils/async";
import { clearHistory, mergeNotifHistory, type MergedHistoryEntry } from "../notifications/store";
import { ensureNotifState } from "../data/workspace-state";
import type { NotifChannel, NotifHistoryItem } from "../notifications/types";

type NotificationKind = "overdue" | "due_today" | "due_soon" | "start_today" | "started" | "reminder_due" | "reminder_soon";
type NotificationTab = "active" | "read" | "snoozed" | "cleared" | "history";
type NotificationSeverity = "danger" | "warning" | "info";
type OverviewSeverity = NotificationSeverity | "none";

interface NotificationItem {
  key: string;
  kind: NotificationKind;
  task: TaskFile;
  date: string;
  title: string;
  message: string;
  severity: NotificationSeverity;
  sort: string;
}

function isReminderItem(plugin: InventTasksPlugin, item: NotificationItem): boolean {
  return plugin.index.findList(item.task.listPath || "")?.config.system_kind === "reminders";
}

function systemKindForItem(plugin: InventTasksPlugin, item: NotificationItem): "reminders" | "short_notes" | undefined {
  return plugin.index.findList(item.task.listPath || "")?.config.system_kind;
}

interface NotificationPrefs {
  dismissed: Record<string, string>;
  snoozed: Record<string, string>;
  read: Record<string, string>;
  returned: Record<string, string>;
}

const UPCOMING_DAYS = 7;
const CLEARED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let activeTab: NotificationTab = "active";

function dayKey(value?: string | null): string | undefined {
  if (!value) return undefined;
  const m = value.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : undefined;
}

export function notificationHasTime(value?: string | null): boolean {
  return !!value && /T\d{2}:\d{2}/.test(value);
}

export function notificationTimeMs(value?: string | null): number | undefined {
  if (!value || !notificationHasTime(value)) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

export function notificationSeverityForDate(plugin: InventTasksPlugin, value?: string | null): OverviewSeverity {
  if (!value) return "none";
  const today = todayInWorkspace(plugin);
  const day = notificationDayKey(plugin, value);
  if (!day) return "none";
  if (day < today) return "danger";
  if (day === today) {
    const ms = notificationTimeMs(value);
    return ms !== undefined && ms <= Date.now() ? "danger" : "warning";
  }
  return "info";
}

function maxSeverity(items: NotificationItem[]): OverviewSeverity {
  return items.some((item) => item.severity === "danger") ? "danger"
    : items.some((item) => item.severity === "warning") ? "warning"
    : items.length ? "info"
    : "none";
}

function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function addMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function fromDateTimeLocal(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

interface DisplayParts { y: number; mo: number; d: number; h: number; mi: number; }

function workspaceTimezone(plugin: InventTasksPlugin): string {
  const tz = plugin.prefs.timezone || "auto";
  return tz === "auto" || tz === "local" ? "" : tz;
}

function partsInWorkspaceTimezone(plugin: InventTasksPlugin, value?: string): DisplayParts | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const tz = workspaceTimezone(plugin);
  if (!tz) return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  try {
    // Cached formatter — this runs per task per render when a fixed timezone
    // is configured, and constructing Intl.DateTimeFormat is expensive.
    const parts = cachedDateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return {
      y: Number(get("year")),
      mo: Number(get("month")) - 1,
      d: Number(get("day")),
      h: Number(get("hour")),
      mi: Number(get("minute")),
    };
  } catch {
    return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  }
}

function todayInWorkspace(plugin: InventTasksPlugin): string {
  const p = partsInWorkspaceTimezone(plugin, new Date().toISOString());
  const pad = (n: number) => String(n).padStart(2, "0");
  return p && Number.isFinite(p.y) ? `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}` : todayKey();
}

function notificationDayKey(plugin: InventTasksPlugin, value?: string | null): string | undefined {
  if (!value) return undefined;
  if (!notificationHasTime(value)) return dayKey(value);
  const p = partsInWorkspaceTimezone(plugin, value);
  if (!p || !Number.isFinite(p.y)) return dayKey(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}`;
}

export function notificationSortDateTimeKey(plugin: InventTasksPlugin, value: string): string {
  const day = notificationDayKey(plugin, value) ?? value.slice(0, 10);
  const p = notificationHasTime(value) ? partsInWorkspaceTimezone(plugin, value) : null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return p && Number.isFinite(p.y)
    ? `${day}:0:${pad(p.h)}:${pad(p.mi)}`
    : `${day}:1:99:99`;
}

function formatDisplayDateTime(plugin: InventTasksPlugin, value?: string): string {
  const p = partsInWorkspaceTimezone(plugin, value);
  if (!p || !Number.isFinite(p.y)) return value || "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateFmt = plugin.prefs.dateFormat ?? "YYYY-MM-DD";
  const timeFmt = plugin.prefs.timeFormat ?? "HH:mm";
  const date = dateFmt.replace(/YYYY|YY|MMM|MM|DD|M|D/g, (tok) => {
    const map: Record<string, string> = {
      YYYY: String(p.y),
      YY: pad(p.y % 100),
      MMM: (monthName(p.mo) || "").slice(0, 3),
      MM: pad(p.mo + 1),
      M: String(p.mo + 1),
      DD: pad(p.d),
      D: String(p.d),
    };
    return map[tok] ?? tok;
  });
  const time = timeFmt === "HH:mm"
    ? `${pad(p.h)}:${pad(p.mi)}`
    : `${pad((p.h % 12) || 12)}:${pad(p.mi)} ${p.h < 12 ? "AM" : "PM"}`;
  return `${date} ${time}`;
}

function formatDisplayDate(plugin: InventTasksPlugin, value?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  const p = m
    ? { y: Number(m[1]), mo: Number(m[2]) - 1, d: Number(m[3]), h: 0, mi: 0 }
    : partsInWorkspaceTimezone(plugin, value);
  if (!p || !Number.isFinite(p.y)) return value || "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateFmt = plugin.prefs.dateFormat ?? "YYYY-MM-DD";
  return dateFmt.replace(/YYYY|YY|MMM|MM|DD|M|D/g, (tok) => {
    const map: Record<string, string> = {
      YYYY: String(p.y),
      YY: pad(p.y % 100),
      MMM: (monthName(p.mo) || "").slice(0, 3),
      MM: pad(p.mo + 1),
      M: String(p.mo + 1),
      DD: pad(p.d),
      D: String(p.d),
    };
    return map[tok] ?? tok;
  });
}

function dateTimeLocalInWorkspace(plugin: InventTasksPlugin, iso?: string): string {
  const p = partsInWorkspaceTimezone(plugin, iso || new Date().toISOString());
  if (!p || !Number.isFinite(p.y)) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

function zoneOffsetMs(dateUtc: Date, tz: string): number {
  const parts = cachedDateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(dateUtc);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - dateUtc.getTime();
}

function dateTimeLocalToWorkspaceIso(plugin: InventTasksPlugin, value: string): string | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return fromDateTimeLocal(value);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5]);
  const tz = workspaceTimezone(plugin);
  if (!tz) return new Date(y, mo - 1, d, h, mi).toISOString();
  if (tz === "UTC") return new Date(Date.UTC(y, mo - 1, d, h, mi)).toISOString();
  try {
    let utc = Date.UTC(y, mo - 1, d, h, mi);
    let offset = zoneOffsetMs(new Date(utc), tz);
    utc = Date.UTC(y, mo - 1, d, h, mi) - offset;
    offset = zoneOffsetMs(new Date(utc), tz);
    return new Date(Date.UTC(y, mo - 1, d, h, mi) - offset).toISOString();
  } catch {
    return new Date(y, mo - 1, d, h, mi).toISOString();
  }
}

function notificationKey(task: TaskFile, kind: NotificationKind, date: string): string {
  return `${task.data.id}:${kind}:${date}`;
}

function listLabel(plugin: InventTasksPlugin, task: TaskFile): string {
  if (!task.listPath) return "";
  return plugin.index.findList(task.listPath)?.config.name || task.data.list || task.listPath;
}

function ensurePrefs(plugin: InventTasksPlugin): NotificationPrefs {
  plugin.prefs.notifications ||= { dismissed: {}, snoozed: {}, read: {}, returned: {} };
  plugin.prefs.notifications.dismissed ||= {};
  plugin.prefs.notifications.snoozed ||= {};
  plugin.prefs.notifications.read ||= {};
  plugin.prefs.notifications.returned ||= {};
  return plugin.prefs.notifications as NotificationPrefs;
}

function reminderValues(task: TaskFile): string[] {
  const raw = task.data as unknown as { reminder_at?: unknown; reminders?: unknown };
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
    else if (v && typeof v === "object" && typeof (v as { at?: unknown }).at === "string") out.push((v as { at: string }).at);
  };
  push(raw.reminder_at);
  if (Array.isArray(raw.reminders)) raw.reminders.forEach(push);
  return out;
}

function stateFor(item: NotificationItem, prefs: NotificationPrefs, nowIso: string): NotificationTab {
  if (prefs.dismissed[item.key]) return "cleared";
  if (prefs.snoozed[item.key] && prefs.snoozed[item.key] > nowIso) return "snoozed";
  if (prefs.read[item.key]) return "read";
  return "active";
}

function normalizeNotificationPrefs(plugin: InventTasksPlugin, items: NotificationItem[], prefs = ensurePrefs(plugin)): boolean {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const keys = new Set(items.map((item) => item.key));
  const hasIndexedTasks = plugin.index.allTasks().length > 0;
  let changed = false;

  for (const key of Object.keys(prefs.snoozed)) {
    if (prefs.snoozed[key] <= nowIso) {
      if (keys.has(key)) {
        delete prefs.snoozed[key];
        prefs.returned[key] = nowIso;
        changed = true;
      } else if (hasIndexedTasks) {
        delete prefs.snoozed[key];
        changed = true;
      }
    }
  }
  for (const key of Object.keys(prefs.dismissed)) {
    const ts = Date.parse(prefs.dismissed[key]);
    if (Number.isFinite(ts) && now - ts > CLEARED_RETENTION_MS) {
      delete prefs.dismissed[key];
      delete prefs.read[key];
      delete prefs.snoozed[key];
      delete prefs.returned[key];
      changed = true;
    }
  }
  for (const key of Object.keys(prefs.read)) {
    if (!prefs.read[key]) {
      delete prefs.read[key];
      changed = true;
    }
  }
  for (const key of Object.keys(prefs.returned)) {
    if (!keys.has(key) && hasIndexedTasks) {
      delete prefs.returned[key];
      changed = true;
    }
  }
  return changed;
}

interface NotificationOverviewResult {
  severity: OverviewSeverity;
  active: number;
  activeSignature: string;
  reminderSeverity: OverviewSeverity;
  reminderActiveSignature: string;
}

// One render burst (fullRender → sidebar → docked sidebar → favorites panel)
// asks for the overview several times in the same synchronous task, and each
// computation walks EVERY task. Cache the result for the duration of the
// current task only — a microtask clears it, so any user action or index
// change sees fresh data while the duplicated work inside one burst is free.
let overviewCache: { plugin: InventTasksPlugin; generation: number; result: NotificationOverviewResult } | null = null;

export function notificationOverview(plugin: InventTasksPlugin): NotificationOverviewResult {
  if (overviewCache && overviewCache.plugin === plugin && overviewCache.generation === plugin.index.generation) {
    return overviewCache.result;
  }
  const prefs = ensurePrefs(plugin);
  const nowIso = new Date().toISOString();
  const items = buildNotifications(plugin);
  const changed = normalizeNotificationPrefs(plugin, items, prefs);
  if (changed) void plugin.saveSettings();
  const active = items.filter((item) => stateFor(item, prefs, nowIso) === "active");
  const reminderActive = active.filter((item) => isReminderItem(plugin, item));
  const activeSignature = active.map((item) => `${item.key}:${item.severity}`).sort().join("|");
  const reminderActiveSignature = reminderActive.map((item) => `${item.key}:${item.severity}`).sort().join("|");
  const result: NotificationOverviewResult = {
    severity: maxSeverity(active),
    active: active.length,
    activeSignature,
    reminderSeverity: maxSeverity(reminderActive),
    reminderActiveSignature,
  };
  overviewCache = { plugin, generation: plugin.index.generation, result };
  queueMicrotask(() => { overviewCache = null; });
  return result;
}

export function buildNotifications(plugin: InventTasksPlugin, today = todayInWorkspace(plugin)): NotificationItem[] {
  const soon = addDays(today, UPCOMING_DAYS);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const items: NotificationItem[] = [];

  const displayDate = (value: string) => notificationHasTime(value) ? formatDisplayDateTime(plugin, value) : formatDisplayDate(plugin, value);

  const add = (task: TaskFile, kind: NotificationKind, date: string, message: string, severity: NotificationSeverity) => {
    items.push({
      key: notificationKey(task, kind, date),
      kind,
      task,
      date,
      title: task.data.title || task.data.id || t("fallback.untitledTask"),
      message,
      severity,
      sort: `${notificationSortDateTimeKey(plugin, date)}:${task.data.title || ""}`,
    });
  };

  for (const task of plugin.index.allTasks()) {
    if (task.data.archived) continue;
    if (!plugin.index.resolveNotificationsEnabledForTask(task)) continue;
    if (task.data.status_group === "closed" || task.data.status_group === "done") continue;

    const dueRaw = typeof task.data.due_date === "string" ? task.data.due_date : "";
    const due = notificationDayKey(plugin, dueRaw);
    let dueNotificationAdded = false;
    if (due) {
      const dueKey = notificationHasTime(dueRaw) ? dueRaw : due;
      const dueTime = notificationTimeMs(dueRaw);
      if (due < today || (due === today && dueTime !== undefined && dueTime <= now)) {
        add(task, "overdue", dueKey, t("notifications.overdue", { date: displayDate(dueKey) }), "danger");
        dueNotificationAdded = true;
      } else if (due === today) {
        add(task, "due_today", dueKey, t("notifications.dueToday", { date: displayDate(dueKey) }), "warning");
        dueNotificationAdded = true;
      } else if (due <= soon) {
        add(task, "due_soon", dueKey, t("notifications.dueSoon", { date: displayDate(dueKey) }), "info");
        dueNotificationAdded = true;
      }
    }

    const startRaw = typeof task.data.start_date === "string" ? task.data.start_date : "";
    const start = notificationDayKey(plugin, startRaw);
    if (start && !dueNotificationAdded) {
      const startKey = notificationHasTime(startRaw) ? startRaw : start;
      if (start === today) add(task, "start_today", startKey, t("notifications.startToday"), "info");
      else if (start < today) add(task, "started", startKey, t("notifications.started", { date: displayDate(startKey) }), "info");
    }

    for (const reminder of reminderValues(task)) {
      const date = notificationDayKey(plugin, reminder);
      if (!date) continue;
      const reminderTime = notificationTimeMs(reminder);
      const iso = new Date(reminder).toISOString();
      if (iso <= nowIso) {
        const severity: NotificationSeverity = date < today || (date === today && reminderTime !== undefined && reminderTime <= now) ? "danger" : "warning";
        add(task, "reminder_due", reminder, t("notifications.reminderDue", { date: formatDisplayDateTime(plugin, reminder) }), severity);
      }
      else if (date <= soon) add(task, "reminder_soon", reminder, t("notifications.reminderSoon", { date: formatDisplayDateTime(plugin, reminder) }), "info");
    }
  }

  return items.sort((a, b) => a.sort.localeCompare(b.sort));
}

async function saveAndRefresh(plugin: InventTasksPlugin, rerender: () => void) {
  await plugin.saveSettings();
  rerender();
}

function clearState(prefs: NotificationPrefs, key: string) {
  delete prefs.read[key];
  delete prefs.snoozed[key];
  delete prefs.dismissed[key];
  delete prefs.returned[key];
}

function markRead(plugin: InventTasksPlugin, prefs: NotificationPrefs, key: string, rerender: () => void) {
  delete prefs.snoozed[key];
  delete prefs.dismissed[key];
  delete prefs.returned[key];
  prefs.read[key] = new Date().toISOString();
  void saveAndRefresh(plugin, rerender);
}

function markCleared(plugin: InventTasksPlugin, prefs: NotificationPrefs, item: NotificationItem, rerender: () => void) {
  const key = item.key;
  if (plugin.index.findList(item.task.listPath || "")?.config.system_kind === "reminders") {
    new ConfirmModal(plugin.app, {
      title: t("system.deleteTitle"),
      message: t("system.deleteMsg", { title: item.task.data.title || t("common.untitled") }),
      destructive: true,
      onConfirm: fireAndForget(async () => {
        delete prefs.snoozed[key];
        delete prefs.read[key];
        delete prefs.returned[key];
        delete prefs.dismissed[key];
        await plugin.index.deleteTask(item.task.data.id);
        await saveAndRefresh(plugin, rerender);
      }),
    }).open();
    return;
  }
  delete prefs.snoozed[key];
  delete prefs.read[key];
  delete prefs.returned[key];
  prefs.dismissed[key] = new Date().toISOString();
  void saveAndRefresh(plugin, rerender);
}

function restore(plugin: InventTasksPlugin, prefs: NotificationPrefs, key: string, rerender: () => void) {
  clearState(prefs, key);
  void saveAndRefresh(plugin, rerender);
}

function setSnooze(plugin: InventTasksPlugin, prefs: NotificationPrefs, key: string, until: string, rerender: () => void) {
  delete prefs.read[key];
  delete prefs.dismissed[key];
  delete prefs.returned[key];
  prefs.snoozed[key] = until;
  void saveAndRefresh(plugin, rerender);
}

function renderSnoozePopover(target: HTMLElement, plugin: InventTasksPlugin, prefs: NotificationPrefs, key: string, rerender: () => void) {
  showPopover(target, (root) => {
    const box = root.createDiv({ cls: "it-notification-snooze-popover" });
    const presets: Array<[string, number]> = [
      [t("notifications.plus1h"), 60 * 60 * 1000],
      [t("notifications.plus2h"), 2 * 60 * 60 * 1000],
      [t("notifications.plus4h"), 4 * 60 * 60 * 1000],
      [t("notifications.plus1d"), 24 * 60 * 60 * 1000],
      [t("notifications.plus2d"), 2 * 24 * 60 * 60 * 1000],
      [t("notifications.plus7d"), 7 * 24 * 60 * 60 * 1000],
      [t("notifications.plus1m"), 30 * 24 * 60 * 60 * 1000],
    ];
    const grid = box.createDiv({ cls: "it-notification-snooze-grid" });
    for (const [label, ms] of presets) {
      grid.createEl("button", { text: label, cls: "it-btn-ghost" }).addEventListener("click", () => {
        setSnooze(plugin, prefs, key, addMs(ms), rerender);
        document.querySelectorAll(".it-popover").forEach((el) => el.remove());
      });
    }

    const custom = box.createDiv({ cls: "it-notification-custom-snooze" });
    custom.createSpan({ text: t("notifications.customSnooze") });
    const input = custom.createEl("input", { type: "datetime-local" });
    input.value = dateTimeLocalInWorkspace(plugin, prefs.snoozed[key]);
    custom.createEl("button", { text: t("common.apply"), cls: "it-btn-secondary" }).addEventListener("click", () => {
      const iso = dateTimeLocalToWorkspaceIso(plugin, input.value);
      if (!iso) return;
      setSnooze(plugin, prefs, key, iso, rerender);
      document.querySelectorAll(".it-popover").forEach((el) => el.remove());
    });
  });
}

function notificationIconButton(parent: HTMLElement, icon: string, label: string, extraCls = ""): HTMLButtonElement {
  const btn = parent.createEl("button", {
    cls: `it-icon-btn it-notification-icon-btn${extraCls ? ` ${extraCls}` : ""}`,
    attr: {
      "aria-label": label,
      title: label,
    },
  });
  setIcon(btn, icon);
  return btn;
}

// ---- Notification history (cross-workspace log) ----

const HISTORY_KIND_ICON: Record<MergedHistoryEntry["kind"], string> = {
  overdue: "alert-triangle",
  reminder: "bell",
  started: "rocket",
  digest: "newspaper",
  batch: "list-checks",
};
const HISTORY_KIND_SEVERITY: Record<MergedHistoryEntry["kind"], NotificationSeverity> = {
  overdue: "danger",
  reminder: "warning",
  started: "info",
  digest: "info",
  batch: "warning",
};
const CHANNEL_ICON: Record<NotifChannel, string> = {
  system: "monitor",
  ntfy: "smartphone",
};
const HISTORY_CHANNEL_ORDER: Record<NotifChannel, number> = { system: 0, ntfy: 1 };

function channelLabel(ch: NotifChannel): string {
  return ch === "system" ? t("notifications.chSystem") : t("notifications.chNtfy");
}

function historyKindLabel(entry: MergedHistoryEntry): string {
  switch (entry.kind) {
    case "overdue": return t("notifications.histOverdue");
    case "reminder": return t("notifications.histReminder");
    case "started": return t("notifications.histStarted");
    case "digest": return t("notifications.histDigest", { count: String(entry.count ?? 0) });
    case "batch": return t("notifications.histBatch", { count: String(entry.count ?? entry.items?.length ?? 0) });
  }
}

function reminderOffsetLabel(minutes: number): string {
  if (minutes === 15) return t("extNotif.reminder.15min");
  if (minutes === 60) return t("extNotif.reminder.1h");
  if (minutes === 1440) return t("extNotif.reminder.1d");
  if (minutes < 60) return t("notifications.histOffsetMinutes", { count: String(minutes) });
  if (minutes < 1440) return t("notifications.histOffsetHours", { count: String(Math.round(minutes / 60)) });
  return t("notifications.histOffsetDays", { count: String(Math.round(minutes / 1440)) });
}

function historyReasonLabel(kind: NotifHistoryItem["kind"], minutesBefore?: number): string {
  if (kind === "reminder") {
    return minutesBefore != null
      ? t("notifications.histReminderWithOffset", { offset: reminderOffsetLabel(minutesBefore) })
      : t("notifications.histReminder");
  }
  if (kind === "overdue") return t("notifications.histOverdue");
  return t("notifications.histStarted");
}

function entryReasonLabel(entry: MergedHistoryEntry): string {
  if (entry.kind === "reminder") return historyReasonLabel("reminder", entry.minutesBefore);
  if (entry.kind === "overdue" || entry.kind === "started") return historyReasonLabel(entry.kind);
  return historyKindLabel(entry);
}

function historyChannelStates(entry: MergedHistoryEntry): Array<{ channel: NotifChannel; ok: boolean; message?: string }> {
  // History synced from older versions can still name the removed email
  // channel; it has no icon or label any more, so it is left out.
  return (entry.channels || [])
    .filter((r) => r.channel in CHANNEL_ICON)
    .sort((a, b) => HISTORY_CHANNEL_ORDER[a.channel] - HISTORY_CHANNEL_ORDER[b.channel])
    .map((r) => ({ channel: r.channel, ok: r.ok, message: r.message }));
}

function historyEntryForItem(entry: MergedHistoryEntry, item: NotifHistoryItem): MergedHistoryEntry {
  return {
    ...entry,
    kind: item.kind,
    taskId: item.taskId,
    taskTitle: item.taskTitle,
    listPath: item.listPath,
    minutesBefore: item.minutesBefore,
  };
}

function clearAllHistory(plugin: InventTasksPlugin, rerender: () => void) {
  new ConfirmModal(plugin.app, {
    title: t("notifications.clearHistoryTitle"),
    message: t("notifications.clearHistoryMsg"),
    destructive: true,
    confirmLabel: t("notifications.clearHistoryConfirm"),
    onConfirm: fireAndForget(async () => {
      // Tombstoned clear: the recorded clear time survives merges, so entries
      // from another device's not-yet-synced file can't resurrect, while every
      // NEW notification is recorded normally from the next send on.
      const at = new Date().toISOString();
      for (const ws of plugin.settings.workspaces) {
        clearHistory(ensureNotifState(ws), at);
      }
      await plugin.saveSettings();
      rerender();
    }),
  }).open();
}

function renderHistoryTab(
  wrap: HTMLElement,
  plugin: InventTasksPlugin,
  history: MergedHistoryEntry[],
  rerender: () => void,
  onHistoryClick?: (entry: MergedHistoryEntry) => void,
) {
  if (!history.length) {
    const empty = wrap.createDiv({ cls: "it-notifications-empty" });
    empty.createEl("h3", { text: t("notifications.empty.history") });
    empty.createEl("p", { text: t("notifications.historyEmptyDesc") });
    return;
  }

  const bar = wrap.createDiv({ cls: "it-notifications-history-bar" });
  const clearBtn = bar.createEl("button", { cls: "it-btn-ghost it-history-clear-btn" });
  setIcon(clearBtn.createSpan(), "trash-2");
  clearBtn.createSpan({ text: t("notifications.clearHistory") });
  clearBtn.addEventListener("click", () => clearAllHistory(plugin, rerender));

  for (const entry of history) {
    const batchItems = entry.kind === "batch" ? (entry.items || []) : [];
    const expandableBatch = batchItems.length > 0;
    const severity = HISTORY_KIND_SEVERITY[entry.kind];
    const clickable = !!entry.taskId && !expandableBatch;
    const details = expandableBatch ? wrap.createEl("details", { cls: "it-notification-history-group" }) : null;
    const row = details
      ? details.createEl("summary", {
        cls: `it-notification-row it-notification-history-row it-notification-history-summary is-${severity} is-expandable`,
      })
      : wrap.createDiv({
        cls: `it-notification-row it-notification-history-row is-${severity}${clickable ? "" : " is-static"}`,
      });
    if (clickable && onHistoryClick) row.addEventListener("click", () => onHistoryClick(entry));

    row.createSpan({ cls: "it-notification-marker" }).setAttribute("aria-hidden", "true");

    const body = row.createDiv({ cls: "it-notification-body" });
    const titleEl = body.createDiv({ cls: "it-notification-title" });
    setIcon(titleEl.createSpan({ cls: "it-notification-reminder-icon" }), HISTORY_KIND_ICON[entry.kind]);
    titleEl.createSpan({
      text: entry.kind === "digest" || entry.kind === "batch" ? historyKindLabel(entry) : (entry.taskTitle || t("fallback.untitledTask")),
    });

    const meta = body.createDiv({ cls: "it-notification-meta" });
    meta.createSpan({ cls: "it-notification-ws-badge", text: entry.workspaceName });
    if (entry.kind !== "digest" && entry.kind !== "batch") meta.createSpan({ text: ` • ${entryReasonLabel(entry)}` });
    meta.createSpan({ text: ` • ${formatDisplayDateTime(plugin, entry.ts)}` });
    if ((entry.attempts || 1) > 1) meta.createSpan({ text: ` • ×${entry.attempts}` });

    const channels = row.createDiv({ cls: "it-notification-history-channels" });
    for (const { channel: ch, ok, message } of historyChannelStates(entry)) {
      const label = ok
        ? t("notifications.histChannelOk", { channel: channelLabel(ch) })
        : t("notifications.histChannelFailed", { channel: channelLabel(ch) }) + (message ? ` — ${message}` : "");
      const chSpan = channels.createSpan({
        cls: `it-notification-channel-icon${ok ? "" : " is-failed"}`,
        attr: { "aria-label": label, title: label },
      });
      setIcon(chSpan, CHANNEL_ICON[ch]);
    }
    if (expandableBatch) setIcon(channels.createSpan({ cls: "it-notification-history-caret" }), "chevron-down");

    if (details) {
      const itemsWrap = details.createDiv({ cls: "it-notification-history-items" });
      for (const item of batchItems) {
        const itemRow = itemsWrap.createDiv({ cls: "it-notification-history-item" });
        const taskLabel = item.taskTitle || t("fallback.untitledTask");
        if (item.taskId && onHistoryClick) {
          const link = itemRow.createEl("button", {
            cls: "it-notification-history-task-link",
            text: taskLabel,
            attr: { type: "button" },
          });
          link.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onHistoryClick(historyEntryForItem(entry, item));
          });
        } else {
          itemRow.createSpan({ cls: "it-notification-history-task-text", text: taskLabel });
        }
        itemRow.createSpan({ cls: "it-notification-history-reason", text: historyReasonLabel(item.kind, item.minutesBefore) });
      }
    }
  }
}

export function renderNotificationsView(opts: {
  parent: HTMLElement;
  plugin: InventTasksPlugin;
  onTaskClick: (task: TaskFile) => void;
  onHistoryClick?: (entry: MergedHistoryEntry) => void;
  rerender: () => void;
}) {
  const { parent, plugin, onTaskClick, onHistoryClick, rerender } = opts;
  const prefs = ensurePrefs(plugin);
  const rawItems = buildNotifications(plugin);
  if (normalizeNotificationPrefs(plugin, rawItems, prefs)) void plugin.saveSettings();
  const nowIso = new Date().toISOString();
  const allItems = rawItems;
  // History is a cross-workspace log of external notification attempts, kept
  // separate from the (computed, active-workspace) attention items above.
  const history = mergeNotifHistory(plugin.settings.workspaces);
  const counts: Record<NotificationTab, number> = { active: 0, read: 0, snoozed: 0, cleared: 0, history: history.length };
  for (const item of allItems) counts[stateFor(item, prefs, nowIso)]++;
  const items = allItems.filter((item) => stateFor(item, prefs, nowIso) === activeTab);

  const wrap = parent.createDiv({ cls: "it-notifications" });
  const head = wrap.createDiv({ cls: "it-notifications-head" });
  const title = head.createEl("h2", { attr: { title: t("notifications.desc") } });
  setIcon(title.createSpan({ cls: "it-notifications-title-icon" }), "bell");
  title.createSpan({ text: navLabel("notifications") });
  head.createSpan({ cls: "it-notifications-count", text: `${counts.active}` });

  const tabs = wrap.createDiv({ cls: "it-notifications-tabs" });
  const tabDefs: Array<[NotificationTab, string]> = [
    ["active", t("notifications.tabActive")],
    ["read", t("notifications.tabRead")],
    ["snoozed", t("notifications.tabSnoozed")],
    ["cleared", t("notifications.tabCleared")],
    ["history", t("notifications.tabHistory")],
  ];
  for (const [tab, label] of tabDefs) {
    const btn = tabs.createEl("button", { cls: "it-notifications-tab" + (activeTab === tab ? " is-active" : "") });
    btn.createSpan({ text: label });
    btn.createSpan({ cls: "it-notifications-tab-count", text: String(counts[tab]) });
    btn.addEventListener("click", () => {
      activeTab = tab;
      rerender();
    });
  }

  // History tab has its own (cross-workspace, log-based) rendering.
  if (activeTab === "history") {
    renderHistoryTab(wrap, plugin, history, rerender, onHistoryClick);
    return;
  }

  if (!items.length) {
    const empty = wrap.createDiv({ cls: "it-notifications-empty" });
    empty.createEl("h3", { text: t(`notifications.empty.${activeTab}`) });
    empty.createEl("p", { text: t("notifications.emptyDesc") });
    return;
  }

  for (const item of items) {
    const snoozedUntil = prefs.snoozed[item.key];
    const systemKind = systemKindForItem(plugin, item);
    const row = wrap.createDiv({
      cls: `it-notification-row is-${item.severity}${activeTab === "read" ? " is-read" : ""}${isReminderItem(plugin, item) ? " is-reminder" : ""}`,
    });
    if (systemKind) {
      row.addEventListener("click", () => {
        void import("./system-list-view").then(({ SystemItemModal }) => {
          new SystemItemModal(plugin.app, plugin, systemKind, item.task, rerender).open();
        });
      });
    } else {
      row.addEventListener("click", () => onTaskClick(item.task));
    }

    const marker = row.createSpan({ cls: "it-notification-marker" });
    marker.setAttribute("aria-hidden", "true");

    const body = row.createDiv({ cls: "it-notification-body" });
    const title = body.createDiv({ cls: "it-notification-title" });
    if (isReminderItem(plugin, item)) {
      const reminderIcon = title.createSpan({ cls: "it-notification-reminder-icon" });
      setIcon(reminderIcon, "alarm-clock");
    }
    title.createSpan({ text: item.title });
    const meta = body.createDiv({ cls: "it-notification-meta" });
    meta.createSpan({ text: item.message });
    const list = listLabel(plugin, item.task);
    if (list) meta.createSpan({ text: ` • ${list}` });
    if (prefs.returned[item.key]) {
      body.createDiv({
        cls: "it-notification-submeta it-notification-returned",
        text: t("notifications.returnedFromSnooze", { date: formatDisplayDateTime(plugin, prefs.returned[item.key]) }),
      });
    }
    if (snoozedUntil) body.createDiv({ cls: "it-notification-submeta", text: t("notifications.snoozedUntil", { date: formatDisplayDateTime(plugin, snoozedUntil) }) });
    if (prefs.read[item.key]) body.createDiv({ cls: "it-notification-submeta", text: t("notifications.readAt", { date: formatDisplayDateTime(plugin, prefs.read[item.key]) }) });
    if (prefs.dismissed[item.key]) body.createDiv({ cls: "it-notification-submeta", text: t("notifications.clearedAt", { date: formatDisplayDateTime(plugin, prefs.dismissed[item.key]) }) });

    const actions = row.createDiv({ cls: "it-notification-actions" });
    const stop = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    if (systemKind) {
      notificationIconButton(actions, "pencil", t("common.edit")).addEventListener("click", (ev) => {
        stop(ev);
        void import("./system-list-view").then(({ SystemItemModal }) => {
          new SystemItemModal(plugin.app, plugin, systemKind, item.task, rerender, { editDescription: true }).open();
        });
      });
    } else {
      notificationIconButton(actions, "external-link", t("notifications.open")).addEventListener("click", (ev) => {
        stop(ev);
        onTaskClick(item.task);
      });
    }
    const snoozeBtn = notificationIconButton(actions, "clock", activeTab === "snoozed" ? t("notifications.editSnooze") : t("notifications.snooze"));
    snoozeBtn.addEventListener("click", (ev) => {
      stop(ev);
      renderSnoozePopover(snoozeBtn, plugin, prefs, item.key, rerender);
    });
    if (activeTab === "snoozed") {
      notificationIconButton(actions, "clock-x", t("notifications.removeSnooze")).addEventListener("click", (ev) => {
        stop(ev);
        delete prefs.snoozed[item.key];
        delete prefs.returned[item.key];
        void saveAndRefresh(plugin, rerender);
      });
    } else {
      notificationIconButton(actions, "calendar-plus", t("notifications.plus1d")).addEventListener("click", (ev) => {
        stop(ev);
        setSnooze(plugin, prefs, item.key, addMs(24 * 60 * 60 * 1000), rerender);
      });
    }
    if (activeTab !== "read") {
      notificationIconButton(actions, "check", t("notifications.read")).addEventListener("click", (ev) => {
        stop(ev);
        markRead(plugin, prefs, item.key, rerender);
      });
    }
    if (activeTab !== "cleared") {
      notificationIconButton(actions, "archive", t("notifications.clear")).addEventListener("click", (ev) => {
        stop(ev);
        markCleared(plugin, prefs, item, rerender);
      });
    }
    if (activeTab !== "active") {
      notificationIconButton(actions, "rotate-ccw", t("notifications.restore")).addEventListener("click", (ev) => {
        stop(ev);
        restore(plugin, prefs, item.key, rerender);
      });
    }
    if (activeTab === "cleared") {
      notificationIconButton(actions, "trash-2", t("notifications.deleteForever"), "it-danger").addEventListener("click", (ev) => {
        stop(ev);
        new ConfirmModal(plugin.app, {
          title: t("trash.deleteForeverTitle"),
          message: t("trash.deleteForeverMsg", { name: item.title, extra: "" }),
          destructive: true,
          confirmLabel: t("trash.deleteForever"),
          onConfirm: fireAndForget(async () => {
            clearState(prefs, item.key);
            await saveAndRefresh(plugin, rerender);
          }),
        }).open();
      });
    }
  }
}
