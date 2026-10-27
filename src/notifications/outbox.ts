// Notification outbox — the single funnel every send goes through.
//
// Anti-flood rule: everything that becomes due together (one tick, several
// workspaces, a catch-up after sleep) is pooled per (channel + physical
// destination) and delivered after a short quiet window as ONE notification:
// a single pending item keeps its rich payload, two or more merge into a
// summary. No delivery modes, no special cases — "one moment, one
// notification per channel".

import type { NotifChannel, NotifPayload } from "./types";
import { buildMergedPayload, type MergeItem } from "./payloads";

/** How long a destination stays quiet before its group is flushed. Long
 *  enough for every workspace's startup catch-up tick (background indexes
 *  load one after another) to land in the same flush. */
export const OUTBOX_QUIET_MS = 8_000;
/** Upper bound on delivery delay even if submissions keep trickling in. */
export const OUTBOX_MAX_WAIT_MS = 30_000;

export interface SendResult {
  ok: boolean;
  message?: string;
}

export interface OutboxSubmission {
  channel: NotifChannel;
  /** Physical destination: "system" or `ntfy:<server>/<topic>`.
   *  Only submissions sharing a destination merge. */
  destKey: string;
  items: MergeItem[];
  /** Dispatch one payload on this channel. */
  send: (payload: NotifPayload) => Promise<SendResult>;
  /** Delivery outcome for this submission (dedup marking / history). A merged
   *  flush sends once and reports the same result to every submission. */
  onResult: (result: SendResult) => void;
}

interface PendingGroup {
  submissions: OutboxSubmission[];
  timer: ReturnType<typeof setTimeout> | null;
  deadline: number;
}

export class NotifOutbox {
  private groups = new Map<string, PendingGroup>();
  private quietMs: number;
  private maxWaitMs: number;
  /** Persist hook — called once per flushed group so dedup marks, history and
   *  lastError land on disk in one save instead of one per submission. */
  private onAfterFlush?: () => Promise<void>;

  constructor(opts?: { quietMs?: number; maxWaitMs?: number; onAfterFlush?: () => Promise<void> }) {
    this.quietMs = opts?.quietMs ?? OUTBOX_QUIET_MS;
    this.maxWaitMs = opts?.maxWaitMs ?? OUTBOX_MAX_WAIT_MS;
    this.onAfterFlush = opts?.onAfterFlush;
  }

  submit(sub: OutboxSubmission): void {
    if (!sub.items.length) return;
    const key = `${sub.channel}|${sub.destKey}`;
    const now = Date.now();
    let group = this.groups.get(key);
    if (!group) {
      group = { submissions: [], timer: null, deadline: now + this.maxWaitMs };
      this.groups.set(key, group);
    }
    group.submissions.push(sub);
    // Trailing debounce capped by the group's deadline.
    if (group.timer) clearTimeout(group.timer);
    const wait = Math.max(0, Math.min(this.quietMs, group.deadline - now));
    group.timer = setTimeout(() => void this.flushGroup(key), wait);
  }

  /** Deliver everything pending immediately (manual sync, app resume, tests). */
  async flushNow(): Promise<void> {
    await Promise.all([...this.groups.keys()].map((key) => this.flushGroup(key)));
  }

  /** Cancel timers and drop queued submissions (plugin unload). Dropped items
   *  were only marked sent in memory, so they re-fire on next start. */
  dispose(): void {
    for (const group of this.groups.values()) {
      if (group.timer) clearTimeout(group.timer);
    }
    this.groups.clear();
  }

  private async flushGroup(key: string): Promise<void> {
    const group = this.groups.get(key);
    if (!group) return;
    this.groups.delete(key);
    if (group.timer) clearTimeout(group.timer);

    const pool = group.submissions.flatMap((s) => s.items);
    if (pool.length) {
      const payload = pool.length === 1 ? pool[0].single : buildMergedPayload(pool);
      let result: SendResult;
      try {
        result = await group.submissions[0].send(payload);
      } catch (e: any) {
        console.error("[InventTasks] Notification send failed:", e);
        result = { ok: false, message: e?.message || String(e) };
      }
      for (const sub of group.submissions) {
        try { sub.onResult(result); } catch (e) { console.error("[InventTasks] Notification result handler failed:", e); }
      }
    }

    if (this.onAfterFlush) {
      try { await this.onAfterFlush(); } catch (e) { console.error("[InventTasks] Post-notification save failed:", e); }
    }
  }
}
