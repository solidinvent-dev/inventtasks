// NotificationCenter — the single runtime that drives external notifications
// for EVERY workspace (active + background). One ticker, one outbox, one
// dispatcher, one history writer.
//
// Flow per tick, per workspace feed:
//   plan (engine) → submit to outbox (anti-flood) → deliver via channels →
//   record history (every attempt, per-channel ok/fail) → rollback dedup keys
//   if nothing delivered → one save per flush.
//
// The center never replaces config/state objects — it mutates the live ones
// supplied by the feeds, so references held across the outbox quiet window
// stay valid (see store.ts for why this matters).

import { Platform } from "obsidian";
import type { TaskFile } from "../types";
import { hhmmKey, todayKey } from "../utils/dates";
import {
  TICK_INTERVAL_MS,
  markSent,
  planNotifications,
  type ChannelAllow,
  type NotifIntent,
} from "./engine";
import { NotifOutbox, OUTBOX_QUIET_MS, type SendResult } from "./outbox";
import { SystemChannel } from "./channels/system";
import { NtfyChannel } from "./channels/ntfy";
import { buildDailyDigest, mergeItemForIntent } from "./payloads";
import { appendHistory, newHistoryId } from "./store";
import type {
  NotifChannel,
  NotifChannelResult,
  NotifHistoryEntry,
  NotifPayload,
  NotifRuntimeState,
  NtfyAccount,
  WorkspaceNotifConfig,
} from "./types";
import { NOTIF_CHANNELS } from "./types";

/** Everything the center needs to know about one workspace. Built fresh by
 *  `getFeeds()` on every tick, so workspace add/remove/switch needs no
 *  attach/detach bookkeeping — but `config`/`state` must be the LIVE objects. */
export interface NotifFeed {
  wsId: string;
  wsName: string;
  /** The active workspace (used by checkNow diagnostics). */
  active?: boolean;
  config: WorkspaceNotifConfig;
  state: NotifRuntimeState;
  tasks: () => TaskFile[];
  /** Per-task location toggles (notifications_enabled + notify_*). */
  resolveAllow: (task: TaskFile) => ChannelAllow;
  /** True for explicit alarms (Reminders system list items). */
  isReminderItem: (task: TaskFile) => boolean;
  linkBuilder: (task: TaskFile) => string | undefined;
}

export interface NotifAccounts {
  ntfy?: NtfyAccount;
}

export interface NotificationCenterOptions {
  getFeeds: () => NotifFeed[];
  getAccounts: () => NotifAccounts;
  /** Persist settings + workspace state files. Called once per outbox flush. */
  save: () => Promise<void>;
  /** UI refresh hook, called after a flush has been saved. */
  onAfterDeliver?: () => void;
  quietMs?: number;
  maxWaitMs?: number;
}

const CHANNEL_ORDER: Record<NotifChannel, number> = { system: 0, ntfy: 1 };

export class NotificationCenter {
  private opts: NotificationCenterOptions;
  private outbox: NotifOutbox;
  private systemChannel = new SystemChannel();
  private ntfyChannel = new NtfyChannel();
  private intervalId: number | null = null;
  private ticking = false;

  constructor(opts: NotificationCenterOptions) {
    this.opts = opts;
    this.outbox = new NotifOutbox({
      quietMs: opts.quietMs ?? (Platform.isMobile ? 250 : OUTBOX_QUIET_MS),
      maxWaitMs: opts.maxWaitMs,
      onAfterFlush: async () => {
        await opts.save();
        opts.onAfterDeliver?.();
      },
    });
  }

