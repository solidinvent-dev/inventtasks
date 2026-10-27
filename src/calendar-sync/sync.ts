import { Platform, type App } from "obsidian";
import type { WorkspaceIndex } from "../data/workspace-index";
import type { CalendarSyncRule, CalendarSyncTarget, TaskFile, ContextLocation } from "../types";
import { evaluateGroup } from "../data/filters";
import { generateIcsFile } from "./ics";
import { syncToCalDav } from "./caldav";
import type { CalendarSyncPrefs, CalendarSyncScope, SyncedEventEntry } from "./types";

/** ICS file path in vault root. */
const ICS_FILENAME = "_tasks-calendar.ics";

/** Debounce for change-triggered syncs — coalesces a burst of vault-sync file
 *  events (e.g. tasks arriving from another device after launch) into one sync. */
const CALENDAR_CHANGE_DEBOUNCE_MS = 30_000;

/**
 * ICS export path for a given workspace root. Each workspace writes its own ICS
 * file inside its own root folder so multiple workspaces syncing in the
 * background don't clobber a single shared file. A root of "/" (or empty) keeps
 * the historical vault-root path `_tasks-calendar.ics`.
 *
 * NOTE: not yet wired into runCalendarSync — switching the live write to this is
 * an outward-facing change (it moves the ICS subscription URL for workspaces
 * rooted in a subfolder) and is gated on an explicit decision.
 */
export function icsPathForRoot(rootPath: string | undefined): string {
  const r = (rootPath || "").trim();
  if (!r || r === "/") return ICS_FILENAME;
  const normalized = r.replace(/\/+$/, "");
  return `${normalized}/${ICS_FILENAME}`;
}

/**
 * Decide whether a task should be exported to external calendars.
 * Combines: per-location calendar_sync toggle (inherited), the scope filters
 * (due-date-only, status groups), and the inherited status-group policy for
 * done/closed tasks.
 */
export function taskShouldSync(task: TaskFile, scope: CalendarSyncScope, index: WorkspaceIndex): boolean {
  const d = task.data;
  const loc: ContextLocation = task.listPath ? { kind: "list", path: task.listPath } : { kind: "everything" };

  // Per-location (space/folder/list) export toggle with inheritance.
  if (!index.resolveConfigBoolForLocation(loc, "calendar_sync")) return false;

  const statusGroup = d.status_group || "not_started";
  const isDone = statusGroup === "done";
  const isClosed = statusGroup === "closed";
  const policy = index.resolveCalendarSyncStatusPolicyForLocation(loc);
  if (policy === "exclude_done_closed" && (isDone || isClosed)) return false;
  if (policy === "exclude_closed" && isClosed) return false;

  if (scope.withDueDateOnly && !d.due_date) return false;
  if (scope.statusGroups.length && !isDone && !isClosed) {
    if (!scope.statusGroups.includes(statusGroup)) return false;
  }
  if (!withinSyncDateWindow(d.due_date || d.start_date, scope, Date.now())) return false;
  return true;
}

/** Optional date-window check by the task's due (or start) date. Pure. */
export function withinSyncDateWindow(refDate: string | null | undefined, scope: CalendarSyncScope, now: number): boolean {
  if (!scope.pastDays && !scope.futureDays) return true; // unlimited
  if (!refDate) return true;                              // no date → window doesn't apply
  const ms = Date.parse(refDate);
  if (!isFinite(ms)) return true;
  if (scope.pastDays && ms < now - scope.pastDays * 86_400_000) return false;
  if (scope.futureDays && ms > now + scope.futureDays * 86_400_000) return false;
  return true;
}

function targetKey(target: CalendarSyncTarget): string {
  return `${target.kind}:${target.calendarId || "default"}`;
}

function syncedNamespaceKey(target: CalendarSyncTarget, taskId: string): string {
  return `${targetKey(target)}::${taskId}`;
}

function extractTargetSyncedEvents(
  syncedEvents: Record<string, SyncedEventEntry>,
  target: CalendarSyncTarget,
): Record<string, SyncedEventEntry> {
  const prefix = `${targetKey(target)}::`;
  const out: Record<string, SyncedEventEntry> = {};
  for (const [key, entry] of Object.entries(syncedEvents)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = entry;
  }
  return out;
}

function mergeTargetSyncedEvents(
  syncedEvents: Record<string, SyncedEventEntry>,
  target: CalendarSyncTarget,
  next: Record<string, SyncedEventEntry>,
): Record<string, SyncedEventEntry> {
  const prefix = `${targetKey(target)}::`;
  const merged: Record<string, SyncedEventEntry> = {};
  for (const [key, entry] of Object.entries(syncedEvents)) {
    if (!key.startsWith(prefix)) merged[key] = entry;
  }
  for (const [taskId, entry] of Object.entries(next)) {
    merged[syncedNamespaceKey(target, taskId)] = entry;
  }
  return merged;
}

