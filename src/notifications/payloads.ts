// Payload builders — turn intents into channel-ready plain text for the
// system and ntfy channels. Pure string building, no I/O.

import type { TaskFile } from "../types";
import type { NotifIntent } from "./engine";
import type { NotifPayload } from "./types";
import { t } from "../i18n";

const PRIORITY_LABEL_KEYS: Record<number, string> = {
  1: "notifPayload.priority.urgent",
  2: "notifPayload.priority.high",
  3: "notifPayload.priority.normal",
  4: "notifPayload.priority.low",
};

export function priorityLabel(p: unknown): string | undefined {
  if (typeof p !== "number") return undefined;
  const key = PRIORITY_LABEL_KEYS[p];
  return key ? t(key) : undefined;
}

export function fmtDateTime(iso?: string | null): string | undefined {
  if (!iso) return undefined;
  const hasTime = /T\d{2}:\d{2}/.test(iso);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return iso;
  const date = `${m[3]}.${m[2]}.${m[1]}`;
  return hasTime ? `${date} ${m[4]}:${m[5]}` : date;
}

export function tierLabel(minutesBefore: number): string {
  if (minutesBefore < 60) return t("notifPayload.tier.minutes", { count: minutesBefore });
  if (minutesBefore < 1440) return t("notifPayload.tier.hours", { count: Math.round(minutesBefore / 60) });
  return t("notifPayload.tier.days", { count: Math.round(minutesBefore / 1440) });
}

export function intentLabel(intent: NotifIntent): string {
  if (intent.kind === "overdue") return t("notifPayload.intent.overdue");
  if (intent.kind === "started") return t("notifPayload.intent.startingNow");
  return intent.minutesBefore != null
    ? t("notifPayload.intent.reminderWithTier", { tier: tierLabel(intent.minutesBefore) })
    : t("notifPayload.intent.reminder");
}

// ---- Single-intent payloads ----

function overduePayload(task: TaskFile, url?: string): NotifPayload {
  const d = task.data;
  const prio = priorityLabel(d.priority);
  const due = fmtDateTime(d.due_date);
  return {
    title: t("notifPayload.overdue.title"),
    body: `*${d.title}*${prio ? ` — ${prio}` : ""}${due ? `\n${t("notifPayload.overdue.wasDue", { date: due })}` : ""}`,
    priority: 5,
    tags: ["warning"],
    clickUrl: url,
  };
}

function alarmPayload(task: TaskFile, url?: string): NotifPayload {
  const d = task.data;
  const at = fmtDateTime(d.due_date);
  return {
    title: t("notifPayload.alarm.title"),
    body: `*${d.title}*${at ? `\n${t("notifPayload.alarm.at", { date: at })}` : ""}`,
    priority: 4,
    tags: ["alarm_clock"],
    clickUrl: url,
  };
}

function tierPayload(task: TaskFile, minutesBefore: number, url?: string): NotifPayload {
  const d = task.data;
  const label = tierLabel(minutesBefore);
  const due = fmtDateTime(d.due_date);
  return {
    title: t("notifPayload.tierReminder.title", { tier: label }),
    body: `*${d.title}*${due ? `\n${t("notifPayload.tierReminder.due", { date: due })}` : ""}`,
    priority: minutesBefore <= 60 ? 4 : 3,
    tags: ["bell"],
    clickUrl: url,
  };
}

function startedPayload(task: TaskFile, url?: string): NotifPayload {
  const d = task.data;
  const start = fmtDateTime(d.start_date);
  return {
    title: t("notifPayload.started.title"),
    body: `${t("notifPayload.started.body", { title: d.title })}${start ? `\n${t("notifPayload.started.start", { date: start })}` : ""}`,
    priority: 3,
    tags: ["rocket"],
    clickUrl: url,
  };
}

export function intentPayload(intent: NotifIntent, url?: string): NotifPayload {
  if (intent.kind === "overdue") return overduePayload(intent.task, url);
  if (intent.kind === "started") return startedPayload(intent.task, url);
  return intent.minutesBefore != null
    ? tierPayload(intent.task, intent.minutesBefore, url)
    : alarmPayload(intent.task, url);
}

// ---- Merged (anti-flood) payload ----

