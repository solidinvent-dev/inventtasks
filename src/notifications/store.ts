// Runtime-state store operations — the ONLY code that mutates
// NotifRuntimeState shape-wise (history append/clear, cross-device merge).
//
// Two invariants keep the rest of the plugin honest:
//
//  1. IN-PLACE: merge functions mutate the live state object instead of
//     building a replacement. Long-lived references (settings UI, scheduler
//     callbacks waiting out the outbox quiet window) therefore never go
//     stale — the exact failure mode that previously lost history entries
//     and reverted settings toggles.
//  2. TOMBSTONE: "Clear history" records `historyClearedAt` instead of just
//     emptying the array, so a merge with another device's not-yet-cleared
//     file drops those entries instead of resurrecting them.

import type { NotifHistoryEntry, NotifRuntimeState } from "./types";

/** Max history entries kept per workspace. */
export const NOTIF_HISTORY_CAP = 200;
/** History older than this is dropped (mirrors in-app cleared-notification retention). */
export const NOTIF_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Dedup-map cap (shared with engine.markSent). */
export const NOTIF_SENT_CAP = 500;

let idSeq = 0;
export function newHistoryId(now = Date.now()): string {
  return `${now.toString(36)}-${(idSeq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function withinRetention(ts: string, now: number): boolean {
  const t = Date.parse(ts);
  // Keep unparseable timestamps (defensive) rather than drop them.
  return !Number.isFinite(t) || t >= now - NOTIF_HISTORY_RETENTION_MS;
}

function afterClear(ts: string, clearedAt: string | undefined): boolean {
  return !clearedAt || ts > clearedAt;
}

function allFailed(entry: NotifHistoryEntry): boolean {
  return entry.channels.length > 0 && entry.channels.every((c) => !c.ok);
}

/** Identity of a failure for coalescing retries: same notification, same
 *  channels failing — only the timestamp/attempt count differs. */
function failureSignature(entry: NotifHistoryEntry): string {
  return [
    entry.kind,
    entry.taskId || "",
    entry.minutesBefore ?? "",
    entry.count ?? "",
    (entry.items || []).map((i) => `${i.kind}:${i.taskId || ""}`).join(","),
    entry.channels.map((c) => c.channel).join(","),
  ].join("|");
}

/**
 * Record a dispatch attempt, newest first. Consecutive identical total
 * failures (the scheduler retries every tick) collapse into one entry with a
 * bumped timestamp + attempt counter, so a dead ntfy server doesn't flood the
 * history while still being visibly red.
 */
export function appendHistory(
  state: NotifRuntimeState,
  entry: NotifHistoryEntry,
  cap = NOTIF_HISTORY_CAP,
  now = Date.now(),
): void {
  const head = state.history[0];
  if (head && allFailed(head) && allFailed(entry) && failureSignature(head) === failureSignature(entry)) {
    head.ts = entry.ts;
    head.attempts = (head.attempts || 1) + 1;
    head.channels = entry.channels;
    return;
  }
  state.history.unshift(entry);
  state.history = state.history.filter((e) => withinRetention(e.ts, now)).slice(0, cap);
}

/** Clear this workspace's history and plant the tombstone. */
export function clearHistory(state: NotifRuntimeState, at = new Date().toISOString()): void {
  state.history = [];
  state.historyClearedAt = state.historyClearedAt && state.historyClearedAt > at ? state.historyClearedAt : at;
}

// ---- Cross-device merge (vault-synced state file → memory), IN PLACE ----

function mergeSent(target: NotifRuntimeState, incoming: Record<string, string> | undefined): void {
  for (const [key, ts] of Object.entries(incoming || {})) {
    if (!ts) continue;
    if (!target.sent[key] || ts > target.sent[key]) target.sent[key] = ts;
  }
  const entries = Object.entries(target.sent);
  if (entries.length > NOTIF_SENT_CAP) {
    const keep = entries.sort((a, b) => b[1].localeCompare(a[1])).slice(0, NOTIF_SENT_CAP);
    for (const key of Object.keys(target.sent)) delete target.sent[key];
    for (const [key, ts] of keep) target.sent[key] = ts;
  }
}

function mergeHistoryLists(
  a: NotifHistoryEntry[],
  b: NotifHistoryEntry[],
  clearedAt: string | undefined,
  now: number,
): NotifHistoryEntry[] {
  const byId = new Map<string, NotifHistoryEntry>();
  for (const entry of [...a, ...b]) {
    if (!entry?.id || !entry.ts) continue;
    if (!afterClear(entry.ts, clearedAt) || !withinRetention(entry.ts, now)) continue;
    const existing = byId.get(entry.id);
    // Same id on both sides (e.g. a coalesced failure updated on one device):
    // keep the newer snapshot.
    if (!existing || entry.ts > existing.ts) byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((x, y) => y.ts.localeCompare(x.ts)).slice(0, NOTIF_HISTORY_CAP);
}

/**
 * Merge a state snapshot read from the vault file into the live in-memory
 * state. Mutates `target` (object identity preserved); never replaces it.
 */
export function mergeRuntimeStateInPlace(
  target: NotifRuntimeState,
  incoming: Partial<NotifRuntimeState> | undefined,
  now = Date.now(),
): void {
  if (!incoming) return;
  mergeSent(target, incoming.sent);

  if (incoming.historyClearedAt && (!target.historyClearedAt || incoming.historyClearedAt > target.historyClearedAt)) {
    target.historyClearedAt = incoming.historyClearedAt;
  }
  target.history = mergeHistoryLists(target.history, incoming.history || [], target.historyClearedAt, now);

  if (incoming.lastError && (!target.lastError || incoming.lastError.ts > target.lastError.ts)) {
    target.lastError = incoming.lastError;
  }

  const slot = (date?: string, time?: string) => (date ? `${date} ${time || ""}` : "");
  if (slot(incoming.lastDigestDate, incoming.lastDigestTime) > slot(target.lastDigestDate, target.lastDigestTime)) {
    target.lastDigestDate = incoming.lastDigestDate;
    target.lastDigestTime = incoming.lastDigestTime;
  }
}

/** Snapshot for the vault state file (drops nothing — state has no secrets). */
export function exportRuntimeState(state: NotifRuntimeState, now = Date.now()): NotifRuntimeState {
  return {
    sent: { ...state.sent },
    history: state.history.filter((e) => afterClear(e.ts, state.historyClearedAt) && withinRetention(e.ts, now)),
    historyClearedAt: state.historyClearedAt,
    lastError: state.lastError,
    lastDigestDate: state.lastDigestDate,
    lastDigestTime: state.lastDigestTime,
  };
}

// ---- Cross-workspace history view (Notifications → History tab) ----

export interface MergedHistoryEntry extends NotifHistoryEntry {
  workspaceId: string;
  workspaceName: string;
}

export function mergeNotifHistory(
  workspaces: Array<{ id: string; name: string; notifState?: { history?: NotifHistoryEntry[] } }>,
  now = Date.now(),
): MergedHistoryEntry[] {
  const out: MergedHistoryEntry[] = [];
  for (const ws of workspaces) {
    for (const entry of ws.notifState?.history ?? []) {
      if (!withinRetention(entry.ts, now)) continue;
      out.push({ ...entry, workspaceId: ws.id, workspaceName: ws.name });
    }
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}
