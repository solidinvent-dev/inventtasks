/**
 * Sync module types: per-workspace settings (data.json), per-device client
 * state (plugin dir, NEVER synced) and runtime status for the UI.
 * See SYNC_SPECIFICATION.md §1.
 */

export interface SyncSettings {
  enabled: boolean;
  /** e.g. https://sync.example.com — no trailing slash needed. */
  serverUrl: string;
  /** Bearer token; protected at rest via protectSecret (like the ntfy token). */
  token: string;
  /** Server-side workspace id (one server hosts many): [A-Za-z0-9_-], ≤64. */
  remoteWorkspace: string;
  /** Periodic full-reconcile interval. */
  intervalMinutes: number;
  /** Quiet window after a local change before it is pushed. */
  debounceSeconds: number;
  /** Also write the losing side of a conflict next to the file (it syncs too). */
  conflictCopies: boolean;
  /** Keep a WebSocket open for instant pulls when another device pushes. */
  liveUpdates: boolean;
}

export function makeSyncSettings(partial?: Partial<SyncSettings>): SyncSettings {
  return {
    enabled: partial?.enabled ?? false,
    serverUrl: (partial?.serverUrl ?? "").trim().replace(/\/+$/, ""),
    token: partial?.token ?? "",
    remoteWorkspace: (partial?.remoteWorkspace ?? "main").trim(),
    intervalMinutes: clamp(partial?.intervalMinutes, 1, 120, 5),
    debounceSeconds: clamp(partial?.debounceSeconds, 2, 300, 4),
    conflictCopies: partial?.conflictCopies ?? false,
    liveUpdates: partial?.liveUpdates ?? true,
  };
}

export function syncConfigured(s: SyncSettings | undefined): boolean {
  return !!s && s.enabled && !!s.serverUrl && !!s.token && !!s.remoteWorkspace;
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Client state (plugin dir: sync/<workspaceId>.json) — the device's memory of
// what the server held after the last successful sync. The manifest is the
// BASE of every 3-way diff: dirty(path) = disk differs from manifest;
// remote-changed = server rev > manifest rev.
// ---------------------------------------------------------------------------

export interface SyncManifestEntry {
  hash: string;   // sha256 of content at last sync ("" = placeholder: local won a conflict, force-push pending)
  mtime: number;  // DISK mtime at last sync (echo/dirty detection)
  size: number;
  rev: number;    // server rev for this path (push baseRev)
}

export interface SyncStateFile {
  version: 1;
  deviceId: string;
  deviceName: string;
  cursor: number;
  manifest: Record<string, SyncManifestEntry>;
  /**
   * Files the server refused outright, keyed by path. Kept across runs so a
   * doomed file is not re-uploaded every cycle; the entry is dropped as soon
   * as the file's content changes, which is the user's way of retrying.
   */
  rejected?: Record<string, RejectedEntry>;
}

export interface RejectedEntry {
  /** Content hash at the time of the rejection — a different hash retries. */
  hash: string;
  reason: string;
}

export function makeSyncState(deviceName: string): SyncStateFile {
  return {
    version: 1,
    deviceId: `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    deviceName,
    cursor: 0,
    manifest: {},
  };
}

export function loadSyncState(raw: unknown, deviceName: string): SyncStateFile {
  const data = (raw || {}) as Partial<SyncStateFile>;
  if (data.version !== 1 || typeof data.deviceId !== "string" || !data.deviceId) {
    return makeSyncState(deviceName);
  }
  return {
    version: 1,
    deviceId: data.deviceId,
    deviceName: data.deviceName || deviceName,
    cursor: typeof data.cursor === "number" && data.cursor >= 0 ? Math.floor(data.cursor) : 0,
    manifest: data.manifest && typeof data.manifest === "object" ? data.manifest as Record<string, SyncManifestEntry> : {},
  };
}

// ---------------------------------------------------------------------------
// Runtime status (UI)
// ---------------------------------------------------------------------------

export type SyncPhase = "idle" | "syncing" | "error" | "blocked";

export interface SyncStatus {
  phase: SyncPhase;
  lastSyncAt?: number;
  lastError?: string;
  /** Paths waiting for the debounce window / next run. */
  pending: number;
}

export interface SyncRunSummary {
  pulled: number;
  pushed: number;
  conflicts: number;
  deletedLocal: number;
  deletedRemote: number;
  /** Set when the mass-delete guard stopped the run before applying anything. */
  blocked?: "mass-delete";
  /** Set when the first-connect bootstrap dialog was cancelled by the user. */
  cancelled?: boolean;
  /**
   * Files skipped this run because the server will never accept them. The run
   * itself still succeeds — everything else syncs — but the user has to be
   * told which files are being left behind, by name.
   */
  rejected: { path: string; reason: string }[];
}

export function emptySummary(): SyncRunSummary {
  return { pulled: 0, pushed: 0, conflicts: 0, deletedLocal: 0, deletedRemote: 0, rejected: [] };
}