export interface MergeItem {
  kind: "overdue" | "reminder" | "started" | "digest";
  /** Plain-text summary line: "Overdue: Title — 01.06.2026". */
  label: string;
  url?: string;
  /** Full payload used when the item ends up alone in its flush. */
  single: NotifPayload;
  priority: 1 | 2 | 3 | 4 | 5;
  /** Origin workspace — prefixes lines when several workspaces merge. */
  workspaceName?: string;
}

export function mergeItemForIntent(intent: NotifIntent, url: string | undefined, workspaceName: string | undefined): MergeItem {
  const title = intent.task.data.title || t("notifPayload.untitled");
  const date = fmtDateTime(intent.kind === "started" ? intent.task.data.start_date : intent.task.data.due_date);
  const single = intentPayload(intent, url);
  return {
    kind: intent.kind,
    label: `${intentLabel(intent)}: ${title}${date ? ` — ${date}` : ""}`,
    url,
    single,
    priority: single.priority,
    workspaceName,
  };
}

/** Merge several items into one summary notification. */
export function buildMergedPayload(items: MergeItem[]): NotifPayload {
  const multiWs = new Set(items.map((i) => i.workspaceName || "")).size > 1;
  const prefix = (i: MergeItem, text: string) => (multiWs && i.workspaceName ? `[${i.workspaceName}] ${text}` : text);
  const counts: Partial<Record<MergeItem["kind"], number>> = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] || 0) + 1;
  const parts = [
    counts.overdue ? t("notifPayload.count.overdue", { count: counts.overdue }) : "",
    counts.reminder
      ? t(counts.reminder > 1 ? "notifPayload.merged.remindersCount" : "notifPayload.merged.reminderCount", { count: counts.reminder })
      : "",
    counts.started ? t("notifPayload.count.starting", { count: counts.started }) : "",
    counts.digest ? t("notifPayload.merged.digestLabel") : "",
  ].filter(Boolean);
  const title = t("notifPayload.merged.title", { count: items.length });
  const intro = parts.join(", ") || t("notifPayload.merged.introFallback");
  const lines = items.map((i) => `• ${prefix(i, i.label)}${i.url ? `\n  ${i.url}` : ""}`);
  return {
    title,
    body: `${intro}\n${lines.join("\n")}`,
    priority: items.reduce((max, i) => (i.priority > max ? i.priority : max), 1 as MergeItem["priority"]),
    tags: counts.overdue ? ["warning"] : ["bell"],
  };
}

// ---- Daily digest ----

/**
 * Build the daily digest payload from all tasks in scope.
 * Groups: overdue | due today | starting today | due this week.
 */
export function buildDailyDigest(tasks: TaskFile[], today = dateKey(new Date())): NotifPayload {
  const weekEnd = new Date(`${today}T00:00:00`);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = dateKey(weekEnd);

  let overdue = 0;
  let dueToday = 0;
  let startingToday = 0;
  let dueThisWeek = 0;

  for (const task of tasks) {
    const d = task.data;
    if (d.status_group === "done" || d.status_group === "closed") continue;
    const dueDay = d.due_date ? d.due_date.slice(0, 10) : undefined;
    const startDay = d.start_date ? d.start_date.slice(0, 10) : undefined;
    if (dueDay && dueDay < today) overdue++;
    else if (dueDay === today) dueToday++;
    else if (startDay === today) startingToday++;
    else if (dueDay && dueDay > today && dueDay <= weekEndStr) dueThisWeek++;
  }

  const parts: string[] = [];
  if (overdue) parts.push(t("notifPayload.count.overdue", { count: overdue }));
  if (dueToday) parts.push(t("notifPayload.digest.dueTodayCount", { count: dueToday }));
  if (startingToday) parts.push(t("notifPayload.count.starting", { count: startingToday }));
  if (dueThisWeek) parts.push(t("notifPayload.digest.thisWeekCount", { count: dueThisWeek }));
  if (!parts.length) parts.push(t("notifPayload.digest.emptyMessage"));

  return {
    title: t("notifPayload.digest.title", { date: today }),
    body: parts.join(", "),
    priority: overdue > 0 ? 4 : 3,
    tags: overdue > 0 ? ["calendar", "warning"] : ["calendar", "white_check_mark"],
  };
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
