// Pure decision logic for external notifications.
//
// Intentionally free of runtime imports (only `import type`) so it can be
// unit-tested in isolation and reused for every workspace (active and
// background). It decides WHICH tasks fire WHICH trigger on WHICH channels
// and which dedup keys to record — but performs no I/O. The NotificationCenter
// turns the plan into actual sends.
//
// Core rule — one winner per task: when several triggers are eligible for the
// same task in the same check (e.g. the app was closed for a week and the task
// is now overdue with every pre-due tier pending), only the MOST important one
// fires and the rest are marked handled:
//
//   overdue  >  reminder (alarm)  >  started  >  15 min  >  1 h  >  1 d
//
// Escalation over time still works: a tier that becomes eligible on a later
// day fires then — only simultaneous eligibility is collapsed.

import type { TaskFile } from "../types";
import type { NotifChannel, WorkspaceNotifConfig, NotifRuntimeState } from "./types";

/** How often the scheduler wakes to check for due notifications (ms). */
export const TICK_INTERVAL_MS = 60_000;

/** Per-task channel allowance (location toggles × workspace toggles × account readiness). */
export type ChannelAllow = { system: boolean; ntfy: boolean };

// ---- Time helpers ----

export function dateKeyFromMs(now: number): string {
  const n = new Date(now);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

export function hhmmFromMs(now: number): string {
  const n = new Date(now);
  return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
}

/** Normalize digest time from settings / `<input type="time">` to "HH:MM". */
export function normalizeDigestTime(time: string | undefined): string {
  const m = (time || "08:00").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "08:00";
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// ---- Deduplication ----
//
// Key shapes (the date tag re-arms everything when the user moves the date):
//   overdue:<task>:<dueTag>        — re-fires once per calendar day until done
//   alarm:<task>:<dueTag>          — explicit reminder, fires once
//   tier:<task>:<mins>:<dueTag>    — pre-due tier, fires once per tier
//   started:<task>:<startTag>      — start event, fires once

export function alreadySent(state: NotifRuntimeState, key: string, today: string): boolean {
  const ts = state.sent[key];
  if (!ts) return false;
  if (key.startsWith("overdue:")) {
    // Compare LOCAL calendar days (`today` is a local date key) — slicing the
    // UTC ISO timestamp would re-fire around midnight in non-UTC timezones.
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? dateKeyFromMs(ms) === today : true;
  }
  return true;
}

export function markSent(state: NotifRuntimeState, key: string, cap = 500): void {
  state.sent[key] = new Date().toISOString();
  const entries = Object.entries(state.sent);
  if (entries.length > cap) {
    state.sent = Object.fromEntries(entries.sort((a, b) => b[1].localeCompare(a[1])).slice(0, cap));
  }
}

// ---- Plan model ----

export type NotifIntentKind = "overdue" | "reminder" | "started";

export interface NotifIntent {
  kind: NotifIntentKind;
  task: TaskFile;
  /** Effective channels — always non-empty (channel-less candidates lose
   *  eligibility instead of being silently marked sent). */
  channels: NotifChannel[];
  /** Pre-due tier that fired, in minutes. Unset for explicit alarms. */
  minutesBefore?: number;
  /** Dedup keys to record once the intent is delivered — the winner's own key
   *  plus every simultaneous loser's, so the rest of the pile-up stays quiet. */
  sentKeys: string[];
}

export interface DigestIntent {
  channel: NotifChannel;
  /** Tasks scoped to this channel via per-location toggles. */
  tasks: TaskFile[];
}

export interface NotifPlan {
  intents: NotifIntent[];
  digests: DigestIntent[];
  /** When set, record state.lastDigestDate/Time after the digest is delivered. */
  setLastDigestDate?: string;
  setLastDigestTime?: string;
}

export interface PlanContext {
  /** Channels that can physically deliver right now (workspace toggles ∩
   *  account readiness). Computed once per workspace by the center. */
  ready: ChannelAllow;
  /** Per-task location toggles (notifications_enabled + notify_*). */
  resolveAllow: (task: TaskFile) => ChannelAllow;
  /** True when the task is an explicit alarm (Reminders system list item). */
  isReminderItem: (task: TaskFile) => boolean;
  /** Injectable clock (tests); defaults derived from `now`. */
  clock?: { today: string; hhmm: string };
}

interface Candidate {
  kind: NotifIntentKind;
  rank: number;            // higher wins
  key: string;
  minutesBefore?: number;
  channels: NotifChannel[];
}

const RANK = { overdue: 600, reminder: 500, started: 400 } as const;
/** Tiers rank below every named kind; closer-to-due tiers win among themselves. */
function tierRank(minutesBefore: number): number {
  return 300 - Math.min(299, minutesBefore / 60);
}

function isActiveStatus(task: TaskFile): boolean {
  const g = task.data.status_group;
  return g !== "done" && g !== "closed";
}

function intersect(
  trigger: { enabled: boolean; channels: NotifChannel[] },
  allow: ChannelAllow,
  ready: ChannelAllow,
): NotifChannel[] {
  if (!trigger.enabled) return [];
  return trigger.channels.filter((c) => allow[c] && ready[c]);
}

/**
 * Decide everything due at `now` for one workspace. Pure: reads `state.sent`
 * for dedup but does not mutate it — the caller records the returned
 * `sentKeys` / digest markers after delivery.
 */
export function planNotifications(
  tasks: TaskFile[],
  config: WorkspaceNotifConfig,
  state: NotifRuntimeState,
  now: number,
  ctx: PlanContext,
): NotifPlan {
  const plan: NotifPlan = { intents: [], digests: [] };
  if (!config.enabled) return plan;
  if (!ctx.ready.system && !ctx.ready.ntfy) return plan;

  const today = ctx.clock?.today ?? dateKeyFromMs(now);
  const triggers = config.triggers;

  for (const task of tasks) {
    const d = task.data;
    if (!isActiveStatus(task)) continue;
    const allow = ctx.resolveAllow(task);
    if (!allow.system && !allow.ntfy) continue;

    const taskId = d.id || task.filePath;
    const dueMs = d.due_date ? Date.parse(d.due_date) : NaN;
    const dueTag = d.due_date ? d.due_date.slice(0, 16) : "";
    const isAlarm = ctx.isReminderItem(task);

    // Gather every trigger eligible RIGHT NOW for this task.
    const candidates: Candidate[] = [];

    if (isFinite(dueMs) && dueMs <= now) {
      if (isAlarm) {
        // Reminders-list items are alarms: one "reminder" at their time, no
        // overdue nagging and no pre-due tiers.
        const key = `alarm:${taskId}:${dueTag}`;
        if (!alreadySent(state, key, today)) {
          candidates.push({ kind: "reminder", rank: RANK.reminder, key, channels: intersect(triggers.reminder, allow, ctx.ready) });
        }
      } else {
        const key = `overdue:${taskId}:${dueTag}`;
        if (!alreadySent(state, key, today)) {
          candidates.push({ kind: "overdue", rank: RANK.overdue, key, channels: intersect(triggers.overdue, allow, ctx.ready) });
        }
      }
    }

    if (!isAlarm && isFinite(dueMs) && triggers.before_due.minutesBefore.length) {
      for (const mins of triggers.before_due.minutesBefore) {
        const windowStart = dueMs - mins * 60_000;
        if (now < windowStart || now >= dueMs) continue;
        const key = `tier:${taskId}:${mins}:${dueTag}`;
        if (alreadySent(state, key, today)) continue;
        candidates.push({
          kind: "reminder",
          rank: tierRank(mins),
          key,
          minutesBefore: mins,
          channels: intersect(triggers.before_due, allow, ctx.ready),
        });
      }
    }

    if (d.start_date) {
      const startMs = Date.parse(d.start_date);
      // Fire once the start time arrives (catching up if we were offline), but
      // not for starts over a day old — enabling notifications on an old vault
      // must not blast a "starting now" for every historical task.
      if (isFinite(startMs) && startMs <= now && now <= startMs + 24 * 60 * 60 * 1000) {
        const key = `started:${taskId}:${d.start_date.slice(0, 16)}`;
        if (!alreadySent(state, key, today)) {
          candidates.push({ kind: "started", rank: RANK.started, key, channels: intersect(triggers.started, allow, ctx.ready) });
        }
      }
    }

    if (!candidates.length) continue;

    // One winner per task: the highest-ranked candidate that can actually
    // deliver. Candidates without channels stay pending (their key is only
    // marked once SOMETHING fires for the task, so nothing is lost while e.g.
    // ntfy is still unconfigured).
    const deliverable = candidates.filter((c) => c.channels.length);
    if (!deliverable.length) continue;
    const winner = deliverable.reduce((best, c) => (c.rank > best.rank ? c : best));

    plan.intents.push({
      kind: winner.kind,
      task,
      channels: winner.channels,
      minutesBefore: winner.minutesBefore,
      sentKeys: candidates.map((c) => c.key),
    });
  }

  // ---- Daily digest (per channel, so per-location toggles apply) ----
  if (triggers.digest.enabled) {
    const digestTime = normalizeDigestTime(triggers.digest.time);
    const hhmm = ctx.clock?.hhmm ?? hhmmFromMs(now);
    const sentForThisSlot = state.lastDigestDate === today
      && normalizeDigestTime(state.lastDigestTime) === digestTime;
    if (hhmm >= digestTime && !sentForThisSlot) {
      for (const channel of triggers.digest.channels) {
        if (!ctx.ready[channel]) continue;
        const scoped = tasks.filter((task) => ctx.resolveAllow(task)[channel]);
        plan.digests.push({ channel, tasks: scoped });
      }
      if (plan.digests.length) {
        plan.setLastDigestDate = today;
        plan.setLastDigestTime = digestTime;
      }
    }
  }

  return plan;
}
