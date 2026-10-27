import { App, EventRef, Notice, TAbstractFile, TFile, normalizePath, arrayBufferToBase64, base64ToArrayBuffer } from "obsidian";
import type InventTasksPlugin from "../main";
import type { WorkspaceEntry } from "../settings";
import { splitFrontmatter, type Frontmatter } from "./parsers";
import { t } from "../i18n";
import { sha256Hex } from "../sync/util";
import { scalarText } from "../utils/text";

export type BackupLocationMode = "plugin" | "vault";
export type BackupBodyMode = "auto" | "always" | "never";

export interface IncrementalBackupSettings {
  enabled: boolean;
  locationMode: BackupLocationMode;
  snapshotEveryHours: number;
  journalDebounceSeconds: number;
  retentionDays: number;
  maxMb: number;
  includeMarkdownBody: BackupBodyMode;
  maxRawFileKb: number;
  lastSnapshotAt?: string;
  lastJournalAt?: string;
  lastError?: string;
}

export const DEFAULT_INCREMENTAL_BACKUP_SETTINGS: IncrementalBackupSettings = {
  enabled: false,
  locationMode: "plugin",
  snapshotEveryHours: 6,
  journalDebounceSeconds: 30,
  retentionDays: 7,
  maxMb: 200,
  includeMarkdownBody: "auto",
  maxRawFileKb: 512,
};

export function makeIncrementalBackupSettings(partial?: Partial<IncrementalBackupSettings>): IncrementalBackupSettings {
  return {
    ...DEFAULT_INCREMENTAL_BACKUP_SETTINGS,
    ...withoutCustomPath(partial),
    snapshotEveryHours: clampNumber(partial?.snapshotEveryHours, 1, 168, DEFAULT_INCREMENTAL_BACKUP_SETTINGS.snapshotEveryHours),
    journalDebounceSeconds: clampNumber(partial?.journalDebounceSeconds, 5, 3600, DEFAULT_INCREMENTAL_BACKUP_SETTINGS.journalDebounceSeconds),
    retentionDays: clampNumber(partial?.retentionDays, 1, 365, DEFAULT_INCREMENTAL_BACKUP_SETTINGS.retentionDays),
    maxMb: clampNumber(partial?.maxMb, 10, 10240, DEFAULT_INCREMENTAL_BACKUP_SETTINGS.maxMb),
    maxRawFileKb: clampNumber(partial?.maxRawFileKb, 1, 10240, DEFAULT_INCREMENTAL_BACKUP_SETTINGS.maxRawFileKb),
    // "custom" (a path outside the vault, written with Node's fs) was removed
    // in 1.2.0; such workspaces fall back to the plugin folder.
    locationMode: partial?.locationMode === "vault" ? "vault" : "plugin",
    includeMarkdownBody: partial?.includeMarkdownBody || DEFAULT_INCREMENTAL_BACKUP_SETTINGS.includeMarkdownBody,
  };
}