function targetEnabled(target: CalendarSyncTarget, prefs: CalendarSyncPrefs): boolean {
  if (target.kind === "ics") return prefs.generateIcs;
  if (target.kind === "caldav") return prefs.caldav.enabled;
  return false;
}

function addTaskToTarget(
  map: Map<string, { target: CalendarSyncTarget; tasks: TaskFile[] }>,
  target: CalendarSyncTarget,
  task: TaskFile,
): void {
  const key = targetKey(target);
  const bucket = map.get(key) || { target, tasks: [] };
  if (!bucket.tasks.some((existing) => existing.data.id === task.data.id)) bucket.tasks.push(task);
  map.set(key, bucket);
}

function ensureTargetBucket(
  map: Map<string, { target: CalendarSyncTarget; tasks: TaskFile[] }>,
  target: CalendarSyncTarget,
): void {
  const key = targetKey(target);
  if (!map.has(key)) map.set(key, { target, tasks: [] });
}

export function collectConfiguredTargets(index: WorkspaceIndex, prefs: CalendarSyncPrefs): CalendarSyncTarget[] {
  const out = new Map<string, CalendarSyncTarget>();
  const addRules = (rules?: CalendarSyncRule[]) => {
    if (!Array.isArray(rules)) return;
    for (const rule of rules) {
      for (const target of rule.targets || []) {
        if (targetEnabled(target, prefs)) out.set(targetKey(target), target);
      }
    }
  };
  addRules(index.workspace?.calendar_sync_rules);
  for (const space of index.spaces) {
    addRules(space.config.calendar_sync_rules);
    for (const folder of space.folders) {
      addRules(folder.config.calendar_sync_rules);
      for (const list of folder.lists) addRules(list.config.calendar_sync_rules);
    }
    for (const list of space.lists) addRules(list.config.calendar_sync_rules);
  }
  return [...out.values()];
}

function matchingRulesForTask(task: TaskFile, rules: CalendarSyncRule[], index: WorkspaceIndex): CalendarSyncRule[] {
  const context = {
    customFields: task.listPath ? index.resolveCustomFields(task.listPath) : index.resolveCustomFieldsForLocation({ kind: "everything" }),
  };
  return rules.filter((rule) => rule.filter && hasFilterConditions(rule.filter) && evaluateGroup(task, rule.filter, context));
}

function hasFilterConditions(group: CalendarSyncRule["filter"]): boolean {
  if (!group?.conditions?.length) return false;
  return group.conditions.some((condition) => {
    const nested = condition as CalendarSyncRule["filter"];
    return !!nested?.logic ? hasFilterConditions(nested) : true;
  });
}

/**
 * Main calendar sync orchestrator.
 * Iterates all enabled services, syncs the in-scope tasks, and updates the prefs
 * object. The caller is responsible for saving settings after this returns.
 */
export async function runCalendarSync(
  app: App,
  indexes: WorkspaceIndex[],
  prefs: CalendarSyncPrefs,
): Promise<void> {
  const errors: string[] = []; // collected per-target failures → prefs.lastSyncError
  const warnings: string[] = []; // per-task partial failures while target stayed reachable

  // Calendar config is global, so aggregate the in-scope tasks across ALL
  // workspaces. Each task keeps its owning index so rules/custom-fields resolve
  // against the right workspace config. Tasks not in this set are removed from
  // the remote calendars by the backends — so aggregating is what stops one
  // workspace's sync from deleting another workspace's events.
  const desired: Array<{ task: TaskFile; index: WorkspaceIndex }> = [];
  for (const index of indexes) {
    for (const task of index.allTasks()) {
      if (task.data.archived) continue;
      if (taskShouldSync(task, prefs.scope, index)) desired.push({ task, index });
    }
  }

  const byTarget = new Map<string, { target: CalendarSyncTarget; tasks: TaskFile[] }>();
  for (const index of indexes) {
    for (const target of collectConfiguredTargets(index, prefs)) ensureTargetBucket(byTarget, target);
  }
  for (const { task, index } of desired) {
    const loc: ContextLocation = task.listPath ? { kind: "list", path: task.listPath } : { kind: "everything" };
    const rules = index.resolveCalendarSyncRulesForLocation(loc);
    for (const rule of matchingRulesForTask(task, rules, index)) {
      for (const target of rule.targets || []) {
        if (targetEnabled(target, prefs)) addTaskToTarget(byTarget, target, task);
      }
    }
  }

  const icsTasks: TaskFile[] = [];

  for (const { target, tasks } of byTarget.values()) {
    if (target.kind === "ics") {
      for (const task of tasks) {
        if (!icsTasks.some((existing) => existing.data.id === task.data.id)) icsTasks.push(task);
      }
      continue;
    }

    if (target.kind === "caldav" && prefs.caldav.enabled) {
      const config = { ...prefs.caldav, calendarPath: target.calendarId || prefs.caldav.calendarPath };
      try {
        const scoped = extractTargetSyncedEvents(prefs.syncedEvents, target);
        const next = await syncToCalDav(config, tasks, scoped);
        // Only count tasks CalDAV could actually have represented. taskToVEvent
        // returns null without a date, so a dateless task is skipped by design —
        // counting it reported a permanent failure for something that was never
        // going to be an event.
        const missing = missingSyncedTasks(tasks.filter(hasCalendarDate), next, "caldav");
        if (missing) warnings.push(`CalDAV: ${missing} event(s) were not synced`);
        prefs.syncedEvents = mergeTargetSyncedEvents(prefs.syncedEvents, target, next);
      } catch (e: any) {
        console.error("[InventTasks] CalDAV sync failed:", e);
        errors.push(`CalDAV: ${e?.message || e}`);
      }
    }
  }

  if (prefs.generateIcs) {
    try {
      const icsContent = generateIcsFile(icsTasks, prefs.icsComponent ?? "event");
      // Single global ICS at the vault root — calendar config is plugin-wide and
      // this file aggregates every workspace's tasks.
      await app.vault.adapter.write(ICS_FILENAME, icsContent);
    } catch (e: any) {
      console.error("[InventTasks] ICS file generation failed:", e);
      errors.push(`ICS: ${e?.message || e}`);
    }
  }

  prefs.lastSync = new Date().toISOString();
  prefs.lastSyncError = errors.length ? { ts: prefs.lastSync, message: errors.join("; ") } : undefined;
  prefs.lastSyncWarning = warnings.length ? { ts: prefs.lastSync, message: warnings.join("; ") } : undefined;
}

