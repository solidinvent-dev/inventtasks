/**
 * Vault Sync module types — whole-vault sync, fully independent from the
 * per-workspace task sync in src/sync/ (which it reuses only as a library:
 * SyncEngine / VaultSyncFs / HttpSyncTransport are shared, state and config
 * are not). Settings live at the PLUGIN level (PluginSettings.vaultSync);
 * client state (cursor/manifest) is per device in the plugin dir.
 */

import type { SyncStatus } from "../sync/types";

export interface VaultSyncSettings {
  enabled: boolean;
  /** e.g. https://sync.example.com — no trailing slash needed. */
  serverUrl: string;
  /** Bearer token of the server-side vault workspace; protectSecret at rest. */
  token: string;
  /** Server-side workspace id (kind "vault"). */
  remoteId: string;
  /** Periodic full-reconcile interval — also the only trigger for .obsidian
   *  changes (Obsidian emits no vault events for dot-paths). */
  intervalMinutes: number;
  /** Quiet window after a local change before it is pushed. */
  debounceSeconds: number;
  /** Also write the losing side of a conflict next to the file (it syncs too). */
  conflictCopies: boolean;
  /** Keep a WebSocket open for instant pulls when another device pushes. */
  liveUpdates: boolean;
  /** Sync .obsidian (settings, themes, snippets) EXCEPT plugins/. */
  syncObsidianConfig: boolean;
  /** Sync .obsidian/plugins (community plugins incl. their data). */
  syncObsidianPlugins: boolean;
  /** Extra exclusions, one pattern per entry (simplified gitignore: `*`, `**`,
   *  trailing `/` = whole subtree; paths relative to the vault root). */
  ignorePatterns: string[];
  /** Skip local files larger than this many MB. 0 = no limit. */
  maxFileMB: number;
}

export function makeVaultSyncSettings(partial?: Partial<VaultSyncSettings>): VaultSyncSettings {
  return {
    enabled: partial?.enabled ?? false,
    serverUrl: (partial?.serverUrl ?? "").trim().replace(/\/+$/, ""),
    token: partial?.token ?? "",
    remoteId: (partial?.remoteId ?? "vault").trim(),
    intervalMinutes: clamp(partial?.intervalMinutes, 1, 120, 5),
    debounceSeconds: clamp(partial?.debounceSeconds, 2, 300, 4),
    conflictCopies: partial?.conflictCopies ?? false,
    liveUpdates: partial?.liveUpdates ?? true,
    syncObsidianConfig: partial?.syncObsidianConfig ?? false,
    syncObsidianPlugins: partial?.syncObsidianPlugins ?? false,
    ignorePatterns: Array.isArray(partial?.ignorePatterns)
      ? partial.ignorePatterns.filter((p): p is string => typeof p === "string")
      : [],
    maxFileMB: clamp(partial?.maxFileMB, 0, 1024, 0),
  };
}

export function vaultSyncConfigured(s: VaultSyncSettings | undefined): boolean {
  return !!s && s.enabled && !!s.serverUrl && !!s.token && !!s.remoteId;
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

/** Vault-sync status extends the shared shape with the skipped-files count. */
export interface VaultSyncStatus extends SyncStatus {
  /** Files skipped because they exceed maxFileMB (last full detection). */
  skippedLarge: number;
}
