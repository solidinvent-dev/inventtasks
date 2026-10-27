/**
 * VaultSyncManager — whole-vault sync orchestration, fully independent from
 * the per-workspace task SyncManager (src/sync/manager.ts) it is modeled on:
 * separate settings (PluginSettings.vaultSync), separate client state file,
 * separate server workspace (kind "vault"). It reuses the task-sync building
 * blocks as a LIBRARY only: SyncEngine (conflicts/LWW/history/guards),
 * VaultSyncFs (root "/" + walk exclusions) and HttpSyncTransport.
 *
 * .obsidian paths emit no vault events — the periodic full reconcile is what
 * picks those up (same mechanism task sync uses for dot-paths).
 */

import { Notice, TFolder, normalizePath } from "obsidian";
import type InventTasksPlugin from "../main";
import { SyncBootstrapModal } from "../modals/sync-bootstrap-modal";
import { SyncFirstPullModal } from "../modals/sync-first-pull-modal";
import { SyncMassDeleteModal } from "../modals/sync-mass-delete-modal";
import { t } from "../i18n";
import { FOLDER_MARKER_NAME, type ChangeEntry, type WatchServerMessage } from "../../shared/protocol";
import { SyncEngine, type BootstrapChoice, type MassDeleteChoice } from "../sync/engine";
import { HttpSyncTransport, type VersionEntry } from "../sync/client";
import { VaultSyncFs } from "../sync/fs";
import { loadSyncState, type SyncRunSummary, type SyncStateFile } from "../sync/types";
import {
  buildVaultExclusions, detectWorkspaceRoots, overlappingWholeVaultRoot, type VaultExclusions,
} from "./exclusions";
import { MarkerScanTransport } from "./marker-transport";
import { SizeCappedFs } from "./size-capped-fs";
import { vaultSyncConfigured, type VaultSyncSettings, type VaultSyncStatus } from "./types";

const INITIAL_SYNC_DELAY_MS = 2500; // after the task sync's initial run window
const WATCH_PULL_DELAY_MS = 500;
const RESUME_SYNC_DELAY_MS = 2000;
const WS_BACKOFF_MIN_MS = 1000;
const WS_BACKOFF_MAX_MS = 60_000;
const ADAPTIVE_FAST_MS = 600;
const ADAPTIVE_IDLE_RESET_MS = 15_000;

type SyncRunMode =
  | { dirtyPaths: true }
  | { pullOnly: true }
  | { wsChanges: { since: number; rev: number; files: ChangeEntry[] } }
  | null;

export class VaultSyncManager {
  private readonly plugin: InventTasksPlugin;
  private listeners = new Set<() => void>();
  private eventsRegistered = false;
  private reconfiguring = false;
  private rerunReconfigure = false;

  // Active entry (null = disabled/not configured).
  private cfgKey: string | null = null;
  private state: SyncStateFile | null = null;
  private engine: SyncEngine | null = null;
  private transport: HttpSyncTransport | null = null;
  private fs: SizeCappedFs | null = null;
  private exclusions: VaultExclusions | null = null;
  /** Auto-detected task-workspace roots (marker files) — grows, never shrinks
   *  within an entry's lifetime; reset on reconfigure. */
  private detectedRoots = new Set<string>();
  private dirty = new Set<string>();
  private debounceTimer: number | null = null;
  private shortTimer: number | null = null;
  private intervalTimer: number | null = null;
  private socket: WebSocket | null = null;
  private wsBackoffMs = WS_BACKOFF_MIN_MS;
  private closed = false;
  private running = false;
  private queuedFull = false;
  private lastRunEndAt = 0;
  private overlapWarned = false;
  readonly status: VaultSyncStatus = { phase: "idle", pending: 0, skippedLarge: 0 };

  constructor(plugin: InventTasksPlugin) {
    this.plugin = plugin;
  }

  start(): void {
    this.registerVaultEvents();
    void this.reconfigure();
  }

  stop(): void {
    this.teardown();
  }

  isActive(): boolean {
    return this.engine !== null;
  }

