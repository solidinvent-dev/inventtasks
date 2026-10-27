import { App, normalizePath } from "obsidian";
import { WORKSPACE_STATE_FILE } from "../constants";
import type { WorkspaceEntry, ActivitySettings } from "../settings";
import { DEFAULT_ACTIVITY_SETTINGS } from "../settings";
import type { WorkspaceIndex } from "./workspace-index";
import type { CalendarSyncPrefs, SyncedEventEntry } from "../calendar-sync/types";
import { defaultNotifRuntimeState, type NotifRuntimeState } from "../notifications/types";
import { exportRuntimeState, mergeRuntimeStateInPlace } from "../notifications/store";

// The workspace shared-state file (`_workspace-state.md` in each workspace
// root) carries RUNTIME state that should follow the vault across devices:
// notification dedup/history, in-app notification read/snooze marks, activity
// config and calendar synced-event ids. It does NOT carry user settings —
// those live in data.json, so a stale file can never revert a toggle.
//
// Two rules keep this loop-free and reference-safe:
//
//  1. Self-write suppression: writes remember their content; when the vault
//     'modify' event echoes our own write back, apply() skips it. Only files
//     genuinely changed by someone else (sync, another device) are merged.
//  2. In-place apply: merging mutates the existing settings objects instead of
//     replacing them, so references captured by open UIs / in-flight
//     notification callbacks never go stale.

const STATE_VERSION = 2;

type NotificationPrefs = WorkspaceEntry["notifications"];

export interface WorkspaceSharedState {
  version: number;
  updatedAt?: string;
  activityConfig?: Partial<ActivitySettings>;
  /** External-notification runtime state (dedup map, history, last error). */
  notifState?: Partial<NotifRuntimeState>;
  /** In-app notification panel marks (read / snoozed / cleared). */
  notifications?: Partial<NotificationPrefs>;
  calendarSync?: {
    syncedEvents?: Record<string, SyncedEventEntry>;
  };
  /** Opaque device-coordination blob — managed by the plugin, do not edit. */
  seed?: string;
}

// `seed` is the newest vendor-signed licence status ("ok" or "rev") — see
// data/license-check.ts. It travels in the shared workspace state so that a
// revocation reaches every device that syncs this vault. The field name is
// historical and kept so existing workspace files keep working.
// undefined = carry whatever the file already has; null = actively clear.
let stateSeed: string | null | undefined;
let seedObserver: ((raw: string) => void) | null = null;

export function setStateSeed(v: string | null): void {
  stateSeed = v;
}

/** Called with the on-disk seed whenever shared state is read (load/persist). */
export function observeStateSeed(cb: ((raw: string) => void) | null): void {
  seedObserver = cb;
}

export interface WorkspaceSharedStateIssue {
  path: string;
  message: string;
}

type ReadWorkspaceSharedState = WorkspaceSharedState & { parseIssue?: WorkspaceSharedStateIssue };

function rootPath(root: string | undefined): string {
  const r = (root || "").trim();
  if (!r || r === "/") return "";
  return normalizePath(r).replace(/\/+$/, "");
}

export function workspaceStatePath(root: string | undefined): string {
  const r = rootPath(root);
  return r ? `${r}/${WORKSPACE_STATE_FILE}` : WORKSPACE_STATE_FILE;
}

export function parseWorkspaceStateContent(raw: string, path: string): ReadWorkspaceSharedState {
  const body = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "").trim();
  const match = body.match(/```json\s*([\s\S]*?)```/i);
  const json = (match ? match[1] : body).trim();
  if (!json) return { version: STATE_VERSION };
  try {
    const parsed = JSON.parse(json) as Partial<ReadWorkspaceSharedState> | null;
    return parsed && typeof parsed === "object" ? { version: STATE_VERSION, ...parsed } : { version: STATE_VERSION };
  } catch (e) {
    return { version: STATE_VERSION, parseIssue: { path, message: (e as Error | undefined)?.message || String(e) } };
  }
}

// Last content (timestamp stripped) we wrote per path — used to recognise the
// vault 'modify' echo of our own write and skip re-applying it.
const lastWrittenByPath = new Map<string, string>();

const sansTs = (s: string) => s.replace(/"updatedAt"\s*:\s*"[^"]*",?\s*/g, "");

async function readRawState(app: App, root: string | undefined): Promise<ReadWorkspaceSharedState & { isOwnEcho?: boolean }> {
  const path = workspaceStatePath(root);
  if (!(await app.vault.adapter.exists(path))) return { version: STATE_VERSION };
  const raw = await app.vault.adapter.read(path);
  const state = parseWorkspaceStateContent(raw, path) as ReadWorkspaceSharedState & { isOwnEcho?: boolean };
  state.isOwnEcho = lastWrittenByPath.get(path) === sansTs(raw);
  if (state.parseIssue) console.warn("[InventTasks] Could not parse workspace shared state:", path, state.parseIssue.message);
  return state;
}

async function writeRawState(app: App, root: string | undefined, state: WorkspaceSharedState): Promise<void> {
  const path = workspaceStatePath(root);
  const r = rootPath(root);
  if (r && !(await app.vault.adapter.exists(r))) await app.vault.createFolder(r);
  const next: WorkspaceSharedState = { ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() };
  const body = JSON.stringify(next, null, 2);
  const raw = [
    "---",
    "type: inventtasks-workspace-state",
    `version: ${STATE_VERSION}`,
    "---",
    "",
    "```json",
    body,
    "```",
    "",
  ].join("\n");
  // Idempotency guard: skip the write when only `updatedAt` would change, so a
  // no-op persist doesn't fire a vault 'modify' event at all.
  const content = sansTs(raw);
  if (await app.vault.adapter.exists(path)) {
    const prev = await app.vault.adapter.read(path);
    if (sansTs(prev) === content) {
      lastWrittenByPath.set(path, content);
      return;
    }
  }
  lastWrittenByPath.set(path, content);
  await app.vault.adapter.write(path, raw);
}

