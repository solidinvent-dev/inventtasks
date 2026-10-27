/**
 * SyncManager — plugin-side orchestration: one SyncEngine per sync-enabled
 * workspace (the plugin supports several), fed by vault events (debounced),
 * a periodic full reconcile, an optional WebSocket for instant pulls, and the
 * app-resume hook (mobile suspends timers and sockets).
 *
 * Engine runs are serialised per workspace (single-flight + trailing rerun).
 * Client state (cursor/manifest) lives in the PLUGIN dir — never in the
 * synced tree: <configDir>/plugins/<id>/sync/<workspaceId>.json.
 */

import { Notice, TFolder, normalizePath } from "obsidian";
import type InventTasksPlugin from "../main";
import type { WorkspaceEntry } from "../settings";
import { SyncBootstrapModal } from "../modals/sync-bootstrap-modal";
import { SyncFirstPullModal } from "../modals/sync-first-pull-modal";
import { SyncMassDeleteModal } from "../modals/sync-mass-delete-modal";
import { t } from "../i18n";
import { WORKSPACE_STATE_FILE } from "../constants";
import { FOLDER_MARKER_NAME, type ChangeEntry, type WatchServerMessage } from "../../shared/protocol";
import { SyncEngine, type BootstrapChoice, type MassDeleteChoice } from "./engine";
import { HttpSyncTransport, type VersionEntry } from "./client";
import { VaultSyncFs } from "./fs";
import {
  loadSyncState, syncConfigured,
  type SyncRunSummary, type SyncSettings, type SyncStateFile, type SyncStatus,
} from "./types";

const INITIAL_SYNC_DELAY_MS = 1500;
const WATCH_PULL_DELAY_MS = 500;
const RESUME_SYNC_DELAY_MS = 2000;
const WS_BACKOFF_MIN_MS = 1000;
const WS_BACKOFF_MAX_MS = 60_000;
// Adaptive debounce: the first edit after a quiet period fires fast; edits made
// during an active session (recent sync) wait the full configured debounce so
// bursts coalesce. See scheduleDebounced.
const ADAPTIVE_FAST_MS = 600;
const ADAPTIVE_IDLE_RESET_MS = 15_000;

type SyncRunMode =
  | { dirtyPaths: true }
  | { pullOnly: true }
  | { wsChanges: { since: number; rev: number; files: ChangeEntry[] } }
  | null;

interface SyncEntry {
  wsId: string;
  /** Reconfigure fingerprint: server/token/remote/root. */
  cfgKey: string;
  root: string;
  state: SyncStateFile;
  engine: SyncEngine;
  transport: HttpSyncTransport;
  fs: VaultSyncFs;
  dirty: Set<string>;
  /** Paths refused on the previous run, so a standing refusal notifies once. */
  lastRejectedKey?: string;
  debounceTimer: number | null;
  shortTimer: number | null;
  intervalTimer: number | null;
  socket: WebSocket | null;
  wsBackoffMs: number;
  closed: boolean;
  running: boolean;
  queuedFull: boolean;
  /** When the last run finished — drives the adaptive debounce (fast first edit after idle). */
  lastRunEndAt: number;
  status: SyncStatus;
}

export class SyncManager {
  private readonly plugin: InventTasksPlugin;
  private entries = new Map<string, SyncEntry>();
  private listeners = new Set<() => void>();
  private eventsRegistered = false;
  private reconfiguring = false;
  private rerunReconfigure = false;

  constructor(plugin: InventTasksPlugin) {
    this.plugin = plugin;
  }

  start(): void {
    this.registerVaultEvents();
    void this.reconfigure();
  }

  stop(): void {
    for (const [id, entry] of [...this.entries]) this.teardown(id, entry);
  }

  /** Bring engines in line with settings. Idempotent; serialised. */
  async reconfigure(): Promise<void> {
    if (this.reconfiguring) { this.rerunReconfigure = true; return; }
    this.reconfiguring = true;
    try {
      do {
        this.rerunReconfigure = false;
        const wanted = new Set<string>();
        for (const ws of this.plugin.settings.workspaces) {
          if (!syncConfigured(ws.sync)) continue;
          wanted.add(ws.id);
          await this.ensureEntry(ws);
        }
        for (const [id, entry] of [...this.entries]) {
          if (!wanted.has(id)) this.teardown(id, entry);
        }
      } while (this.rerunReconfigure);
    } finally {
      this.reconfiguring = false;
    }
    this.emit();
  }