/** Does this task carry enough to become a calendar event at all? */
export function hasCalendarDate(task: TaskFile): boolean {
  return !!(task.data.start_date || task.data.due_date);
}

export function missingSyncedTasks(tasks: TaskFile[], synced: Record<string, SyncedEventEntry>, field: keyof SyncedEventEntry): number {
  return tasks.filter((task) => task.data.id && !synced[task.data.id]?.[field]).length;
}

/**
 * Calendar sync manager that handles periodic auto-sync.
 */
export class CalendarSyncManager {
  private intervalId: number | null = null;
  private changeTimer: number | null = null;
  private syncing = false;
  private resyncQueued = false;
  private onSave: () => Promise<void>;
  private app: App;
  // Calendar config is global, so the manager pulls tasks from EVERY workspace's
  // index (active + background) at sync time.
  private getIndexes: () => WorkspaceIndex[];
  private getPrefs: () => CalendarSyncPrefs;

  constructor(
    app: App,
    getIndexes: () => WorkspaceIndex[],
    getPrefs: () => CalendarSyncPrefs,
    onSave: () => Promise<void>,
  ) {
    this.app = app;
    this.getIndexes = getIndexes;
    this.getPrefs = getPrefs;
    this.onSave = onSave;
  }

  start(): void {
    this.stop();
    if (Platform.isMobile) return; // calendar sync is desktop-only (mobile can't see all workspaces safely)
    const prefs = this.getPrefs();
    if (!prefs.enabled || prefs.frequency === "manual") return;

    const intervalMs = prefs.frequency === "15min" ? 15 * 60 * 1000 : 60 * 60 * 1000;
    this.intervalId = window.setInterval(() => void this.sync(), intervalMs);
    // Catch up once on (re)launch — start() only arms the interval, so without
    // this the calendar would stay stale for a whole interval after each start.
    void this.sync();
  }

  /** Debounced sync driven by index changes (a task edited here, or synced in
   *  from another device after launch). No-op when disabled or manual. */
  scheduleSync(): void {
    const prefs = this.getPrefs();
    if (!prefs.enabled || prefs.frequency === "manual") return;
    if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
    this.changeTimer = window.setTimeout(() => void this.sync(), CALENDAR_CHANGE_DEBOUNCE_MS);
  }

  stop(): void {
    if (this.intervalId !== null) { window.clearInterval(this.intervalId); this.intervalId = null; }
    if (this.changeTimer !== null) { window.clearTimeout(this.changeTimer); this.changeTimer = null; }
  }

  async sync(): Promise<void> {
    if (Platform.isMobile) return; // desktop-only — mobile loads only the active index
    // Guard against overlapping runs (interval + change-trigger + manual button).
    // Two concurrent runCalendarSync on the same syncedEvents map would
    // double-create events. A queued rerun captures changes that landed mid-sync.
    if (this.syncing) { this.resyncQueued = true; return; }
    this.syncing = true;
    try {
      do {
        this.resyncQueued = false;
        const prefs = this.getPrefs();
        if (!prefs.enabled) break;
        await runCalendarSync(this.app, this.getIndexes(), prefs);
        await this.onSave();
      } while (this.resyncQueued);
    } catch (e) {
      console.error("[InventTasks] Calendar auto-sync error:", e);
    } finally {
      this.syncing = false;
    }
  }

  /** Restart with updated frequency after settings change. */
  restart(): void {
    this.stop();
    this.start();
  }
}
