import { App, Platform, normalizePath } from "obsidian";
import { WorkspaceIndex } from "./workspace-index";
import type { CalendarSyncPrefs } from "../calendar-sync/types";
import type { PluginSettings } from "../settings";
import { applyWorkspaceSharedState } from "./workspace-state";

interface BgEntry {
  index: WorkspaceIndex;
  changeUnsub: () => void;
}

// Mirrors InventTasksPlugin.normalizedRoot so background indexes resolve their
// roots identically to the active one.
function normalizeRoot(v: string | undefined): string {
  const s = (v || "").trim();
  if (!s || s === "/") return "/";
  return normalizePath(s);
}

/**
 * Decide which workspaces background services should manage: every workspace
 * EXCEPT the active one (the active one runs on the plugin's shared UI index).
 * Returns nothing on mobile, where the active-only behaviour is intentional
 * (RAM / battery / data). Pure — unit-tested.
 */
export function planBackgroundEntries(
  workspaces: Array<{ id: string; workspaceRoot?: string }>,
  activeId: string,
  isMobile: boolean,
): Array<{ id: string; root: string }> {
  if (isMobile) return [];
  return workspaces
    .filter((w) => w.id !== activeId)
    .map((w) => ({ id: w.id, root: normalizeRoot(w.workspaceRoot) }));
}

/**
 * Keeps a resident WorkspaceIndex for every NON-active workspace, so the
 * NotificationCenter can keep firing reminders/overdue for them and the global
 * calendar sync can see their tasks while a different workspace is active.
 *
 * This class only manages INDEX lifecycles — notification scheduling lives in
 * the NotificationCenter (which pulls these indexes as feeds each tick) and
 * calendar sync in the global CalendarSyncManager (poked via onIndexChange).
 *
 * File events are root-filtered, so an idle index only re-scans when its own
 * files change. Mobile: a no-op.
 */
export class BackgroundServices {
  private app: App;
  private getSettings: () => PluginSettings;
  private getCalendarSync?: () => CalendarSyncPrefs | undefined;
  private onIndexChange?: () => void;
  private entries = new Map<string, BgEntry>();
  private reconciling = false;
  private rerun = false;

  constructor(
    app: App,
    getSettings: () => PluginSettings,
    onIndexChange?: () => void,
    getCalendarSync?: () => CalendarSyncPrefs | undefined,
  ) {
    this.app = app;
    this.getSettings = getSettings;
    this.onIndexChange = onIndexChange;
    this.getCalendarSync = getCalendarSync;
  }

  /** Indexes of all managed (non-active) workspaces. */
  indexes(): WorkspaceIndex[] {
    return [...this.entries.values()].map((e) => e.index);
  }

  /** The managed index for a workspace id (undefined when not managed). */
  indexFor(id: string): WorkspaceIndex | undefined {
    return this.entries.get(id)?.index;
  }

  /**
   * Bring running services in line with the current workspace list, excluding
   * `activeId`. Idempotent — safe to call after any workspace add / remove /
   * root change or a workspace switch. Overlapping calls are serialised.
   */
  async reconcile(activeId: string): Promise<void> {
    if (this.reconciling) { this.rerun = true; return; }
    this.reconciling = true;
    try {
      do {
        this.rerun = false;
        await this.reconcileOnce(activeId);
      } while (this.rerun);
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOnce(activeId: string): Promise<void> {
    // planBackgroundEntries returns [] on mobile, so the teardown loop below
    // naturally stops everything there (active-only behaviour preserved).
    const wanted = new Map(
      planBackgroundEntries(this.getSettings().workspaces, activeId, Platform.isMobile)
        .map((e) => [e.id, e.root] as const),
    );

    // Tear down entries that are no longer wanted (became active or removed).
    for (const [id, entry] of [...this.entries]) {
      if (!wanted.has(id)) {
        this.teardown(entry);
        this.entries.delete(id);
      }
    }

    // Create new entries; re-root existing ones whose folder changed.
    for (const [id, root] of wanted) {
      const existing = this.entries.get(id);
      if (existing) {
        if (existing.index.rootPath !== root) {
          await this.ensureFolder(root);
          await existing.index.setRoot(root);
          const ws = this.getSettings().workspaces.find((w) => w.id === id);
          if (ws) await applyWorkspaceSharedState(this.app, ws, this.getCalendarSync?.());
        }
        continue;
      }
      try {
        await this.ensureFolder(root);
        const ws = this.getSettings().workspaces.find((w) => w.id === id);
        if (ws) await applyWorkspaceSharedState(this.app, ws, this.getCalendarSync?.());
        const index = new WorkspaceIndex(this.app, root);
        await index.load();
        // Poke the global calendar manager when this workspace's files change
        // (e.g. tasks synced in from another device) so it re-syncs promptly.
        const changeUnsub = index.onChange(() => this.onIndexChange?.());
        this.entries.set(id, { index, changeUnsub });
        // A newly-managed workspace may add tasks to the global calendar set.
        this.onIndexChange?.();
      } catch (e) {
        // Isolate failures so one broken workspace can't stop the others.
        console.error(`[InventTasks] Background workspace "${id}" failed to start:`, e);
      }
    }
  }

  /** Stop and unload everything. Synchronous so it is safe to call from onunload. */
  stopAll(): void {
    for (const entry of this.entries.values()) this.teardown(entry);
    this.entries.clear();
  }

  private teardown(entry: BgEntry): void {
    entry.changeUnsub();
    entry.index.unload();
  }

  private async ensureFolder(root: string): Promise<void> {
    if (root === "/" || root === "") return;
    if (!this.app.vault.getAbstractFileByPath(root)) {
      try { await this.app.vault.createFolder(root); } catch { /* already exists / race */ }
    }
  }
}