  statusFor(wsId: string): SyncStatus | null {
    return this.entries.get(wsId)?.status ?? null;
  }

  onStatusChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Manual full sync (command / settings button). Returns null when not configured. */
  async syncNow(wsId?: string): Promise<SyncRunSummary | null> {
    const id = wsId ?? this.plugin.settings.activeWorkspaceId;
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.debounceTimer !== null) { window.clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
    return this.runSync(entry, null);
  }

  /** Mobile resume: timers/sockets died while suspended — catch up now. */
  onAppResume(): void {
    for (const entry of this.entries.values()) {
      this.scheduleShort(entry, RESUME_SYNC_DELAY_MS, null);
      if (!entry.socket && this.settingsFor(entry.wsId)?.liveUpdates) this.connectWatch(entry);
    }
  }

  /**
   * Push pending local changes RIGHT NOW instead of waiting out the debounce —
   * called when the app goes to the background / loses focus, so "edit then
   * close quickly" still ships. Best-effort: if the OS suspends us mid-request
   * the change is safe on disk and the next startup's full scan re-pushes it.
   */
  flushPending(): void {
    for (const entry of this.entries.values()) {
      if (entry.closed) continue;
      if (entry.debounceTimer !== null) { window.clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
      if (entry.dirty.size > 0 || entry.status.phase === "error") {
        void this.runSync(entry, { dirtyPaths: true });
      }
    }
  }

  /** Settings "Test connection": reachability, protocol version, then auth. */
  async testConnection(s: SyncSettings): Promise<{ ok: boolean; message: string }> {
    try {
      const transport = new HttpSyncTransport(s.serverUrl.replace(/\/+$/, ""), s.token, s.remoteWorkspace);
      const info = await transport.info();
      await transport.ping();
      return { ok: true, message: t("sync.testOk", { version: info.serverVersion }) };
    } catch (e) {
      return { ok: false, message: t("sync.testFail", { msg: e instanceof Error ? e.message : String(e) }) };
    }
  }

  /** True when sync is live for this workspace (history operations are usable). */
  isActive(wsId: string): boolean {
    return this.entries.has(wsId);
  }

  /** Paths currently tracked by sync (manifest keys) — for the history picker. */
  syncedPaths(wsId: string): string[] {
    const entry = this.entries.get(wsId);
    return entry ? Object.keys(entry.state.manifest).sort() : [];
  }

  /** Server-side version history for one file (newest first). */
  async listVersions(wsId: string, path: string): Promise<VersionEntry[]> {
    const entry = this.entries.get(wsId);
    if (!entry) throw new Error(t("sync.notConfigured"));
    return (await entry.transport.listVersions(path)).versions;
  }

  /** Raw bytes of one stored version (preview / restore). */
  async versionContent(wsId: string, id: number): Promise<ArrayBuffer> {
    const entry = this.entries.get(wsId);
    if (!entry) throw new Error(t("sync.notConfigured"));
    return entry.transport.versionContent(id);
  }

  /**
   * Restore a historical version: fetch its bytes and write them to the file.
   * The current content is preserved automatically (the server copies the
   * overwritten live row into history), and the next sync run pushes the
   * restored content — so a restore is itself just another tracked change.
   */
  async restoreVersion(wsId: string, path: string, id: number): Promise<void> {
    const entry = this.entries.get(wsId);
    if (!entry) throw new Error(t("sync.notConfigured"));
    const data = await entry.transport.versionContent(id);
    await entry.fs.writeBinary(path, data);
    this.scheduleShort(entry, 150, null);
  }

  // -------------------------------------------------------------------------
  // Entry lifecycle
  // -------------------------------------------------------------------------

  private settingsFor(wsId: string): SyncSettings | undefined {
    return this.plugin.settings.workspaces.find((w) => w.id === wsId)?.sync;
  }

  private async ensureEntry(ws: WorkspaceEntry): Promise<void> {
    const s = ws.sync;
    const root = this.normalizeRoot(ws.workspaceRoot);
    const cfgKey = [s.serverUrl, s.remoteWorkspace, s.token, root].join("\0");
    const existing = this.entries.get(ws.id);
    if (existing) {
      if (existing.cfgKey === cfgKey) {
        this.applyTimerSettings(existing, s);
        return;
      }
      this.teardown(ws.id, existing);
    }

    const state = await this.loadState(ws.id);
    const transport = new HttpSyncTransport(s.serverUrl, s.token, s.remoteWorkspace);
    const fs = new VaultSyncFs(this.plugin.app, root);
    const entry: SyncEntry = {
      wsId: ws.id,
      cfgKey,
      root,
      state,
      transport,
      fs,
      engine: null as unknown as SyncEngine, // set right below (needs entry for saveState closure)
      dirty: new Set(),
      debounceTimer: null,
      shortTimer: null,
      intervalTimer: null,
      socket: null,
      wsBackoffMs: WS_BACKOFF_MIN_MS,
      closed: false,
      running: false,
      queuedFull: false,
      lastRunEndAt: 0,
      status: { phase: "idle", pending: 0 },
    };
    entry.engine = new SyncEngine({
      fs,
      transport,
      state,
      saveState: () => this.saveState(entry),
      conflictCopies: () => this.settingsFor(ws.id)?.conflictCopies ?? false,
      isMergeFile: (path) => path === WORKSPACE_STATE_FILE,
      exclude: root === "/" ? (path) => this.isVaultRootExcluded(path) : undefined,
      confirmMassDeletion: (deletions, total, paths) => this.confirmMassDeletion(ws.name, deletions, total, paths),
      confirmBootstrap: (info) => this.confirmBootstrap(ws.name, info),
      confirmFirstPull: (info) => this.confirmFirstPull(ws.name, info),
      log: (msg) => console.warn(`[InventTasks sync] ${msg}`),
    });
    this.entries.set(ws.id, entry);

    this.applyTimerSettings(entry, s);
    this.scheduleShort(entry, INITIAL_SYNC_DELAY_MS, null);
    if (s.liveUpdates) this.connectWatch(entry);
  }

  private applyTimerSettings(entry: SyncEntry, s: SyncSettings): void {
    if (entry.intervalTimer !== null) window.clearInterval(entry.intervalTimer);
    entry.intervalTimer = window.setInterval(
      () => void this.runSync(entry, null),
      s.intervalMinutes * 60_000,
    );
    if (s.liveUpdates && !entry.socket) this.connectWatch(entry);
    if (!s.liveUpdates && entry.socket) {
      try { entry.socket.close(); } catch { /* closing */ }
      entry.socket = null;
    }
  }

  private teardown(id: string, entry: SyncEntry): void {
    entry.closed = true;
    if (entry.debounceTimer !== null) window.clearTimeout(entry.debounceTimer);
    if (entry.shortTimer !== null) window.clearTimeout(entry.shortTimer);
    if (entry.intervalTimer !== null) window.clearInterval(entry.intervalTimer);
    if (entry.socket) { try { entry.socket.close(); } catch { /* closing */ } }
    this.entries.delete(id);
  }

  private normalizeRoot(v: string | undefined): string {
    const s = (v || "").trim();
    if (!s || s === "/") return "/";
    return normalizePath(s);
  }

  /** Whole-vault roots must never ship Obsidian config, trash or git innards. */
  private isVaultRootExcluded(rel: string): boolean {
    const top = rel.split("/")[0];
    const configDir = this.plugin.app.vault.configDir;
    return top === configDir || top === ".trash" || top === ".git";
  }

  // -------------------------------------------------------------------------
  // Vault events → debounced quick sync
  // -------------------------------------------------------------------------

  private registerVaultEvents(): void {
    if (this.eventsRegistered) return;
    this.eventsRegistered = true;
    const vault = this.plugin.app.vault;
    this.plugin.registerEvent(vault.on("create", (f) => this.onVaultChange(f)));
    this.plugin.registerEvent(vault.on("modify", (f) => this.onVaultChange(f)));
    this.plugin.registerEvent(vault.on("delete", (f) => this.onVaultChange(f)));
    this.plugin.registerEvent(vault.on("rename", (f, oldPath) => this.onVaultChange(f, oldPath)));
  }

  /** Fan an event out to the changed path(s) AND the empty-folder markers it
   *  may flip: the folder's own marker (folder events) and each parent's
   *  marker — a child appearing/vanishing changes the parent's emptiness. */
  private onVaultChange(f: { path: string }, oldPath?: string): void {
    for (const p of oldPath ? [f.path, oldPath] : [f.path]) {
      this.onFsEvent(p);
      if (f instanceof TFolder) this.onFsEvent(`${p}/${FOLDER_MARKER_NAME}`);
      const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      if (parent) this.onFsEvent(`${parent}/${FOLDER_MARKER_NAME}`);
    }
  }

  private onFsEvent(absPath: string): void {
    for (const entry of this.entries.values()) {
      const rel = this.relTo(entry.root, absPath);
      if (rel === null) continue;
      if (entry.root === "/" && this.isVaultRootExcluded(rel)) continue;
      entry.dirty.add(rel);
      entry.status.pending = entry.dirty.size;
      this.scheduleDebounced(entry);
    }
    // Note: Obsidian does not emit events for dot-paths (.views/…) — the
    // periodic full reconcile picks those up.
  }

  private relTo(root: string, absPath: string): string | null {
    if (root === "/") return absPath;
    const prefix = `${root}/`;
    return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : null;
  }

  private scheduleDebounced(entry: SyncEntry): void {
    const full = (this.settingsFor(entry.wsId)?.debounceSeconds ?? 4) * 1000;
    // Snappy first edit after a quiet period; full debounce during active bursts.
    const idle = entry.debounceTimer === null && (Date.now() - entry.lastRunEndAt) > ADAPTIVE_IDLE_RESET_MS;
    const delay = idle ? Math.min(ADAPTIVE_FAST_MS, full) : full;
    if (entry.debounceTimer !== null) window.clearTimeout(entry.debounceTimer);
    entry.debounceTimer = window.setTimeout(() => {
      entry.debounceTimer = null;
      void this.runSync(entry, { dirtyPaths: true });
    }, delay);
  }

  private scheduleShort(entry: SyncEntry, delayMs: number, mode: { pullOnly: true } | null): void {
    if (entry.shortTimer !== null) window.clearTimeout(entry.shortTimer);
    entry.shortTimer = window.setTimeout(() => {
      entry.shortTimer = null;
      void this.runSync(entry, mode === null ? null : { pullOnly: true });
    }, delayMs);
  }

  // -------------------------------------------------------------------------
  // Run orchestration (single-flight per workspace)
  // -------------------------------------------------------------------------

  private async runSync(entry: SyncEntry, mode: SyncRunMode): Promise<SyncRunSummary | null> {
    if (entry.closed) return null;
    if (entry.running) {
      entry.queuedFull = true;
      return null;
    }
    entry.running = true;
    entry.status.phase = "syncing";
    this.emit();

    // Snapshot the dirty set; restore on failure so nothing is dropped.
    // (wsChanges only applies remote data, so it leaves the dirty set alone.)
    const isWs = !!mode && "wsChanges" in mode;
    const dirtySnapshot = isWs ? [] : [...entry.dirty];
    if (!isWs) entry.dirty.clear();

    try {
      if (mode && "wsChanges" in mode) {
        const { since, rev, files } = mode.wsChanges;
        const result = await entry.engine.applyLiveChanges(since, rev, files);
        if (result === "gap") {
          // Not contiguous with our cursor — fall back to a normal pull.
          this.scheduleShort(entry, 0, { pullOnly: true });
        } else if (result === "applied-needs-push") {
          // The user chose to UNDO a deletion — run a full cycle to push the
          // kept files back to the server.
          this.scheduleShort(entry, 0, null);
          entry.status.phase = "syncing";
          return null;
        } else if (result === "blocked") {
          entry.status.phase = "blocked";
          entry.status.lastError = t("sync.blockedMassDelete");
          return null;
        } else {
          entry.status.phase = "idle";
          entry.status.lastSyncAt = Date.now();
          entry.status.lastError = undefined;
        }
        return null;
      }

      const sum = await entry.engine.run(
        mode && "dirtyPaths" in mode ? { dirtyPaths: dirtySnapshot }
          : mode && "pullOnly" in mode ? { pullOnly: true }
            : undefined,
      );
      if (sum.cancelled) {
        // User chose "Cancel" in the first-connect dialog → turn sync off for
        // this workspace so it doesn't retry and re-prompt.
        entry.status.phase = "idle";
        entry.status.lastError = undefined;
        new Notice(t("sync.bootstrapCancelledNotice", { name: this.plugin.settings.workspaces.find((w) => w.id === entry.wsId)?.name ?? entry.wsId }));
        void this.disableSyncFor(entry.wsId);
        return sum;
      }
      if (sum.blocked) {
        entry.status.phase = "blocked";
        entry.status.lastError = t("sync.blockedMassDelete");
      } else {
        // The run succeeded even if individual files were refused, so the
        // phase stays idle — but the skipped files must be named, or the user
        // is left believing everything reached the server.
        entry.status.phase = "idle";
        entry.status.lastSyncAt = Date.now();
        entry.status.lastError = sum.rejected.length > 0 ? this.rejectionMessage(sum.rejected) : undefined;
        this.announceRejections(entry, sum.rejected);
      }
      return sum;
    } catch (e) {
      for (const p of dirtySnapshot) entry.dirty.add(p);
      entry.status.phase = "error";
      entry.status.lastError = e instanceof Error ? e.message : String(e);
      console.warn(`[InventTasks sync] ${entry.wsId}: ${entry.status.lastError}`);
      return null;
    } finally {
      entry.running = false;
      entry.lastRunEndAt = Date.now();
      entry.status.pending = entry.dirty.size;
      this.emit();
      if (entry.queuedFull && !entry.closed) {
        entry.queuedFull = false;
        this.scheduleShort(entry, 250, null);
      }
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket watch (instant pulls)
  // -------------------------------------------------------------------------

  private connectWatch(entry: SyncEntry): void {
    if (typeof WebSocket === "undefined" || entry.closed || entry.socket) return;
    const s = this.settingsFor(entry.wsId);
    if (!s || !s.liveUpdates) return;
    const url = `${s.serverUrl.replace(/^http/, "ws")}/api/v1/workspaces/${encodeURIComponent(s.remoteWorkspace)}/watch`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect(entry);
      return;
    }
    entry.socket = socket;
    socket.onopen = () => {
      entry.wsBackoffMs = WS_BACKOFF_MIN_MS;
      socket.send(JSON.stringify({ type: "auth", token: s.token }));
    };
    socket.onmessage = (ev) => {
      let msg: WatchServerMessage | null = null;
      try { msg = JSON.parse(String(ev.data)) as WatchServerMessage | null; } catch { return; }
      if (!msg) return;
      if (msg.type === "changes" && msg.rev > entry.state.cursor) {
        // Fast path: contiguous delta carried inline — apply without a GET.
        // applyLiveChanges falls back to a pull if `since` doesn't line up.
        void this.runSync(entry, { wsChanges: { since: msg.since, rev: msg.rev, files: msg.files } });
      } else if (msg.type === "rev" && msg.rev > entry.state.cursor) {
        this.scheduleShort(entry, WATCH_PULL_DELAY_MS, { pullOnly: true });
      }
    };
    socket.onclose = () => {
      if (entry.socket === socket) entry.socket = null;
      this.scheduleReconnect(entry);
    };
    socket.onerror = () => {
      try { socket.close(); } catch { /* closing */ }
    };
  }

  private scheduleReconnect(entry: SyncEntry): void {
    if (entry.closed || !this.settingsFor(entry.wsId)?.liveUpdates) return;
    const delay = entry.wsBackoffMs;
    entry.wsBackoffMs = Math.min(entry.wsBackoffMs * 2, WS_BACKOFF_MAX_MS);
    window.setTimeout(() => {
      if (!entry.closed && !entry.socket) this.connectWatch(entry);
    }, delay);
  }

  // -------------------------------------------------------------------------
  // State persistence + guard modal
  // -------------------------------------------------------------------------

  private stateDir(): string {
    const configDir = this.plugin.app.vault.configDir;
    return normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/sync`);
  }

  private statePath(wsId: string): string {
    return `${this.stateDir()}/${wsId}.json`;
  }

  private async loadState(wsId: string): Promise<SyncStateFile> {
    const deviceName = this.deviceName();
    try {
      const path = this.statePath(wsId);
      if (await this.plugin.app.vault.adapter.exists(path)) {
        return loadSyncState(JSON.parse(await this.plugin.app.vault.adapter.read(path)), deviceName);
      }
    } catch (e) {
      console.warn("[InventTasks sync] failed to read sync state, starting fresh", e);
    }
    return loadSyncState(null, deviceName);
  }

  private async saveState(entry: SyncEntry): Promise<void> {
    const dir = this.stateDir();
    if (!(await this.plugin.app.vault.adapter.exists(dir))) {
      await this.plugin.app.vault.adapter.mkdir(dir);
    }
    await this.plugin.app.vault.adapter.write(this.statePath(entry.wsId), JSON.stringify(entry.state));
  }

  private deviceName(): string {
    return this.plugin.app.vault.getName();
  }

  private confirmMassDeletion(wsName: string, deletions: number, total: number, paths?: string[]): Promise<MassDeleteChoice> {
    return new Promise((resolve) => {
      new SyncMassDeleteModal(this.plugin.app, {
        name: wsName,
        deletions,
        total,
        paths,
        onChoose: (choice) => resolve(choice),
      }).open();
      new Notice(t("sync.blockedMassDelete"), 8000);
    });
  }

  /** First-connect dialog: both sides have data → ask how to reconcile. */
  private confirmBootstrap(wsName: string, info: { localFiles: number; serverFiles: number }): Promise<BootstrapChoice> {
    return new Promise((resolve) => {
      new SyncBootstrapModal(this.plugin.app, {
        wsName,
        localFiles: info.localFiles,
        serverFiles: info.serverFiles,
        onChoose: (choice) => resolve(choice),
      }).open();
    });
  }

  private confirmFirstPull(wsName: string, info: { serverFiles: number }): Promise<"pull" | "cancel"> {
    return new Promise((resolve) => {
      new SyncFirstPullModal(this.plugin.app, {
        name: wsName,
        serverFiles: info.serverFiles,
        onChoose: (choice) => resolve(choice),
      }).open();
    });
  }

  /** Turn sync off for one workspace (used when the bootstrap dialog is cancelled). */
  private rejectionMessage(rejected: { path: string; reason: string }[]): string {
    return t("sync.filesRejected", {
      count: String(rejected.length),
      files: rejected.map((r) => r.path).join(", "),
    });
  }

  /**
   * Notify once per distinct set of refusals. Every cycle re-reports the same
   * files (they stay refused until edited), so notifying unconditionally would
   * turn a standing condition into a stream of popups.
   */
  private announceRejections(entry: SyncEntry, rejected: { path: string; reason: string }[]): void {
    const key = rejected.map((r) => r.path).sort().join("\u0000");
    if (key === (entry.lastRejectedKey ?? "")) return;
    entry.lastRejectedKey = key;
    if (rejected.length > 0) new Notice(this.rejectionMessage(rejected), 10000);
  }

  private async disableSyncFor(wsId: string): Promise<void> {
    const ws = this.plugin.settings.workspaces.find((w) => w.id === wsId);
    if (ws?.sync) ws.sync.enabled = false;
    const entry = this.entries.get(wsId);
    if (entry) this.teardown(wsId, entry);
    await this.plugin.saveSettings();
    this.emit();
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch { /* listener errors must not break sync */ }
    }
  }
}