  /** Bring the engine in line with settings. Idempotent; serialised. */
  async reconfigure(): Promise<void> {
    if (this.reconfiguring) { this.rerunReconfigure = true; return; }
    this.reconfiguring = true;
    try {
      do {
        this.rerunReconfigure = false;
        const s = this.settings();
        if (!vaultSyncConfigured(s) || this.overlapGuard(s!)) {
          this.teardown();
          continue;
        }
        await this.ensureEntry(s!);
      } while (this.rerunReconfigure);
    } finally {
      this.reconfiguring = false;
    }
    this.emit();
  }

  onStatusChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Manual full sync. Returns null when not configured. */
  async syncNow(): Promise<SyncRunSummary | null> {
    if (!this.engine) return null;
    if (this.debounceTimer !== null) { window.clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    return this.runSync(null);
  }

  /** Mobile resume: timers/sockets died while suspended — catch up now. */
  onAppResume(): void {
    if (!this.engine) return;
    this.scheduleShort(RESUME_SYNC_DELAY_MS, null);
    if (!this.socket && this.settings()?.liveUpdates) this.connectWatch();
  }

  /** Ship pending edits before the app is backgrounded (see SyncManager.flushPending). */
  flushPending(): void {
    if (!this.engine || this.closed) return;
    if (this.debounceTimer !== null) { window.clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.dirty.size > 0 || this.status.phase === "error") {
      void this.runSync({ dirtyPaths: true });
    }
  }

  /** Settings "Test connection". */
  async testConnection(s: VaultSyncSettings): Promise<{ ok: boolean; message: string }> {
    try {
      const transport = new HttpSyncTransport(s.serverUrl.replace(/\/+$/, ""), s.token, s.remoteId);
      const info = await transport.info();
      await transport.ping();
      return { ok: true, message: t("sync.testOk", { version: info.serverVersion }) };
    } catch (e) {
      return { ok: false, message: t("sync.testFail", { msg: e instanceof Error ? e.message : String(e) }) };
    }
  }

  /** Paths currently tracked (manifest keys) — for the history picker. */
  syncedPaths(): string[] {
    return this.state ? Object.keys(this.state.manifest).sort() : [];
  }

  async listVersions(path: string): Promise<VersionEntry[]> {
    if (!this.transport) throw new Error(t("sync.notConfigured"));
    return (await this.transport.listVersions(path)).versions;
  }

  async versionContent(id: number): Promise<ArrayBuffer> {
    if (!this.transport) throw new Error(t("sync.notConfigured"));
    return this.transport.versionContent(id);
  }

  /** Restore a historical version (see SyncManager.restoreVersion). */
  async restoreVersion(path: string, id: number): Promise<void> {
    if (!this.transport || !this.fs) throw new Error(t("sync.notConfigured"));
    const data = await this.transport.versionContent(id);
    await this.fs.writeBinary(path, data);
    this.scheduleShort(150, null);
  }

  // -------------------------------------------------------------------------
  // Entry lifecycle
  // -------------------------------------------------------------------------

  private settings(): VaultSyncSettings | undefined {
    return this.plugin.settings.vaultSync;
  }

  /** True (and warns once) when a task workspace already syncs the whole vault. */
  private overlapGuard(s: VaultSyncSettings): boolean {
    if (!overlappingWholeVaultRoot(this.plugin.settings.workspaces.map((w) => w.workspaceRoot))) {
      this.overlapWarned = false;
      return false;
    }
    if (s.enabled && !this.overlapWarned) {
      this.overlapWarned = true;
      new Notice(t("vaultSync.overlapNotice"), 10000);
    }
    return true;
  }

  private async ensureEntry(s: VaultSyncSettings): Promise<void> {
    const cfgKey = [
      s.serverUrl, s.remoteId, s.token,
      s.syncObsidianConfig, s.syncObsidianPlugins, s.maxFileMB,
      s.ignorePatterns.join("\n"),
      this.plugin.settings.workspaces.map((w) => w.workspaceRoot).join("|"),
    ].join(" ");
    if (this.engine && this.cfgKey === cfgKey) {
      this.applyTimerSettings(s);
      return;
    }
    this.teardown();
    this.closed = false;
    this.cfgKey = cfgKey;

    const configDir = this.plugin.app.vault.configDir;
    this.detectedRoots = new Set();
    this.scanLocalMarkers();
    this.exclusions = buildVaultExclusions({
      configDir,
      pluginId: this.plugin.manifest.id,
      workspaceRoots: this.plugin.settings.workspaces.map((w) => w.workspaceRoot),
      extraRoots: () => this.detectedRoots,
      syncObsidianConfig: s.syncObsidianConfig,
      syncObsidianPlugins: s.syncObsidianPlugins,
      ignorePatterns: s.ignorePatterns,
    });
    const state = await this.loadState(s.remoteId);
    this.state = state;
    this.transport = new HttpSyncTransport(s.serverUrl, s.token, s.remoteId);
    const rawFs = new VaultSyncFs(this.plugin.app, "/", {
      file: (abs) => this.exclusions!.isExcludedPath(abs),
      dir: (abs) => this.exclusions!.isPrunedDir(abs),
    });
    this.fs = new SizeCappedFs(
      rawFs,
      () => (this.settings()?.maxFileMB ?? 0) * 1024 * 1024,
      (path) => !!this.state?.manifest[path],
    );
    this.engine = new SyncEngine({
      fs: this.fs,
      transport: new MarkerScanTransport(this.transport, (paths) => this.registerDetectedRoots(paths)),
      state,
      saveState: () => this.saveState(),
      conflictCopies: () => this.settings()?.conflictCopies ?? false,
      exclude: (path) => this.exclusions!.isExcludedPath(path),
      confirmMassDeletion: (deletions, total, paths) => this.confirmMassDeletion(deletions, total, paths),
      confirmBootstrap: (info) => this.confirmBootstrap(info),
      confirmFirstPull: (info) => this.confirmFirstPull(info),
      log: (msg) => console.warn(`[InventTasks vault sync] ${msg}`),
    });

    this.applyTimerSettings(s);
    this.scheduleShort(INITIAL_SYNC_DELAY_MS, null);
    if (s.liveUpdates) this.connectWatch();
  }

  private applyTimerSettings(s: VaultSyncSettings): void {
    if (this.intervalTimer !== null) window.clearInterval(this.intervalTimer);
    this.intervalTimer = window.setInterval(() => void this.runSync(null), s.intervalMinutes * 60_000);
    if (s.liveUpdates && !this.socket) this.connectWatch();
    if (!s.liveUpdates && this.socket) {
      try { this.socket.close(); } catch { /* closing */ }
      this.socket = null;
    }
  }

  private teardown(): void {
    this.closed = true;
    if (this.debounceTimer !== null) { window.clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.shortTimer !== null) { window.clearTimeout(this.shortTimer); this.shortTimer = null; }
    if (this.intervalTimer !== null) { window.clearInterval(this.intervalTimer); this.intervalTimer = null; }
    if (this.socket) { try { this.socket.close(); } catch { /* closing */ } this.socket = null; }
    this.engine = null;
    this.transport = null;
    this.fs = null;
    this.state = null;
    this.exclusions = null;
    this.dirty.clear();
    this.status.phase = "idle";
    this.status.pending = 0;
    this.status.skippedLarge = 0;
    this.cfgKey = null;
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
    if (!this.engine || this.closed) return;
    // A marker file appearing means its directory just became a task
    // workspace — register it right away so the files created around it in
    // the same burst never enter the dirty set.
    this.registerDetectedRoots([absPath]);
    if (this.exclusions!.isExcludedPath(absPath)) return;
    this.dirty.add(absPath); // root is "/", so abs == engine-relative
    this.status.pending = this.dirty.size;
    this.scheduleDebounced();
  }

  /** Detected-roots bookkeeping (marker files → their directories). */
  private registerDetectedRoots(paths: Iterable<string>): void {
    for (const root of detectWorkspaceRoots(paths)) this.detectedRoots.add(root);
  }

  /** Sweep the in-memory file index for marker files (cheap, no IO). */
  private scanLocalMarkers(): void {
    this.registerDetectedRoots(this.plugin.app.vault.getFiles().map((f) => f.path));
  }

  private scheduleDebounced(): void {
    const full = (this.settings()?.debounceSeconds ?? 4) * 1000;
    const idle = this.debounceTimer === null && (Date.now() - this.lastRunEndAt) > ADAPTIVE_IDLE_RESET_MS;
    const delay = idle ? Math.min(ADAPTIVE_FAST_MS, full) : full;
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.runSync({ dirtyPaths: true });
    }, delay);
  }

  private scheduleShort(delayMs: number, mode: { pullOnly: true } | null): void {
    if (this.shortTimer !== null) window.clearTimeout(this.shortTimer);
    this.shortTimer = window.setTimeout(() => {
      this.shortTimer = null;
      void this.runSync(mode === null ? null : { pullOnly: true });
    }, delayMs);
  }

  // -------------------------------------------------------------------------
  // Run orchestration (single-flight)
  // -------------------------------------------------------------------------

  private async runSync(mode: SyncRunMode): Promise<SyncRunSummary | null> {
    const engine = this.engine;
    if (!engine || this.closed) return null;
    if (this.running) {
      this.queuedFull = true;
      return null;
    }
    this.running = true;
    this.status.phase = "syncing";
    this.emit();
    // Fresh markers on disk (workspace created since the last run) must be
    // known before the engine lists/pushes anything.
    this.scanLocalMarkers();

    const isWs = !!mode && "wsChanges" in mode;
    const dirtySnapshot = isWs ? [] : [...this.dirty];
    if (!isWs) this.dirty.clear();

    try {
      if (mode && "wsChanges" in mode) {
        const { since, rev, files } = mode.wsChanges;
        // Inline WS deltas bypass the transport wrapper — scan them here.
        this.registerDetectedRoots(files.map((f) => f.path));
        const result = await engine.applyLiveChanges(since, rev, files);
        if (result === "gap") {
          this.scheduleShort(0, { pullOnly: true });
        } else if (result === "applied-needs-push") {
          // The user chose to UNDO a deletion — full cycle pushes files back.
          this.scheduleShort(0, null);
          this.status.phase = "syncing";
          return null;
        } else if (result === "blocked") {
          this.status.phase = "blocked";
          this.status.lastError = t("sync.blockedMassDelete");
          return null;
        } else {
          this.markIdle();
        }
        return null;
      }

      const sum = await engine.run(
        mode && "dirtyPaths" in mode ? { dirtyPaths: dirtySnapshot }
          : mode && "pullOnly" in mode ? { pullOnly: true }
            : undefined,
      );
      if (sum.cancelled) {
        this.status.phase = "idle";
        this.status.lastError = undefined;
        new Notice(t("vaultSync.bootstrapCancelledNotice"));
        await this.disableSelf();
        return sum;
      }
      if (sum.blocked) {
        this.status.phase = "blocked";
        this.status.lastError = t("sync.blockedMassDelete");
      } else {
        this.markIdle();
      }
      return sum;
    } catch (e) {
      for (const p of dirtySnapshot) this.dirty.add(p);
      this.status.phase = "error";
      this.status.lastError = e instanceof Error ? e.message : String(e);
      console.warn(`[InventTasks vault sync] ${this.status.lastError}`);
      return null;
    } finally {
      this.running = false;
      this.lastRunEndAt = Date.now();
      this.status.pending = this.dirty.size;
      this.status.skippedLarge = this.fs?.skippedLarge ?? 0;
      this.emit();
      if (this.queuedFull && !this.closed) {
        this.queuedFull = false;
        this.scheduleShort(250, null);
      }
    }
  }

  private markIdle(): void {
    this.status.phase = "idle";
    this.status.lastSyncAt = Date.now();
    this.status.lastError = undefined;
  }

  // -------------------------------------------------------------------------
  // WebSocket watch (instant pulls)
  // -------------------------------------------------------------------------

  private connectWatch(): void {
    if (typeof WebSocket === "undefined" || this.closed || this.socket || !this.engine) return;
    const s = this.settings();
    if (!s || !s.liveUpdates) return;
    const url = `${s.serverUrl.replace(/^http/, "ws")}/api/v1/workspaces/${encodeURIComponent(s.remoteId)}/watch`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.wsBackoffMs = WS_BACKOFF_MIN_MS;
      socket.send(JSON.stringify({ type: "auth", token: s.token }));
    };
    socket.onmessage = (ev) => {
      let msg: WatchServerMessage | null = null;
      try { msg = JSON.parse(String(ev.data)) as WatchServerMessage | null; } catch { return; }
      if (!msg || !this.state) return;
      if (msg.type === "changes" && msg.rev > this.state.cursor) {
        void this.runSync({ wsChanges: { since: msg.since, rev: msg.rev, files: msg.files } });
      } else if (msg.type === "rev" && msg.rev > this.state.cursor) {
        this.scheduleShort(WATCH_PULL_DELAY_MS, { pullOnly: true });
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      try { socket.close(); } catch { /* closing */ }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.settings()?.liveUpdates) return;
    const delay = this.wsBackoffMs;
    this.wsBackoffMs = Math.min(this.wsBackoffMs * 2, WS_BACKOFF_MAX_MS);
    window.setTimeout(() => {
      if (!this.closed && !this.socket) this.connectWatch();
    }, delay);
  }

  // -------------------------------------------------------------------------
  // State persistence + guard modals
  // -------------------------------------------------------------------------

  private stateDir(): string {
    const configDir = this.plugin.app.vault.configDir;
    return normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/sync`);
  }

  /** "vault~" prefix keeps clear of task-workspace ids (ws-…) in the same dir. */
  private statePath(remoteId: string): string {
    return `${this.stateDir()}/vault~${remoteId}.json`;
  }

  private async loadState(remoteId: string): Promise<SyncStateFile> {
    const deviceName = this.plugin.app.vault.getName();
    try {
      const path = this.statePath(remoteId);
      if (await this.plugin.app.vault.adapter.exists(path)) {
        return loadSyncState(JSON.parse(await this.plugin.app.vault.adapter.read(path)), deviceName);
      }
    } catch (e) {
      console.warn("[InventTasks vault sync] failed to read sync state, starting fresh", e);
    }
    return loadSyncState(null, deviceName);
  }

  private async saveState(): Promise<void> {
    if (!this.state) return;
    const s = this.settings();
    if (!s) return;
    const dir = this.stateDir();
    if (!(await this.plugin.app.vault.adapter.exists(dir))) {
      await this.plugin.app.vault.adapter.mkdir(dir);
    }
    await this.plugin.app.vault.adapter.write(this.statePath(s.remoteId), JSON.stringify(this.state));
  }

  private confirmMassDeletion(deletions: number, total: number, paths?: string[]): Promise<MassDeleteChoice> {
    return new Promise((resolve) => {
      new SyncMassDeleteModal(this.plugin.app, {
        name: t("vaultSync.scopeName"),
        deletions,
        total,
        paths,
        onChoose: (choice) => resolve(choice),
      }).open();
      new Notice(t("sync.blockedMassDelete"), 8000);
    });
  }

  private confirmBootstrap(info: { localFiles: number; serverFiles: number }): Promise<BootstrapChoice> {
    return new Promise((resolve) => {
      new SyncBootstrapModal(this.plugin.app, {
        wsName: t("vaultSync.scopeName"),
        localFiles: info.localFiles,
        serverFiles: info.serverFiles,
        onChoose: (choice) => resolve(choice),
      }).open();
    });
  }

  private confirmFirstPull(info: { serverFiles: number }): Promise<"pull" | "cancel"> {
    return new Promise((resolve) => {
      new SyncFirstPullModal(this.plugin.app, {
        name: t("vaultSync.scopeName"),
        serverFiles: info.serverFiles,
        onChoose: (choice) => resolve(choice),
      }).open();
    });
  }

  /** Turn vault sync off (bootstrap dialog cancelled) so it doesn't re-prompt. */
  private async disableSelf(): Promise<void> {
    const s = this.settings();
    if (s) s.enabled = false;
    this.teardown();
    await this.plugin.saveSettings();
    this.emit();
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch { /* listener errors must not break sync */ }
    }
  }
}