function withoutCustomPath(partial?: Partial<IncrementalBackupSettings>): Partial<IncrementalBackupSettings> {
  const { customPath: _customPath, ...rest } = (partial || {}) as Partial<IncrementalBackupSettings> & { customPath?: string };
  return rest;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : parseInt(scalarText(value), 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

type BackupKind = "snapshot" | "journal" | "safety";
type BackupFileKind = "task" | "config" | "view" | "doc" | "markdown" | "asset" | "other";

export interface BackupFileEntry {
  path: string;
  kind: BackupFileKind;
  deleted?: boolean;
  size?: number;
  mtime?: number;
  sha256?: string;
  yamlError?: string;
  frontmatter?: Frontmatter;
  body?: string;
  raw?: string;
  /**
   * Content lives in the shared blob store under this sha256 instead of being
   * inlined. A full snapshot every few hours would otherwise re-encode every
   * unchanged attachment, so identical bytes are written once and referenced.
   */
  blobRef?: string;
  rawEncoding?: "utf8" | "base64";
  rawTruncated?: boolean;
  /** Set when the file's content could NOT be captured — surfaced to the user. */
  skipped?: string;
  note?: string;
}

export interface IncrementalBackupBundle {
  format: "inventtasks-incremental-backup";
  version: 1;
  kind: BackupKind;
  createdAt: string;
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  pluginSettings: Record<string, unknown>;
  stats: {
    files: number;
    rawFiles: number;
    frontmatterOnlyFiles: number;
    deletedFiles: number;
  };
  files: BackupFileEntry[];
}

export interface BackupSummary {
  name: string;
  path: string;
  kind: BackupKind;
  createdAt: string;
  workspaceId: string;
  workspaceName: string;
  files: number;
  bytes: number;
  /** Files whose content this backup does not contain, with the reason. */
  skipped?: { path: string; reason: string }[];
}

interface BackupTarget {
  root: string;
  ensureDir(path: string): Promise<void>;
  write(path: string, contents: string): Promise<void>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
}

export class IncrementalBackupService {
  private plugin: InventTasksPlugin;
  private eventRefs: EventRef[] = [];
  private snapshotTimers = new Map<string, number>();
  private journalTimers = new Map<string, number>();
  private pendingPaths = new Map<string, Set<string>>();

  constructor(plugin: InventTasksPlugin) {
    this.plugin = plugin;
  }

  start(): void {
    this.stop();
    this.eventRefs = [
      this.plugin.app.vault.on("modify", (file) => this.onVaultChange("modify", file)),
      this.plugin.app.vault.on("create", (file) => this.onVaultChange("create", file)),
      this.plugin.app.vault.on("delete", (file) => this.onVaultChange("delete", file)),
      this.plugin.app.vault.on("rename", (file, oldPath) => {
        this.onVaultChange("delete", oldPath);
        this.onVaultChange("modify", file);
      }),
    ];
    for (const ws of this.enabledWorkspaces()) this.armWorkspace(ws);
  }

  stop(): void {
    for (const ref of this.eventRefs) {
      try { this.plugin.app.vault.offref(ref); } catch { /* ignore */ }
    }
    this.eventRefs = [];
    for (const timer of this.snapshotTimers.values()) window.clearInterval(timer);
    for (const timer of this.journalTimers.values()) window.clearTimeout(timer);
    this.snapshotTimers.clear();
    this.journalTimers.clear();
    this.pendingPaths.clear();
  }

  reconfigure(): void {
    this.start();
  }

  defaultPluginBackupRoot(): string {
    const configDir = this.plugin.app.vault.configDir;
    return normalizePath(`${configDir}/plugins/${this.plugin.manifest.id}/backups`);
  }

  async runSnapshot(ws: WorkspaceEntry = this.plugin.prefs, kind: BackupKind = "snapshot"): Promise<BackupSummary> {
    const settings = makeIncrementalBackupSettings(ws.backup);
    const target = await this.targetFor(ws);
    const bundle = await this.buildBundle(ws, kind, await this.workspacePaths(ws), settings);
    const summary = await this.writeBundle(target, ws, bundle);
    ws.backup = { ...settings, lastSnapshotAt: bundle.createdAt, lastError: undefined };
    await this.prune(ws);
    await this.plugin.saveSettings();
    return summary;
  }

  async runJournal(ws: WorkspaceEntry, paths: string[]): Promise<BackupSummary | null> {
    const settings = makeIncrementalBackupSettings(ws.backup);
    if (!settings.enabled || !paths.length) return null;
    const relevant = paths.filter((path) => this.pathInWorkspace(ws, path) && !this.isBackupPath(path));
    if (!relevant.length) return null;
    const target = await this.targetFor(ws);
    const bundle = await this.buildBundle(ws, "journal", relevant, settings);
    const summary = await this.writeBundle(target, ws, bundle);
    ws.backup = { ...settings, lastJournalAt: bundle.createdAt, lastError: undefined };
    await this.prune(ws);
    await this.plugin.saveSettings();
    return summary;
  }

  async listBackups(ws: WorkspaceEntry = this.plugin.prefs): Promise<BackupSummary[]> {
    const target = await this.targetFor(ws);
    const dir = this.workspaceBackupDir(target, ws);
    const files = await this.safeList(target, dir);
    const summaries: BackupSummary[] = [];
    for (const path of files.files.filter((p) => p.endsWith(".json"))) {
      try {
        const raw = await target.read(path);
        const parsed = JSON.parse(raw) as IncrementalBackupBundle;
        if (parsed?.format !== "inventtasks-incremental-backup") continue;
        const stat = await target.stat(path);
        summaries.push({
          name: path.split("/").pop() || path,
          path,
          kind: parsed.kind,
          createdAt: parsed.createdAt,
          workspaceId: parsed.workspaceId,
          workspaceName: parsed.workspaceName,
          files: parsed.files?.length || 0,
          bytes: stat?.size ?? raw.length,
        });
      } catch { /* skip unreadable backup */ }
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async restoreBackup(ws: WorkspaceEntry, backupPath: string, opts: { mode: "new-folder" | "overwrite"; destinationRoot?: string }): Promise<number> {
    if (opts.mode === "overwrite") {
      await this.runSnapshot(ws, "safety");
    }
    const target = await this.targetFor(ws);
    const selected = JSON.parse(await target.read(backupPath)) as IncrementalBackupBundle;
    if (selected.format !== "inventtasks-incremental-backup") throw new Error("Not an InventTasks incremental backup.");
    const chain = await this.restoreChain(ws, selected, backupPath);
    const base = chain[0] || selected;
    let restored = 0;
    const destinationRoot = normalizePath(opts.destinationRoot || `${ws.workspaceRoot || "Tasks"} Restored ${timestampSlug(new Date())}`);
    const finalFiles = new Map<string, BackupFileEntry>();
    const deletedPaths = new Set<string>();
    for (const bundle of chain) {
      for (const entry of bundle.files) {
        if (entry.deleted) {
          finalFiles.delete(entry.path);
          deletedPaths.add(entry.path);
        } else {
          finalFiles.set(entry.path, entry);
          deletedPaths.delete(entry.path);
        }
      }
    }
    if (opts.mode === "overwrite") {
      for (const path of deletedPaths) {
        const existing = this.plugin.app.vault.getAbstractFileByPath(path);
        if (existing) await this.plugin.app.fileManager.trashFile(existing);
      }
    }
    const unrestorable: { path: string; reason: string }[] = [];
    for (const entry of finalFiles.values()) {
      if (entry.deleted) continue;
      const stored = await this.contentFor(target, ws, entry);
      const contents = stored || this.frontmatterOnlyMarkdown(entry);
      if (!contents) {
        // Say so out loud. A restore that quietly rebuilds an incomplete vault
        // is worse than one that fails, because the gap is only found later.
        unrestorable.push({ path: entry.path, reason: entry.skipped ?? "no content stored in this backup" });
        continue;
      }
      const destPath = opts.mode === "overwrite"
        ? entry.path
        : normalizePath(`${destinationRoot}/${this.relativeToWorkspace(base.workspaceRoot, entry.path)}`);
      await this.ensureVaultFolder(destPath.split("/").slice(0, -1).join("/"));
      const existing = this.plugin.app.vault.getAbstractFileByPath(destPath);
      if (entry.rawEncoding === "base64") {
        // Overwrite in place: replacing a file is not deleting it.
        await this.writeVaultBinary(destPath, contents, existing);
      } else if (existing instanceof TFile) await this.plugin.app.vault.modify(existing, contents);
      else await this.plugin.app.vault.create(destPath, contents);
      restored++;
    }
    this.lastRestoreSkipped = unrestorable;
    await this.plugin.index.rescan();
    this.plugin.refreshViews();
    return restored;
  }

  /** Files the last restore could not bring back (read by the restore dialog). */
  lastRestoreSkipped: { path: string; reason: string }[] = [];

  private async restoreChain(ws: WorkspaceEntry, selected: IncrementalBackupBundle, selectedPath: string): Promise<IncrementalBackupBundle[]> {
    if (selected.kind === "snapshot" || selected.kind === "safety") return [selected];
    const backups = await this.listBackups(ws);
    const before = backups
      .filter((b) => b.createdAt <= selected.createdAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const baseIndex = before.map((b) => b.kind === "snapshot" || b.kind === "safety").lastIndexOf(true);
    if (baseIndex < 0) throw new Error("Cannot restore this journal because its base snapshot was pruned.");
    const chainSummaries = before.slice(baseIndex);
    if (!chainSummaries.some((b) => b.path === selectedPath)) chainSummaries.push({
      name: selectedPath.split("/").pop() || selectedPath,
      path: selectedPath,
      kind: selected.kind,
      createdAt: selected.createdAt,
      workspaceId: selected.workspaceId,
      workspaceName: selected.workspaceName,
      files: selected.files.length,
      bytes: 0,
    });
    const target = await this.targetFor(ws);
    const chain: IncrementalBackupBundle[] = [];
    for (const summary of chainSummaries.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const bundle = summary.path === selectedPath ? selected : JSON.parse(await target.read(summary.path)) as IncrementalBackupBundle | null;
      if (bundle?.format === "inventtasks-incremental-backup") chain.push(bundle);
    }
    return chain.length ? chain : [selected];
  }

  backupStatus(ws: WorkspaceEntry = this.plugin.prefs): { root: string; enabled: boolean; lastSnapshotAt?: string; lastJournalAt?: string; lastError?: string } {
    const settings = makeIncrementalBackupSettings(ws.backup);
    return {
      root: this.rootFor(ws),
      enabled: settings.enabled,
      lastSnapshotAt: settings.lastSnapshotAt,
      lastJournalAt: settings.lastJournalAt,
      lastError: settings.lastError,
    };
  }

  private enabledWorkspaces(): WorkspaceEntry[] {
    return this.plugin.settings.workspaces.filter((ws) => makeIncrementalBackupSettings(ws.backup).enabled);
  }

  private armWorkspace(ws: WorkspaceEntry): void {
    const settings = makeIncrementalBackupSettings(ws.backup);
    if (!settings.enabled) return;
    void this.maybeInitialSnapshot(ws);
    const intervalMs = settings.snapshotEveryHours * 60 * 60 * 1000;
    const timer = window.setInterval(() => void this.runSnapshot(ws).catch((e) => this.recordError(ws, e)), intervalMs);
    this.snapshotTimers.set(ws.id, timer);
  }

  private async maybeInitialSnapshot(ws: WorkspaceEntry): Promise<void> {
    const settings = makeIncrementalBackupSettings(ws.backup);
    const last = settings.lastSnapshotAt ? Date.parse(settings.lastSnapshotAt) : 0;
    const dueMs = settings.snapshotEveryHours * 60 * 60 * 1000;
    if (!last || Date.now() - last >= dueMs) {
      await this.runSnapshot(ws).catch((e) => this.recordError(ws, e));
    }
  }

  private onVaultChange(_kind: "create" | "modify" | "delete", fileOrPath: TAbstractFile | string): void {
    const path = typeof fileOrPath === "string" ? fileOrPath : fileOrPath.path;
    if (!path || this.isBackupPath(path)) return;
    for (const ws of this.enabledWorkspaces()) {
      if (!this.pathInWorkspace(ws, path)) continue;
      const pending = this.pendingPaths.get(ws.id) || new Set<string>();
      pending.add(path);
      this.pendingPaths.set(ws.id, pending);
      const existing = this.journalTimers.get(ws.id);
      if (existing) window.clearTimeout(existing);
      const delay = makeIncrementalBackupSettings(ws.backup).journalDebounceSeconds * 1000;
      const timer = window.setTimeout(() => {
        this.journalTimers.delete(ws.id);
        const paths = [...(this.pendingPaths.get(ws.id) || [])];
        this.pendingPaths.delete(ws.id);
        void this.runJournal(ws, paths).catch((e) => this.recordError(ws, e));
      }, delay);
      this.journalTimers.set(ws.id, timer);
    }
  }

  private async buildBundle(
    ws: WorkspaceEntry,
    kind: BackupKind,
    paths: string[],
    settings: IncrementalBackupSettings,
  ): Promise<IncrementalBackupBundle> {
    const files: BackupFileEntry[] = [];
    for (const path of [...new Set(paths.map((p) => normalizePath(p)))]) {
      if (this.isBackupPath(path)) continue;
      files.push(await this.entryForPath(path, settings));
    }
    const rawFiles = files.filter((f) => !!f.raw).length;
    const deletedFiles = files.filter((f) => f.deleted).length;
    return {
      format: "inventtasks-incremental-backup",
      version: 1,
      kind,
      createdAt: new Date().toISOString(),
      workspaceId: ws.id,
      workspaceName: ws.name,
      workspaceRoot: normalizeWorkspaceRoot(ws.workspaceRoot),
      pluginSettings: this.sanitizedSettingsFor(ws),
      stats: {
        files: files.length,
        rawFiles,
        frontmatterOnlyFiles: files.filter((f) => !f.raw && !f.deleted).length,
        deletedFiles,
      },
      files,
    };
  }

  private async entryForPath(path: string, settings: IncrementalBackupSettings): Promise<BackupFileEntry> {
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(existing instanceof TFile)) return { path, kind: this.fileKind(path), deleted: true };
    const isText = this.isTextFile(path);
    const raw = isText ? await this.plugin.app.vault.read(existing) : "";
    const binary = isText ? undefined : await this.readVaultBinaryBase64(path);
    const size = isText ? raw.length : (binary?.byteLength ?? existing.stat?.size ?? 0);
    const parsed = isText ? splitFrontmatter(raw) : { fm: {}, body: "", hadFrontmatter: false as const, yamlError: undefined };
    const base: BackupFileEntry = {
      path,
      kind: this.fileKind(path),
      size,
      mtime: existing.stat?.mtime,
      sha256: isText ? await sha256Hex(new TextEncoder().encode(raw)) : binary?.sha256,
      yamlError: parsed.yamlError,
      frontmatter: parsed.hadFrontmatter ? parsed.fm : undefined,
    };
    if (!isText && binary) {
      base.raw = binary.base64;
      base.rawEncoding = "base64";
    } else if (this.shouldStoreRaw(path, raw, settings)) {
      base.raw = raw;
      base.rawEncoding = "utf8";
    } else if (path.endsWith(".md")) {
      base.body = settings.includeMarkdownBody === "never" ? undefined : parsed.body;
      base.rawTruncated = true;
      base.note = "Stored frontmatter/body fallback instead of full raw file.";
    } else {
      base.skipped = `over the ${settings.maxRawFileKb} KB per-file limit`;
      base.note = "Content not captured — see skipped.";
    }
    return base;
  }

  private shouldStoreRaw(path: string, raw: string, settings: IncrementalBackupSettings): boolean {
    // Non-markdown text (csv, txt, json, ics, …) used to fall straight through
    // to "metadata only", so a restore silently rebuilt a vault without them —
    // while binaries of any size were kept in full. Text is cheap; the only
    // reason to leave it out is the same size ceiling markdown obeys.
    if (!path.endsWith(".md")) return raw.length <= settings.maxRawFileKb * 1024;
    if (settings.includeMarkdownBody === "never") return false;
    if (settings.includeMarkdownBody === "always") return true;
    return raw.length <= settings.maxRawFileKb * 1024;
  }

  private frontmatterOnlyMarkdown(entry: BackupFileEntry): string {
    if (!entry.frontmatter) return "";
    const lines = ["---", ...Object.entries(entry.frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), "---", ""];
    if (entry.body) lines.push(entry.body);
    else lines.push(`# ${(entry.frontmatter.title as string | undefined) || entry.path.split("/").pop()?.replace(/\.md$/, "") || "Restored"}\n`);
    return lines.join("\n");
  }

  private fileKind(path: string): BackupFileKind {
    const name = path.split("/").pop() || "";
    if (name === "_workspace.md" || name === "_space.md" || name === "_folder.md" || name === "_list.md" || name === "_workspace-state.md") return "config";
    if (path.includes("/_views/")) return "view";
    if (path.includes("/_docs/")) return "doc";
    if (path.endsWith(".md")) return name.startsWith("_") ? "config" : "task";
    return /\.(png|jpe?g|gif|webp|pdf|zip|mp4|mov)$/i.test(path) ? "asset" : "other";
  }

  private isTextFile(path: string): boolean {
    return /\.(md|json|txt|csv|html|css|ics)$/i.test(path);
  }

  private async workspacePaths(ws: WorkspaceEntry): Promise<string[]> {
    const root = normalizeWorkspaceRoot(ws.workspaceRoot);
    const out: string[] = [];
    const walk = async (dir: string) => {
      const listed = await this.safeVaultList(dir);
      for (const file of listed.files) {
        if (!this.isBackupPath(file) && this.pathInWorkspace(ws, file)) out.push(file);
      }
      for (const folder of listed.folders) {
        // Same rule as the journal: the config folder (whatever it is called)
        // is never part of a workspace, so snapshots skip it too.
        if (!this.isBackupPath(folder) && normalizePath(folder) !== this.plugin.app.vault.configDir) await walk(folder);
      }
    };
    await walk(root);
    return out;
  }

  private sanitizedSettingsFor(ws: WorkspaceEntry): Record<string, unknown> {
    // notifConfig carries no secrets (the ntfy token lives in
    // the global accounts, which are not part of workspace backups); the
    // runtime notifState is transient and excluded.
    const { notifState, ...rest } = ws;
    return {
      workspace: {
        ...rest,
        backup: makeIncrementalBackupSettings(ws.backup),
      },
      calendarSync: this.plugin.settings.calendarSync ? {
        ...this.plugin.settings.calendarSync,
        caldav: this.plugin.settings.calendarSync.caldav ? redactSecrets(this.plugin.settings.calendarSync.caldav) : undefined,
      } : undefined,
    };
  }

  /** Shared content store beside the bundles: one file per sha256. */
  private blobDir(target: BackupTarget, ws: WorkspaceEntry): string {
    return `${this.workspaceBackupDir(target, ws)}/blobs`;
  }

  /**
   * Move every entry's content into the blob store and leave a reference.
   *
   * A snapshot is a FULL capture by design — that is what makes a restore
   * self-contained — but writing it every few hours re-encoded every unchanged
   * attachment, so an untouched 1 MB file cost 1.4 MB of base64 four times a
   * day. Content is keyed by the sha256 the entry already carries, so a repeat
   * snapshot of unchanged files writes nothing at all, and far more restore
   * points fit inside the same size budget.
   */
  private async externalizeContent(target: BackupTarget, ws: WorkspaceEntry, bundle: IncrementalBackupBundle): Promise<number> {
    const dir = this.blobDir(target, ws);
    await target.ensureDir(dir);
    let written = 0;
    for (const entry of bundle.files) {
      if (entry.raw === undefined || !entry.sha256) continue;
      const blobPath = `${dir}/${entry.sha256}`;
      if (!(await target.stat(blobPath))) {
        await target.write(blobPath, entry.raw);
        written += entry.raw.length;
      }
      entry.blobRef = entry.sha256;
      delete entry.raw;
    }
    return written;
  }

  /** Content for an entry, from the blob store or inlined by an older bundle. */
  private async contentFor(target: BackupTarget, ws: WorkspaceEntry, entry: BackupFileEntry): Promise<string> {
    if (entry.raw !== undefined) return entry.raw;
    if (!entry.blobRef) return "";
    try { return await target.read(`${this.blobDir(target, ws)}/${entry.blobRef}`); }
    catch { return ""; }
  }

  private async writeBundle(target: BackupTarget, ws: WorkspaceEntry, bundle: IncrementalBackupBundle): Promise<BackupSummary> {
    const dir = this.workspaceBackupDir(target, ws);
    await target.ensureDir(dir);
    const blobBytes = await this.externalizeContent(target, ws, bundle);
    const name = `${bundle.createdAt.replace(/[:.]/g, "-")}-${bundle.kind}.json`;
    const path = `${dir}/${name}`;
    const raw = JSON.stringify(bundle, null, 2);
    await target.write(path, raw);
    const skipped = bundle.files
      .filter((f) => f.skipped)
      .map((f) => ({ path: f.path, reason: f.skipped! }));
    return {
      name,
      path,
      kind: bundle.kind,
      createdAt: bundle.createdAt,
      workspaceId: ws.id,
      workspaceName: ws.name,
      files: bundle.files.length,
      bytes: raw.length + blobBytes,
      skipped: skipped.length ? skipped : undefined,
    };
  }

  /**
   * Retention works on whole restore chains, never on single bundles.
   *
   * A journal is only meaningful together with the snapshot it builds on, and
   * the old rule protected just the NEWEST anchor — so an older snapshot could
   * be pruned while its journals survived, leaving restore points that fail
   * with "its base snapshot was pruned". Dropping a chain as a unit means every
   * bundle left on disk is still restorable.
   */
  private async prune(ws: WorkspaceEntry): Promise<void> {
    const settings = makeIncrementalBackupSettings(ws.backup);
    const target = await this.targetFor(ws);
    const backups = await this.listBackups(ws);
    const ordered = backups.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const chains: BackupSummary[][] = [];
    for (const backup of ordered) {
      if (backup.kind === "snapshot" || backup.kind === "safety" || !chains.length) chains.push([backup]);
      else chains[chains.length - 1].push(backup);
    }

    const cutoff = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
    const maxBytes = settings.maxMb * 1024 * 1024;
    // Bundles are small now that content lives in blobs, so the ceiling has to
    // count the blob store too or maxMb would stop bounding anything real.
    let total = ordered.reduce((sum, b) => sum + b.bytes, 0) + await this.blobBytes(target, ws);

    // Oldest first, and never the last chain: something must stay restorable.
    for (const chain of chains.slice(0, -1)) {
      const chainBytes = chain.reduce((sum, b) => sum + b.bytes, 0);
      const tooOld = Date.parse(chain[chain.length - 1].createdAt) < cutoff;
      if (!tooOld && total <= maxBytes) break;
      for (const backup of chain) await target.remove(backup.path).catch(() => {});
      total -= chainBytes;
    }
    await this.collectBlobs(target, ws);
  }

  /** Drop blobs no surviving bundle refers to any more. */
  private async collectBlobs(target: BackupTarget, ws: WorkspaceEntry): Promise<void> {
    const dir = this.blobDir(target, ws);
    const listing = await this.safeListRaw(target, dir);
    if (!listing.length) return;
    const referenced = new Set<string>();
    for (const summary of await this.listBackups(ws)) {
      try {
        const bundle = JSON.parse(await target.read(summary.path)) as IncrementalBackupBundle;
        for (const entry of bundle.files) if (entry.blobRef) referenced.add(entry.blobRef);
      } catch { /* unreadable bundle — keep its blobs rather than risk data loss */ return; }
    }
    for (const blobPath of listing) {
      const hash = blobPath.split("/").pop() || "";
      if (!referenced.has(hash)) await target.remove(blobPath).catch(() => {});
    }
  }

  private async blobBytes(target: BackupTarget, ws: WorkspaceEntry): Promise<number> {
    let total = 0;
    for (const path of await this.safeListRaw(target, this.blobDir(target, ws))) {
      total += (await target.stat(path))?.size ?? 0;
    }
    return total;
  }

  private async safeListRaw(target: BackupTarget, dir: string): Promise<string[]> {
    try { return (await target.list(dir)).files; } catch { return []; }
  }

  private async targetFor(ws: WorkspaceEntry): Promise<BackupTarget> {
    return adapterTarget(this.plugin.app, this.rootFor(ws));
  }

  private rootFor(ws: WorkspaceEntry): string {
    const settings = makeIncrementalBackupSettings(ws.backup);
    if (settings.locationMode === "vault") return normalizePath(`${normalizeWorkspaceRoot(ws.workspaceRoot)}/.inventtasks-backups`);
    return this.defaultPluginBackupRoot();
  }

  private workspaceBackupDir(target: BackupTarget, ws: WorkspaceEntry): string {
    return normalizePath(`${target.root}/${safeSegment(ws.id)}`);
  }

  private pathInWorkspace(ws: WorkspaceEntry, path: string): boolean {
    const root = normalizeWorkspaceRoot(ws.workspaceRoot);
    const p = normalizePath(path);
    // The vault's config folder is not part of a whole-vault workspace — and its
    // name is the user's choice, not necessarily ".obsidian".
    return root === "/" ? !p.startsWith(`${this.plugin.app.vault.configDir}/`) : p === root || p.startsWith(`${root}/`);
  }

  private isBackupPath(path: string): boolean {
    const p = normalizePath(path);
    return p.includes("/.inventtasks-backups/") || p.includes("/inventtasks/backups/") || p.startsWith(`${this.defaultPluginBackupRoot()}/`);
  }

  private relativeToWorkspace(root: string, path: string): string {
    const r = normalizeWorkspaceRoot(root);
    const p = normalizePath(path);
    return r === "/" ? p : p.replace(new RegExp(`^${escapeRegExp(r)}/?`), "");
  }

  private async safeVaultList(path: string): Promise<{ files: string[]; folders: string[] }> {
    try {
      return await this.plugin.app.vault.adapter.list(path === "/" ? "" : path);
    } catch {
      return { files: [], folders: [] };
    }
  }

  private async safeList(target: BackupTarget, path: string): Promise<{ files: string[]; folders: string[] }> {
    try { return await target.list(path); } catch { return { files: [], folders: [] }; }
  }

  private async ensureVaultFolder(path: string): Promise<void> {
    const norm = normalizePath(path || "/");
    if (!norm || norm === "/") return;
    const parts = norm.split("/");
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.plugin.app.vault.getAbstractFileByPath(cur)) {
        await this.plugin.app.vault.createFolder(cur);
      }
    }
  }

  private async readVaultBinaryBase64(path: string): Promise<{ base64: string; sha256: string; byteLength: number } | undefined> {
    const adapter = this.plugin.app.vault.adapter as unknown as { readBinary?: (path: string) => Promise<ArrayBuffer> };
    if (!adapter.readBinary) return undefined;
    const data = await adapter.readBinary(path);
    return { base64: arrayBufferToBase64(data), sha256: await sha256Hex(new Uint8Array(data)), byteLength: data.byteLength };
  }

  private async writeVaultBinary(path: string, base64: string, existing?: TAbstractFile | null): Promise<void> {
    const data = base64ToArrayBuffer(base64);
    if (existing instanceof TFile) await this.plugin.app.vault.modifyBinary(existing, data);
    else if ((this.plugin.app.vault as unknown as { createBinary?: unknown }).createBinary) await this.plugin.app.vault.createBinary(path, data);
    else await this.plugin.app.vault.adapter.writeBinary(path, data);
  }

  private async recordError(ws: WorkspaceEntry, e: unknown): Promise<void> {
    const message: string = (e as Error | undefined)?.message || String(e);
    ws.backup = { ...makeIncrementalBackupSettings(ws.backup), lastError: message };
    await this.plugin.saveSettings();
    new Notice(t("backup.failed", { msg: message }));
  }
}

function adapterTarget(app: App, root: string): BackupTarget {
  const adapter = app.vault.adapter;
  return {
    root: normalizePath(root),
    async ensureDir(path: string) {
      const parts = normalizePath(path).split("/").filter(Boolean);
      let cur = "";
      for (const part of parts) {
        cur = cur ? `${cur}/${part}` : part;
        if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
      }
    },
    write: (path, contents) => adapter.write(normalizePath(path), contents),
    read: (path) => adapter.read(normalizePath(path)),
    remove: (path) => adapter.remove(normalizePath(path)),
    list: (path) => adapter.list(normalizePath(path)),
    async stat(path) {
      const stat = await adapter.stat(normalizePath(path));
      return stat ? { mtime: stat.mtime, size: stat.size } : null;
    },
  };
}

function normalizeWorkspaceRoot(root: string | undefined): string {
  const value = (root || "").trim();
  if (!value || value === "/") return "/";
  return normalizePath(value).replace(/\/+$/, "");
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-") || "workspace";
}

function timestampSlug(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[T:]/g, "-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactSecrets<T extends object>(value: T): T {
  const out = { ...value } as Record<string, unknown>;
  for (const key of ["clientSecret", "accessToken", "refreshToken", "password"]) {
    if (out[key]) out[key] = "[redacted]";
  }
  return out as T;
}