// ---- In-place merge helpers ----

function mergeTimestampRecordInPlace(target: Record<string, string>, incoming: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(incoming || {})) {
    if (!value) continue;
    if (!target[key] || value > target[key]) target[key] = value;
  }
}

function ensureNotifications(ws: WorkspaceEntry): NotificationPrefs {
  ws.notifications ||= { dismissed: {}, snoozed: {}, read: {}, returned: {} };
  ws.notifications.dismissed ||= {};
  ws.notifications.snoozed ||= {};
  ws.notifications.read ||= {};
  ws.notifications.returned ||= {};
  return ws.notifications;
}

export function ensureNotifState(ws: WorkspaceEntry): NotifRuntimeState {
  ws.notifState ||= defaultNotifRuntimeState();
  ws.notifState.sent ||= {};
  ws.notifState.history ||= [];
  return ws.notifState;
}

function mergeNotificationsInPlace(target: NotificationPrefs, incoming?: Partial<NotificationPrefs>): void {
  mergeTimestampRecordInPlace(target.dismissed, incoming?.dismissed);
  mergeTimestampRecordInPlace(target.snoozed, incoming?.snoozed);
  mergeTimestampRecordInPlace(target.read, incoming?.read);
  mergeTimestampRecordInPlace(target.returned ||= {}, incoming?.returned);
}

/**
 * Merge the on-disk shared state into the live workspace entry. ALWAYS
 * mutates in place; skips entirely when the file content is the echo of our
 * own last write (memory is already at least as new).
 */
export async function applyWorkspaceSharedState(
  app: App,
  ws: WorkspaceEntry,
  calendarSync: CalendarSyncPrefs | undefined,
): Promise<WorkspaceSharedStateIssue | undefined> {
  const shared = await readRawState(app, ws.workspaceRoot);
  if (shared.parseIssue) return shared.parseIssue;
  if (shared.seed) seedObserver?.(shared.seed);
  ensureNotifications(ws);
  ensureNotifState(ws);
  if (shared.isOwnEcho) return undefined;

  Object.assign(ws.activityConfig, { ...DEFAULT_ACTIVITY_SETTINGS, ...ws.activityConfig, ...(shared.activityConfig || {}) });
  mergeRuntimeStateInPlace(ws.notifState!, shared.notifState);
  mergeNotificationsInPlace(ws.notifications, shared.notifications);
  if (calendarSync && shared.calendarSync?.syncedEvents) {
    calendarSync.syncedEvents = { ...calendarSync.syncedEvents, ...shared.calendarSync.syncedEvents };
  }
  return undefined;
}

function taskIdsForIndex(index: WorkspaceIndex | undefined): Set<string> {
  const ids = new Set<string>();
  if (!index) return ids;
  for (const task of index.allTasks()) {
    if (task.data.id) ids.add(task.data.id);
  }
  return ids;
}

function syncedTaskId(key: string): string {
  const sep = key.lastIndexOf("::");
  return sep >= 0 ? key.slice(sep + 2) : key;
}

function syncedForIndex(
  syncedEvents: Record<string, SyncedEventEntry> | undefined,
  index: WorkspaceIndex | undefined,
): Record<string, SyncedEventEntry> {
  if (!syncedEvents) return {};
  const ids = taskIdsForIndex(index);
  if (!ids.size) return {};
  const out: Record<string, SyncedEventEntry> = {};
  for (const [key, value] of Object.entries(syncedEvents)) {
    if (ids.has(syncedTaskId(key))) out[key] = value;
  }
  return out;
}

/**
 * Persist the workspace's shared state: pull (merge any genuinely external
 * file changes into memory, in place), then push the merged memory snapshot.
 * No replace flags needed — "clear history" survives via its tombstone.
 */
export async function persistWorkspaceSharedState(
  app: App,
  ws: WorkspaceEntry,
  calendarSync: CalendarSyncPrefs | undefined,
  index?: WorkspaceIndex,
): Promise<void> {
  const existing = await readRawState(app, ws.workspaceRoot);
  const notifications = ensureNotifications(ws);
  const notifState = ensureNotifState(ws);
  if (!existing.isOwnEcho && !existing.parseIssue) {
    mergeRuntimeStateInPlace(notifState, existing.notifState);
    mergeNotificationsInPlace(notifications, existing.notifications);
  }
  const state: WorkspaceSharedState = {
    version: STATE_VERSION,
    activityConfig: { ...DEFAULT_ACTIVITY_SETTINGS, ...existing.activityConfig, ...ws.activityConfig },
    notifState: exportRuntimeState(notifState),
    notifications,
    calendarSync: {
      syncedEvents: {
        ...(existing.calendarSync?.syncedEvents || {}),
        ...syncedForIndex(calendarSync?.syncedEvents, index),
      },
    },
  };
  const seed = stateSeed === undefined ? existing.seed : stateSeed;
  if (seed) state.seed = seed;
  if (existing.seed) seedObserver?.(existing.seed);
  await writeRawState(app, ws.workspaceRoot, state);
}