  start(): void {
    this.stop();
    // Don't block on the OS permission prompt (it can hang on mobile); the
    // system channel re-checks permission live on every send anyway.
    void this.systemChannel.init();
    void this.tick(); // immediate catch-up
    this.intervalId = window.setInterval(() => void this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.outbox.dispose();
  }

  /** Run one check cycle now. Sends still pass through the outbox quiet
   *  window; call flushNow() afterwards for immediate delivery. */
  async runNow(): Promise<void> {
    await this.tick();
  }

  /** Deliver everything queued in the outbox right now. */
  async flushNow(): Promise<void> {
    await this.outbox.flushNow();
  }

  async requestSystemPermission(): Promise<boolean> {
    return this.systemChannel.requestPermission();
  }

  /** Which channels can physically deliver for a workspace right now. */
  channelReadiness(config: WorkspaceNotifConfig): ChannelAllow {
    const accounts = this.opts.getAccounts();
    return {
      // A channel that cannot deliver on this platform must not be planned for.
      system: config.channels.system && this.systemChannel.isPossible(),
      ntfy: config.channels.ntfy && !!accounts.ntfy?.topic,
    };
  }

  /** Diagnostic: run a check now and return a short human summary (shown via
   *  Notice so mobile users can debug without a console). */
  async checkNow(): Promise<string> {
    const feed = this.opts.getFeeds().find((f) => f.active) ?? this.opts.getFeeds()[0];
    if (!feed) return "no workspace";
    const tasks = feed.tasks();
    if (!feed.config.enabled) return `OFF — enable notifications in settings (tasks=${tasks.length})`;

    const now = Date.now();
    const ready = this.channelReadiness(feed.config);
    const plan = planNotifications(tasks, feed.config, feed.state, now, {
      ready,
      resolveAllow: feed.resolveAllow,
      isReminderItem: feed.isReminderItem,
      clock: { today: todayKey(), hhmm: hhmmKey(new Date(now)) },
    });
    const isActive = (t: TaskFile) => t.data.status_group !== "done" && t.data.status_group !== "closed";
    const withDue = tasks.filter((t) => !!t.data.due_date);
    const pastDue = withDue.filter((t) => {
      const ms = Date.parse(t.data.due_date as string);
      return isFinite(ms) && ms <= now && isActive(t);
    });
    const chans = [...new Set(plan.intents.flatMap((i) => i.channels))].join("/") || "—";
    await this.runNow();
    await this.flushNow();
    const err = feed.state.lastError
      ? ` err[${feed.state.lastError.channel}]:${feed.state.lastError.message}`
      : "";
    const readyStr = NOTIF_CHANNELS.filter((c) => ready[c]).join("/") || "none";
    return `ON tasks=${tasks.length} due=${withDue.length} pastDue=${pastDue.length} `
      + `channels=${readyStr} fired=${plan.intents.length}(${chans})`
      + `${plan.digests.length ? " +digest" : ""}${err}`;
  }

  // ---- Tick ----

  private async tick(): Promise<void> {
    // Skip overlapping ticks (a slow send must not double up with the next
    // interval). Nothing is lost: state is re-derived from dedup each tick.
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const feed of this.opts.getFeeds()) {
        try {
          this.runFeed(feed);
        } catch (e) {
          console.error(`[InventTasks] Notification check failed for workspace "${feed.wsName}":`, e);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private runFeed(feed: NotifFeed): void {
    if (!feed.config.enabled) return;
    const now = Date.now();
    const plan = planNotifications(feed.tasks(), feed.config, feed.state, now, {
      ready: this.channelReadiness(feed.config),
      resolveAllow: feed.resolveAllow,
      isReminderItem: feed.isReminderItem,
      clock: { today: todayKey(), hhmm: hhmmKey(new Date(now)) },
    });
    if (plan.intents.length) this.submitIntents(feed, plan.intents);
    if (plan.digests.length && plan.setLastDigestDate) {
      this.submitDigests(feed, plan.digests, plan.setLastDigestDate, plan.setLastDigestTime);
    }
  }

  // ---- Single-task intents ----

  private submitIntents(feed: NotifFeed, intents: NotifIntent[]): void {
    const byChannel: Partial<Record<NotifChannel, NotifIntent[]>> = {};
    for (const intent of intents) {
      for (const channel of intent.channels) {
        (byChannel[channel] ||= []).push(intent);
      }
    }
    const channels = NOTIF_CHANNELS.filter((c) => byChannel[c]?.length);

    // Per-intent delivery tracker: an intent counts as delivered when ANY of
    // its channels delivered; if every channel failed, its dedup keys are
    // rolled back so the next tick retries.
    const intentTracker = new Map<NotifIntent, { pending: number; anyOk: boolean }>();
    for (const intent of intents) {
      intentTracker.set(intent, { pending: intent.channels.length, anyOk: false });
    }

    // One history entry per dispatch cycle: a task tile when one intent fired,
    // a group tile when several merged — with per-channel ok/fail icons.
    const dispatchTracker = { pending: channels.length, results: [] as NotifChannelResult[] };

    const finishChannel = (channel: NotifChannel, result: SendResult) => {
      this.noteChannelOutcome(feed, channel, result);
      for (const intent of byChannel[channel] || []) {
        const t = intentTracker.get(intent);
        if (!t) continue;
        t.anyOk ||= result.ok;
        t.pending--;
        if (t.pending === 0 && !t.anyOk) {
          for (const key of intent.sentKeys) delete feed.state.sent[key];
        }
      }
      dispatchTracker.results.push({ channel, ok: result.ok, message: result.ok ? undefined : result.message });
      dispatchTracker.pending--;
      if (dispatchTracker.pending === 0) {
        appendHistory(feed.state, this.historyEntry(intents, dispatchTracker.results));
      }
    };

    // Build each intent's merge item once and share it across channels.
    const items = new Map<NotifIntent, ReturnType<typeof mergeItemForIntent>>();
    const itemFor = (intent: NotifIntent) => {
      let item = items.get(intent);
      if (!item) {
        item = mergeItemForIntent(intent, feed.linkBuilder(intent.task), feed.wsName);
        items.set(intent, item);
      }
      return item;
    };

    for (const channel of channels) {
      this.outbox.submit({
        channel,
        destKey: this.destKey(channel),
        items: (byChannel[channel] || []).map(itemFor),
        send: (payload) => this.dispatch(channel, payload),
        onResult: (result) => finishChannel(channel, result),
      });
    }

    // Mark every dedup key now (optimistic — rolled back above if every
    // channel fails), so an overlapping runNow() can't double-plan while the
    // outbox quiet window is open. Persisted by the post-flush save.
    for (const intent of intents) {
      for (const key of intent.sentKeys) markSent(feed.state, key);
    }
  }

  private historyEntry(intents: NotifIntent[], results: NotifChannelResult[]): NotifHistoryEntry {
    const channels = [...results].sort((a, b) => CHANNEL_ORDER[a.channel] - CHANNEL_ORDER[b.channel]);
    const base = { id: newHistoryId(), ts: new Date().toISOString(), channels };
    if (intents.length === 1) {
      const intent = intents[0];
      return {
        ...base,
        kind: intent.kind,
        taskId: intent.task.data.id,
        taskTitle: intent.task.data.title || "",
        listPath: intent.task.listPath,
        minutesBefore: intent.minutesBefore,
      };
    }
    return {
      ...base,
      kind: "batch",
      count: intents.length,
      items: intents.map((intent) => ({
        kind: intent.kind,
        taskId: intent.task.data.id,
        taskTitle: intent.task.data.title || "",
        listPath: intent.task.listPath,
        minutesBefore: intent.minutesBefore,
      })),
    };
  }

  // ---- Daily digest ----

  private submitDigests(
    feed: NotifFeed,
    digests: Array<{ channel: NotifChannel; tasks: TaskFile[] }>,
    setDate: string,
    setTime: string | undefined,
  ): void {
    const prevDate = feed.state.lastDigestDate;
    const prevTime = feed.state.lastDigestTime;
    // Optimistic, like intent dedup keys — rolled back if every channel fails.
    feed.state.lastDigestDate = setDate;
    feed.state.lastDigestTime = setTime;

    const tracker = {
      pending: digests.length,
      anyOk: false,
      count: digests.reduce((max, d) => Math.max(max, d.tasks.length), 0),
      results: [] as NotifChannelResult[],
    };

    for (const { channel, tasks } of digests) {
      const payload = buildDailyDigest(tasks, todayKey());
      this.outbox.submit({
        channel,
        destKey: this.destKey(channel),
        items: [{
          kind: "digest",
          label: `Daily digest: ${payload.body}`,
          single: payload,
          priority: payload.priority,
          workspaceName: feed.wsName,
        }],
        send: (p) => this.dispatch(channel, p),
        onResult: (result) => {
          this.noteChannelOutcome(feed, channel, result);
          tracker.anyOk ||= result.ok;
          tracker.results.push({ channel, ok: result.ok, message: result.ok ? undefined : result.message });
          tracker.pending--;
          if (tracker.pending === 0) {
            appendHistory(feed.state, {
              id: newHistoryId(),
              ts: new Date().toISOString(),
              kind: "digest",
              channels: [...tracker.results].sort((a, b) => CHANNEL_ORDER[a.channel] - CHANNEL_ORDER[b.channel]),
              count: tracker.count,
            });
            if (!tracker.anyOk) {
              feed.state.lastDigestDate = prevDate;
              feed.state.lastDigestTime = prevTime;
            }
          }
        },
      });
    }
  }

  // ---- Channel dispatch ----

  private destKey(channel: NotifChannel): string {
    const accounts = this.opts.getAccounts();
    if (channel === "system") return "system";
    return `ntfy:${accounts.ntfy?.serverUrl || ""}/${accounts.ntfy?.topic || ""}`;
  }

  /** Keep the per-workspace "last channel error" fresh: set on failure,
   *  cleared when that channel next succeeds. Surfaced in settings/health. */
  private noteChannelOutcome(feed: NotifFeed, channel: NotifChannel, result: SendResult): void {
    if (result.ok) {
      if (feed.state.lastError?.channel === channel) feed.state.lastError = undefined;
    } else {
      feed.state.lastError = {
        ts: new Date().toISOString(),
        channel,
        message: result.message || "Send failed.",
      };
    }
  }

  private async dispatch(channel: NotifChannel, payload: NotifPayload): Promise<SendResult> {
    const accounts = this.opts.getAccounts();
    try {
      if (channel === "system") {
        return this.systemChannel.send(payload)
          ? { ok: true }
          : { ok: false, message: "System notifications are unavailable or permission was denied." };
      }
      if (!accounts.ntfy?.topic) return { ok: false, message: "ntfy topic is not configured." };
      const err = await this.ntfyChannel.send(accounts.ntfy, payload);
      return err ? { ok: false, message: err } : { ok: true };
    } catch (e) {
      console.error(`[InventTasks] ${channel} send failed:`, e);
      return { ok: false, message: (e as Error | undefined)?.message || String(e) };
    }
  }
}
